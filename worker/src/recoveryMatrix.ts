import { FailureCategory } from './failureTaxonomy';

// The design's Recovery Matrix, made concrete. Reuses the PWA's existing
// client-side vocabulary (src/supervisor.ts's RecoveryAction: RETRY,
// TRY_ALTERNATIVE, ASK_HUMAN, CREATE_HANDOFF) for the strategies that mean
// the same thing on both sides, plus two Worker-only strategies
// (RELOAD_KERNEL, ALTERNATE_RUNTIME) the PWA has no equivalent concept for
// (it never re-detects a repo's Project Kernel or switches execution
// runtimes — that's Worker-side machinery). Keeping the shared names
// identical, rather than inventing a parallel set, means a future unified
// view (e.g. a Completion/Recovery dashboard reading both) doesn't need a
// translation table between "the PWA's answer" and "the Worker's answer"
// for the cases where they're actually the same answer.
export type RecoveryStrategy =
  | 'RETRY'
  | 'TRY_ALTERNATIVE'
  | 'ALTERNATE_RUNTIME'
  | 'RELOAD_KERNEL'
  | 'CREATE_HANDOFF'
  | 'ASK_HUMAN'
  | 'NONE';

// A headSha-independent signature for "this same kind of failure", used to
// count REPEATED recovery attempts rather than repeated polling of an
// unchanged head. orchestratorPolicy.ts's failureFingerprint() deliberately
// includes headSha (it exists to dedupe re-processing the SAME still-
// unfixed commit across Guardian poll cycles) — reusing it here would mean
// every fix attempt produces a different fingerprint even when it fails the
// same way, so a genuinely stuck job would never reach
// ALTERNATIVE_STRATEGY_THRESHOLD. This signature intentionally drops
// headSha and each check's specific conclusion, keeping only which checks
// are failing plus the classified category — stable across distinct commits
// that fail "the same way".
export function recurringFailureSignature(checkNames: readonly string[], category: FailureCategory): string {
  return `${category}:${[...checkNames].sort().join(',')}`;
}

export interface RecoveryMatrixInput {
  category: FailureCategory;
  // How many consecutive refreshes have produced the SAME failureFingerprint
  // (see developerAgent.ts's sameFingerprintRepeatCount) — i.e. the same
  // failing checks on the same head, not merely "another failure of the
  // same category". 1 on first observation.
  sameFingerprintRepeatCount: number;
}

// Above this many consecutive identical-fingerprint failures, repeating the
// same repair approach is assumed exhausted — see design item #26
// (failureFingerprint) and #13 (STRATEGY_EXHAUSTED). Matches the PWA's own
// RETRY-vs-TRY_ALTERNATIVE threshold in src/supervisor.ts (retryCount < 2)
// closely enough in spirit (2 attempts before escalating) without copying
// its exact numbers, since the Worker's counter tracks the SAME failure
// fingerprint rather than a flat retry counter that resets on any change.
const ALTERNATIVE_STRATEGY_THRESHOLD = 3;

// Pure, total function. category is the primary key; repeatCount only
// matters for the categories where "try again" is even a sensible first
// move (see failureTaxonomy.isRetryableCategory) — a HUMAN_APPROVAL_REQUIRED
// failure is never going to resolve via repetition, so its strategy never
// depends on how many times it's been seen.
export function resolveRecoveryStrategy(input: RecoveryMatrixInput): RecoveryStrategy {
  const { category, sameFingerprintRepeatCount } = input;

  switch (category) {
    case 'HUMAN_APPROVAL_REQUIRED':
      return 'ASK_HUMAN';
    case 'RATE_LIMITED':
      // Waiting out a provider's rate limit is not a repair action at all —
      // the next scheduled refresh already retries automatically.
      return 'NONE';
    case 'CONTEXT_PRESSURE':
      return 'CREATE_HANDOFF';
    case 'POLICY_FAILURE':
    case 'GUARD_FAILURE':
      // A repo's own guard/policy check failing is evidence the Kernel's
      // rules (or the manifest itself) may have changed since this job
      // last read them — re-detecting before another blind repair attempt
      // avoids repairing against a stale understanding of the repo's own
      // constraints.
      return 'RELOAD_KERNEL';
    case 'ENV_FAILURE':
    case 'INFRA_FAILURE':
      return 'ALTERNATE_RUNTIME';
    case 'TRANSIENT_FAILURE':
    case 'CI_CONFIG_FAILURE':
      return sameFingerprintRepeatCount >= ALTERNATIVE_STRATEGY_THRESHOLD ? 'ASK_HUMAN' : 'RETRY';
    case 'STRATEGY_EXHAUSTED':
      return 'ASK_HUMAN';
    case 'CODE_FAILURE':
    case 'TEST_FAILURE':
    case 'TYPE_FAILURE':
    case 'BUILD_FAILURE':
    default:
      return sameFingerprintRepeatCount >= ALTERNATIVE_STRATEGY_THRESHOLD ? 'TRY_ALTERNATIVE' : 'RETRY';
  }
}

// A short, human/ChatGPT-facing instruction fragment for the strategy —
// used to make TRY_ALTERNATIVE an actual behavioral change in the recovery
// prompt (see orchestratorPolicy.ts's buildRecoveryPrompt strategyHint
// param) rather than a label nobody reads. Empty string for strategies that
// don't need to change how the prompt reads (RETRY is already the default
// prompt behavior; ASK_HUMAN/NONE/CREATE_HANDOFF are handled by phase
// routing, not prompt wording).
export function recoveryStrategyPromptHint(strategy: RecoveryStrategy): string {
  switch (strategy) {
    case 'TRY_ALTERNATIVE':
      return '同じ修正方針を繰り返しても解決していません。これまでと異なる原因の可能性を検討し、別の診断・別の修正アプローチを試してください。';
    case 'ALTERNATE_RUNTIME':
      return '環境・インフラ起因の失敗が疑われます。可能であれば別の実行経路（再実行、別ジョブ、別ランナー）を確認してください。';
    case 'RELOAD_KERNEL':
      return 'このリポジトリのガードレール/ポリシー設定（project-kernel.json、guard設定）を読み直し、最新の制約に沿っているか確認してから修正してください。';
    default:
      return '';
  }
}
