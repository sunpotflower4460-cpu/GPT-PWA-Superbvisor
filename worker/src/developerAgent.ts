import {
  GitHubEnv,
  GitHubWorkspace,
  assertAllowedRepo,
  compareWorkspace,
  createPullRequest,
  createWorkspace,
  getBranchWorkflowRuns,
  getRepositorySummary,
} from './githubExecutor';
import { OrchestrationEnv, runOrchestrationModel } from './orchestrationModel';
import {
  CiCheckLike,
  assessCi,
  buildChatGptHandoff,
  buildRecoveryPrompt,
  failureFingerprint,
} from './orchestratorPolicy';
import { PushEnv, sendSupervisorPush } from './push';

interface AgentEnv extends GitHubEnv, PushEnv, OrchestrationEnv {
  SUPERVISOR_STATE: KVNamespace;
}

export interface CreateDeveloperJobBody {
  projectId?: string;
  projectName?: string;
  repository: string;
  goal: string;
  prompt: string;
  definitionOfDone?: string[];
  model?: string;
  maxToolTurns?: number;
  maxAutoCiReruns?: number;
}

export type DeveloperJobStatus = 'starting' | 'running' | 'completed' | 'failed';
export type DeveloperJobPhase = 'handoff_ready' | 'waiting_chatgpt' | 'waiting_ci' | 'recovery_ready' | 'human_required' | 'review_ready';

export interface DeveloperJob {
  id: string;
  projectId?: string;
  projectName?: string;
  repository: string;
  goal: string;
  prompt: string;
  definitionOfDone: string[];
  model: string;
  orchestratorProvider: string;
  workspace: GitHubWorkspace;
  status: DeveloperJobStatus;
  phase: DeveloperJobPhase;
  toolTurns: number;
  maxToolTurns: number;
  createdAt: string;
  updatedAt: string;
  firstChangeSeenAt?: string;
  lastHeadSha?: string;
  outputText?: string;
  handoffPrompt?: string;
  error?: string;
  changedFiles?: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>;
  ciChecks?: CiCheckLike[];
  pullRequest?: { number: number; url: string; draft: true };
  managedByGoalRunId?: string;
  recoveryCount: number;
  lastFailureFingerprint?: string;
  ciAutoReruns: number;
  lastCiRerunFingerprint?: string;
  maxAutoCiReruns: number;
  degradedOrchestration?: boolean;
}

const JOB_TTL = 60 * 60 * 24 * 14;
const CI_APPEAR_GRACE_MS = 7 * 60_000;
const MAX_AUTO_CI_RERUNS = 2;

export async function createDeveloperJob(env: AgentEnv, body: CreateDeveloperJobBody): Promise<DeveloperJob> {
  return createDeveloperJobInternal(env, body);
}

export async function createManagedDeveloperJob(
  env: AgentEnv,
  body: CreateDeveloperJobBody,
  goalRunId: string,
  workspace?: GitHubWorkspace,
): Promise<DeveloperJob> {
  return createDeveloperJobInternal(env, body, workspace, goalRunId);
}

export async function continueDeveloperJob(
  env: AgentEnv,
  previous: DeveloperJob,
  prompt: string,
  goalRunId?: string,
): Promise<DeveloperJob> {
  return createDeveloperJobInternal(env, {
    projectId: previous.projectId,
    projectName: previous.projectName,
    repository: previous.repository,
    goal: previous.goal,
    prompt,
    definitionOfDone: previous.definitionOfDone,
    maxToolTurns: previous.maxToolTurns,
    maxAutoCiReruns: previous.maxAutoCiReruns,
  }, previous.workspace, goalRunId ?? previous.managedByGoalRunId);
}

async function createDeveloperJobInternal(
  env: AgentEnv,
  body: CreateDeveloperJobBody,
  existingWorkspace?: GitHubWorkspace,
  managedByGoalRunId?: string,
): Promise<DeveloperJob> {
  if (!body.repository?.trim() || !body.goal?.trim() || !body.prompt?.trim()) throw new Error('repository, goal and prompt are required');
  const workspace = existingWorkspace ?? await createWorkspace(env, body.repository, body.projectName || body.goal.slice(0, 32));
  const definitionOfDone = (body.definitionOfDone ?? []).filter((item) => typeof item === 'string' && item.trim()).slice(0, 30);
  const deterministicPrompt = buildChatGptHandoff({
    repository: workspace.repository,
    branch: workspace.branch,
    defaultBranch: workspace.defaultBranch,
    goal: body.goal,
    task: body.prompt,
    definitionOfDone,
  });
  const decision = await runOrchestrationModel(env, {
    mode: 'PLAN',
    repository: workspace.repository,
    branch: workspace.branch,
    goal: body.goal,
    task: body.prompt,
    evidence: `A protected feature branch has been prepared at ${workspace.branch}. No implementation has been performed by the external API.`,
    deterministicPrompt,
  });

  const now = new Date().toISOString();
  const job: DeveloperJob = {
    id: crypto.randomUUID(),
    projectId: body.projectId,
    projectName: body.projectName,
    repository: workspace.repository,
    goal: body.goal,
    prompt: body.prompt,
    definitionOfDone,
    model: decision.model,
    orchestratorProvider: decision.provider,
    workspace,
    status: 'running',
    phase: 'handoff_ready',
    toolTurns: 0,
    maxToolTurns: clamp(body.maxToolTurns ?? 10, 1, 16),
    createdAt: now,
    updatedAt: now,
    outputText: decision.summary,
    handoffPrompt: decision.chatgptPrompt,
    managedByGoalRunId,
    recoveryCount: 0,
    ciAutoReruns: 0,
    maxAutoCiReruns: clamp(body.maxAutoCiReruns ?? 2, 0, MAX_AUTO_CI_RERUNS),
    degradedOrchestration: decision.degraded,
  };
  await saveJob(env, job);
  return job;
}

export async function getDeveloperJob(env: AgentEnv, id: string): Promise<DeveloperJob | null> {
  return readJob(env, id);
}

export async function getLatestDeveloperJob(env: AgentEnv, projectId: string): Promise<DeveloperJob | null> {
  const id = await env.SUPERVISOR_STATE.get(`developer-project:${projectId}:latest`);
  return id ? readJob(env, id) : null;
}

export async function refreshDeveloperJob(env: AgentEnv, id: string): Promise<DeveloperJob | null> {
  let job = await readJob(env, id);
  if (!job || job.status === 'completed' || job.status === 'failed') return job;

  const comparison = await compareWorkspace(env, job.workspace);
  if (comparison.ahead_by <= 0) {
    job = {
      ...job,
      phase: 'waiting_chatgpt',
      changedFiles: comparison.files ?? [],
      outputText: job.outputText || 'ChatGPTによるbranch上の実装開始を待っています。Supervisorは停止せず監視を継続します。',
      updatedAt: new Date().toISOString(),
    };
    await saveJob(env, job);
    return job;
  }

  const repo = await getRepositorySummary(env, job.repository, job.workspace.branch);
  const headChanged = job.lastHeadSha !== repo.headSha;
  const firstChangeSeenAt = headChanged || !job.firstChangeSeenAt ? new Date().toISOString() : job.firstChangeSeenAt;
  const allRuns = await getBranchWorkflowRuns(env, job.repository, job.workspace.branch);
  const checks = latestChecksForHead(allRuns.filter((item) => item.headSha === repo.headSha));
  const assessment = assessCi(checks);
  job = {
    ...job,
    lastHeadSha: repo.headSha,
    firstChangeSeenAt,
    changedFiles: comparison.files ?? [],
    ciChecks: checks,
    updatedAt: new Date().toISOString(),
  };

  if (assessment.state === 'PENDING') {
    job = { ...job, phase: 'waiting_ci', error: undefined, outputText: 'ChatGPTの変更を検出しました。現在headに対応するGitHub Actionsの完了を監視しています。' };
    await saveJob(env, job);
    return job;
  }

  if (assessment.state === 'NO_RUN') {
    const elapsed = Date.now() - new Date(firstChangeSeenAt).getTime();
    if (elapsed < CI_APPEAR_GRACE_MS) {
      job = { ...job, phase: 'waiting_ci', error: undefined, outputText: '変更を検出しました。現在headのCI runが現れるまで監視しています。' };
      await saveJob(env, job);
      return job;
    }
    return prepareRecovery(env, job, repo.headSha, [], '現在headに対応するCI runが7分以上確認できません。CI設定・trigger・対象branchをChatGPT側で確認してください。', 'CI_CONFIG_FAILURE');
  }

  if (assessment.state === 'TRANSIENT_FAILURE') {
    const fingerprint = failureFingerprint(repo.headSha, assessment.failed);
    const rerunsForFailure = job.lastCiRerunFingerprint === fingerprint ? job.ciAutoReruns : 0;
    if (rerunsForFailure < job.maxAutoCiReruns) {
      const runIds = [...new Set(assessment.transient.map((check) => check.id))];
      try {
        for (const runId of runIds) await rerunFailedWorkflowJobs(env, job.repository, runId);
        job = {
          ...job,
          phase: 'waiting_ci',
          ciAutoReruns: rerunsForFailure + 1,
          lastCiRerunFingerprint: fingerprint,
          error: undefined,
          outputText: `CIの一時障害候補を検出したため、自動再実行を要求しました (${rerunsForFailure + 1}/${job.maxAutoCiReruns})。コードは変更せず監視を継続します。`,
          updatedAt: new Date().toISOString(),
        };
        await saveJob(env, job);
        return job;
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'CI rerun request failed';
        return prepareRecovery(env, job, repo.headSha, assessment.failed, `CI自動再実行に失敗しました: ${detail}`, 'CI_TRANSIENT');
      }
    }
    return prepareRecovery(env, job, repo.headSha, assessment.failed, 'CIの一時障害候補が自動再実行上限後も継続しています。', 'CI_TRANSIENT');
  }

  if (assessment.state === 'HUMAN_REQUIRED') {
    const prepared = await prepareRecovery(env, job, repo.headSha, assessment.failed, 'GitHub Actionsがaction_requiredを返しています。権限・承認など人間操作が必要な可能性があります。', 'HUMAN_REQUIRED');
    prepared.phase = 'human_required';
    await saveJob(env, prepared);
    return prepared;
  }

  if (assessment.state === 'CODE_FAILURE') {
    return prepareRecovery(env, job, repo.headSha, assessment.failed, '現在headのCIが失敗しています。停止せず、ChatGPTへ原因確認と修正を引き継ぎます。', 'CI_CODE_FAILURE');
  }

  let pullRequest = job.pullRequest;
  if (!pullRequest) {
    try {
      const pr = await createPullRequest(
        env,
        job.workspace,
        `${job.projectName || 'AI DEV DECK'}: ${shortTitle(job.goal)}`,
        buildPullRequestBody(job, comparison),
      );
      pullRequest = { number: pr.number, url: pr.url, draft: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Draft PR creation failed';
      job = { ...job, error: detail };
    }
  }

  job = {
    ...job,
    status: 'completed',
    phase: 'review_ready',
    pullRequest,
    outputText: '現在headのCI成功を確認しました。実装はChatGPTが行い、Workerは監督・CI確認・Draft PR準備のみを担当しました。',
    updatedAt: new Date().toISOString(),
  };
  await saveJob(env, job);
  await safePush(env, {
    title: `${job.projectName || job.repository}: CI確認完了`,
    body: pullRequest ? `CI成功。Draft PR #${pullRequest.number} を確認できます。` : 'CI成功を確認しました。',
    tag: `developer-${job.id}`,
    projectId: job.projectId,
    kind: 'complete',
    url: pullRequest?.url || './',
  });
  return job;
}

// Kept for webhook compatibility. Orchestration jobs never create external-model response mappings.
export async function handleDeveloperResponse(_env: AgentEnv, _responseId: string): Promise<boolean> {
  return false;
}

async function prepareRecovery(
  env: AgentEnv,
  job: DeveloperJob,
  headSha: string,
  checks: CiCheckLike[],
  reason: string,
  classification: 'CI_TRANSIENT' | 'CI_CODE_FAILURE' | 'CI_CONFIG_FAILURE' | 'HUMAN_REQUIRED',
): Promise<DeveloperJob> {
  const fingerprint = checks.length ? failureFingerprint(headSha, checks) : `${headSha}:no-ci`;
  if (job.lastFailureFingerprint === fingerprint && job.handoffPrompt) {
    const phase: DeveloperJobPhase = classification === 'HUMAN_REQUIRED' ? 'human_required' : 'recovery_ready';
    const stable: DeveloperJob = { ...job, phase, error: reason, updatedAt: new Date().toISOString() };
    await saveJob(env, stable);
    return stable;
  }

  const deterministicPrompt = buildRecoveryPrompt({
    repository: job.repository,
    branch: job.workspace.branch,
    goal: job.goal,
    originalTask: job.prompt,
    headSha,
    checks,
    previousSummary: job.outputText,
  });
  const decision = await runOrchestrationModel(env, {
    mode: 'RECOVER',
    repository: job.repository,
    branch: job.workspace.branch,
    goal: job.goal,
    task: job.prompt,
    evidence: `${reason}\n${checks.map((check) => `${check.name}: ${check.conclusion || check.status} ${check.url}`).join('\n') || 'No CI checks observed for the current head.'}`,
    deterministicPrompt,
  });

  const updated: DeveloperJob = {
    ...job,
    phase: classification === 'HUMAN_REQUIRED' || decision.classification === 'HUMAN_REQUIRED' ? 'human_required' : 'recovery_ready',
    model: decision.model,
    orchestratorProvider: decision.provider,
    outputText: `${reason}\n\n${decision.summary}`,
    handoffPrompt: decision.chatgptPrompt,
    error: reason,
    lastFailureFingerprint: fingerprint,
    recoveryCount: job.recoveryCount + 1,
    degradedOrchestration: decision.degraded,
    updatedAt: new Date().toISOString(),
  };
  await saveJob(env, updated);
  await safePush(env, {
    title: `${job.projectName || job.repository}: GPT復旧指示あり`,
    body: reason.slice(0, 220),
    tag: `developer-recovery-${job.id}`,
    projectId: job.projectId,
    kind: updated.phase === 'human_required' ? 'human' : 'error',
    url: './',
  });
  return updated;
}

async function rerunFailedWorkflowJobs(env: AgentEnv, repository: string, runId: number) {
  const repo = assertAllowedRepo(env, repository);
  const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/actions/runs/${runId}/rerun-failed-jobs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'AI-DEV-DECK-Worker',
    },
  });
  if (!response.ok) throw new Error(`GitHub CI rerun failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
}

function latestChecksForHead(runs: Awaited<ReturnType<typeof getBranchWorkflowRuns>>): CiCheckLike[] {
  const byName = new Map<string, CiCheckLike>();
  for (const run of runs) {
    if (!byName.has(run.name)) byName.set(run.name, run);
  }
  return [...byName.values()];
}

function buildPullRequestBody(job: DeveloperJob, comparison: Awaited<ReturnType<typeof compareWorkspace>>) {
  const files = (comparison.files ?? []).slice(0, 50).map((file) => `- \`${file.filename}\` (${file.status}, +${file.additions}/-${file.deletions})`).join('\n') || '- No file list returned';
  return `## AI DEV DECK / ChatGPT execution\n\n**Goal:** ${job.goal}\n\n**Executor:** ChatGPT chat\n**Orchestrator:** ${job.orchestratorProvider}/${job.model}\n**Worker role:** branch preparation, monitoring, CI recovery routing, Draft PR preparation. The external orchestration model did not edit repository files.\n\n### Changed files\n${files}\n\n### Supervisor summary\n${job.outputText || 'No summary'}\n\n### Safety\n- Draft only\n- No automatic merge\n- No production deploy\n`;
}

async function saveJob(env: AgentEnv, job: DeveloperJob) {
  await env.SUPERVISOR_STATE.put(`developer-job:${job.id}`, JSON.stringify(job), { expirationTtl: JOB_TTL });
  if (job.projectId) await env.SUPERVISOR_STATE.put(`developer-project:${job.projectId}:latest`, job.id, { expirationTtl: JOB_TTL });
}

async function readJob(env: AgentEnv, id: string): Promise<DeveloperJob | null> {
  const raw = await env.SUPERVISOR_STATE.get(`developer-job:${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as DeveloperJob; } catch { return null; }
}

async function safePush(env: AgentEnv, payload: Parameters<typeof sendSupervisorPush>[1]) {
  try { await sendSupervisorPush(env, payload); } catch { /* Push failure must never stop orchestration. */ }
}

function shortTitle(value: string) {
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, 80) || 'ChatGPT implementation';
}

function clamp(value: number, min: number, max: number) {
  const integer = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.max(min, Math.min(max, integer));
}
