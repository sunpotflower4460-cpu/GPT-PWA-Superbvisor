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
  checks: ProjectKernelValidationCheck[];
}

export interface ProjectKernelManifest {
  schemaVersion: 1;
  kind: 'ai-project-kernel';
  defaultMode?: string;
  modes?: string[];
  paths: Record<string, string>;
  capabilities: Record<string, boolean>;
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

  if (isRecord(value.contextRouting)) {
    const contextRouting: ProjectKernelManifest['contextRouting'] = {};
    for (const key of ['core', 'scoped', 'onDemand'] as const) {
      const raw = value.contextRouting[key];
      if (raw === undefined) continue;
      const items = parseStringArray(raw, `contextRouting.${key}`);
      for (const path of items) assertSafeManifestPath(path, `contextRouting.${key}`);
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

function parseValidationStrategy(value: unknown, index: number): ProjectKernelValidationStrategy {
  if (!isRecord(value) || typeof value.type !== 'string' || !VALIDATION_TYPES.has(value.type)) {
    throw new Error(`validation.strategies[${index}].type is invalid`);
  }
  const checksRaw = value.checks ?? [];
  if (!Array.isArray(checksRaw)) throw new Error(`validation.strategies[${index}].checks must be an array`);
  const checks = checksRaw.map((check, checkIndex) => {
    if (!isRecord(check) || typeof check.name !== 'string' || !check.name.trim()) {
      throw new Error(`validation.strategies[${index}].checks[${checkIndex}].name is required`);
    }
    const category = typeof check.category === 'string' && check.category.trim() ? check.category.trim() : undefined;
    return { name: check.name.trim(), category };
  });
  return { type: value.type as ProjectKernelValidationStrategy['type'], checks };
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

function assertSafeManifestPath(path: string, label: string) {
  if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
    throw new Error(`${label} contains an unsafe repository path`);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
