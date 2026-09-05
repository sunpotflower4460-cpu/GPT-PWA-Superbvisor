import { DevProject } from './core';
import { WorkerConnection, loadWorkerConnection } from './backgroundWorker';
import { RouteNode } from './operatingPlan';

export type DeveloperJobPhase = 'handoff_ready' | 'waiting_chatgpt' | 'waiting_ci' | 'recovery_ready' | 'human_required' | 'review_ready';

export interface AutopilotRouteCheckpoint {
  headSha: string;
  reachedAt: string;
  step?: string;
}

export interface AutopilotRouteState {
  checkpoints: AutopilotRouteCheckpoint[];
  completedAt?: string;
}

// Mirrors the Worker's own PullRequestRef (worker/src/githubExecutor.ts) —
// shared here so DeveloperJob and GuardianRun (guardianRunner.ts) don't
// each redeclare it with a stale literal `draft: true`, the exact drift
// that let GuardianRun's own copy slip out of date across the auto-merge
// feature (PR #56) without anyone noticing until this file was touched
// again.
export interface PullRequestRef {
  number: number;
  url: string;
  state: string;
  draft: boolean;
  merged?: boolean;
  mergedAt?: string;
  mergeMethod?: string;
  autoMergeSkippedReason?: string;
}

// Single shared label for the three PWA call sites that render a job's/
// run's PullRequestRef (DeveloperAgentCenter.tsx x2, OperatingPlanCenter.tsx)
// — before this, all three independently said "Draft PR" unconditionally,
// which became inaccurate the moment a PR could be auto-merged or
// undrafted-but-not-merged (see autoMergePolicy.ts's attemptAutoMerge).
export function pullRequestStatusLabel(pr: PullRequestRef): { label: string; note?: string } {
  if (pr.merged) return { label: `マージ済み PR #${pr.number} を開く ↗` };
  if (pr.autoMergeSkippedReason) {
    return {
      label: `${pr.draft ? 'Draft ' : ''}PR #${pr.number} を開く ↗`,
      note: `自動マージ対象外: ${pr.autoMergeSkippedReason}`,
    };
  }
  return { label: `${pr.draft ? 'Draft ' : ''}PR #${pr.number} を開く ↗` };
}

// A shorter "Draft PR #N" / "マージ済み PR #N" fragment for call sites that
// compose it into their own sentence (NotificationCenter.tsx,
// RuntimeProjectSync.tsx) rather than rendering a standalone button —
// same underlying staleness this file's own pullRequestStatusLabel exists
// to fix, just without a note (these are compact one-liners, no room for
// a secondary explanation).
export function pullRequestPhrase(pr: PullRequestRef): string {
  if (pr.merged) return `マージ済み PR #${pr.number}`;
  return `${pr.draft ? 'Draft ' : ''}PR #${pr.number}`;
}

export interface DeveloperJob {
  id: string;
  projectId?: string;
  projectName?: string;
  repository: string;
  goal: string;
  prompt: string;
  definitionOfDone?: string[];
  model: string;
  orchestratorProvider?: string;
  workspace: {
    repository: string;
    defaultBranch: string;
    branch: string;
    baseSha: string;
    createdAt: string;
  };
  status: 'starting' | 'running' | 'completed' | 'failed';
  phase?: DeveloperJobPhase;
  toolTurns: number;
  maxToolTurns: number;
  createdAt: string;
  updatedAt: string;
  outputText?: string;
  handoffPrompt?: string;
  error?: string;
  degradedOrchestration?: boolean;
  orchestratorRateLimited?: boolean;
  autopilotRoute?: AutopilotRouteState;
  routePlan?: RouteNode[];
  recoveryCount?: number;
  ciAutoReruns?: number;
  maxAutoCiReruns?: number;
  ciChecks?: Array<{ id: number; name: string; status: string; conclusion: string | null; url: string; headSha: string }>;
  changedFiles?: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>;
  pullRequest?: PullRequestRef;
  chatUrl?: string;
  autoDispatch?: boolean;
  autoMerge?: boolean;
  lastQueuedCommandId?: string;
  lastDispatchError?: string;
}

export interface DeveloperConfig {
  configured: boolean;
  repositories: string[];
  executor?: 'chatgpt';
  orchestrationOnly?: boolean;
  atomicCoordinator?: boolean;
  primaryProvider?: string;
  availableProviders?: string[];
  deterministicFallback?: boolean;
}

export async function getDeveloperConfig(connection: WorkerConnection = loadWorkerConnection()) {
  return api<DeveloperConfig>(connection, '/api/github-agent/config', { method: 'GET' });
}

export async function startDeveloperJob(
  project: DevProject,
  prompt: string,
  maxToolTurns = 10,
  connection: WorkerConnection = loadWorkerConnection(),
  routePlan?: RouteNode[],
): Promise<DeveloperJob> {
  if (!project.githubUrl) throw new Error('この案件にはGitHub URLが登録されていません。');
  const result = await api<{ job: DeveloperJob }>(connection, '/api/developer-jobs', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.id,
      projectName: project.name,
      repository: project.githubUrl,
      goal: project.goal,
      definitionOfDone: project.definitionOfDone,
      prompt,
      maxToolTurns: Math.max(1, Math.min(16, Math.trunc(maxToolTurns))),
      maxAutoCiReruns: 2,
      chatUrl: project.chatUrl,
      autoDispatch: project.automationLevel === 'AUTO' || project.automationLevel === 'GUARDIAN',
      autoMerge: Boolean(project.autoMerge),
      routePlan,
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
  if (!response.ok) throw new Error(payload.detail || payload.error || `ChatGPT Orchestrator request failed (${response.status})`);
  return payload;
}
