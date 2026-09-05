import {
  CreateDeveloperJobBody,
  DeveloperJob,
  createManagedDeveloperJob,
  getDeveloperJob,
  refreshDeveloperJob,
} from './developerAgent';
import { CompletionCertificate, describeCompletionOutcome } from './completionJudge';
import { ChatBridgeEnv, getChatBridgeStatus } from './chatBridge';
import { GitHubEnv, PullRequestRef } from './githubExecutor';
import { OrchestrationEnv } from './orchestrationModel';
import { AutopilotRouteState } from './orchestratorPolicy';
import { RouteNode } from './routePlan';
import {
  acquireCoordinatorLease,
  hasAtomicCoordinator,
  releaseCoordinatorLease,
  renewCoordinatorLease,
} from './projectCoordinator';
import { PushEnv, sendSupervisorPush } from './push';

export interface GuardianEnv extends GitHubEnv, PushEnv, OrchestrationEnv, ChatBridgeEnv {
  SUPERVISOR_STATE: KVNamespace;
  PROJECT_COORDINATOR?: DurableObjectNamespace;
}

export interface CreateGuardianRunBody extends CreateDeveloperJobBody {
  maxCycles?: number;
  maxMinutes?: number;
}

export type GuardianRunStatus = 'starting' | 'running' | 'waiting_ci' | 'review_ready' | 'completed' | 'failed' | 'expired';

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
  status: GuardianRunStatus;
  phase?: DeveloperJob['phase'];
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
  pullRequest?: PullRequestRef;
  finalSummary?: string;
  handoffPrompt?: string;
  recoveryCount?: number;
  degradedOrchestration?: boolean;
  orchestratorRateLimited?: boolean;
  autopilotRoute?: AutopilotRouteState;
  routePlan?: RouteNode[];
  notifiedAt?: string;
  // Mirrors DeveloperJob.completionCertificate (see developerAgent.ts's own
  // comment) — copied over on the same refresh that observes
  // job.status === 'completed', so a Guardian-run consumer sees the same
  // Semantic Judge verdict a plain Developer job would.
  completionCertificate?: CompletionCertificate;
  // Bridge-staleness tracking for phases that mean "waiting on the human's
  // ChatGPT tab" (waiting_chatgpt / handoff_ready) — see
  // checkBridgeStaleness. Both cleared whenever the run leaves those phases
  // or the Bridge is observed connected again, so a later stall gets a
  // fresh clock and a fresh notification rather than being permanently
  // debounced by an earlier, unrelated disconnection.
  bridgeDisconnectedSinceAt?: string;
  bridgeStallNotifiedAt?: string;
}

const RUN_TTL = 60 * 60 * 24 * 14;
const MAX_CYCLES = 4;
const MAX_MINUTES = 360;
const PROCESSING_GRACE_MS = 60_000;
const GUARDIAN_ADVANCE_LEASE_MS = 5 * 60_000;
const GUARDIAN_ADVANCE_LEASE_NAME = 'guardian-advance';

export async function createGuardianRun(env: GuardianEnv, body: CreateGuardianRunBody): Promise<GuardianRun> {
  if (!body.repository?.trim() || !body.goal?.trim() || !body.prompt?.trim()) throw new Error('repository, goal and prompt are required');
  const id = crypto.randomUUID();
  const maxCycles = clamp(body.maxCycles ?? 3, 1, MAX_CYCLES);
  const maxMinutes = clamp(body.maxMinutes ?? 180, 15, MAX_MINUTES);
  const maxToolTurns = clamp(body.maxToolTurns ?? 10, 1, 16);
  const now = new Date().toISOString();

  const developer = await createManagedDeveloperJob(env, { ...body, maxToolTurns }, id);
  const run: GuardianRun = {
    id,
    projectId: body.projectId,
    projectName: body.projectName,
    repository: developer.repository,
    goal: body.goal,
    prompt: body.prompt,
    model: developer.model,
    orchestratorProvider: developer.orchestratorProvider,
    status: 'running',
    phase: developer.phase,
    cycle: 1,
    maxCycles,
    maxToolTurns,
    maxMinutes,
    currentDeveloperJobId: developer.id,
    createdAt: now,
    updatedAt: now,
    message: 'ChatGPT用の作業branchと引き継ぎ指示を準備しました。Workerは実装せず、CIと復旧状態を監視します。',
    handoffPrompt: developer.handoffPrompt,
    finalSummary: developer.outputText,
    recoveryCount: developer.recoveryCount,
    degradedOrchestration: developer.degradedOrchestration,
    orchestratorRateLimited: developer.orchestratorRateLimited,
    autopilotRoute: developer.autopilotRoute,
    routePlan: developer.routePlan,
  };
  await saveRun(env, run);
  await mapDeveloperJob(env, developer.id, run.id);
  return run;
}

export async function getGuardianRun(env: GuardianEnv, id: string): Promise<GuardianRun | null> {
  return readRun(env, id);
}

export async function getLatestGuardianRun(env: GuardianEnv, projectId: string): Promise<GuardianRun | null> {
  const id = await env.SUPERVISOR_STATE.get(`guardian-project:${projectId}:latest`);
  return id ? readRun(env, id) : null;
}

export async function getGuardianRunIdForDeveloperJob(env: GuardianEnv, developerJobId: string) {
  return env.SUPERVISOR_STATE.get(`guardian-developer:${developerJobId}`);
}

export async function advanceGuardianRun(
  env: GuardianEnv,
  id: string,
  options: { force?: boolean } = {},
): Promise<GuardianRun> {
  const existing = await readRun(env, id);
  if (!existing) throw new Error('Guardian run not found');
  if (isFinal(existing.status)) return existing;

  if (!hasAtomicCoordinator(env)) return advanceGuardianRunUnlocked(env, id, options);

  const scope = `guardian:${id}`;
  const owner = `${options.force ? 'manual' : 'sweep'}:${crypto.randomUUID()}`;
  const acquired = await acquireCoordinatorLease(env, scope, {
    name: GUARDIAN_ADVANCE_LEASE_NAME,
    owner,
    ttlMs: GUARDIAN_ADVANCE_LEASE_MS,
  });
  if (acquired.status === 409 || acquired.data.acquired === false) {
    return await readRun(env, id) ?? existing;
  }
  const token = acquired.data.lease?.token;
  if (!acquired.ok || !token) throw new Error(acquired.data.error || `guardian_advance_lease_failed_${acquired.status}`);

  try {
    return await advanceGuardianRunUnlocked(env, id, options, { scope, token });
  } finally {
    try {
      await releaseCoordinatorLease(env, scope, { name: GUARDIAN_ADVANCE_LEASE_NAME, token });
    } catch {
      // Lease expiry provides crash recovery; release is best-effort.
    }
  }
}

async function advanceGuardianRunUnlocked(
  env: GuardianEnv,
  id: string,
  options: { force?: boolean },
  lease?: { scope: string; token: string },
): Promise<GuardianRun> {
  let run = await readRun(env, id);
  if (!run) throw new Error('Guardian run not found');
  if (isFinal(run.status)) return run;

  const nowMs = Date.now();
  if (nowMs - new Date(run.createdAt).getTime() > run.maxMinutes * 60_000) {
    return finalize(env, run, 'expired', `Guardianの監視時間上限 (${run.maxMinutes}分) に達しました。状態は保存済みです。ChatGPTで続きを再開できます。`);
  }
  if (!options.force && run.lastAdvanceAt && nowMs - new Date(run.lastAdvanceAt).getTime() < PROCESSING_GRACE_MS) return run;

  run = { ...run, lastAdvanceAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString() };
  await saveRun(env, run);

  let job = await getDeveloperJob(env, run.currentDeveloperJobId);
  if (!job) return recordRecoverableError(env, run, 'Developer orchestration job was temporarily unavailable. Guardian will retry on the next sweep.');

  if (lease) {
    const renewed = await renewCoordinatorLease(env, lease.scope, {
      name: GUARDIAN_ADVANCE_LEASE_NAME,
      token: lease.token,
      ttlMs: GUARDIAN_ADVANCE_LEASE_MS,
    });
    if (!renewed.ok || !renewed.data.renewed) throw new Error(renewed.data.error || 'guardian_advance_lease_lost');
  }

  try {
    job = await refreshDeveloperJob(env, job.id) ?? job;
  } catch (error) {
    return recordRecoverableError(env, run, error instanceof Error ? error.message : 'Developer refresh failed');
  }

  const recoveryCount = job.recoveryCount ?? 0;
  const cycle = Math.min(run.maxCycles, Math.max(1, recoveryCount + 1));
  const overNominalRecoveryBudget = recoveryCount >= run.maxCycles;
  run = {
    ...run,
    model: job.model,
    orchestratorProvider: job.orchestratorProvider,
    phase: job.phase,
    cycle,
    recoveryCount,
    ciChecks: job.ciChecks,
    pullRequest: job.pullRequest,
    finalSummary: job.outputText,
    handoffPrompt: job.handoffPrompt,
    degradedOrchestration: job.degradedOrchestration,
    orchestratorRateLimited: job.orchestratorRateLimited,
    autopilotRoute: job.autopilotRoute,
    routePlan: job.routePlan,
    completionCertificate: job.completionCertificate,
    transientErrorCount: 0,
    error: job.error,
    updatedAt: new Date().toISOString(),
  };

  if (job.status === 'completed') {
    // Must reflect the Semantic Judge's verdict here, not a hardcoded
    // success line: this finalize() call sends Guardian's OWN push
    // (tag `guardian-${run.id}`, separate from developerAgent.ts's own
    // `developer-${job.id}` push for the same completion). A job.status
    // === 'completed' with completionCertificate.state === 'REJECTED'
    // still means real evidence contradicts completion — reporting plain
    // "CI success, all done" here would directly contradict the correct
    // push refreshDeveloperJob already sent moments earlier, for every
    // Guardian user (this app's primary/heavily-used path).
    const message = describeCompletionOutcome(
      job.completionCertificate,
      '現在headのCI成功を確認しました。実装はChatGPT、Workerは監督のみで完了しています。',
    );
    return finalize(env, run, 'completed', message);
  }

  if (job.phase === 'human_required') {
    return finalize(env, run, 'review_ready', '権限・承認など人間操作が必要な状態です。復旧用ChatGPT指示と証拠を保存して監督を安全停止しました。');
  }

  if (job.phase === 'waiting_ci') {
    run = clearBridgeStallTracking({ ...run, status: 'waiting_ci', message: '現在headのGitHub Actionsを監視中です。失敗してもジョブ自体は終了せず、復旧経路へ移ります。' });
  } else if (job.phase === 'recovery_ready') {
    run = clearBridgeStallTracking({
      ...run,
      status: 'running',
      message: overNominalRecoveryBudget
        ? '通常の復旧サイクル目安を超えましたが、Guardianは停止せず監視を継続しています。ChatGPT用の最新復旧指示を使用してください。'
        : `CI失敗を検出しました。復旧サイクル ${recoveryCount}/${run.maxCycles}。ChatGPT用の修正指示を更新し、監視を継続しています。`,
    });
  } else if (job.phase === 'waiting_chatgpt' || job.phase === 'handoff_ready') {
    run = { ...run, status: 'running', message: 'ChatGPTによるbranch上の作業を待っています。Workerは外部APIで実装せず、定期監視を継続します。' };
    run = await checkBridgeStaleness(env, run, job.chatUrl);
  } else {
    run = clearBridgeStallTracking({ ...run, status: 'running', message: job.outputText || 'Supervisor is monitoring the ChatGPT execution state.' });
  }

  await saveRun(env, run);
  return run;
}

export async function sweepGuardianRuns(env: GuardianEnv): Promise<{ checked: number; advanced: number; recoverableErrors: number }> {
  let checked = 0;
  let advanced = 0;
  let recoverableErrors = 0;
  let cursor: string | undefined;

  do {
    const listed = await env.SUPERVISOR_STATE.list({ prefix: 'guardian-run:', limit: 100, cursor });
    for (const key of listed.keys) {
      const id = key.name.slice('guardian-run:'.length);
      const run = await readRun(env, id);
      if (!run || isFinal(run.status)) continue;
      checked += 1;
      const before = `${run.status}:${run.phase || ''}:${run.recoveryCount || 0}:${run.updatedAt}`;
      try {
        const afterRun = await advanceGuardianRun(env, id);
        const after = `${afterRun.status}:${afterRun.phase || ''}:${afterRun.recoveryCount || 0}:${afterRun.updatedAt}`;
        if (after !== before) advanced += 1;
      } catch (error) {
        recoverableErrors += 1;
        const current = await readRun(env, id);
        if (current && !isFinal(current.status)) {
          await recordRecoverableError(env, current, error instanceof Error ? error.message : 'Guardian sweep failed');
        }
      }
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);

  return { checked, advanced, recoverableErrors };
}

const BRIDGE_STALL_THRESHOLD_MS = 15 * 60_000;

export function clearBridgeStallTracking(run: GuardianRun): GuardianRun {
  if (!run.bridgeDisconnectedSinceAt && !run.bridgeStallNotifiedAt) return run;
  return { ...run, bridgeDisconnectedSinceAt: undefined, bridgeStallNotifiedAt: undefined };
}

// Only called for a run whose job.phase is waiting_chatgpt/handoff_ready —
// i.e. genuinely waiting on the human's ChatGPT tab (via the ChatGPT Apps
// Bridge widget) to act. Before this, nothing proactively noticed a
// project's Bridge going dark while a job depended on it: getChatBridgeStatus
// was only ever checked reactively, from the PWA's own overview poll while
// Chat Control happened to be open. A closed/abandoned tab could leave a
// job silently stuck with zero signal.
//
// Scoped limitation, stated honestly rather than assumed universal: this
// only covers Guardian-run-tracked jobs. A standalone ad-hoc Quick Command
// enqueued outside a Guardian run has no analogous waiting-state machine to
// hang a staleness check off of, and is not covered here.
//
// Debounced via bridgeStallNotifiedAt so an ongoing stall pushes exactly
// once, not every 5-minute sweep; clearBridgeStallTracking (called from
// every other phase branch, and from here once reconnected) resets both
// fields so a later, genuinely new disconnection gets a fresh clock and a
// fresh notification.
export async function checkBridgeStaleness(env: GuardianEnv, run: GuardianRun, chatUrl?: string): Promise<GuardianRun> {
  if (!run.projectId) return run;
  try {
    const bridge = await getChatBridgeStatus(env, run.projectId, chatUrl);
    if (bridge.connected) return clearBridgeStallTracking(run);

    const nowMs = Date.now();
    let updated = run.bridgeDisconnectedSinceAt ? run : { ...run, bridgeDisconnectedSinceAt: new Date(nowMs).toISOString() };
    const disconnectedSinceMs = new Date(updated.bridgeDisconnectedSinceAt!).getTime();
    const stalled = Number.isFinite(disconnectedSinceMs) && nowMs - disconnectedSinceMs >= BRIDGE_STALL_THRESHOLD_MS;
    if (stalled && !updated.bridgeStallNotifiedAt) {
      const name = updated.projectName || updated.repository;
      try {
        await sendSupervisorPush(env, {
          title: `${name}: ChatGPTタブが応答していません`,
          body: `Bridgeからのheartbeatが${Math.round(BRIDGE_STALL_THRESHOLD_MS / 60_000)}分以上ありません。ChatGPTタブを確認してください。`,
          tag: `guardian-bridge-stall-${updated.id}`,
          projectId: updated.projectId,
          kind: 'human',
        });
        updated = { ...updated, bridgeStallNotifiedAt: new Date(nowMs).toISOString() };
      } catch {
        // Push delivery is best-effort, same as finalize()'s own push below.
      }
    }
    return updated;
  } catch {
    // A bridge-status lookup failure must never corrupt Guardian orchestration state.
    return run;
  }
}

async function recordRecoverableError(env: GuardianEnv, run: GuardianRun, detail: string): Promise<GuardianRun> {
  const count = (run.transientErrorCount || 0) + 1;
  const updated: GuardianRun = {
    ...run,
    status: run.status === 'waiting_ci' ? 'waiting_ci' : 'running',
    transientErrorCount: count,
    error: detail,
    message: `監督処理で一時エラーを検出しました (${count}回)。状態を失敗終了にはせず、次回Cron/手動更新で再試行します。: ${detail}`,
    updatedAt: new Date().toISOString(),
  };
  await saveRun(env, updated);
  return updated;
}

async function finalize(
  env: GuardianEnv,
  run: GuardianRun,
  status: 'review_ready' | 'completed' | 'expired',
  message: string,
): Promise<GuardianRun> {
  let updated: GuardianRun = {
    ...run,
    status,
    message,
    error: status === 'expired' ? message : run.error,
    updatedAt: new Date().toISOString(),
  };
  if (!run.notifiedAt) {
    const name = run.projectName || run.repository;
    const title = status === 'completed' ? `${name}: Guardian完了` : status === 'review_ready' ? `${name}: 人間確認が必要` : `${name}: 監視時間上限`;
    try {
      await sendSupervisorPush(env, {
        title,
        body: message.slice(0, 240),
        tag: `guardian-${run.id}`,
        projectId: run.projectId,
        kind: status === 'completed' ? 'complete' : 'human',
        url: run.pullRequest?.url || './',
      });
      updated = { ...updated, notifiedAt: new Date().toISOString() };
    } catch {
      // Push delivery is best-effort and must never corrupt the orchestration state.
    }
  }
  await saveRun(env, updated);
  return updated;
}

async function saveRun(env: GuardianEnv, run: GuardianRun) {
  await env.SUPERVISOR_STATE.put(`guardian-run:${run.id}`, JSON.stringify(run), { expirationTtl: RUN_TTL });
  if (run.projectId) await env.SUPERVISOR_STATE.put(`guardian-project:${run.projectId}:latest`, run.id, { expirationTtl: RUN_TTL });
}

async function readRun(env: GuardianEnv, id: string): Promise<GuardianRun | null> {
  const raw = await env.SUPERVISOR_STATE.get(`guardian-run:${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as GuardianRun; } catch { return null; }
}

async function mapDeveloperJob(env: GuardianEnv, developerJobId: string, runId: string) {
  await env.SUPERVISOR_STATE.put(`guardian-developer:${developerJobId}`, runId, { expirationTtl: RUN_TTL });
}

function isFinal(status: GuardianRunStatus) {
  return status === 'review_ready' || status === 'completed' || status === 'failed' || status === 'expired';
}

function clamp(value: number, min: number, max: number) {
  const integer = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.max(min, Math.min(max, integer));
}