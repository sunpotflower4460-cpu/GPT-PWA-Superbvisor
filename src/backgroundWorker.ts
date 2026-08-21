import { DevProject } from './core';

export type BackgroundJobStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'incomplete' | 'cancelled';

export interface BackgroundCheckpoint {
  at: string;
  status: BackgroundJobStatus;
  summary: string;
}

export interface BackgroundJob {
  id: string;
  projectId: string;
  projectName?: string;
  goal: string;
  currentPhase?: string;
  definitionOfDone: string[];
  model: string;
  status: BackgroundJobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  outputText?: string;
  error?: string;
  checkpoint?: BackgroundCheckpoint;
}

export interface WorkerConnection {
  baseUrl: string;
  token: string;
}

const SETTINGS_KEY = 'gpt-pwa-supervisor.worker-connection.v1';
const JOB_IDS_KEY = 'gpt-pwa-supervisor.background-jobs.v1';

export function loadWorkerConnection(): WorkerConnection {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { baseUrl: '', token: '' };
    const parsed = JSON.parse(raw) as Partial<WorkerConnection>;
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      token: typeof parsed.token === 'string' ? parsed.token : '',
    };
  } catch {
    return { baseUrl: '', token: '' };
  }
}

export function saveWorkerConnection(connection: WorkerConnection) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    baseUrl: connection.baseUrl.trim().replace(/\/$/, ''),
    token: connection.token.trim(),
  }));
}

export function loadBackgroundJobIds(): Record<string, string> {
  try {
    const raw = localStorage.getItem(JOB_IDS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function rememberBackgroundJob(projectId: string, jobId: string) {
  const jobs = loadBackgroundJobIds();
  jobs[projectId] = jobId;
  localStorage.setItem(JOB_IDS_KEY, JSON.stringify(jobs));
}

export async function checkWorkerHealth(connection: WorkerConnection) {
  const response = await fetch(`${normalizeBaseUrl(connection.baseUrl)}/health`);
  if (!response.ok) throw new Error(`Worker health check failed (${response.status})`);
  return response.json() as Promise<{ ok: boolean; service: string }>;
}

export async function startBackgroundJob(
  project: DevProject,
  prompt: string,
  connection: WorkerConnection = loadWorkerConnection(),
): Promise<BackgroundJob> {
  validateConnection(connection);
  const response = await workerFetch<{ job: BackgroundJob }>(connection, '/api/jobs', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.id,
      projectName: project.name,
      goal: project.goal,
      currentPhase: project.currentPhase,
      definitionOfDone: project.definitionOfDone,
      prompt,
    }),
  });
  rememberBackgroundJob(project.id, response.job.id);
  return response.job;
}

export async function getBackgroundJob(
  jobId: string,
  connection: WorkerConnection = loadWorkerConnection(),
): Promise<BackgroundJob> {
  validateConnection(connection);
  const response = await workerFetch<{ job: BackgroundJob }>(
    connection,
    `/api/jobs/${encodeURIComponent(jobId)}`,
    { method: 'GET' },
  );
  return response.job;
}

export async function getLatestBackgroundJob(
  projectId: string,
  connection: WorkerConnection = loadWorkerConnection(),
): Promise<BackgroundJob> {
  validateConnection(connection);
  const response = await workerFetch<{ job: BackgroundJob }>(
    connection,
    `/api/projects/${encodeURIComponent(projectId)}/latest`,
    { method: 'GET' },
  );
  rememberBackgroundJob(projectId, response.job.id);
  return response.job;
}

async function workerFetch<T>(connection: WorkerConnection, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${normalizeBaseUrl(connection.baseUrl)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({})) as { error?: string; detail?: string } & T;
  if (!response.ok) {
    throw new Error(payload.detail || payload.error || `Worker request failed (${response.status})`);
  }
  return payload;
}

function validateConnection(connection: WorkerConnection) {
  if (!connection.baseUrl.trim()) throw new Error('Background Worker URLが未設定です。');
  if (!connection.token.trim()) throw new Error('Background Worker接続トークンが未設定です。');
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/$/, '');
}
