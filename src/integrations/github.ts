export interface GitHubRepositoryRef {
  owner: string;
  repo: string;
}

export type GitHubCiState = 'SUCCESS' | 'FAILURE' | 'PENDING' | 'UNKNOWN';

export interface GitHubProjectSnapshot {
  repository: GitHubRepositoryRef;
  defaultBranch?: string;
  latestCommitSha?: string;
  latestCommitAt?: string;
  openPullRequests?: number;
  openIssues?: number;
  ciState?: GitHubCiState;
  rateLimitRemaining?: number;
  fetchedAt: string;
}

export function parseGitHubRepositoryUrl(value: string): GitHubRepositoryRef | null {
  try {
    const url = new URL(value);
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;
    const [owner, repoRaw] = url.pathname.split('/').filter(Boolean);
    if (!owner || !repoRaw) return null;
    return { owner, repo: repoRaw.replace(/\.git$/, '') };
  } catch {
    return null;
  }
}

export function repositoryFullName(ref: GitHubRepositoryRef) {
  return `${ref.owner}/${ref.repo}`;
}

/**
 * Browser credentials are intentionally not supported here.
 * Public repositories can use this read-only provider. Private repositories
 * will use a later backend/connector adapter so tokens never live in the PWA.
 */
export interface GitHubSnapshotProvider {
  fetchSnapshot(repository: GitHubRepositoryRef): Promise<GitHubProjectSnapshot>;
}

function countFromLinkHeader(response: Response, fallback: number) {
  const link = response.headers.get('link');
  const lastPageMatch = link?.match(/[?&]page=(\d+)>; rel="last"/);
  return lastPageMatch ? Number(lastPageMatch[1]) : fallback;
}

function mapWorkflowState(run: { status?: string; conclusion?: string | null } | undefined): GitHubCiState {
  if (!run) return 'UNKNOWN';
  if (run.status !== 'completed') return 'PENDING';
  if (run.conclusion === 'success' || run.conclusion === 'neutral' || run.conclusion === 'skipped') return 'SUCCESS';
  if (run.conclusion) return 'FAILURE';
  return 'UNKNOWN';
}

export class PublicGitHubSnapshotProvider implements GitHubSnapshotProvider {
  async fetchSnapshot(repository: GitHubRepositoryRef): Promise<GitHubProjectSnapshot> {
    const fullName = repositoryFullName(repository);
    const headers = { Accept: 'application/vnd.github+json' };
    const repoResponse = await fetch(`https://api.github.com/repos/${fullName}`, { headers });

    if (!repoResponse.ok) {
      throw new Error(
        repoResponse.status === 404
          ? 'Repository not found or it is private. Private repositories require the secure backend adapter.'
          : `GitHub repository request failed: ${repoResponse.status}`,
      );
    }

    const repoData = await repoResponse.json();
    const branch = repoData.default_branch as string | undefined;
    const rateLimitRemaining = Number(repoResponse.headers.get('x-ratelimit-remaining'));

    if (!branch) {
      return {
        repository,
        rateLimitRemaining: Number.isFinite(rateLimitRemaining) ? rateLimitRemaining : undefined,
        fetchedAt: new Date().toISOString(),
      };
    }

    const [pullsResponse, commitResponse, runsResponse] = await Promise.all([
      fetch(`https://api.github.com/repos/${fullName}/pulls?state=open&per_page=1`, { headers }),
      fetch(`https://api.github.com/repos/${fullName}/commits/${encodeURIComponent(branch)}`, { headers }),
      fetch(`https://api.github.com/repos/${fullName}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=10`, { headers }),
    ]);

    const pulls = pullsResponse.ok ? await pullsResponse.json() : [];
    const commit = commitResponse.ok ? await commitResponse.json() : undefined;
    const runsData = runsResponse.ok ? await runsResponse.json() : undefined;

    const pullCount = Array.isArray(pulls) ? countFromLinkHeader(pullsResponse, pulls.length) : undefined;
    const repoOpenCount = typeof repoData.open_issues_count === 'number' ? repoData.open_issues_count : undefined;
    const issueCount = repoOpenCount !== undefined && pullCount !== undefined
      ? Math.max(0, repoOpenCount - pullCount)
      : undefined;
    const latestCommitSha = typeof commit?.sha === 'string' ? commit.sha : undefined;
    const workflowRuns = Array.isArray(runsData?.workflow_runs) ? runsData.workflow_runs : [];
    const matchingRun = latestCommitSha
      ? workflowRuns.find((run: { head_sha?: string }) => run.head_sha === latestCommitSha)
      : undefined;

    return {
      repository,
      defaultBranch: branch,
      latestCommitSha,
      latestCommitAt: commit?.commit?.committer?.date ?? repoData.pushed_at,
      openPullRequests: pullCount,
      openIssues: issueCount,
      ciState: mapWorkflowState(matchingRun),
      rateLimitRemaining: Number.isFinite(rateLimitRemaining) ? rateLimitRemaining : undefined,
      fetchedAt: new Date().toISOString(),
    };
  }
}
