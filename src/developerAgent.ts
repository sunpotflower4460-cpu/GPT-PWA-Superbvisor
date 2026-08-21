import { DevProject } from './core';
import { WorkerConnection, loadWorkerConnection } from './backgroundWorker';

export interface DeveloperJob {
  id: string;
  projectId?: string;
  projectName?: string;
  repository: string;
  goal: string;
  prompt: string;
  model: string;
  workspace: {
    repository: string;
    defaultBranch: string;
    branch: string;
    baseSha: string;
    createdAt: string;
  };
  status: 'starting' | 'running' | 'completed' | 'failed';
  currentResponseId?: string;
  toolTurns: number;
  maxToolTurns: number;
  createdAt: string;
  updatedAt: string;
  outputText?: string;
  error?: string;
  changedFiles?: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>;
  pullRequest?: { number: number; url: string; draft: true };
}

export async function getDeveloperConfig(connection: WorkerConnection = loadWorkerConnection()) {
  return api<{ configured: boolean; repositories: string[] }>(connection, '/api/github-agent/config', { method: 'GET' });
}

export async function startDeveloperJob(
  project: DevProject,
  prompt: string,
  maxToolTurns = 10,
  connection: WorkerConnection = loadWorkerConnection(),
): Promise<DeveloperJob> {
  if (!project.githubUrl) throw new Error('この案件にはGitHub URLが登録されていません。');
  const result = await api<{ job: DeveloperJob }>(connection, '/api/developer-jobs', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.id,
      projectName: project.name,
      repository: project.githubUrl,
      goal: project.goal,
      prompt,
      maxToolTurns: Math.max(1, Math.min(16, Math.trunc(maxToolTurns))),
    }),
  });
  return result.job;
}

export async function getDeveloperJob(id: string, connection: WorkerConnection = loadWorkerConnection()) {
  const result = await api<{ job: DeveloperJob }>(connection, `/api/developer-jobs/${encodeURIComponent(id)}`, { method: 'GET' });
  return result.job;
}

export async function getLatestDeveloperJob(projectId: string, connection: WorkerConnection = loadWorkerConnection()) {
  const result = await api<{ job: DeveloperJob }>(connection, `/api/developer-projects/${encodeURIComponent(projectId)}/latest`, { method: 'GET' });
  return result.job;
}

async function api<T>(connection: WorkerConnection, path: string, init: RequestInit): Promise<T> {
  if (!connection.baseUrl.trim() || !connection.token.trim()) throw new Error('先にBackground Workerの接続設定を保存してください。');
  const response = await fetch(`${connection.baseUrl.trim().replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.token.trim()}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; detail?: string };
  if (!response.ok) throw new Error(payload.detail || payload.error || `Developer Agent request failed (${response.status})`);
  return payload;
}
