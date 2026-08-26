import { afterEach, describe, expect, it, vi } from 'vitest';
import { inferGenericRepoContract } from './genericRepoInference';
import type { GitHubEnv } from './githubExecutor';

const env: GitHubEnv = {
  GITHUB_TOKEN: 'test-token',
  GITHUB_ALLOWED_REPOS: 'sunpotflower4460-cpu/some-generic-repo',
};
const REPO = 'sunpotflower4460-cpu/some-generic-repo';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Routes every /contents/{path} request against a fixed file map (absent
// key or explicit null = 404), and every /actions/runs request to a fixed
// list of trigger event names — mirroring the real Contents/Actions APIs
// closely enough for inferGenericRepoContract's own fetch calls, without
// needing a full GitHub API mock.
function mockRepoFiles(files: Record<string, string | null>, workflowEvents: string[] = []) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/actions/runs?')) {
      return jsonResponse({ workflow_runs: workflowEvents.map((event) => ({ event })) });
    }
    const match = url.match(/\/contents\/([^?]+)\?ref=/);
    const path = match ? decodeURIComponent(match[1]) : '';
    const content = files[path];
    if (content === undefined || content === null) return jsonResponse({ message: 'Not Found' }, 404);
    return jsonResponse({
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(content, 'utf-8').toString('base64'),
      sha: `sha-${path}`,
      size: content.length,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('inferGenericRepoContract', () => {
  it('returns undefined when no recognizable signal exists at all', async () => {
    mockRepoFiles({});
    const result = await inferGenericRepoContract(env, REPO, 'main', 'main');
    expect(result).toBeUndefined();
  });

  it('infers Node runtime commands from package.json scripts, using npm ci when package-lock.json exists', async () => {
    mockRepoFiles({
      'package.json': JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc -b', typecheck: 'tsc --noEmit', lint: 'eslint .' } }),
      'package-lock.json': '{}',
    });
    const result = await inferGenericRepoContract(env, REPO, 'main', 'main');
    expect(result?.runtime).toEqual({
      setup: 'npm ci',
      test: 'npm test',
      build: 'npm run build',
      typecheck: 'npm run typecheck',
      lint: 'npm run lint',
    });
  });

  it('falls back to npm install --no-package-lock when no lockfile is present, and uses npm-shrinkwrap.json over package-lock.json when both exist', async () => {
    mockRepoFiles({ 'package.json': JSON.stringify({ scripts: {} }) });
    const noLockfile = await inferGenericRepoContract(env, REPO, 'main', 'main');
    expect(noLockfile?.runtime?.setup).toBe('npm install --no-package-lock');

    mockRepoFiles({
      'package.json': JSON.stringify({ scripts: {} }),
      'package-lock.json': '{}',
      'npm-shrinkwrap.json': '{}',
    });
    const shrinkwrapWins = await inferGenericRepoContract(env, REPO, 'main', 'main');
    expect(shrinkwrapWins?.runtime?.setup).toBe('npm ci');
  });

  it('infers Python runtime commands from pyproject.toml, preferring poetry install when [tool.poetry] is declared', async () => {
    mockRepoFiles({
      'pyproject.toml': '[tool.poetry]\nname = "demo"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
    });
    const result = await inferGenericRepoContract(env, REPO, 'main', 'main');
    expect(result?.runtime).toEqual({ setup: 'poetry install', test: 'pytest' });
  });

  it('falls back to pip install -e . for a plain pyproject.toml with no poetry/pytest markers', async () => {
    mockRepoFiles({ 'pyproject.toml': '[project]\nname = "demo"\n' });
    const result = await inferGenericRepoContract(env, REPO, 'main', 'main');
    expect(result?.runtime).toEqual({ setup: 'pip install -e .' });
  });

  it('infers Rust runtime commands from Cargo.toml with no separate setup command', async () => {
    mockRepoFiles({ 'Cargo.toml': '[package]\nname = "demo"\n' });
    const result = await inferGenericRepoContract(env, REPO, 'main', 'main');
    expect(result?.runtime).toEqual({ test: 'cargo test', build: 'cargo build' });
  });

  it('infers Makefile targets, preferring an explicit setup: target over install:', async () => {
    mockRepoFiles({ Makefile: 'test:\n\tgo test ./...\n\nbuild:\n\tgo build\n\nsetup:\n\tgo mod download\n\ninstall:\n\techo unused\n' });
    const result = await inferGenericRepoContract(env, REPO, 'main', 'main');
    expect(result?.runtime).toEqual({ test: 'make test', build: 'make build', setup: 'make setup' });
  });

  it('merges ecosystems Node > Python > Rust > Makefile, each layer only filling keys the earlier ones left unset', async () => {
    // package.json only declares `test` — `build` should come from the
    // Makefile fallback instead of being left unset.
    mockRepoFiles({
      'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      Makefile: 'build:\n\tmake -C native\n',
    });
    const result = await inferGenericRepoContract(env, REPO, 'main', 'main');
    expect(result?.runtime).toEqual({
      setup: 'npm install --no-package-lock',
      test: 'npm test',
      build: 'make build',
    });
  });

  it('infers a push+pull_request Validation Contract from Actions run history, restricting the push strategy to the given default branch', async () => {
    mockRepoFiles({}, ['push', 'pull_request']);
    const result = await inferGenericRepoContract(env, REPO, 'trunk', 'trunk');
    expect(result?.validation).toEqual({
      strategies: [
        { type: 'push', required: true, branches: ['trunk'], checks: [] },
        { type: 'pull_request', required: true, checks: [] },
      ],
    });
  });

  it('infers a pull_request-only Validation Contract when no push-triggered run has ever fired', async () => {
    mockRepoFiles({}, ['pull_request']);
    const result = await inferGenericRepoContract(env, REPO, 'main', 'main');
    expect(result?.validation).toEqual({ strategies: [{ type: 'pull_request', required: true, checks: [] }] });
  });

  it('treats pull_request_target the same as pull_request', async () => {
    mockRepoFiles({}, ['pull_request_target']);
    const result = await inferGenericRepoContract(env, REPO, 'main', 'main');
    expect(result?.validation).toEqual({ strategies: [{ type: 'pull_request', required: true, checks: [] }] });
  });

  it('ignores workflow_dispatch/schedule-only history (neither push nor pull_request evidence)', async () => {
    mockRepoFiles({}, ['workflow_dispatch', 'schedule']);
    const result = await inferGenericRepoContract(env, REPO, 'main', 'main');
    expect(result?.validation).toEqual({ strategies: [{ type: 'workflow_dispatch', required: true, checks: [] }] });
  });

  it('never infers a Validation Contract with zero run history, even with runtime commands present', async () => {
    mockRepoFiles({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) }, []);
    const result = await inferGenericRepoContract(env, REPO, 'main', 'main');
    expect(result?.runtime).toBeDefined();
    expect(result?.validation).toBeUndefined();
  });

  it('degrades gracefully when one file read fails, without losing other signals', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/actions/runs?')) return jsonResponse({ workflow_runs: [] });
      if (url.includes('/contents/package.json')) return jsonResponse({ message: 'Internal Server Error' }, 500);
      if (url.includes('/contents/Cargo.toml')) {
        const content = '[package]\nname = "demo"\n';
        return jsonResponse({ type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64'), sha: 'x', size: content.length });
      }
      return jsonResponse({ message: 'Not Found' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await inferGenericRepoContract(env, REPO, 'main', 'main');
    expect(result?.runtime).toEqual({ test: 'cargo test', build: 'cargo build' });
  });

  it('never throws when the Actions run-history request itself fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/actions/runs?')) return jsonResponse({ message: 'Internal Server Error' }, 500);
      return jsonResponse({ message: 'Not Found' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(inferGenericRepoContract(env, REPO, 'main', 'main')).resolves.toBeUndefined();
  });
});
