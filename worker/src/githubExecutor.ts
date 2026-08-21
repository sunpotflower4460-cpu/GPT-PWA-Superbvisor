export interface GitHubEnv {
  GITHUB_TOKEN?: string;
  GITHUB_ALLOWED_REPOS?: string;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface GitHubWorkspace {
  repository: string;
  defaultBranch: string;
  branch: string;
  baseSha: string;
  createdAt: string;
}

export interface GitHubFileResult {
  path: string;
  sha: string;
  content: string;
  size: number;
}

const API = 'https://api.github.com';
const BRANCH_PREFIX = 'ai-dev-deck/';
const MAX_FILE_BYTES = 250_000;
const BLOCKED_PATHS = [
  /^\.env(?:\.|$)/i,
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:id_rsa|id_ed25519)$/i,
  /(^|\/)secrets?\//i,
  /(^|\/)\.github\/workflows\//i,
  /\.(?:pem|key|p12|pfx)$/i,
  /(^|\/)(?:credentials|service-account)(?:\.[^/]+)?$/i,
];

export function parseRepo(value: string): RepoRef | null {
  const normalized = value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
  const [owner, repo, ...rest] = normalized.split('/');
  if (!owner || !repo || rest.length || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return { owner, repo };
}

export function assertAllowedRepo(env: GitHubEnv, repository: string): RepoRef {
  const repo = parseRepo(repository);
  if (!repo) throw new Error('Invalid GitHub repository');
  const fullName = `${repo.owner}/${repo.repo}`.toLowerCase();
  const allowed = (env.GITHUB_ALLOWED_REPOS || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length || !allowed.includes(fullName)) throw new Error(`Repository is not allowlisted: ${repo.owner}/${repo.repo}`);
  if (!env.GITHUB_TOKEN?.trim()) throw new Error('GITHUB_TOKEN is not configured');
  return repo;
}

export async function createWorkspace(env: GitHubEnv, repository: string, taskLabel: string): Promise<GitHubWorkspace> {
  const repo = assertAllowedRepo(env, repository);
  const repoInfo = await githubJson<{ default_branch: string }>(env, repo, 'GET', '');
  const defaultBranch = repoInfo.default_branch;
  const ref = await githubJson<{ object: { sha: string } }>(env, repo, 'GET', `/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
  const suffix = crypto.randomUUID().slice(0, 8);
  const slug = taskLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'task';
  const branch = `${BRANCH_PREFIX}${slug}-${suffix}`;
  await githubJson(env, repo, 'POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: ref.object.sha });
  return { repository: `${repo.owner}/${repo.repo}`, defaultBranch, branch, baseSha: ref.object.sha, createdAt: new Date().toISOString() };
}

export async function getRepositorySummary(env: GitHubEnv, repository: string, ref?: string) {
  const repo = assertAllowedRepo(env, repository);
  const info = await githubJson<{ default_branch: string; private: boolean; html_url: string }>(env, repo, 'GET', '');
  const branch = ref || info.default_branch;
  const head = await githubJson<{ object: { sha: string } }>(env, repo, 'GET', `/git/ref/heads/${encodeURIComponent(branch)}`);
  return { repository: `${repo.owner}/${repo.repo}`, defaultBranch: info.default_branch, branch, headSha: head.object.sha, private: info.private, url: info.html_url };
}

export async function listTree(env: GitHubEnv, repository: string, ref: string, maxItems = 500) {
  assertSafeBranch(ref);
  const repo = assertAllowedRepo(env, repository);
  const branchRef = await githubJson<{ object: { sha: string } }>(env, repo, 'GET', `/git/ref/heads/${encodeURIComponent(ref)}`);
  const commit = await githubJson<{ tree: { sha: string } }>(env, repo, 'GET', `/git/commits/${branchRef.object.sha}`);
  const tree = await githubJson<{ tree: Array<{ path: string; type: string; size?: number; sha: string }>; truncated: boolean }>(env, repo, 'GET', `/git/trees/${commit.tree.sha}?recursive=1`);
  return {
    truncated: tree.truncated,
    items: tree.tree
      .filter((item) => item.type === 'blob' && isSafePath(item.path))
      .slice(0, Math.max(1, Math.min(maxItems, 1000)))
      .map((item) => ({ path: item.path, size: item.size, sha: item.sha })),
  };
}

export async function readFile(env: GitHubEnv, repository: string, ref: string, path: string): Promise<GitHubFileResult> {
  assertSafeBranch(ref);
  assertSafePath(path);
  const repo = assertAllowedRepo(env, repository);
  const result = await githubJson<{ type: string; sha: string; size: number; content?: string; encoding?: string }>(env, repo, 'GET', `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
  if (result.type !== 'file' || result.encoding !== 'base64' || typeof result.content !== 'string') throw new Error('Path is not a readable text file');
  if (result.size > MAX_FILE_BYTES) throw new Error(`File exceeds ${MAX_FILE_BYTES} bytes`);
  const bytes = decodeBase64(result.content.replace(/\n/g, ''));
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { path, sha: result.sha, size: result.size, content };
}

export async function writeFile(env: GitHubEnv, repository: string, branch: string, path: string, content: string, message: string) {
  assertSafeBranch(branch);
  assertSafePath(path);
  if (new TextEncoder().encode(content).byteLength > MAX_FILE_BYTES) throw new Error(`File exceeds ${MAX_FILE_BYTES} bytes`);
  const repo = assertAllowedRepo(env, repository);
  let currentSha: string | undefined;
  try {
    const current = await githubJson<{ sha: string; type: string }>(env, repo, 'GET', `/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
    if (current.type === 'file') currentSha = current.sha;
  } catch (error) {
    if (!(error instanceof GitHubHttpError) || error.status !== 404) throw error;
  }
  const body: Record<string, unknown> = {
    message: sanitizeCommitMessage(message),
    content: encodeBase64(content),
    branch,
  };
  if (currentSha) body.sha = currentSha;
  const result = await githubJson<{ content?: { sha?: string }; commit: { sha: string; html_url?: string } }>(env, repo, 'PUT', `/contents/${encodePath(path)}`, body);
  return { path, fileSha: result.content?.sha, commitSha: result.commit.sha, commitUrl: result.commit.html_url };
}

export async function deleteFile(env: GitHubEnv, repository: string, branch: string, path: string, message: string) {
  assertSafeBranch(branch);
  assertSafePath(path);
  const repo = assertAllowedRepo(env, repository);
  const current = await githubJson<{ sha: string; type: string }>(env, repo, 'GET', `/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
  if (current.type !== 'file') throw new Error('Only files may be deleted');
  const result = await githubJson<{ commit: { sha: string; html_url?: string } }>(env, repo, 'DELETE', `/contents/${encodePath(path)}`, {
    message: sanitizeCommitMessage(message), sha: current.sha, branch,
  });
  return { path, commitSha: result.commit.sha, commitUrl: result.commit.html_url };
}

export async function compareWorkspace(env: GitHubEnv, workspace: GitHubWorkspace) {
  assertSafeBranch(workspace.branch);
  const repo = assertAllowedRepo(env, workspace.repository);
  return githubJson<{
    status: string;
    ahead_by: number;
    behind_by: number;
    total_commits: number;
    files?: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>;
  }>(env, repo, 'GET', `/compare/${encodeURIComponent(workspace.defaultBranch)}...${encodeURIComponent(workspace.branch)}`);
}

export async function createPullRequest(env: GitHubEnv, workspace: GitHubWorkspace, title: string, body: string) {
  assertSafeBranch(workspace.branch);
  const repo = assertAllowedRepo(env, workspace.repository);
  const result = await githubJson<{ number: number; html_url: string; state: string }>(env, repo, 'POST', '/pulls', {
    title: title.slice(0, 200),
    head: workspace.branch,
    base: workspace.defaultBranch,
    body: body.slice(0, 20_000),
    draft: true,
  });
  return { number: result.number, url: result.html_url, state: result.state, draft: true };
}

export async function getBranchWorkflowRuns(env: GitHubEnv, repository: string, branch: string) {
  assertSafeBranch(branch);
  const repo = assertAllowedRepo(env, repository);
  const result = await githubJson<{ workflow_runs: Array<{ id: number; name: string; status: string; conclusion: string | null; html_url: string; head_sha: string }> }>(env, repo, 'GET', `/actions/runs?branch=${encodeURIComponent(branch)}&per_page=20`);
  return result.workflow_runs.map((run) => ({ id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, url: run.html_url, headSha: run.head_sha }));
}

export function assertSafeBranch(branch: string) {
  if (!branch.startsWith(BRANCH_PREFIX) || branch.includes('..') || branch.includes('~') || branch.includes('^') || branch.includes(':')) {
    throw new Error(`Writes are restricted to ${BRANCH_PREFIX}* branches`);
  }
}

function isSafePath(path: string) {
  const normalized = path.replace(/^\/+/, '');
  return Boolean(normalized) && !normalized.includes('..') && !normalized.includes('\\') && !BLOCKED_PATHS.some((rule) => rule.test(normalized));
}

function assertSafePath(path: string) {
  if (!isSafePath(path)) throw new Error(`Unsafe or blocked path: ${path}`);
}

async function githubJson<T>(env: GitHubEnv, repo: RepoRef, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}/repos/${repo.owner}/${repo.repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'AI-DEV-DECK-Worker',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  if (!response.ok) {
    const message = parsed && typeof parsed === 'object' && 'message' in parsed && typeof (parsed as { message?: unknown }).message === 'string'
      ? String((parsed as { message: string }).message)
      : text || `GitHub request failed (${response.status})`;
    throw new GitHubHttpError(response.status, message);
  }
  return parsed as T;
}

class GitHubHttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function sanitizeCommitMessage(value: string) {
  return (value.trim() || 'chore: AI DEV DECK update').replace(/[\r\n]+/g, ' ').slice(0, 180);
}

function encodePath(path: string) {
  return path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
}

function encodeBase64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function decodeBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
