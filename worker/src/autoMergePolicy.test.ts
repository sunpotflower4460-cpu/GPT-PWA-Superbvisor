import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompletionCertificate } from './completionJudge';
import { GitHubWorkspace } from './githubExecutor';
import { attemptAutoMerge, shouldAutoMerge } from './autoMergePolicy';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function baseCertificate(overrides: Partial<CompletionCertificate> = {}): CompletionCertificate {
  return {
    goal: 'PASS',
    ci: 'PASS',
    guard: 'PASS',
    semanticReview: 'PASS',
    blockingIssues: 0,
    knownLimitations: [],
    state: 'CERTIFIED',
    ...overrides,
  };
}

const workspace: GitHubWorkspace = {
  repository: 'sunpotflower4460-cpu/GPT-template',
  defaultBranch: 'main',
  branch: 'ai-dev-deck/task-abcd1234',
  baseSha: 'base123',
  createdAt: '2026-01-01T00:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shouldAutoMerge', () => {
  it('blocks a job that has not reached CERTIFIED', () => {
    const result = shouldAutoMerge({
      certificate: baseCertificate({ state: 'COMPLETION_CANDIDATE' }),
      changedFiles: [],
      autoMergeEnabled: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/CERTIFIED/);
  });

  it('blocks a CERTIFIED job when the project has not opted in', () => {
    const result = shouldAutoMerge({
      certificate: baseCertificate(),
      changedFiles: [{ filename: 'src/foo.ts' }],
      autoMergeEnabled: false,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/オプトイン/);
  });

  it('allows a CERTIFIED, opted-in job with a clean diff', () => {
    const result = shouldAutoMerge({
      certificate: baseCertificate(),
      changedFiles: [{ filename: 'src/foo.ts' }, { filename: 'README.md' }],
      autoMergeEnabled: true,
    });
    expect(result).toEqual({ allowed: true });
  });

  it('blocks a diff touching .github/workflows/, naming the matched path', () => {
    const result = shouldAutoMerge({
      certificate: baseCertificate(),
      changedFiles: [{ filename: 'src/foo.ts' }, { filename: '.github/workflows/ci.yml' }],
      autoMergeEnabled: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.github/workflows/ci.yml');
  });

  it('blocks a diff touching project-kernel.json even though the Worker never writes it directly', () => {
    const result = shouldAutoMerge({
      certificate: baseCertificate(),
      changedFiles: [{ filename: 'project-kernel.json' }],
      autoMergeEnabled: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('project-kernel.json');
  });

  it('blocks a diff touching CODEOWNERS', () => {
    const result = shouldAutoMerge({
      certificate: baseCertificate(),
      changedFiles: [{ filename: 'CODEOWNERS' }],
      autoMergeEnabled: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('CODEOWNERS');
  });

  it('is case-insensitive on guarded paths', () => {
    const result = shouldAutoMerge({
      certificate: baseCertificate(),
      changedFiles: [{ filename: 'Codeowners' }],
      autoMergeEnabled: true,
    });
    expect(result.allowed).toBe(false);
  });
});

describe('attemptAutoMerge', () => {
  it('undrafts then merges, in order, and reports success', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(input)}`);
      if (init?.method === 'PATCH') return jsonResponse({ number: 7, draft: false });
      return jsonResponse({ merged: true, sha: 'abc123' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await attemptAutoMerge(
      { GITHUB_TOKEN: 'test-token', GITHUB_ALLOWED_REPOS: workspace.repository },
      workspace,
      7,
      'squash',
    );

    expect(calls).toEqual([
      `PATCH https://api.github.com/repos/${workspace.repository}/pulls/7`,
      `PUT https://api.github.com/repos/${workspace.repository}/pulls/7/merge`,
    ]);
    expect(outcome.merged).toBe(true);
    if (outcome.merged) expect(outcome.mergeMethod).toBe('squash');
  });

  it('reports a soft failure with readyForReview:true when undraft succeeds but merge fails (conflict/pending check)', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') return jsonResponse({ number: 7, draft: false });
      return jsonResponse({ message: 'Pull Request is not mergeable' }, 405);
    });
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await attemptAutoMerge(
      { GITHUB_TOKEN: 'test-token', GITHUB_ALLOWED_REPOS: workspace.repository },
      workspace,
      7,
      'squash',
    );

    expect(outcome.merged).toBe(false);
    if (!outcome.merged) {
      expect(outcome.readyForReview).toBe(true);
      expect(outcome.reason).toMatch(/not mergeable/);
    }
  });

  it('reports a soft failure with readyForReview:false and never attempts merge when undraft itself fails', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'Server Error' }, 500));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await attemptAutoMerge(
      { GITHUB_TOKEN: 'test-token', GITHUB_ALLOWED_REPOS: workspace.repository },
      workspace,
      7,
      'squash',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome.merged).toBe(false);
    if (!outcome.merged) expect(outcome.readyForReview).toBe(false);
  });
});
