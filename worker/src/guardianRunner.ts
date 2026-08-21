import {
  CreateDeveloperJobBody,
  DeveloperJob,
  continueDeveloperJob,
  createManagedDeveloperJob,
  getDeveloperJob,
  refreshDeveloperJob,
} from './developerAgent';
import { GitHubEnv, getBranchWorkflowRuns, getRepositorySummary } from './githubExecutor';
import { PushEnv, sendSupervisorPush } from './push';

interface GuardianEnv extends GitHubEnv, PushEnv {
  OPENAI_API_KEY: string;
  OPENAI_MODEL?: string;
  SUPERVISOR_STATE: KVNamespace;
}

export interface CreateGuardianRunBody extends CreateDeveloperJobBody {
  maxCycles?: number;
  maxMinutes?: number;
}

export type GuardianRunStatus = 'starting' | 'running' | 'waiting_ci' | 'completed' | 'failed' | 'expired';

export interface GuardianCiCheck {
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
  status: GuardianRunStatus;
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
  ciChecks?: GuardianCiCheck[];
  pullRequest?: { number: number; url: string; draft: true };
  finalSummary?: string;
  notifiedAt?: string;
}

const RUN_TTL = 60 * 60 * 24 * 14;
const MAX_CYCLES = 4;
const MAX_MINUTES = 360;
const CI_GRACE_MS = 7 * 60_000;
const PROCESSING_GRACE_MS = 90_000;

export async function createGuardianRun(env: GuardianEnv, body: CreateGuardianRunBody): Promise<GuardianRun> {
  if (!body.repository?.trim() || !body.goal?.trim() || !body.prompt?.trim()) throw new Error('repository, goal and prompt are required');
  const id = crypto.randomUUID();
  const maxCycles = clamp(body.maxCycles ?? 3, 1, MAX_CYCLES);
  const maxMinutes = clamp(body.maxMinutes ?? 180, 15, MAX_MINUTES);
  const maxToolTurns = clamp(body.maxToolTurns ?? 10, 1, 16);
  const now = new Date().toISOString();

  const developer = await createManagedDeveloperJob(env, {
    ...body,
    maxToolTurns,
  }, id);

  const run: GuardianRun = {
    id,
    projectId: body.projectId,
    projectName: body.projectName,
    repository: developer.repository,
    goal: body.goal,
    prompt: body.prompt,
    model: developer.model,
    status: developer.status === 'failed' ? 'running' : 'running',
    cycle: 1,
    maxCycles,
    maxToolTurns,
    maxMinutes,
    currentDeveloperJobId: developer.id,
    createdAt: now,
    updatedAt: now,
    message: 'Developer Agent cycle 1 started.',
  };

  await saveRun(env, run);
  await mapDeveloperJob(env, developer.id, run.id);
  return advanceGuardianRun(env, run.id);
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

export async function advanceGuardianRun(env: GuardianEnv, id: string): Promise<GuardianRun> {
  let run = await readRun(env, id);
  if (!run) throw new Error('Guardian run not found');
  if (isFinal(run.status)) return run;

  const nowMs = Date.now();
  if (nowMs - new Date(run.createdAt).getTime() > run.maxMinutes * 60_000) {
    run = await finalize(env, run, 'expired', `Guardian time limit reached (${run.maxMinutes} min).`);
    return run;
  }

  if (run.lastAdvanceAt && nowMs - new Date(run.lastAdvanceAt).getTime() < PROCESSING_GRACE_MS) return run;
  run = { ...run, lastAdvanceAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString() };
  await saveRun(env, run);

  let job = await getDeveloperJob(env, run.currentDeveloperJobId);
  if (!job) return finalize(env, run, 'failed', 'Current developer job was not found.');

  if (job.status === 'running') {
    job = await refreshDeveloperJob(env, job.id) ?? job;
    if (job.status === 'running') {
      run = { ...run, status: 'running', message: `Developer Agent cycle ${run.cycle} is running.`, updatedAt: new Date().toISOString() };
      await saveRun(env, run);
      return run;
    }
  }

  if (job.status === 'failed') return recoverOrFail(env, run, job, `Developer Agent failed: ${job.error || 'unknown error'}`);

  run = {
    ...run,
    pullRequest: job.pullRequest ?? run.pullRequest,
    finalSummary: job.outputText || run.finalSummary,
    updatedAt: new Date().toISOString(),
  };
  await saveRun(env, run);

  const repo = await getRepositorySummary(env, job.repository, job.workspace.branch);
  const allRuns = await getBranchWorkflowRuns(env, job.repository, job.workspace.branch);
  const relevant = latestChecksForHead(allRuns.filter((item) => item.headSha === repo.headSha));

  if (!relevant.length) {
    const sinceJob = nowMs - new Date(job.updatedAt).getTime();
    if (sinceJob < CI_GRACE_MS) {
      run = { ...run, status: 'waiting_ci', ciChecks: [], message: 'Waiting for GitHub Actions to appear.', updatedAt: new Date().toISOString() };
      await saveRun(env, run);
      return run;
    }
    return finalize(env, run, 'completed', 'Developer work completed. No GitHub Actions run was detected for the branch head; human review is still required.');
  }

  run = { ...run, ciChecks: relevant, updatedAt: new Date().toISOString() };
  await saveRun(env, run);

  if (relevant.some((check) => check.status !== 'completed')) {
    run = { ...run, status: 'waiting_ci', message: 'Waiting for GitHub Actions to finish.', updatedAt: new Date().toISOString() };
    await saveRun(env, run);
    return run;
  }

  const failures = relevant.filter((check) => !isSuccessfulConclusion(check.conclusion));
  if (failures.length) {
    const detail = failures.map((check) => `${check.name}: ${check.conclusion || check.status} (${check.url})`).join('\n');
    return recoverOrFail(env, run, job, `CI failed on cycle ${run.cycle}:\n${detail}`);
  }

  return finalize(env, run, 'completed', `CI is green after ${run.cycle} cycle${run.cycle === 1 ? '' : 's'}. Draft PR is ready for human review.`);
}

export async function sweepGuardianRuns(env: GuardianEnv): Promise<{ checked: number; advanced: number }> {
  const listed = await env.SUPERVISOR_STATE.list({ prefix: 'guardian-run:', limit: 100 });
  let checked = 0;
  let advanced = 0;
  for (const key of listed.keys) {
    const id = key.name.slice('guardian-run:'.length);
    const run = await readRun(env, id);
    if (!run || isFinal(run.status)) continue;
    checked += 1;
    const before = `${run.status}:${run.cycle}:${run.updatedAt}`;
    try {
      const afterRun = await advanceGuardianRun(env, id);
      const after = `${afterRun.status}:${afterRun.cycle}:${afterRun.updatedAt}`;
      if (after !== before) advanced += 1;
    } catch (error) {
      const failed = await readRun(env, id);
      if (failed) await finalize(env, failed, 'failed', error instanceof Error ? error.message : 'Guardian sweep failed');
    }
  }
  return { checked, advanced };
}

async function recoverOrFail(env: GuardianEnv, run: GuardianRun, job: DeveloperJob, reason: string): Promise<GuardianRun> {
  if (run.cycle >= run.maxCycles) return finalize(env, run, 'failed', `${reason}\nMaximum recovery cycles reached (${run.maxCycles}).`);

  const nextCycle = run.cycle + 1;
  const prompt = `Guardian Supervisor detected that the previous implementation cycle did not reach a clean result.\n\nReason:\n${reason}\n\nOriginal goal:\n${run.goal}\n\nOriginal task:\n${run.prompt}\n\nPrevious agent summary:\n${job.outputText || 'No summary available.'}\n\nContinue on the SAME protected feature branch. Inspect the current branch state first, preserve completed work, fix the actual cause, and re-check the diff. Do not merely repeat the previous attempt. Do not merge or deploy production.`;
  const next = await continueDeveloperJob(env, job, prompt, run.id);
  await mapDeveloperJob(env, next.id, run.id);
  const updated: GuardianRun = {
    ...run,
    status: 'running',
    cycle: nextCycle,
    currentDeveloperJobId: next.id,
    message: `Recovery cycle ${nextCycle}/${run.maxCycles} started on the same branch.`,
    error: undefined,
    ciChecks: undefined,
    updatedAt: new Date().toISOString(),
    lastAdvanceAt: undefined,
  };
  await saveRun(env, updated);
  return updated;
}

async function finalize(env: GuardianEnv, run: GuardianRun, status: 'completed' | 'failed' | 'expired', message: string): Promise<GuardianRun> {
  let updated: GuardianRun = { ...run, status, message, error: status === 'completed' ? undefined : message, updatedAt: new Date().toISOString() };
  if (!run.notifiedAt) {
    const name = run.projectName || run.repository;
    await sendSupervisorPush(env, {
      title: status === 'completed' ? `${name}: Guardian完了` : `${name}: Guardian停止`,
      body: message.slice(0, 240),
      tag: `guardian-${run.id}`,
      projectId: run.projectId,
      kind: status === 'completed' ? 'complete' : 'error',
      url: run.pullRequest?.url || './',
    });
    updated = { ...updated, notifiedAt: new Date().toISOString() };
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

async function mapDeveloperJob(env: GuardianEnv, developerJobId: string, guardianRunId: string) {
  await env.SUPERVISOR_STATE.put(`guardian-developer:${developerJobId}`, guardianRunId, { expirationTtl: RUN_TTL });
}

function latestChecksForHead(items: GuardianCiCheck[]) {
  const byName = new Map<string, GuardianCiCheck>();
  for (const item of items) if (!byName.has(item.name)) byName.set(item.name, item);
  return [...byName.values()];
}

function isSuccessfulConclusion(value: string | null) {
  return value === 'success' || value === 'neutral' || value === 'skipped';
}

function isFinal(status: GuardianRunStatus) {
  return status === 'completed' || status === 'failed' || status === 'expired';
}

function clamp(value: number, min: number, max: number) {
  const integer = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.max(min, Math.min(max, integer));
}
