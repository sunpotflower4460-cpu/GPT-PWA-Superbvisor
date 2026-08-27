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
    goal: deterministic.pass ? 'PASS' : (state === 'NOT_CANDIDATE' ? 'PENDING' : 'FAIL'),
    // deterministic.ciPassing is a plain boolean (true only once phase
    // reaches review_ready), so reporting its negation directly here would
    // certify a job still in waiting_ci/waiting_chatgpt/handoff_ready as a
    // CI *failure* — there's no failure yet, just no result. FAIL is
    // reserved for a phase reached specifically because CI/recovery
    // observed an actual problem.
    ci: ciCertificateStatus(job),
    guard: deterministic.guardPassing ? 'PASS' : 'FAIL',
    semanticReview: 'PENDING',
    blockingIssues: deterministic.reasons.length,
    headSha: job.lastHeadSha,
    knownLimitations: deterministic.reasons,
    state,
  };
}

function ciCertificateStatus(job: DeveloperJob): 'PASS' | 'FAIL' | 'PENDING' {
  if (job.phase === 'review_ready') return 'PASS';
  if (job.phase === 'recovery_ready' || job.phase === 'human_required') return 'FAIL';
  return 'PENDING'; // handoff_ready / waiting_chatgpt / waiting_ci — no CI result yet, not a failure
}
