import { DeveloperJob } from './developerAgent';
import { hasAutopilotRouteContract } from './orchestratorPolicy';

// COMPLETION_CANDIDATE -> Deterministic Judge -> Semantic Judge ->
// Completion Certificate, per the design. "AIが完了と言っただけでは
// completedにしない" — the point is that ChatGPT/the orchestrator reaching
// a self-reported end state is only ever a CANDIDATE, never proof.
export type CompletionState = 'NOT_CANDIDATE' | 'COMPLETION_CANDIDATE' | 'CERTIFIED' | 'REJECTED';

export interface DeterministicJudgeResult {
  ciPassing: boolean;
  guardPassing: boolean;
  routeComplete: boolean;
  humanApprovalOutstanding: boolean;
  pass: boolean;
  reasons: string[];
}

// Everything this can check is limited to what the Worker actually observes
// today (see docs/ARCHITECTURE.md's own note that it never executes code
// itself — CI is the only real test/build/typecheck evidence available on
// this side; see executionFabric.ts for why a local runTest/runBuild
// equivalent does not exist here). This is deliberately conservative: it
// never returns pass:true from job.status alone (a self-reported
// 'completed' with real CI evidence contradicting it must still fail here).
export function evaluateDeterministicCompletion(job: DeveloperJob): DeterministicJudgeResult {
  const reasons: string[] = [];

  const ciPassing = job.phase === 'review_ready';
  if (!ciPassing) reasons.push(`CI/監視フェーズが未完了です (phase=${job.phase})`);

  // No repo-declared GUARD_FAILURE/POLICY_FAILURE has been observed for the
  // CURRENT head — job.failureCategory/error persist from the most recent
  // recovery even after later succeeding, so this only counts them when the
  // job is not currently in a passing phase (a stale category from an
  // already-fixed earlier failure must not block a since-passed job).
  const guardPassing = ciPassing || (job.failureCategory !== 'GUARD_FAILURE' && job.failureCategory !== 'POLICY_FAILURE');
  if (!guardPassing) reasons.push(`Kernelのガード/ポリシー違反が未解決です: ${job.error || job.failureCategory}`);

  const routeComplete = !hasAutopilotRouteContract(job.prompt) || Boolean(job.autopilotRoute?.completedAt);
  if (!routeComplete) reasons.push('AUTOPILOT ROUTEが完了マーカーに到達していません');

  const humanApprovalOutstanding = job.phase === 'human_required';
  if (humanApprovalOutstanding) reasons.push('人間の承認/操作待ちです');

  const pass = ciPassing && guardPassing && routeComplete && !humanApprovalOutstanding;
  return { ciPassing, guardPassing, routeComplete, humanApprovalOutstanding, pass, reasons };
}

// Deliberately an interface with no default "yes" implementation, per the
// design's own instruction: implement the state machine and the extension
// point first, and do not hand a fake semantic judgment to an external
// coding agent to fill in later. A real implementation (an LLM asked "does
// this diff actually satisfy the goal, is scope drift present, is the
// architecture sound") is future work that plugs in here; until one exists,
// pendingSemanticJudge below always reports PENDING rather than fabricating
// a PASS.
export interface SemanticJudgeResult {
  verdict: 'PASS' | 'FAIL' | 'PENDING';
  notes: string[];
}

export interface SemanticJudge {
  evaluate(job: DeveloperJob, deterministic: DeterministicJudgeResult): Promise<SemanticJudgeResult>;
}

export const pendingSemanticJudge: SemanticJudge = {
  async evaluate() {
    return { verdict: 'PENDING', notes: ['No Semantic Judge is configured — architecture/scope-drift/UX review still requires a human.'] };
  },
};

export interface CompletionCertificate {
  goal: 'PASS' | 'FAIL' | 'PENDING';
  ci: 'PASS' | 'FAIL' | 'PENDING';
  guard: 'PASS' | 'FAIL' | 'PENDING';
  semanticReview: 'PASS' | 'FAIL' | 'PENDING';
  blockingIssues: number;
  headSha?: string;
  knownLimitations: string[];
  state: CompletionState;
}

// For a human-facing summary line (e.g. a completion push notification)
// that needs ONE concrete reason, not the full list. knownLimitations can
// contain an empty string (parseVerdict's notes filter accepts any string,
// including ''), so a plain `knownLimitations[0]` fallback can surface an
// empty reason and fall through to whatever the caller substitutes next —
// this finds the first entry that's actually non-blank instead.
export function firstNonEmpty(items: string[] | undefined): string | undefined {
  return items?.find((item) => item.trim());
}

// Synchronous by design: only runs the Deterministic Judge and treats the
// Semantic Judge as always-PENDING (no SemanticJudge is wired in yet — see
// pendingSemanticJudge above). A future async variant that actually invokes
// a configured SemanticJudge belongs alongside whatever first implements
// one; adding an unused async seam here now would be speculative.
export function buildCompletionCertificate(job: DeveloperJob): CompletionCertificate {
  const deterministic = evaluateDeterministicCompletion(job);
  const state: CompletionState = job.status !== 'completed' && job.phase !== 'review_ready'
    ? 'NOT_CANDIDATE'
    : deterministic.pass
      ? 'COMPLETION_CANDIDATE' // semantic review still PENDING -> never auto-CERTIFIED here
      : 'REJECTED';

  return {
    // Deliberately never 'PASS': deterministic.pass only means "no
    // deterministic check contradicts completion" (CI green, route
    // complete, no outstanding approval) — it says nothing about whether
    // job.definitionOfDone was actually satisfied, which only a real
    // Semantic Judge could confirm, and none exists yet (pendingSemanticJudge
    // above always reports PENDING). Claiming 'PASS' here from deterministic
    // evidence alone would be exactly the "AI says done -> treat as done"
    // shortcut this whole module exists to prevent. 'FAIL' is still
    // warranted once REJECTED: a deterministic check actively contradicting
    // completion (e.g. CI red) is real negative evidence, unlike the
    // positive case which has no equivalent real evidence yet.
    goal: state === 'REJECTED' ? 'FAIL' : 'PENDING',
    // deterministic.ciPassing is a plain boolean (true only once phase
    // reaches review_ready), so reporting its negation directly here would
    // certify a job still in waiting_ci/waiting_chatgpt/handoff_ready as a
    // CI *failure* — there's no failure yet, just no result. FAIL is
    // reserved for a phase reached specifically because CI/recovery
    // observed an actual problem.
    ci: ciCertificateStatus(job),
    guard: guardCertificateStatus(job),
    semanticReview: 'PENDING',
    blockingIssues: deterministic.reasons.length,
    headSha: job.lastHeadSha,
    knownLimitations: deterministic.reasons,
    state,
  };
}

// The async counterpart buildCompletionCertificate's own comment above
// said would "belong alongside whatever first implements" a real
// SemanticJudge (see semanticJudge.ts's createSemanticJudge). Reuses
// every deterministic-side field from the sync certificate unchanged and
// only replaces semanticReview + re-derives state/goal from the real
// verdict instead of the permanent PENDING stub. A FAIL verdict here is
// real negative evidence exactly like a deterministic contradiction is —
// it downgrades an otherwise-passing deterministic result to REJECTED
// rather than leaving it stuck at COMPLETION_CANDIDATE forever.
export async function buildCompletionCertificateAsync(job: DeveloperJob, judge: SemanticJudge): Promise<CompletionCertificate> {
  const base = buildCompletionCertificate(job);
  if (base.state !== 'COMPLETION_CANDIDATE') return base;

  // Safe to recompute rather than thread through from buildCompletionCertificate:
  // base.state === 'COMPLETION_CANDIDATE' already means deterministic.pass was
  // true (see buildCompletionCertificate above), so this is pure and cheap.
  const semantic = await judge.evaluate(job, evaluateDeterministicCompletion(job));
  const state: CompletionState = semantic.verdict === 'PASS'
    ? 'CERTIFIED'
    : semantic.verdict === 'FAIL'
      ? 'REJECTED'
      : 'COMPLETION_CANDIDATE';

  return {
    ...base,
    goal: semantic.verdict,
    semanticReview: semantic.verdict,
    blockingIssues: base.blockingIssues + (semantic.verdict === 'FAIL' ? 1 : 0),
    knownLimitations: [...base.knownLimitations, ...semantic.notes],
    state,
  };
}

function ciCertificateStatus(job: DeveloperJob): 'PASS' | 'FAIL' | 'PENDING' {
  if (job.phase === 'review_ready') return 'PASS';
  if (job.phase === 'recovery_ready' || job.phase === 'human_required') return 'FAIL';
  return 'PENDING'; // handoff_ready / waiting_chatgpt / waiting_ci — no CI result yet, not a failure
}

// Reuses ciCertificateStatus's phase bucketing (PENDING before any CI
// result exists, PASS once review_ready) and only overrides the FAIL case:
// a job in a failed CI phase whose specific observed failure was NOT
// guard/policy-related has no evidence its guard checks themselves failed
// (they may simply not have run yet, or passed while something else
// broke), so it stays PASS rather than inheriting the unrelated failure.
function guardCertificateStatus(job: DeveloperJob): 'PASS' | 'FAIL' | 'PENDING' {
  const status = ciCertificateStatus(job);
  if (status !== 'FAIL') return status;
  const guardFailing = job.failureCategory === 'GUARD_FAILURE' || job.failureCategory === 'POLICY_FAILURE';
  return guardFailing ? 'FAIL' : 'PASS';
}
