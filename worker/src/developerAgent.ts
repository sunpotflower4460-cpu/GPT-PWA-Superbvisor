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
  AutopilotRouteState,
  CiCheckLike,
  applyDeclaredCategoryOverride,
  applyHumanApprovalOverride,
  assessCi,
  buildAutopilotRouteContinuationPrompt,
  buildChatGptHandoff,
  buildRecoveryPrompt,
  extractAutopilotRouteStep,
  failureFingerprint,
  hasAutopilotRouteCompletionMarker,
  hasAutopilotRouteContract,
  markAutopilotRouteCompleted,
  recordAutopilotRouteCheckpoint,
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
import { FailureCategory, classifyFailureCategory } from './failureTaxonomy';
import { RecoveryStrategy, recoveryStrategyPromptHint, recurringFailureSignature, resolveRecoveryStrategy } from './recoveryMatrix';
import { assembleKernelContext } from './contextAssembler';
import { hooks } from './lifecycleHooks';
import { RouteNode, parseRoutePlanInput } from './routePlan';
import { deriveContextPressure } from './contextPressure';

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
  // The declared Route plan (see routePlan.ts) — an ordered list of named
  // phases the caller (the PWA, from src/operatingPlan.ts's
  // parseRoutePlan) planned upfront. Optional and never required: a caller
  // with no structured plan simply omits it, same as definitionOfDone.
  routePlan?: RouteNode[];
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
  // Failure Taxonomy / Recovery Matrix (failureTaxonomy.ts, recoveryMatrix.ts).
  // Set only once a recovery has actually been prepared (CI reached a
  // non-success, non-pending state); absent for a job that has never
  // needed recovery. recurringFailureSignature/Count track REPEATED
  // recovery attempts that fail "the same way" across distinct commits —
  // see recurringFailureSignature's own comment for why this is not the
  // same thing as lastFailureFingerprint.
  failureCategory?: FailureCategory;
  recoveryStrategy?: RecoveryStrategy;
  recurringFailureSignature?: string;
  recurringFailureCount?: number;
  ciAutoReruns: number;
  lastCiRerunFingerprint?: string;
  maxAutoCiReruns: number;
  degradedOrchestration?: boolean;
  // Narrower than degradedOrchestration: true only when every configured
  // orchestrator provider's terminal failure was specifically HTTP 429 (see
  // OrchestrationDecision.rateLimited). Lets the PWA distinguish "will
  // likely resolve itself once quota resets" from a generic degraded
  // fallback (missing/invalid keys, network errors, etc.) that needs a
  // human to actually fix something.
  orchestratorRateLimited?: boolean;
  // Structured Autopilot Route progress, persisted independently of the
  // chat's own conversational memory (docs/ARCHITECTURE.md §10 gap #4).
  // Only ever set for a job whose prompt carries the route contract
  // (hasAutopilotRouteContract) — absent for every ordinary job.
  autopilotRoute?: AutopilotRouteState;
  // The declared Route plan (see routePlan.ts's own comment on why this is
  // kept separate from autopilotRoute's self-reported progress). Absent
  // for any job created without one — never required.
  routePlan?: RouteNode[];
  // A short, capped chronological log of real state transitions this job
  // has actually gone through (job created, CI failed, recovery prepared,
  // human required, completed, …) — literally the design's "trace":
  // deterministic bookkeeping, not a hook side effect (see
  // lifecycleHooks.ts's own note on why trace-appending stays plain code
  // here rather than going through a hook handler).
  trace?: TraceEntry[];
  chatUrl?: string;
  autoDispatch: boolean;
  lastQueuedHandoffFingerprint?: string;
  lastQueuedCommandId?: string;
  lastDispatchError?: string;
}

export interface TraceEntry {
  event: string;
  at: string;
  detail?: string;
}

const JOB_TTL = 60 * 60 * 24 * 14;
const CI_APPEAR_GRACE_MS = 7 * 60_000;
const MAX_AUTO_CI_RERUNS = 2;
const MAX_TRACE_ENTRIES = 30;

function appendTrace(job: DeveloperJob, event: string, detail?: string): TraceEntry[] {
  const entries = job.trace ?? [];
  return [...entries, { event, at: new Date().toISOString(), detail }].slice(-MAX_TRACE_ENTRIES);
}

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
    routePlan: previous.routePlan,
  }, previous.workspace, goalRunId ?? previous.managedByGoalRunId);
}

async function createDeveloperJobInternal(
  env: AgentEnv,
  body: CreateDeveloperJobBody,
  existingWorkspace?: GitHubWorkspace,
  managedByGoalRunId?: string,
): Promise<DeveloperJob> {
  if (!body.repository?.trim() || !body.goal?.trim() || !body.prompt?.trim()) throw new Error('repository, goal and prompt are required');
  const jobId = crypto.randomUUID();
  await hooks.run('BEFORE_TASK', { jobId, repository: body.repository, at: new Date().toISOString(), detail: body.goal });
  const workspace = existingWorkspace ?? await createWorkspace(env, body.repository, body.projectName || body.goal.slice(0, 32));
  // Best-effort: a Project Kernel detection failure (network hiccup,
  // malformed manifest) must never block the job — it only means the
  // Validation Contract shortcuts below stay unavailable for this job.
  const kernel = await detectProjectKernel(env, workspace.repository, workspace.defaultBranch).catch(
    (): Awaited<ReturnType<typeof detectProjectKernel>> => ({ mode: 'GENERIC_REPO', reason: 'not_found' }),
  );
  const definitionOfDone = (body.definitionOfDone ?? []).filter((item) => typeof item === 'string' && item.trim()).slice(0, 30);
  // Context Assembler (contextAssembler.ts): only for KERNEL_AWARE repos —
  // a GENERIC_REPO has no contextRouting to resolve. Best-effort: a Kernel
  // doc fetch failure (network hiccup, since-deleted file) must never block
  // job creation, same reasoning as the kernel detection above.
  const assembledContext = kernel.mode === 'KERNEL_AWARE' && kernel.manifest
    ? await assembleKernelContext({
      env,
      repository: workspace.repository,
      ref: workspace.defaultBranch,
      manifest: kernel.manifest,
      task: body.prompt,
    }).catch((): Awaited<ReturnType<typeof assembleKernelContext>> | undefined => undefined)
    : undefined;
  const deterministicPrompt = buildChatGptHandoff({
    repository: workspace.repository,
    branch: workspace.branch,
    defaultBranch: workspace.defaultBranch,
    goal: body.goal,
    task: body.prompt,
    definitionOfDone,
  }) + (assembledContext?.text ? `\n\nこのリポジトリのProject Kernelから読み込んだ関連コンテキスト:\n\n${assembledContext.text}` : '');
  const decision = await runOrchestrationModel(env, {
    mode: 'PLAN',
    repository: workspace.repository,
    branch: workspace.branch,
    goal: body.goal,
    task: body.prompt,
    evidence: `A protected feature branch has been prepared at ${workspace.branch}. No implementation has been performed by the external API.`
      + (assembledContext?.text ? `\n\nProject Kernel context (CORE${assembledContext.sections.some((section) => section.tier === 'scoped') ? '+SCOPED' : ''}):\n${assembledContext.text}` : ''),
    deterministicPrompt,
  });

  const now = new Date().toISOString();
  let job: DeveloperJob = {
    id: jobId,
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
    orchestratorRateLimited: decision.rateLimited,
    chatUrl: body.chatUrl?.trim() || undefined,
    autoDispatch: Boolean(body.autoDispatch),
    kernelMode: kernel.mode,
    kernelManifest: kernel.manifest,
    inferredContract: kernel.inferredContract,
    routePlan: parseRoutePlanInput(body.routePlan),
    trace: [{ event: 'CREATED', at: now, detail: body.goal.slice(0, 160) }],
  };
  await saveJob(env, job);
  await hooks.run('AFTER_TASK', { jobId: job.id, repository: job.repository, branch: job.workspace.branch, at: job.updatedAt });
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
  if (headChanged) await hooks.run('BEFORE_VALIDATION', { jobId: job.id, repository: job.repository, branch: job.workspace.branch, at: new Date().toISOString(), detail: repo.headSha });
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
    // Fires on every refresh cycle the job remains CODE_FAILURE (not
    // deduplicated by failureFingerprint) — a future handler that sends a
    // notification per firing should dedupe on its own, the same way
    // prepareRecovery's own fingerprint check below avoids re-generating a
    // recovery prompt for a failure it already handled.
    await hooks.run('CI_FAILED', { jobId: job.id, repository: job.repository, branch: job.workspace.branch, at: new Date().toISOString(), detail: repo.headSha });
    const reason = assessment.declaredCategories?.length
      ? `現在headのCIが失敗しています(このリポジトリのValidation Contractが宣言するカテゴリ: ${assessment.declaredCategories.join(', ')})。停止せず、ChatGPTへ原因確認と修正を引き継ぎます。`
      : '現在headのCIが失敗しています。停止せず、ChatGPTへ原因確認と修正を引き継ぎます。';
    return prepareRecovery(env, job, repo.headSha, assessment.failed, reason, 'CI_CODE_FAILURE', assessment.declaredCategories);
  }

  if (hasAutopilotRouteContract(job.prompt) && !hasAutopilotRouteCompletionMarker(repo.headCommitMessage)) {
    const autopilotRoute = recordAutopilotRouteCheckpoint(
      job.autopilotRoute,
      repo.headSha,
      new Date().toISOString(),
      extractAutopilotRouteStep(repo.headCommitMessage),
    );
    // recordAutopilotRouteCheckpoint returns the SAME reference when the
    // head hasn't advanced since the last recorded checkpoint (it only
    // appends on a genuinely new head). Re-entering this branch on every
    // refresh of an unchanged still-in-progress head must not also
    // re-append to trace — a minute-by-minute poll would otherwise fill the
    // capped trace with identical ROUTE_CHECKPOINT entries and evict real
    // history (creation, recovery) that trace exists to preserve.
    const routeAdvanced = autopilotRoute !== job.autopilotRoute;
    const continuationPrompt = buildAutopilotRouteContinuationPrompt({
      repository: job.repository,
      branch: job.workspace.branch,
      goal: job.goal,
      originalTask: job.prompt,
      headSha: repo.headSha,
      checks,
      routeState: autopilotRoute,
    });
    job = {
      ...job,
      status: 'running',
      phase: 'handoff_ready',
      error: undefined,
      handoffPrompt: continuationPrompt,
      outputText: '現在headのCIは成功しました。AUTOPILOT ROUTEの途中チェックポイントとして扱い、完了済み工程を飛ばさず次の未完了工程へ進むChatGPT指示を準備しました。',
      autopilotRoute,
      trace: routeAdvanced ? appendTrace(job, 'ROUTE_CHECKPOINT', extractAutopilotRouteStep(repo.headCommitMessage)) : job.trace,
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

  await hooks.run('BEFORE_COMPLETE', { jobId: job.id, repository: job.repository, branch: job.workspace.branch, at: new Date().toISOString(), detail: repo.headSha });
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
    autopilotRoute: hasAutopilotRouteContract(job.prompt)
      ? markAutopilotRouteCompleted(job.autopilotRoute, new Date().toISOString())
      : job.autopilotRoute,
    trace: appendTrace(job, 'COMPLETED', pullRequest ? `PR #${pullRequest.number}` : undefined),
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
  // Advisory proxy, not a token-count measurement — see contextPressure.ts's
  // own comment on why the Worker cannot know the chat's real context
  // usage. Computed from THIS job's own recovery/route history so it only
  // reflects how long-running *this* conversation has likely been, not
  // some cross-job global count.
  const pressure = deriveContextPressure({
    recoveryCount: job.recoveryCount,
    routeCheckpointCount: job.autopilotRoute?.checkpoints.length ?? 0,
  });
  // declaredCategories folds into the fingerprint (see failureFingerprint's
  // own comment) so a category discovered on a later refresh — after an
  // earlier one landed here with it still unknown, since getWorkflowRunJobs
  // is best-effort — invalidates the cached handoffPrompt instead of being
  // silently dropped.
  //
  // contextPressure is deliberately NOT passed into classifyFailureCategory
  // here: this call site always has a real CI-derived classification (that
  // field exists for the opposite case — no CI signal at all, see its own
  // doc comment). recoveryCount/routeCheckpointCount are monotonic and never
  // reset, so once pressure reaches HIGH it would stay HIGH for the rest of
  // the job's life, permanently masking the actual failureCategory (and,
  // through it, recoveryStrategy — e.g. a real GUARD_FAILURE would never
  // resolve to RELOAD_KERNEL again). High pressure is carried as an
  // additional handoff signal on the prompt instead (below), never as an
  // override of which failure this actually is.
  const failureCategory = classifyFailureCategory({
    ciClassification: classification,
    declaredCategories,
  });
  const fingerprint = checks.length ? failureFingerprint(headSha, checks, declaredCategories) : `${headSha}:no-ci`;
  if (job.lastFailureFingerprint === fingerprint && job.handoffPrompt) {
    // job.recoveryStrategy is the value a prior call to this function
    // already computed for this exact fingerprint (nothing new happened
    // since — that's what makes this the dedup fast-path) — reuse it rather
    // than recomputing, so an ASK_HUMAN escalation from a prior refresh
    // isn't lost just because this refresh saw the identical evidence.
    const phase: DeveloperJobPhase = classification === 'HUMAN_REQUIRED' || job.recoveryStrategy === 'ASK_HUMAN' ? 'human_required' : 'recovery_ready';
    let stable: DeveloperJob = { ...job, phase, error: reason, failureCategory, updatedAt: new Date().toISOString() };
    await saveJob(env, stable);
    if (phase !== 'human_required') stable = await queueHandoffIfEnabled(env, stable);
    return stable;
  }

  // Only counted on an actually-new observation (this branch), never in the
  // dedup fast-path above — see recurringFailureSignature's own comment.
  const signature = recurringFailureSignature(checks.map((check) => check.name), failureCategory);
  const recurringFailureCount = job.recurringFailureSignature === signature ? (job.recurringFailureCount ?? 1) + 1 : 1;
  const recoveryStrategy = resolveRecoveryStrategy({ category: failureCategory, sameFingerprintRepeatCount: recurringFailureCount });

  // High context pressure rides alongside the real strategy hint (never in
  // place of it) — see the note above classifyFailureCategory on why the
  // failure category/strategy itself must stay accurate even when pressure
  // is high.
  const strategyHint = [
    recoveryStrategyPromptHint(recoveryStrategy),
    pressure === 'HIGH' ? recoveryStrategyPromptHint('CREATE_HANDOFF') : '',
  ].filter(Boolean).join('\n');
  const deterministicPrompt = buildRecoveryPrompt({
    repository: job.repository,
    branch: job.workspace.branch,
    goal: job.goal,
    originalTask: job.prompt,
    headSha,
    checks,
    previousSummary: job.outputText,
    declaredCategories,
    routeState: job.autopilotRoute,
    strategyHint,
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
    // recoveryStrategy === 'ASK_HUMAN' covers the Recovery Matrix's own
    // escalation (e.g. a TRANSIENT_FAILURE/CI_CONFIG_FAILURE that has now
    // recurred past ALTERNATIVE_STRATEGY_THRESHOLD — see recoveryMatrix.ts)
    // — without this, recoveryStrategyPromptHint() correctly stays empty
    // for ASK_HUMAN (it documents itself as "handled by phase routing"),
    // but nothing actually routed the phase, so auto-dispatch kept
    // re-queuing the same unhelpful retry prompt to ChatGPT indefinitely.
    phase: classification === 'HUMAN_REQUIRED' || decision.classification === 'HUMAN_REQUIRED' || recoveryStrategy === 'ASK_HUMAN' ? 'human_required' : 'recovery_ready',
    model: decision.model,
    orchestratorProvider: decision.provider,
    outputText: `${reason}\n\n${decision.summary}`,
    handoffPrompt: decision.chatgptPrompt,
    error: reason,
    lastFailureFingerprint: fingerprint,
    recoveryCount: job.recoveryCount + 1,
    failureCategory,
    recoveryStrategy,
    recurringFailureSignature: signature,
    recurringFailureCount,
    degradedOrchestration: decision.degraded,
    orchestratorRateLimited: decision.rateLimited,
    trace: appendTrace(job, `RECOVERY:${failureCategory}`, `strategy=${recoveryStrategy}${pressure !== 'LOW' ? ` contextPressure=${pressure}` : ''}`),
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
