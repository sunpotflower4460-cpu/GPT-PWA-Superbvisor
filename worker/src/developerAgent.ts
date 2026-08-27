import {
  GitHubEnv,
  GitHubWorkspace,
  assertAllowedRepo,
  compareWorkspace,
  createPullRequest,
  createWorkspace,
  getBranchWorkflowRuns,
  getRepositorySummary,
  getWorkflowRunJobs,
} from './githubExecutor';
import { OrchestrationEnv, runOrchestrationModel } from './orchestrationModel';
import {
  CiCheckLike,
  applyDeclaredCategoryOverride,
  applyHumanApprovalOverride,
  assessCi,
  buildAutopilotRouteContinuationPrompt,
  buildChatGptHandoff,
  buildRecoveryPrompt,
  failureFingerprint,
  hasAutopilotRouteCompletionMarker,
  hasAutopilotRouteContract,
} from './orchestratorPolicy';
import { PushEnv, sendSupervisorPush } from './push';
import { enqueueChatCommand } from './chatCommandQueue';
import {
  ProjectKernelManifest,
  ProjectKernelMode,
  detectProjectKernel,
  getCheckCategoryMap,
  getCheckNamesByCategory,
  requiresDraftPrFirst,
} from './projectKernel';
import { InferredGenericRepoContract } from './genericRepoInference';

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
  chatUrl?: string;
  autoDispatch?: boolean;
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
  // Detected once at job creation and cached; never a hard dependency —
  // GENERIC_REPO (no manifest, or one that failed to parse) falls back to
  // the pre-Kernel heuristics unchanged. See projectKernel.ts.
  kernelMode?: ProjectKernelMode;
  kernelManifest?: ProjectKernelManifest;
  // GENERIC_REPO best-effort fallback (see genericRepoInference.ts) —
  // only ever set when kernelManifest is absent, and only ever consulted
  // for validation-contract heuristics like requiresDraftPrFirst below,
  // never for human-approval check-name classification.
  inferredContract?: InferredGenericRepoContract;
  // Last confidently-discovered declared category set (see
  // applyDeclaredCategoryOverride) for the failing run identified by
  // lastKnownDeclaredCategoriesFingerprint (headSha+checks signature, no
  // category — see failureFingerprint). getWorkflowRunJobs is best-effort:
  // when it fails entirely for the SAME failing run a previous refresh
  // already resolved categories for, this lets that refresh reuse them
  // instead of a transient fetch failure masquerading as "categories
  // disappeared" and forcing a wasted recovery regeneration.
  lastKnownDeclaredCategories?: string[];
  lastKnownDeclaredCategoriesFingerprint?: string;
  recoveryCount: number;
  lastFailureFingerprint?: string;
  ciAutoReruns: number;
  lastCiRerunFingerprint?: string;
  maxAutoCiReruns: number;
  degradedOrchestration?: boolean;
  chatUrl?: string;
  autoDispatch: boolean;
  lastQueuedHandoffFingerprint?: string;
  lastQueuedCommandId?: string;
  lastDispatchError?: string;
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
    chatUrl: previous.chatUrl,
    autoDispatch: previous.autoDispatch,
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
  // Best-effort: a Project Kernel detection failure (network hiccup,
  // malformed manifest) must never block the job — it only means the
  // Validation Contract shortcuts below stay unavailable for this job.
  const kernel = await detectProjectKernel(env, workspace.repository, workspace.defaultBranch).catch(
    (): Awaited<ReturnType<typeof detectProjectKernel>> => ({ mode: 'GENERIC_REPO', reason: 'not_found' }),
  );
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
  let job: DeveloperJob = {
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
    chatUrl: body.chatUrl?.trim() || undefined,
    autoDispatch: Boolean(body.autoDispatch),
    kernelMode: kernel.mode,
    kernelManifest: kernel.manifest,
    inferredContract: kernel.inferredContract,
  };
  await saveJob(env, job);
  job = await queueHandoffIfEnabled(env, job);
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
      outputText: job.autoDispatch
        ? 'Chat Control Busへ指示を渡し、ChatGPTによるbranch上の実装開始を待っています。Supervisorは停止せず監視を継続します。'
        : job.outputText || 'ChatGPTによるbranch上の実装開始を待っています。Supervisorは停止せず監視を継続します。',
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
  const humanRequiredCheckNames = getCheckNamesByCategory(job.kernelManifest, 'HUMAN_APPROVAL_REQUIRED');
  const checkCategories = getCheckCategoryMap(job.kernelManifest);
  let assessment = assessCi(checks, humanRequiredCheckNames);
  let lastKnownDeclaredCategories = job.lastKnownDeclaredCategories;
  let lastKnownDeclaredCategoriesFingerprint = job.lastKnownDeclaredCategoriesFingerprint;
  if ((humanRequiredCheckNames.size || checkCategories.size) && assessment.failed.length) {
    // assessCi() only sees workflow-run names, which don't match Kernel-
    // declared job/check names in the common case (see
    // applyHumanApprovalOverride's own comment). Fetch the actual job-level
    // data for each currently-failing workflow run to reconcile, scoped to
    // those runs' own IDs (getWorkflowRunJobs) rather than every check on
    // the commit — cheaper, and it can't pick up unrelated third-party App
    // checks. Best-effort per run: a run whose jobs fail to fetch is simply
    // absent from the reconciliation rather than blocking the others or the
    // refresh cycle.
    const repository = job.repository;
    const results = await Promise.allSettled(assessment.failed.map((run) => getWorkflowRunJobs(env, repository, run.id)));
    const jobLevelChecks = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
    assessment = applyHumanApprovalOverride(assessment, jobLevelChecks, humanRequiredCheckNames);
    assessment = applyDeclaredCategoryOverride(assessment, jobLevelChecks, checkCategories);

    const currentRunFingerprint = failureFingerprint(repo.headSha, assessment.failed);
    const sameFailingRunAsLastKnownCategories = lastKnownDeclaredCategoriesFingerprint === currentRunFingerprint;
    const hadAnyFetchFailure = results.length > 0 && results.some((result) => result.status === 'rejected');
    const hadTotalFetchFailure = results.length > 0 && results.every((result) => result.status === 'rejected');
    if (assessment.declaredCategories?.length) {
      // When multiple runs are failing at once and only SOME of their
      // job-level fetches succeeded this round, the fresh categories cover
      // only those runs — overwriting the prior set outright would silently
      // drop a still-real category whose run's fetch happened to fail this
      // specific round. Union with the prior set instead, but only for the
      // SAME set of failing runs (a genuinely different failure composition
      // gets a clean slate, not stale carry-over).
      const merged = sameFailingRunAsLastKnownCategories && hadAnyFetchFailure && lastKnownDeclaredCategories?.length
        ? [...new Set([...lastKnownDeclaredCategories, ...assessment.declaredCategories])].sort()
        : assessment.declaredCategories;
      assessment = { ...assessment, declaredCategories: merged };
      lastKnownDeclaredCategories = merged;
      lastKnownDeclaredCategoriesFingerprint = currentRunFingerprint;
    } else if (
      assessment.state === 'CODE_FAILURE'
      && hadTotalFetchFailure
      && sameFailingRunAsLastKnownCategories
      && lastKnownDeclaredCategories?.length
    ) {
      // Every job-level fetch failed outright this round for the SAME
      // failing run a previous refresh already resolved categories for —
      // that's a transient lookup failure, not new evidence that the
      // categories went away. Reuse the last confident answer rather than
      // letting the gap force a wasted recovery regeneration.
      assessment = { ...assessment, declaredCategories: lastKnownDeclaredCategories };
    }
  }
  job = {
    ...job,
    lastHeadSha: repo.headSha,
    firstChangeSeenAt,
    changedFiles: comparison.files ?? [],
    ciChecks: checks,
    lastKnownDeclaredCategories,
    lastKnownDeclaredCategoriesFingerprint,
    updatedAt: new Date().toISOString(),
  };

  if (assessment.state === 'PENDING') {
    job = { ...job, phase: 'waiting_ci', error: undefined, outputText: 'ChatGPTの変更を検出しました。現在headに対応するGitHub Actionsの完了を監視しています。' };
    await saveJob(env, job);
    return job;
  }

  if (assessment.state === 'NO_RUN') {
    // Some repositories (e.g. GPT-template's guard.yml: pull_request + push
    // on main only) never fire CI on a feature branch at all — no amount of
    // waiting produces a run. If the Kernel's Validation Contract says a
    // pull_request is required and this branch isn't covered by a required
    // push strategy, open the Draft PR now instead of waiting out the grace
    // period first; the same polling loop then picks up the resulting
    // pull_request-triggered run on the next refresh.
    if (!job.pullRequest && requiresDraftPrFirst(job.kernelManifest ?? job.inferredContract, job.workspace.branch)) {
      const created = await tryCreateDraftPr(env, job, comparison);
      if (created.pullRequest) {
        job = {
          ...job,
          pullRequest: created.pullRequest,
          phase: 'waiting_ci',
          error: undefined,
          outputText: `このリポジトリのValidation Contractはpull_request経由のCIを要求しています。CI発火のためDraft PR #${created.pullRequest.number} を作成し、現在headのCI完了を監視しています。`,
          updatedAt: new Date().toISOString(),
        };
        await saveJob(env, job);
        return job;
      }
      // PR creation failed (e.g. a transient API error, or one already
      // exists that this job lost track of) — don't hard-fail the job over
      // it, fall through to the existing grace-period wait.
      job = { ...job, error: created.error };
    }

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
    const reason = assessment.declaredCategories?.length
      ? `現在headのCIが失敗しています(このリポジトリのValidation Contractが宣言するカテゴリ: ${assessment.declaredCategories.join(', ')})。停止せず、ChatGPTへ原因確認と修正を引き継ぎます。`
      : '現在headのCIが失敗しています。停止せず、ChatGPTへ原因確認と修正を引き継ぎます。';
    return prepareRecovery(env, job, repo.headSha, assessment.failed, reason, 'CI_CODE_FAILURE', assessment.declaredCategories);
  }

  if (hasAutopilotRouteContract(job.prompt) && !hasAutopilotRouteCompletionMarker(repo.headCommitMessage)) {
    const continuationPrompt = buildAutopilotRouteContinuationPrompt({
      repository: job.repository,
      branch: job.workspace.branch,
      goal: job.goal,
      originalTask: job.prompt,
      headSha: repo.headSha,
      checks,
    });
    job = {
      ...job,
      status: 'running',
      phase: 'handoff_ready',
      error: undefined,
      handoffPrompt: continuationPrompt,
      outputText: '現在headのCIは成功しました。AUTOPILOT ROUTEの途中チェックポイントとして扱い、完了済み工程を飛ばさず次の未完了工程へ進むChatGPT指示を準備しました。',
      updatedAt: new Date().toISOString(),
    };
    await saveJob(env, job);
    job = await queueHandoffIfEnabled(env, job);
    await safePush(env, {
      title: `${job.projectName || job.repository}: ルート次工程`,
      body: job.autoDispatch
        ? 'CI成功。後続工程のChatGPT指示をChat Control Busへ自動投入しました。'
        : 'CI成功。自動運転ルートに後続工程があるため、次のChatGPT実行指示を準備しました。',
      tag: `developer-route-${job.id}`,
      projectId: job.projectId,
      kind: 'info',
      url: './',
    });
    return job;
  }

  const created = await tryCreateDraftPr(env, job, comparison);
  const pullRequest = created.pullRequest;
  if (created.error) job = { ...job, error: created.error };

  job = {
    ...job,
    status: 'completed',
    phase: 'review_ready',
    pullRequest,
    outputText: hasAutopilotRouteContract(job.prompt)
      ? 'AUTOPILOT ROUTE完了マーカーと現在headのCI成功を確認しました。全ルート終了後のレビュー可能状態です。'
      : '現在headのCI成功を確認しました。実装はChatGPTが行い、Workerは監督・CI確認・Draft PR準備のみを担当しました。',
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
  declaredCategories?: readonly string[],
): Promise<DeveloperJob> {
  // declaredCategories folds into the fingerprint (see failureFingerprint's
  // own comment) so a category discovered on a later refresh — after an
  // earlier one landed here with it still unknown, since getWorkflowRunJobs
  // is best-effort — invalidates the cached handoffPrompt instead of being
  // silently dropped.
  const fingerprint = checks.length ? failureFingerprint(headSha, checks, declaredCategories) : `${headSha}:no-ci`;
  if (job.lastFailureFingerprint === fingerprint && job.handoffPrompt) {
    const phase: DeveloperJobPhase = classification === 'HUMAN_REQUIRED' ? 'human_required' : 'recovery_ready';
    let stable: DeveloperJob = { ...job, phase, error: reason, updatedAt: new Date().toISOString() };
    await saveJob(env, stable);
    if (phase !== 'human_required') stable = await queueHandoffIfEnabled(env, stable);
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
    declaredCategories,
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

  let updated: DeveloperJob = {
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
  if (updated.phase !== 'human_required') updated = await queueHandoffIfEnabled(env, updated);
  await safePush(env, {
    title: `${job.projectName || job.repository}: GPT復旧指示あり`,
    body: updated.autoDispatch && updated.phase !== 'human_required'
      ? `${reason.slice(0, 170)} / 復旧指示をChat Control Busへ自動投入済み`
      : reason.slice(0, 220),
    tag: `developer-recovery-${job.id}`,
    projectId: job.projectId,
    kind: updated.phase === 'human_required' ? 'human' : 'error',
    url: './',
  });
  return updated;
}

async function queueHandoffIfEnabled(env: AgentEnv, job: DeveloperJob): Promise<DeveloperJob> {
  if (!job.autoDispatch || job.phase === 'human_required' || !job.projectId || !job.chatUrl || !job.handoffPrompt?.trim()) return job;
  const fingerprint = promptFingerprint(job.handoffPrompt);
  if (job.lastQueuedHandoffFingerprint === fingerprint && job.lastQueuedCommandId) return job;

  try {
    const command = await enqueueChatCommand(env, {
      projectId: job.projectId,
      projectName: job.projectName,
      chatUrl: job.chatUrl,
      prompt: job.handoffPrompt,
      dedupeKey: `developer:${job.id}:${fingerprint}`,
    });
    const updated: DeveloperJob = {
      ...job,
      lastQueuedHandoffFingerprint: fingerprint,
      lastQueuedCommandId: command.id,
      lastDispatchError: undefined,
      outputText: `${job.outputText || ''}${job.outputText ? '\n\n' : ''}Chat Control Busへ次のChatGPT指示を自動投入しました。`,
      updatedAt: new Date().toISOString(),
    };
    await saveJob(env, updated);
    return updated;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Chat Control Bus dispatch failed';
    const updated: DeveloperJob = {
      ...job,
      lastDispatchError: detail,
      outputText: `${job.outputText || ''}${job.outputText ? '\n\n' : ''}Chat Control Busへの自動投入に失敗しました。監督状態は維持し、再開可能です: ${detail}`,
      updatedAt: new Date().toISOString(),
    };
    await saveJob(env, updated);
    return updated;
  }
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

async function tryCreateDraftPr(
  env: AgentEnv,
  job: DeveloperJob,
  comparison: Awaited<ReturnType<typeof compareWorkspace>>,
): Promise<{ pullRequest?: DeveloperJob['pullRequest']; error?: string }> {
  if (job.pullRequest) return { pullRequest: job.pullRequest };
  try {
    const pr = await createPullRequest(
      env,
      job.workspace,
      `${job.projectName || 'AI DEV DECK'}: ${shortTitle(job.goal)}`,
      buildPullRequestBody(job, comparison),
    );
    return { pullRequest: { number: pr.number, url: pr.url, draft: true } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Draft PR creation failed' };
  }
}

function buildPullRequestBody(job: DeveloperJob, comparison: Awaited<ReturnType<typeof compareWorkspace>>) {
  const files = (comparison.files ?? []).slice(0, 50).map((file) => `- \`${file.filename}\` (${file.status}, +${file.additions}/-${file.deletions})`).join('\n') || '- No file list returned';
  return `## AI DEV DECK / ChatGPT execution\n\n**Goal:** ${job.goal}\n\n**Executor:** ChatGPT chat\n**Orchestrator:** ${job.orchestratorProvider}/${job.model}\n**Worker role:** branch preparation, monitoring, CI recovery routing, Chat Control Bus routing, Draft PR preparation. The external orchestration model did not edit repository files.\n\n### Changed files\n${files}\n\n### Supervisor summary\n${job.outputText || 'No summary'}\n\n### Safety\n- Draft only\n- No automatic merge\n- No production deploy\n`;
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

function promptFingerprint(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function shortTitle(value: string) {
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, 80) || 'ChatGPT implementation';
}

function clamp(value: number, min: number, max: number) {
  const integer = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.max(min, Math.min(max, integer));
}
