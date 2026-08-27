// Single canonical Failure Taxonomy for the Worker side of AI DEV DECK.
//
// Before this module, "what kind of failure is this" was answered by three
// separate, not-quite-aligned vocabularies: CiAssessmentState (assessCi's
// six-state CI machine, orchestratorPolicy.ts), the inline classification
// union `developerAgent.ts`'s prepareRecovery() accepted
// ('CI_TRANSIENT'|'CI_CODE_FAILURE'|'CI_CONFIG_FAILURE'|'HUMAN_REQUIRED'),
// and OrchestrationClassification (orchestrationModel.ts's LLM-facing
// READY/WAIT/... enum). None of the three could express GUARD_FAILURE,
// POLICY_FAILURE, ENV_FAILURE, INFRA_FAILURE, TEST_FAILURE, TYPE_FAILURE,
// BUILD_FAILURE, RATE_LIMITED, CONTEXT_PRESSURE, or STRATEGY_EXHAUSTED as a
// distinct machine-readable value — those only ever showed up as free-form
// strings (Project Kernel declaredCategories) or were not represented at
// all. This module does not replace the three existing vocabularies (they
// stay in place — CiAssessmentState is still what assessCi()'s state
// machine over GitHub check data actually needs, and rewriting it would
// touch a lot of already-correct, already-tested logic for no behavioral
// gain). Instead it adds the one thing that was actually missing: a single
// FailureCategory enum covering every category the design calls for, plus
// a pure classifier that folds the existing signals into it. New code
// (recoveryMatrix.ts, developmentCheckpoint.ts, completionJudge.ts) is
// built against this module, not against the three narrower ones.
export type FailureCategory =
  | 'CODE_FAILURE'
  | 'TEST_FAILURE'
  | 'TYPE_FAILURE'
  | 'BUILD_FAILURE'
  | 'GUARD_FAILURE'
  | 'POLICY_FAILURE'
  | 'HUMAN_APPROVAL_REQUIRED'
  | 'CI_CONFIG_FAILURE'
  | 'INFRA_FAILURE'
  | 'ENV_FAILURE'
  | 'TRANSIENT_FAILURE'
  | 'RATE_LIMITED'
  | 'CONTEXT_PRESSURE'
  | 'STRATEGY_EXHAUSTED';

export const FAILURE_CATEGORIES: readonly FailureCategory[] = [
  'CODE_FAILURE',
  'TEST_FAILURE',
  'TYPE_FAILURE',
  'BUILD_FAILURE',
  'GUARD_FAILURE',
  'POLICY_FAILURE',
  'HUMAN_APPROVAL_REQUIRED',
  'CI_CONFIG_FAILURE',
  'INFRA_FAILURE',
  'ENV_FAILURE',
  'TRANSIENT_FAILURE',
  'RATE_LIMITED',
  'CONTEXT_PRESSURE',
  'STRATEGY_EXHAUSTED',
];

// Categories a Project Kernel's Validation Contract (checks[].category, see
// projectKernel.ts) is free to declare. Anything a repo author writes that
// isn't one of ours passes through unchanged in declaredCategories — this
// set is only used to recognize declared values as ALREADY being one of
// the canonical categories, so classifyFailureCategory doesn't need to
// re-derive them.
const KNOWN_CATEGORY_SET = new Set<string>(FAILURE_CATEGORIES);

export interface ClassifyFailureInput {
  // The CI-recovery classification prepareRecovery() already computes
  // today (see developerAgent.ts) — kept as the primary CI-side signal
  // since it already reconciles TRANSIENT_FAILURE/CODE_FAILURE/
  // CI_CONFIG_FAILURE/HUMAN_REQUIRED correctly against GitHub's own data.
  ciClassification?: 'CI_TRANSIENT' | 'CI_CODE_FAILURE' | 'CI_CONFIG_FAILURE' | 'HUMAN_REQUIRED';
  // Project Kernel Validation Contract declared categories for the specific
  // checks that are actually failing (assessCi's declaredCategories). A run
  // can fail more than one independently-categorized check at once — the
  // first KNOWN category wins (deterministic: declaration order from
  // getCheckCategoryMap, itself insertion-ordered from the manifest), a
  // strictly better answer than the generic CODE_FAILURE fallback whenever
  // the repo actually told us what broke.
  declaredCategories?: readonly string[];
  // True only when every configured orchestration provider's terminal
  // failure was specifically HTTP 429 (OrchestrationDecision.rateLimited).
  rateLimited?: boolean;
  // Explicit override for cases with no CI signal at all (worker-side
  // context-budget exhaustion is not currently self-detected — see
  // contextAssembler.ts's own note — so this stays caller-supplied rather
  // than invented here).
  contextPressure?: boolean;
}

// Pure, total function: always returns exactly one category, never throws.
// Precedence, most specific/actionable first:
//   1. an explicit contextPressure signal (caller-observed, not CI-derived)
//   2. rate limiting (orchestration-provider-side, unrelated to the repo's
//      own CI — takes priority over ciClassification because a rate-limited
//      orchestrator call still produced *a* ciClassification via the
//      deterministic fallback, which would otherwise mask the real cause)
//   3. a KNOWN declared category from the repo's own Validation Contract —
//      the repo author's own word for what broke beats our generic guess
//   4. the existing CI classification, mapped 1:1 onto the taxonomy
//   5. CODE_FAILURE as the final, always-safe default
export function classifyFailureCategory(input: ClassifyFailureInput): FailureCategory {
  if (input.contextPressure) return 'CONTEXT_PRESSURE';
  if (input.rateLimited) return 'RATE_LIMITED';

  const declaredKnown = input.declaredCategories?.find((category): category is FailureCategory => KNOWN_CATEGORY_SET.has(category));
  if (declaredKnown) return declaredKnown;

  switch (input.ciClassification) {
    case 'HUMAN_REQUIRED': return 'HUMAN_APPROVAL_REQUIRED';
    case 'CI_TRANSIENT': return 'TRANSIENT_FAILURE';
    case 'CI_CONFIG_FAILURE': return 'CI_CONFIG_FAILURE';
    case 'CI_CODE_FAILURE': return 'CODE_FAILURE';
    default: return 'CODE_FAILURE';
  }
}

// True for categories where retrying/repairing the SAME way is expected to
// help (a code fix, a rerun). False for categories where the Recovery
// Matrix (recoveryMatrix.ts) should never suggest "just try again" —
// human-gated or policy-gated states need a different action, not
// persistence.
export function isRetryableCategory(category: FailureCategory): boolean {
  return category !== 'HUMAN_APPROVAL_REQUIRED' && category !== 'RATE_LIMITED';
}
