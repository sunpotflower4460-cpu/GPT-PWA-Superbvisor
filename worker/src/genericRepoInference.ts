// Best-effort Validation Contract / runtime command inference for
// GENERIC_REPO (no project-kernel.json declared at all). This is a lesser-
// fidelity fallback, never a replacement for a real Kernel: it never
// invents human-approval check names (getCheckNamesByCategory stays
// explicit-declaration-only — see projectKernel.ts), and every heuristic
// below is documented at its use site so a caller can tell inferred data
// from a maintainer's own declaration.
import { GitHubEnv, listRecentWorkflowEvents, readOptionalFile } from './githubExecutor';
import { isRecord } from './projectKernel';
import type { ProjectKernelManifest } from './projectKernel';

export interface InferredGenericRepoContract {
  runtime?: Record<string, string>;
  validation?: ProjectKernelManifest['validation'];
}

interface GenericRepoSignals {
  defaultBranch: string;
  packageJson: string | null;
  lockfile: 'package-lock' | 'npm-shrinkwrap' | 'yarn' | 'pnpm' | null;
  pyprojectToml: string | null;
  cargoToml: string | null;
  makefile: string | null;
  workflowEvents: ReadonlySet<string>;
}

function inferNodeRuntime(signals: GenericRepoSignals): Record<string, string> | undefined {
  if (!signals.packageJson) return undefined;
  let pkg: unknown;
  try {
    pkg = JSON.parse(signals.packageJson);
  } catch {
    return undefined;
  }
  if (!isRecord(pkg)) return undefined;

  const runtime: Record<string, string> = {};
  // Mirrors GPT-template's own runtime.setup reasoning (scripts/guard's
  // documented `if npm-shrinkwrap/package-lock then npm ci else npm
  // install --no-package-lock`): `npm ci` requires a lockfile to exist or
  // it fails outright, and a bare `npm install` would write an untracked
  // lockfile into a checkout that has none.
  runtime.setup =
    signals.lockfile === 'package-lock' || signals.lockfile === 'npm-shrinkwrap'
      ? 'npm ci'
      : signals.lockfile === 'yarn'
        ? 'yarn install --frozen-lockfile'
        : signals.lockfile === 'pnpm'
          ? 'pnpm install --frozen-lockfile'
          : 'npm install --no-package-lock';

  const scripts = isRecord(pkg.scripts) ? pkg.scripts : {};
  const SCRIPT_NAMES = ['test', 'build', 'typecheck', 'lint', 'dev'] as const;
  for (const name of SCRIPT_NAMES) {
    const value = scripts[name];
    if (typeof value === 'string' && value.trim()) {
      runtime[name] = name === 'test' ? 'npm test' : `npm run ${name}`;
    }
  }
  return runtime;
}

function inferPythonRuntime(signals: GenericRepoSignals): Record<string, string> | undefined {
  if (!signals.pyprojectToml) return undefined;
  const text = signals.pyprojectToml;
  const runtime: Record<string, string> = {};
  runtime.setup = /^\s*\[tool\.poetry]/m.test(text) ? 'poetry install' : 'pip install -e .';
  if (/^\s*\[tool\.pytest/m.test(text)) runtime.test = 'pytest';
  return runtime;
}

function inferRustRuntime(signals: GenericRepoSignals): Record<string, string> | undefined {
  // No separate setup command: `cargo build`/`cargo test` fetch and build
  // dependencies as part of the same invocation.
  if (!signals.cargoToml) return undefined;
  return { test: 'cargo test', build: 'cargo build' };
}

function inferMakefileRuntime(signals: GenericRepoSignals): Record<string, string> | undefined {
  if (!signals.makefile) return undefined;
  const runtime: Record<string, string> = {};
  const hasTarget = (name: string) => new RegExp(`^${name}\\s*:`, 'm').test(signals.makefile as string);
  if (hasTarget('test')) runtime.test = 'make test';
  if (hasTarget('build')) runtime.build = 'make build';
  if (hasTarget('setup')) runtime.setup = 'make setup';
  else if (hasTarget('install')) runtime.setup = 'make install';
  if (hasTarget('lint')) runtime.lint = 'make lint';
  return Object.keys(runtime).length ? runtime : undefined;
}

// Merges every ecosystem's inferred commands, Node > Python > Rust >
// Makefile, each layer only filling keys none of the earlier layers set —
// a monorepo can plausibly carry more than one of these files at once.
function inferRuntime(signals: GenericRepoSignals): Record<string, string> | undefined {
  const layers = [inferNodeRuntime(signals), inferPythonRuntime(signals), inferRustRuntime(signals), inferMakefileRuntime(signals)];
  const runtime: Record<string, string> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (!(key in runtime)) runtime[key] = value;
    }
  }
  return Object.keys(runtime).length ? runtime : undefined;
}

function inferValidation(signals: GenericRepoSignals): ProjectKernelManifest['validation'] | undefined {
  const events = signals.workflowEvents;
  if (!events.size) return undefined;
  const strategies: NonNullable<ProjectKernelManifest['validation']>['strategies'] = [];
  if (events.has('push')) {
    strategies.push({
      type: 'push',
      required: true,
      // Reading .github/workflows/*.yml directly is deliberately blocked
      // (see githubExecutor.ts's BLOCKED_PATHS), so the real `branches:`
      // filter on a push trigger can't be seen — only that push-triggered
      // CI exists at all. The overwhelming real-world convention restricts
      // it to the default branch only, and assuming otherwise (unrestricted)
      // would silently hide the draft-PR-first deadlock this inference
      // exists to catch on every other branch, so the narrower assumption
      // is the safe one.
      branches: [signals.defaultBranch],
      checks: [],
    });
  }
  if (events.has('pull_request') || events.has('pull_request_target')) {
    strategies.push({ type: 'pull_request', required: true, checks: [] });
  }
  if (events.has('workflow_dispatch')) {
    strategies.push({ type: 'workflow_dispatch', required: true, checks: [] });
  }
  return strategies.length ? { strategies } : undefined;
}

async function readOptionalOrNull(env: GitHubEnv, repository: string, ref: string, path: string): Promise<string | null> {
  try {
    const file = await readOptionalFile(env, repository, ref, path);
    return file?.content ?? null;
  } catch {
    // Best-effort per file: an oversized or otherwise unreadable file must
    // not take down inference for every other signal.
    return null;
  }
}

async function detectLockfile(env: GitHubEnv, repository: string, ref: string): Promise<GenericRepoSignals['lockfile']> {
  const [packageLock, shrinkwrap, yarnLock, pnpmLock] = await Promise.all([
    readOptionalOrNull(env, repository, ref, 'package-lock.json'),
    readOptionalOrNull(env, repository, ref, 'npm-shrinkwrap.json'),
    readOptionalOrNull(env, repository, ref, 'yarn.lock'),
    readOptionalOrNull(env, repository, ref, 'pnpm-lock.yaml'),
  ]);
  if (shrinkwrap !== null) return 'npm-shrinkwrap';
  if (packageLock !== null) return 'package-lock';
  if (yarnLock !== null) return 'yarn';
  if (pnpmLock !== null) return 'pnpm';
  return null;
}

// Entry point for detectProjectKernel's GENERIC_REPO/not_found path. Never
// throws: any individual signal that fails to fetch is simply treated as
// absent, so a slow or oversized file degrades inference rather than
// blocking job creation.
export async function inferGenericRepoContract(
  env: GitHubEnv,
  repository: string,
  ref: string,
  defaultBranch: string,
): Promise<InferredGenericRepoContract | undefined> {
  const [packageJson, lockfile, pyprojectToml, cargoToml, makefile, workflowEvents] = await Promise.all([
    readOptionalOrNull(env, repository, ref, 'package.json'),
    detectLockfile(env, repository, ref),
    readOptionalOrNull(env, repository, ref, 'pyproject.toml'),
    readOptionalOrNull(env, repository, ref, 'Cargo.toml'),
    readOptionalOrNull(env, repository, ref, 'Makefile'),
    listRecentWorkflowEvents(env, repository).catch(() => new Set<string>()),
  ]);

  const signals: GenericRepoSignals = { defaultBranch, packageJson, lockfile, pyprojectToml, cargoToml, makefile, workflowEvents };
  const runtime = inferRuntime(signals);
  const validation = inferValidation(signals);
  if (!runtime && !validation) return undefined;
  return { runtime, validation };
}
