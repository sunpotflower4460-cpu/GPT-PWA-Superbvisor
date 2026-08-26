import { GitHubEnv, GitHubFileResult, readOptionalFile } from './githubExecutor';

const MANIFEST_PATH = 'project-kernel.json';
const SUPPORTED_SCHEMA_VERSION = 1;
const VALIDATION_TYPES = new Set(['push', 'pull_request', 'workflow_dispatch']);

export type ProjectKernelMode = 'KERNEL_AWARE' | 'GENERIC_REPO';

export interface ProjectKernelValidationCheck {
  name: string;
  category?: string;
}

export interface ProjectKernelValidationStrategy {
  type: 'push' | 'pull_request' | 'workflow_dispatch';
  // Absent is treated as required: a strategy declared in the manifest is
  // assumed load-bearing unless explicitly opted out.
  required?: boolean;
  // push-only: which branches this strategy actually fires on. Absent/empty
  // means "any branch". A pull_request strategy has no branches field —
  // it fires on the PR's head branch by definition.
  branches?: string[];
  checks: ProjectKernelValidationCheck[];
}

export interface ProjectKernelManifest {
  schemaVersion: 1;
  kind: 'ai-project-kernel';
  defaultMode?: string;
  modes?: string[];
  paths: Record<string, string>;
  capabilities: Record<string, boolean>;
  // Each entry is a KEY into `paths` (e.g. "soul"), not a literal repository
  // path. This mirrors the contract GPT-template's own project-kernel.json
  // actually ships (paths dictionary + contextRouting arrays of path keys),
  // so a producer and consumer manifest can't silently disagree on what a
  // routing entry even means.
  contextRouting?: {
    core?: string[];
    scoped?: string[];
    onDemand?: string[];
  };
  governance?: Record<string, unknown>;
  runtime?: Record<string, string>;
  validation?: {
    strategies: ProjectKernelValidationStrategy[];
  };
  dependencyPolicy?: Record<string, unknown>;
}

export interface ProjectKernelDetection {
  mode: ProjectKernelMode;
  manifest?: ProjectKernelManifest;
  source?: Pick<GitHubFileResult, 'path' | 'sha' | 'size'>;
  reason?: 'not_found' | 'unsupported_schema' | 'invalid_manifest';
  error?: string;
}

export async function detectProjectKernel(
  env: GitHubEnv,
  repository: string,
  ref: string,
): Promise<ProjectKernelDetection> {
  const file = await readOptionalFile(env, repository, ref, MANIFEST_PATH);
  if (!file) return { mode: 'GENERIC_REPO', reason: 'not_found' };

  try {
    const manifest = parseProjectKernel(file.content);
    return {
      mode: 'KERNEL_AWARE',
      manifest,
      source: { path: file.path, sha: file.sha, size: file.size },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: 'GENERIC_REPO',
      reason: message.startsWith('Unsupported Project Kernel schema') ? 'unsupported_schema' : 'invalid_manifest',
      source: { path: file.path, sha: file.sha, size: file.size },
      error: message,
    };
  }
}

export function parseProjectKernel(content: string): ProjectKernelManifest {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error('Project Kernel manifest is not valid JSON');
  }
  if (!isRecord(value)) throw new Error('Project Kernel manifest must be an object');
  if (value.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`Unsupported Project Kernel schema: ${String(value.schemaVersion)}`);
  }
  if (value.kind !== 'ai-project-kernel') throw new Error('Project Kernel kind must be ai-project-kernel');

  const paths = parseStringRecord(value.paths, 'paths', true);
  for (const [key, path] of Object.entries(paths)) assertSafeManifestPath(path, `paths.${key}`);

  const capabilities = parseBooleanRecord(value.capabilities, 'capabilities');
  const manifest: ProjectKernelManifest = {
    schemaVersion: 1,
    kind: 'ai-project-kernel',
    paths,
    capabilities,
  };

  if (typeof value.defaultMode === 'string' && value.defaultMode.trim()) manifest.defaultMode = value.defaultMode.trim();
  if (Array.isArray(value.modes)) manifest.modes = parseStringArray(value.modes, 'modes');

  if (value.contextRouting !== undefined) {
    // Unlike defaultMode/modes above (which silently ignore a wrong-typed
    // value instead of throwing), contextRouting is rejected outright when
    // it isn't an object. Silently ignoring it here would leave the
    // manifest looking valid on this side while GPT-template's producer-side
    // isValidKernelManifest() already rejects the same input — the parity
    // gap runs the opposite direction from most others in this file (here
    // the consumer was the loose one), but it's still a real one.
    if (!isRecord(value.contextRouting)) throw new Error('contextRouting must be an object');
    const contextRouting: ProjectKernelManifest['contextRouting'] = {};
    for (const key of ['core', 'scoped', 'onDemand'] as const) {
      const raw = value.contextRouting[key];
      if (raw === undefined) continue;
      const items = parseStringArray(raw, `contextRouting.${key}`);
      for (const pathKey of items) {
        // `in` also matches inherited Object.prototype names (toString,
        // constructor, __proto__, ...) even when `paths` has no own key by
        // that name, silently accepting a routing entry with no real path
        // behind it. Object.hasOwn is the own-property-only check.
        if (!Object.hasOwn(paths, pathKey)) throw new Error(`contextRouting.${key} references unknown paths key "${pathKey}"`);
      }
      contextRouting[key] = items;
    }
    manifest.contextRouting = contextRouting;
  }

  if (isRecord(value.governance)) manifest.governance = value.governance;
  if (value.runtime !== undefined) manifest.runtime = parseStringRecord(value.runtime, 'runtime', false);
  if (isRecord(value.dependencyPolicy)) manifest.dependencyPolicy = value.dependencyPolicy;

  if (value.validation !== undefined) {
    if (!isRecord(value.validation) || !Array.isArray(value.validation.strategies)) {
      throw new Error('validation.strategies must be an array');
    }
    manifest.validation = {
      strategies: value.validation.strategies.map((strategy, index) => parseValidationStrategy(strategy, index)),
    };
  }

  return manifest;
}

// Resolve one contextRouting tier's path keys against `paths`, in declared
// order. Callers read the returned path strings; the key is kept alongside
// for labeling (e.g. a context-assembly section header).
export function resolveContextRoutingPaths(
  manifest: ProjectKernelManifest,
  tier: 'core' | 'scoped' | 'onDemand',
): Array<{ key: string; path: string }> {
  const keys = manifest.contextRouting?.[tier] ?? [];
  return keys.map((key) => ({ key, path: manifest.paths[key] }));
}

// Every check name across every validation strategy whose declared category
// matches. A repo's CI check names are effectively global (the same
// "check-approval" run reports the same way regardless of which trigger
// fired it), so this deliberately doesn't scope by strategy/branch.
export function getCheckNamesByCategory(manifest: ProjectKernelManifest | undefined, category: string): Set<string> {
  const names = new Set<string>();
  for (const strategy of manifest?.validation?.strategies ?? []) {
    for (const check of strategy.checks) {
      if (check.category === category) names.add(check.name);
    }
  }
  return names;
}

// True when this repository's Validation Contract requires a pull_request
// for CI to fire at all, and the given branch isn't already covered by a
// required push strategy. Feature-branch workflows (branch !== the push
// strategy's declared branches, typically just the default branch) need a
// PR opened before any CI run will ever appear — waiting for one is a
// deadlock, not a transient delay.
export function requiresDraftPrFirst(manifest: ProjectKernelManifest | undefined, branch: string): boolean {
  const strategies = manifest?.validation?.strategies;
  if (!strategies?.length) return false;
  const pushCoversBranch = strategies.some(
    (strategy) => strategy.type === 'push' && strategy.required !== false && (!strategy.branches?.length || strategy.branches.includes(branch)),
  );
  if (pushCoversBranch) return false;
  return strategies.some((strategy) => strategy.type === 'pull_request' && strategy.required !== false);
}

function parseValidationStrategy(value: unknown, index: number): ProjectKernelValidationStrategy {
  if (!isRecord(value) || typeof value.type !== 'string' || !VALIDATION_TYPES.has(value.type)) {
    throw new Error(`validation.strategies[${index}].type is invalid`);
  }
  const strategy: ProjectKernelValidationStrategy = { type: value.type as ProjectKernelValidationStrategy['type'], checks: [] };

  if (value.required !== undefined) {
    if (typeof value.required !== 'boolean') throw new Error(`validation.strategies[${index}].required must be boolean`);
    strategy.required = value.required;
  }

  if (value.branches !== undefined) {
    strategy.branches = parseStringArray(value.branches, `validation.strategies[${index}].branches`);
  }

  const checksRaw = value.checks ?? [];
  if (!Array.isArray(checksRaw)) throw new Error(`validation.strategies[${index}].checks must be an array`);
  strategy.checks = checksRaw.map((check, checkIndex) => {
    if (!isRecord(check) || typeof check.name !== 'string' || !check.name.trim()) {
      throw new Error(`validation.strategies[${index}].checks[${checkIndex}].name is required`);
    }
    const category = typeof check.category === 'string' && check.category.trim() ? check.category.trim() : undefined;
    return { name: check.name.trim(), category };
  });

  return strategy;
}

function parseStringRecord(value: unknown, label: string, requireNonEmpty: boolean): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const entries = Object.entries(value);
  if (requireNonEmpty && entries.length === 0) throw new Error(`${label} must not be empty`);
  const result: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error(`${label}.${key} must be a non-empty string`);
    result[key] = raw.trim();
  }
  return result;
}

function parseBooleanRecord(value: unknown, label: string): Record<string, boolean> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const result: Record<string, boolean> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'boolean') throw new Error(`${label}.${key} must be boolean`);
    result[key] = raw;
  }
  return result;
}

function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) throw new Error(`${label}[${index}] must be a non-empty string`);
    return item.trim();
  });
}

// A Windows drive-qualified path (e.g. "C:/Windows/..." or "C:foo") is
// absolute/rooted outside the repository despite starting with neither
// "/" nor "\\" and containing no "..". An orchestrator resolving this path
// on Windows would read outside the checkout.
const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:/;

function assertSafeManifestPath(path: string, label: string) {
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').includes('..') ||
    WINDOWS_DRIVE_PATH.test(path)
  ) {
    throw new Error(`${label} contains an unsafe repository path`);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
