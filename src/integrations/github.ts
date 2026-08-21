export interface GitHubRepositoryRef {
  owner: string;
  repo: string;
}

export interface GitHubProjectSnapshot {
  repository: GitHubRepositoryRef;
  defaultBranch?: string;
  latestCommitSha?: string;
  latestCommitAt?: string;
  openPullRequests?: number;
  openIssues?: number;
  ciState?: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'UNKNOWN';
  fetchedAt: string;
}

export function parseGitHubRepositoryUrl(value: string): GitHubRepositoryRef | null {
  try {
    const url = new URL(value);
    if (url.hostname !== 'github.com') return null;
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
 * v0.1 intentionally does not put GitHub credentials in the browser.
 * A later server/connector adapter will implement this interface for private repositories.
 */
export interface GitHubSnapshotProvider {
  fetchSnapshot(repository: GitHubRepositoryRef): Promise<GitHubProjectSnapshot>;
}

export class PublicGitHubSnapshotProvider implements GitHubSnapshotProvider {
  async fetchSnapshot(repository: GitHubRepositoryRef): Promise<GitHubProjectSnapshot> {
    const fullName = repositoryFullName(repository);
    const headers = { Accept: 'application/vnd.github+json' };

    const [repoResponse, pullsResponse, issuesResponse] = await Promise.all([
      fetch(`https://api.github.com/repos/${fullName}`, { headers }),
      fetch(`https://api.github.com/repos/${fullName}/pulls?state=open&per_page=1`, { headers }),
      fetch(`https://api.github.com/repos/${fullName}/issues?state=open&per_page=100`, { headers }),
    ]);

    if (!repoResponse.ok) {
      throw new Error(`GitHub repository request failed: ${repoResponse.status}`);
    }

    const repoData = await repoResponse.json();
    const pulls = pullsResponse.ok ? await pullsResponse.json() : [];
    const issues = issuesResponse.ok ? await issuesResponse.json() : [];

    const openIssueCount = Array.isArray(issues)
      ? issues.filter((item: { pull_request?: unknown }) => !item.pull_request).length
      : undefined;

    const link = pullsResponse.headers.get('link');
    const lastPageMatch = link?.match(/[?&]page=(\d+)>; rel="last"/);
    const pullCount = Array.isArray(pulls)
      ? lastPageMatch
        ? Number(lastPageMatch[1])
        : pulls.length
      : undefined;

    return {
      repository,
      defaultBranch: repoData.default_branch,
      latestCommitAt: repoData.pushed_at,
      openPullRequests: pullCount,
      openIssues: openIssueCount,
      ciState: 'UNKNOWN',
      fetchedAt: new Date().toISOString(),
    };
  }
}
