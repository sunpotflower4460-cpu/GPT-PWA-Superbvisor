import { WorkerConnection, loadWorkerConnection } from './backgroundWorker';
import { DevProject } from './core';
import { DeveloperJobPhase } from './developerAgent';

export interface GuardianCiCheck {
  id?: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  headSha: string;
}

export interface GuardianRun {
  id: string;
  projectId?: string;
  projectName?: string;
  repository: string;
  goal: string;
  prompt: string;
  model?: string;
  orchestratorProvider?: string;
  status: 'starting' | 'running' | 'waiting_ci' | 'review_ready' | 'completed' | 'failed' | 'expired';
  phase?: DeveloperJobPhase;
  cycle: number;
  maxCycles: number;
  maxToolTurns: number;
  maxMinutes: number;
  currentDeveloperJobId: string;
  createdAt: string;
  updatedAt: string;
  lastAdvanceAt?: string;
  message?: string;
  error?: string;
  transientErrorCount?: number;
  ciChecks?: GuardianCiCheck[];
  pullRequest?: { number: number; url: string; draft: true };
  finalSummary?: string;
  handoffPrompt?: string;
  recoveryCount?: number;
  degradedOrchestration?: boolean;
  notifiedAt?: string;
}

export async function startGuardianRun(
  project: DevProject,
  prompt: string,
  options: { maxCycles?: number; maxToolTurns?: number; maxMinutes?: number } = {},
  connection: WorkerConnection = loadWorkerConnection(),
): Promise<GuardianRun> {
  if (!project.githubUrl) throw new Error('この案件にはGitHub URLが登録されていません。');
  if (!project.chatUrl) throw new Error('Guardian自動運転には対象ChatGPT URLが必要です。');
  const result = await api<{ run: GuardianRun }>(connection, '/api/guardian-runs', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.id,
      projectName: project.name,
      repository: project.githubUrl,
      goal: project.goal,
      definitionOfDone: project.definitionOfDone,
      prompt,
      maxCycles: clamp(options.maxCycles ?? 3, 1, 4),
      maxToolTurns: clamp(options.maxToolTurns ?? 10, 1, 16),
      maxMinutes: clamp(options.maxMinutes ?? 180, 15, 360),
      maxAutoCiReruns: 2,
      chatUrl: project.chatUrl,
      autoDispatch: true,
    }),
  });
  return result.run;
}

export async function getGuardianRun(
  id: string,
  connection: WorkerConnection = loadWorkerConnection(),
): Promise<GuardianRun> {
  const result = await api<{ run: GuardianRun }>(connection, `/api/guardian-runs/${encodeURIComponent(id)}`, { method: 'GET' });
  return result.run;
}

export async function getLatestGuardianRun(
  projectId: string,
  connection: WorkerConnection = loadWorkerConnection(),
): Promise<GuardianRun> {
  const result = await api<{ run: GuardianRun }>(connection, `/api/guardian-projects/${encodeURIComponent(projectId)}/latest`, { method: 'GET' });
  return result.run;
}

async function api<T>(connection: WorkerConnection, path: string, init: RequestInit): Promise<T> {
  if (!connection.baseUrl.trim() || !connection.token.trim()) throw new Error('先にSupervisor Workerの接続設定を保存してください。');
  const response = await fetch(`${connection.baseUrl.trim().replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.token.trim()}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; detail?: string };
  if (!response.ok) throw new Error(payload.detail || payload.error || `Guardian request failed (${response.status})`);
  return payload;
}

function clamp(value: number, min: number, max: number) {
  const integer = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.max(min, Math.min(max, integer));
}
