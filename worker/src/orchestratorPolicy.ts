export interface CiCheckLike {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  headSha: string;
}

export type CiAssessmentState =
  | 'NO_RUN'
  | 'PENDING'
  | 'SUCCESS'
  | 'TRANSIENT_FAILURE'
  | 'CODE_FAILURE'
  | 'HUMAN_REQUIRED';

export interface CiAssessment {
  state: CiAssessmentState;
  failed: CiCheckLike[];
  transient: CiCheckLike[];
  humanRequired: CiCheckLike[];
  // CODE_FAILURE only: every distinct declared category (Validation
  // Contract checks[].category, e.g. GUARD_FAILURE/POLICY_FAILURE/
  // ENV_FAILURE/INFRA_FAILURE) among the actionable (non-transient,
  // non-success) failing checks the repo's own Kernel labeled — see
  // applyDeclaredCategoryOverride below. A run can fail two independently-
  // categorized checks at once (e.g. lint AND a Terraform plan), so this is
  // a set, not a single value; picking only the first would silently drop
  // the other's evidence. Never fabricated from GitHub's own conclusion or
  // guessed; empty/absent whenever nothing declared a category (including
  // every GENERIC_REPO).
  declaredCategories?: string[];
}

export const AUTOPILOT_ROUTE_HEADER = '【AUTOPILOT ROUTE CONTRACT】';
export const AUTOPILOT_ROUTE_COMPLETE_MARKER = '[AUTOPILOT_ROUTE_COMPLETE]';
const AUTOPILOT_ROUTE_STEP_PATTERN = /\[AUTOPILOT_ROUTE_STEP:\s*([^\]\n]{1,200})\]/;
const MAX_AUTOPILOT_ROUTE_CHECKPOINTS = 20;

export interface AutopilotRouteCheckpoint {
  headSha: string;
  reachedAt: string;
  // Verbatim text extracted from an [AUTOPILOT_ROUTE_STEP: ...] marker in
  // the commit message at this checkpoint, when the executor included one.
  // Never interpreted, counted, or validated by the Worker — this is
  // self-reported free text, persisted as-is so a Handoff/new chat session
  // has real recorded context instead of having to re-derive route
  // progress from git history or trust discarded in-conversation memory.
  step?: string;
}

export interface AutopilotRouteState {
  checkpoints: AutopilotRouteCheckpoint[];
  completedAt?: string;
}

const SUCCESS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const TRANSIENT_CONCLUSIONS = new Set(['cancelled', 'timed_out', 'startup_failure', 'stale']);
const HUMAN_CONCLUSIONS = new Set(['action_required']);

// humanRequiredCheckNames comes from a repository's Project Kernel Validation
// Contract (checks[].category === 'HUMAN_APPROVAL_REQUIRED'). It exists
// because GitHub's own `action_required` conclusion is not a reliable
// signal on its own: a check job can call core.setFailed() to report a
// missing human approval, which GitHub reports as a plain `failure`
// conclusion, indistinguishable from a real code failure without this
// declared override. Absent/empty for GENERIC_REPO — falls back to the
// action_required-only heuristic unchanged.
export function assessCi(checks: CiCheckLike[], humanRequiredCheckNames?: ReadonlySet<string>): CiAssessment {
  if (!checks.length) return { state: 'NO_RUN', failed: [], transient: [], humanRequired: [] };
  if (checks.some((check) => check.status !== 'completed')) {
    return { state: 'PENDING', failed: [], transient: [], humanRequired: [] };
  }

  const failed = checks.filter((check) => !SUCCESS_CONCLUSIONS.has((check.conclusion || '').toLowerCase()));
  if (!failed.length) return { state: 'SUCCESS', failed: [], transient: [], humanRequired: [] };

  const humanRequired = failed.filter(
    (check) => HUMAN_CONCLUSIONS.has((check.conclusion || '').toLowerCase()) || humanRequiredCheckNames?.has(check.name),
  );
  if (humanRequired.length) return { state: 'HUMAN_REQUIRED', failed, transient: [], humanRequired };

  const transient = failed.filter((check) => TRANSIENT_CONCLUSIONS.has((check.conclusion || '').toLowerCase()));
  if (transient.length === failed.length) return { state: 'TRANSIENT_FAILURE', failed, transient, humanRequired: [] };

  return { state: 'CODE_FAILURE', failed, transient, humanRequired: [] };
}

// assessCi() only sees workflow-run-level data (GitHub's /actions/runs),
// whose `name` is the WORKFLOW's name — but a Project Kernel declares
// checks[].name at job granularity (GitHub's
// /actions/runs/{run_id}/jobs), which is what actually shows up as a
// named check on a PR. The two coincide only when a workflow has a single
// job sharing its name (e.g. GPT-template's "guard" workflow/job); they
// diverge whenever they don't (e.g. the "require-human-approval" workflow
// contains a job named "check-approval" — Kernel-declared checks[].name
// is "check-approval", but assessCi() alone can only ever see
// "require-human-approval"). This reconciles the two: given the actual
// job-level data for the same failing run(s), upgrade a workflow-run-
// level CODE_FAILURE/TRANSIENT_FAILURE to HUMAN_REQUIRED when a
// Kernel-declared human-approval check is the one that's actually failing.
// A no-op for PENDING/SUCCESS/NO_RUN, and merges into (never replaces) any
// human-required checks assessCi() already found via action_required.
export function applyHumanApprovalOverride(
  assessment: CiAssessment,
  jobLevelChecks: CiCheckLike[],
  humanRequiredCheckNames: ReadonlySet<string>,
): CiAssessment {
  if (!humanRequiredCheckNames.size) return assessment;
  if (assessment.state === 'PENDING' || assessment.state === 'SUCCESS' || assessment.state === 'NO_RUN') return assessment;

  const failingHumanChecks = jobLevelChecks.filter(
    (check) => humanRequiredCheckNames.has(check.name)
      && check.status === 'completed'
      && !SUCCESS_CONCLUSIONS.has((check.conclusion || '').toLowerCase()),
  );
  if (!failingHumanChecks.length) return assessment;

  const alreadyPresent = new Set(assessment.humanRequired.map((check) => check.name));
  const humanRequired = [...assessment.humanRequired, ...failingHumanChecks.filter((check) => !alreadyPresent.has(check.name))];
  return { state: 'HUMAN_REQUIRED', failed: assessment.failed, transient: [], humanRequired };
}

// Same job-level-vs-workflow-run-level problem applyHumanApprovalOverride
// solves for HUMAN_APPROVAL_REQUIRED specifically, generalized to any other
// declared category: a Kernel's checks[].category is declared at job
// granularity (e.g. a "lint" job inside a "ci" workflow), but assessCi()
// only ever sees workflow-run-level names unless given the real job-level
// data. Only enriches a plain CODE_FAILURE — HUMAN_REQUIRED/TRANSIENT_
// FAILURE/PENDING/SUCCESS/NO_RUN already have clearer meaning on their own,
// and re-labeling a human-approval check here would just fight
// applyHumanApprovalOverride over the same signal.
export function applyDeclaredCategoryOverride(
  assessment: CiAssessment,
  jobLevelChecks: CiCheckLike[],
  checkCategories: ReadonlyMap<string, string>,
): CiAssessment {
  if (!checkCategories.size || assessment.state !== 'CODE_FAILURE') return assessment;

  // A CODE_FAILURE run can still contain transient-looking checks alongside
  // the real failure (assessCi only escalates to TRANSIENT_FAILURE when
  // EVERY failing check is transient) — excluding them here keeps a
  // cancelled/timed-out/stale check's category from being mistaken for the
  // actionable failure's own. Collects every distinct category rather than
  // just the first match: two independently-categorized checks (e.g. lint
  // AND a Terraform plan) can fail in the same run, and picking only one
  // would silently discard the other's evidence.
  const categories = [...new Set(
    jobLevelChecks
      .filter((check) => {
        const conclusion = (check.conclusion || '').toLowerCase();
        return check.status === 'completed' && !SUCCESS_CONCLUSIONS.has(conclusion) && !TRANSIENT_CONCLUSIONS.has(conclusion);
      })
      .map((check) => checkCategories.get(check.name))
      .filter((value): value is string => Boolean(value) && value !== 'HUMAN_APPROVAL_REQUIRED'),
  )];

  return categories.length ? { ...assessment, declaredCategories: categories } : assessment;
}

// declaredCategories is optional and appended only when non-empty, so
// every existing 2-argument caller (e.g. the CI-auto-rerun dedup check) is
// unaffected. It matters for prepareRecovery's own dedup specifically:
// getWorkflowRunJobs is best-effort (Promise.allSettled), so an earlier
// refresh can land here with categories still unknown, cache a
// handoffPrompt against a fingerprint built from `checks` alone, and a
// later refresh — same failing run, same `checks` — would otherwise reuse
// that stale prompt forever even after the categories become available.
// Sorted so the same set in a different discovery order still fingerprints
// identically.
export function failureFingerprint(headSha: string, checks: CiCheckLike[], declaredCategories?: readonly string[]) {
  const signature = checks
    .map((check) => `${check.id}:${check.name}:${check.status}:${check.conclusion || ''}`)
    .sort()
    .join('|');
  const categorySuffix = declaredCategories?.length ? `:${[...declaredCategories].sort().join(',')}` : '';
  return `${headSha}:${signature}${categorySuffix}`;
}

export function isRetryableProviderStatus(status: number) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export function hasAutopilotRouteContract(task: string) {
  return task.includes(AUTOPILOT_ROUTE_HEADER);
}

export function hasAutopilotRouteCompletionMarker(commitMessage?: string) {
  return Boolean(commitMessage?.includes(AUTOPILOT_ROUTE_COMPLETE_MARKER));
}

export function extractAutopilotRouteStep(commitMessage?: string): string | undefined {
  return commitMessage?.match(AUTOPILOT_ROUTE_STEP_PATTERN)?.[1]?.trim() || undefined;
}

// The persisted, chat-text-independent half of route progress (docs/
// ARCHITECTURE.md §10 gap #4). Each CI-green-but-route-not-complete
// checkpoint the Worker's own gating logic (see developerAgent.ts)
// observes is a real, Worker-witnessed fact — this head, at this time,
// route not yet marked complete — not something reconstructed from git
// history or a chat's own conversational memory, which a Handoff
// explicitly discards. Only appends when the head actually changed since
// the last recorded checkpoint, so re-refreshing the same still-in-progress
// head doesn't pad the list; capped to the most recent N so a
// legitimately long-running route doesn't grow this without bound.
export function recordAutopilotRouteCheckpoint(
  state: AutopilotRouteState | undefined,
  headSha: string,
  reachedAt: string,
  step: string | undefined,
): AutopilotRouteState {
  const checkpoints = state?.checkpoints ?? [];
  if (checkpoints[checkpoints.length - 1]?.headSha === headSha) return state ?? { checkpoints };
  return { ...state, checkpoints: [...checkpoints, { headSha, reachedAt, step }].slice(-MAX_AUTOPILOT_ROUTE_CHECKPOINTS) };
}

// Idempotent: keeps the first-observed completion time rather than
// overwriting it on a later refresh that happens to re-check a job whose
// route was already marked complete.
export function markAutopilotRouteCompleted(state: AutopilotRouteState | undefined, completedAt: string): AutopilotRouteState {
  return { checkpoints: state?.checkpoints ?? [], completedAt: state?.completedAt ?? completedAt };
}

function definitionOfDone(items?: string[]) {
  return items?.length
    ? items.map((item) => `- ${item}`).join('\n')
    : '- Goalを満たすこと\n- 可能な検証を行うこと\n- 未確認事項と人間操作を明示すること';
}

function autopilotExecutionRule(task: string) {
  if (!hasAutopilotRouteContract(task)) return '';
  return `\n\nAUTOPILOT ROUTE:\n元TASK内の ${AUTOPILOT_ROUTE_HEADER} は実行契約です。工程順・反復回数・条件分岐を守り、CIが途中で成功しても後続工程を省略しないでください。中断後は完了済みパスをやり直さず、最初の未完了工程/パスから再開してください。全ルート工程と最終検証が完了した時だけ、最終コミットのメッセージに ${AUTOPILOT_ROUTE_COMPLETE_MARKER} を含めてください。まだ後続工程が残る状態でこのマーカーを付けてはいけません。最終工程で変更が不要だった場合、利用可能なGitHub操作でtreeを変えない安全な空コミットを作れるなら、そのコミットに完了マーカーを付けてください。できない場合は完了を偽装せず、その制約を明示してください。各コミットのメッセージに、現在のルート工程/反復回数を短く示す [AUTOPILOT_ROUTE_STEP: 内容] 形式の1行(例: [AUTOPILOT_ROUTE_STEP: 3回デバッグ 2/3回目])を含めてください。Supervisorはこの内容を解釈・検算せず、そのまま記録して次回の引き継ぎに使います。`;
}

function autopilotRouteHistory(routeState?: AutopilotRouteState) {
  if (!routeState?.checkpoints.length) return '';
  const lines = routeState.checkpoints
    .map((checkpoint) => `- ${checkpoint.reachedAt} (${checkpoint.headSha.slice(0, 7)}): ${checkpoint.step || '(工程の自己申告なし)'}`)
    .join('\n');
  return `\n\n過去に記録されたルートチェックポイント(chat本文とは独立してWorkerが保存したもの):\n${lines}`;
}

export function buildGenericChatGptHandoff(input: {
  projectName?: string;
  goal: string;
  currentPhase?: string;
  task: string;
  definitionOfDone?: string[];
}) {
  return `重要: この依頼の実行主体は、このChatGPTチャットです。Cloudflare WorkerやDeepSeek/MiniMax/OpenAI APIは監督・整理・次手生成だけを担当し、実作業を完了したふりをしてはいけません。\n\nPROJECT:\n${input.projectName || '未指定'}\n\nGOAL:\n${input.goal}\n\nCURRENT PHASE:\n${input.currentPhase || '未指定'}\n\nTASK:\n${input.task}\n\nDefinition of Done:\n${definitionOfDone(input.definitionOfDone)}\n\nこのChatGPTで利用可能なツール・接続先・現在の会話文脈を使って、実際にできる作業はここで進めてください。調査だけで終えず、安全に実行可能な実装・デバッグ・レビュー・検証は可能な範囲で実行してください。失敗した場合は同じ手順を漫然と繰り返さず、原因を確認して別手段または修正を試し、証拠を再確認してください。課金、秘密情報、本人確認、不可逆操作、本番公開など人間判断が必要なものだけ止めて明示してください。外部APIの要約だけを根拠に完成扱いせず、実際の結果・CI・取得できた証拠を優先してください。${autopilotExecutionRule(input.task)}`;
}

export function buildChatGptHandoff(input: {
  repository: string;
  branch: string;
  defaultBranch: string;
  goal: string;
  task: string;
  definitionOfDone?: string[];
}) {
  return `この作業の実装担当は、このChatGPTチャットです。外部APIは実装を行いません。\n\nRepository: ${input.repository}\n作業branch: ${input.branch}\nDefault branch: ${input.defaultBranch}\n\nGOAL:\n${input.goal}\n\nTASK:\n${input.task}\n\nDefinition of Done:\n${definitionOfDone(input.definitionOfDone)}\n\nGitHubを確認して必要な実装・デバッグ・テストをこのChatGPTから実際に行ってください。必ず指定branch上で作業し、main/default branchへ直接書き込まないでください。作業後はdiffとCIを確認し、失敗していたら原因を特定して修正→再確認まで進めてください。課金・秘密情報・本人確認・本番deploy・mergeなど人間判断が必要な操作は勝手に行わず、必要事項だけ明示してください。${autopilotExecutionRule(input.task)}`;
}

export function buildRecoveryPrompt(input: {
  repository: string;
  branch: string;
  goal: string;
  originalTask: string;
  headSha: string;
  checks: CiCheckLike[];
  previousSummary?: string;
  // The repo's own Validation Contract categories for the failing checks
  // (see applyDeclaredCategoryOverride), when known — a run can fail more
  // than one independently-categorized check at once. This is the
  // deterministic fallback prompt actually sent to ChatGPT whenever no
  // orchestration provider is configured or every one fails — it must
  // carry the same category info the LLM-generated path receives via
  // evidence, or the categories silently never reach ChatGPT on that path.
  declaredCategories?: readonly string[];
  // Structured, persisted route progress (see recordAutopilotRouteCheckpoint)
  // — independent of anything in the chat's own conversational memory.
  routeState?: AutopilotRouteState;
  // Recovery Matrix guidance (see recoveryMatrix.ts's recoveryStrategyPromptHint)
  // for the current failureFingerprint's repeat count. Empty/absent for the
  // common case (first or second occurrence) — only escalating strategies
  // like TRY_ALTERNATIVE change the prompt text at all.
  strategyHint?: string;
}) {
  const ci = input.checks.length
    ? input.checks.map((check) => `- ${check.name}: ${check.conclusion || check.status} (${check.url})`).join('\n')
    : '- CI runを確認できません';
  const categoryLine = input.declaredCategories?.length ? `\n宣言されたカテゴリ: ${input.declaredCategories.join(', ')}` : '';
  const strategyLine = input.strategyHint?.trim() ? `\n\n復旧方針:\n${input.strategyHint.trim()}` : '';
  const routeRecovery = hasAutopilotRouteContract(input.originalTask)
    ? `\n\nAUTOPILOT復旧ルール:\n元TASKのルート契約は復旧後も有効です。完了済み工程を最初から再実行せず、今回失敗した工程を直して再検証した後、最初の未完了工程/パスへ戻って残りルートを続けてください。CIが緑へ戻ったことはルート途中のチェックポイントであり、後続工程が残っている限り最終完了ではありません。全ルートが終わった時だけ ${AUTOPILOT_ROUTE_COMPLETE_MARKER} を最終コミットメッセージに含めてください。コミットメッセージには引き続き [AUTOPILOT_ROUTE_STEP: 内容] で現在工程を示してください。${autopilotRouteHistory(input.routeState)}`
    : '';

  return `この作業の実装修正担当は、このChatGPTチャットです。Supervisorは外部APIで監視だけを行っています。\n\nRepository: ${input.repository}\n作業branch: ${input.branch}\n現在head: ${input.headSha}\n\nGOAL:\n${input.goal}\n\n元のTASK:\n${input.originalTask}\n\nCI/監視結果:\n${ci}${categoryLine}\n\n直前の監督要約:\n${input.previousSummary || 'なし'}\n\n同じ失敗を繰り返さないでください。まず現在のbranch・diff・CI失敗箇所を実際に確認し、原因を切り分け、必要なコード修正またはテスト修正をこのChatGPTから行い、再度CIまで確認してください。CI自体の一時障害ならコードを無意味に変更せず再実行/再確認を優先してください。mainへの直接write・自動merge・本番deployはしないでください。${strategyLine}${routeRecovery}`;
}

export function buildAutopilotRouteContinuationPrompt(input: {
  repository: string;
  branch: string;
  goal: string;
  originalTask: string;
  headSha: string;
  checks: CiCheckLike[];
  // Structured, persisted route progress (see recordAutopilotRouteCheckpoint)
  // — independent of anything in the chat's own conversational memory, so
  // this continuation prompt carries real history even across a Handoff to
  // a fresh chat session.
  routeState?: AutopilotRouteState;
}) {
  const ci = input.checks.length
    ? input.checks.map((check) => `- ${check.name}: ${check.conclusion || check.status} (${check.url})`).join('\n')
    : '- CI runを確認できません';
  return `AUTOPILOT ROUTEを継続してください。この作業の実行主体は、このChatGPTチャットです。\n\nRepository: ${input.repository}\n作業branch: ${input.branch}\n現在head: ${input.headSha}\nGOAL: ${input.goal}\n\n元のTASK:\n${input.originalTask}\n\n現在headのCI:\n${ci}\n\n現在のCIは成功していますが、元TASKには ${AUTOPILOT_ROUTE_HEADER} があるため、CI成功だけでは完了扱いにしません。これまでのdiff・作業結果・会話文脈からルート進捗を確認し、完了済みの工程/パスは繰り返さず、最初の未完了工程/未完了パスから続行してください。回数指定と条件分岐を省略しないでください。全ルート工程と最終検証まで完了した場合だけ、最終コミットメッセージへ ${AUTOPILOT_ROUTE_COMPLETE_MARKER} を含めてください。それまではマーカーを付けず、次工程を実行してください。コミットメッセージには引き続き [AUTOPILOT_ROUTE_STEP: 内容] で現在工程を示してください。${autopilotRouteHistory(input.routeState)}`;
}
