import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWorkflowRunJobs, listRecentWorkflowEvents, markPullRequestReadyForReview, mergePullRequest, type GitHubEnv, type GitHubWorkspace } from './githubExecutor';

const env: GitHubEnv = {
  GITHUB_TOKEN: 'test-token',
  GITHUB_ALLOWED_REPOS: 'sunpotflower4460-cpu/GPT-template',
};

const workspace: GitHubWorkspace = {
  repository: 'sunpotflower4460-cpu/GPT-template',
  defaultBranch: 'main',
  branch: 'ai-dev-deck/task-abcd1234',
  baseSha: 'base123',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getWorkflowRunJobs', () => {
  it('calls the Actions API (not the Checks API) and maps job-level fields', async () => {
    // This is the whole point of using this endpoint over
    // /commits/{sha}/check-runs: it only needs the "Actions: Read"
    // fine-grained PAT permission this Worker already documents as its
    // minimum, not the separate "Checks: Read" permission the Checks API
    // requires on a private repository.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toBe('https://api.github.com/repos/sunpotflower4460-cpu/GPT-template/actions/runs/32954188422/jobs?per_page=100&page=1');
      return jsonResponse({
        total_count: 1,
        jobs: [
          {
            id: 98132113307,
            run_id: 32954188422,
            name: 'guard',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.com/sunpotflower4460-cpu/GPT-template/actions/runs/32954188422/job/98132113307',
            head_sha: 'deee28cac488e997bb9264d9c5ca5b082cf18a1f',
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const jobs = await getWorkflowRunJobs(env, 'sunpotflower4460-cpu/GPT-template', 32954188422);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jobs).toEqual([
      {
        id: 98132113307,
        name: 'guard',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/sunpotflower4460-cpu/GPT-template/actions/runs/32954188422/job/98132113307',
        headSha: 'deee28cac488e997bb9264d9c5ca5b082cf18a1f',
      },
    ]);
  });

  it('resolves the actual require-human-approval -> check-approval hierarchy from a real-shaped response', async () => {
    // The exact case this whole fix exists for: the workflow is named
    // "require-human-approval", but the job inside it — what a Project
    // Kernel's checks[].name actually declares — is "check-approval".
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      jobs: [
        {
          id: 1,
          run_id: 99,
          name: 'check-approval',
          status: 'completed',
          conclusion: 'failure',
          html_url: 'https://github.com/sunpotflower4460-cpu/GPT-template/actions/runs/99/job/1',
          head_sha: 'abc123',
        },
      ],
    })));

    const jobs = await getWorkflowRunJobs(env, 'sunpotflower4460-cpu/GPT-template', 99);
    expect(jobs.map((job) => job.name)).toEqual(['check-approval']);
    expect(jobs[0].conclusion).toBe('failure');
  });

  it('propagates a 403 (e.g. a genuinely missing Actions permission) rather than silently returning no jobs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'Resource not accessible by integration' }, 403)));
    await expect(getWorkflowRunJobs(env, 'sunpotflower4460-cpu/GPT-template', 1)).rejects.toThrow();
  });

  it('rejects a repository that is not allowlisted before making any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(getWorkflowRunJobs(env, 'someone-else/other-repo', 1)).rejects.toThrow('not allowlisted');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('paginates past the first 100 jobs so a declared-category job in a large matrix is not silently invisible', async () => {
    const page1Jobs = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      run_id: 1,
      name: `matrix-${index + 1}`,
      status: 'completed',
      conclusion: 'success',
      html_url: `https://example.com/job/${index + 1}`,
      head_sha: 'abc123',
    }));
    const page2Jobs = [
      { id: 101, run_id: 1, name: 'lint', status: 'completed', conclusion: 'failure', html_url: 'https://example.com/job/101', head_sha: 'abc123' },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('page=1')) return jsonResponse({ total_count: 101, jobs: page1Jobs });
      if (url.endsWith('page=2')) return jsonResponse({ total_count: 101, jobs: page2Jobs });
      throw new Error(`unexpected page request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const jobs = await getWorkflowRunJobs(env, 'sunpotflower4460-cpu/GPT-template', 1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(jobs).toHaveLength(101);
    expect(jobs[100]).toEqual({ id: 101, name: 'lint', status: 'completed', conclusion: 'failure', url: 'https://example.com/job/101', headSha: 'abc123' });
  });

  it('stops after a single request when the first page is not full, without probing for a second page', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      total_count: 1,
      jobs: [{ id: 1, run_id: 1, name: 'guard', status: 'completed', conclusion: 'success', html_url: 'https://example.com/job/1', head_sha: 'abc123' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await getWorkflowRunJobs(env, 'sunpotflower4460-cpu/GPT-template', 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('listRecentWorkflowEvents', () => {
  it('calls the repo-wide Actions run-history API (not scoped to a branch) and returns distinct event types', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toBe('https://api.github.com/repos/sunpotflower4460-cpu/GPT-template/actions/runs?per_page=50');
      return jsonResponse({
        workflow_runs: [
          { event: 'push' },
          { event: 'pull_request' },
          { event: 'push' },
          { event: 'schedule' },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = await listRecentWorkflowEvents(env, 'sunpotflower4460-cpu/GPT-template');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual(new Set(['push', 'pull_request', 'schedule']));
  });

  it('returns an empty set for a repository with no workflow run history yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ workflow_runs: [] })));
    const events = await listRecentWorkflowEvents(env, 'sunpotflower4460-cpu/GPT-template');
    expect(events).toEqual(new Set());
  });

  it('clamps an out-of-range perPage into the API-accepted 1-100 window', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://api.github.com/repos/sunpotflower4460-cpu/GPT-template/actions/runs?per_page=100');
      return jsonResponse({ workflow_runs: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    await listRecentWorkflowEvents(env, 'sunpotflower4460-cpu/GPT-template', 500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a repository that is not allowlisted before making any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(listRecentWorkflowEvents(env, 'someone-else/other-repo')).rejects.toThrow('not allowlisted');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('markPullRequestReadyForReview', () => {
  it('PATCHes the pull request with draft:false', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.github.com/repos/sunpotflower4460-cpu/GPT-template/pulls/42');
      expect(init?.method).toBe('PATCH');
      expect(JSON.parse(String(init?.body))).toEqual({ draft: false });
      return jsonResponse({ number: 42, draft: false });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await markPullRequestReadyForReview(env, workspace, 42);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ number: 42, draft: false });
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'Not Found' }, 404)));
    await expect(markPullRequestReadyForReview(env, workspace, 42)).rejects.toThrow('Not Found');
  });
});

describe('mergePullRequest', () => {
  it('PUTs the merge request with the given merge_method', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.github.com/repos/sunpotflower4460-cpu/GPT-template/pulls/42/merge');
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(String(init?.body))).toEqual({ merge_method: 'squash' });
      return jsonResponse({ merged: true, sha: 'deadbeef' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await mergePullRequest(env, workspace, 42, 'squash');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ merged: true, sha: 'deadbeef' });
  });

  it('throws on a non-2xx response (e.g. a merge conflict or a still-pending required check)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'Pull Request is not mergeable' }, 405)));
    await expect(mergePullRequest(env, workspace, 42, 'squash')).rejects.toThrow('Pull Request is not mergeable');
  });
});
