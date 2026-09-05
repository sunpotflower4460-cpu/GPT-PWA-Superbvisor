import { CompletionCertificate } from './completionJudge';
import { BLOCKED_PATHS, GitHubEnv, GitHubWorkspace, MergeMethod, markPullRequestReadyForReview, mergePullRequest } from './githubExecutor';

// These are short-lived ai-dev-deck/* branches that accumulate noisy
// CI-auto-rerun/recovery commits — squashing collapses them into one
// commit, and the Draft PR body (buildPullRequestBody in
// developerAgent.ts) already doubles as a good squash message. No
// merge/rebase fallback chain for v1: if a repo's branch protection
// disallows squash merges, the call fails and lands in the same
// non-fatal "leave it for a human" bucket as any other merge failure.
export const AUTO_MERGE_METHOD: MergeMethod = 'squash';

// A hard, non-configurable rail — there is deliberately no parameter
// anywhere in this module to disable this list, not even via a project's
// own autoMerge opt-in. evaluateDeterministicCompletion's
// humanApprovalOutstanding/guard-passing logic (completionJudge.ts) is
// only trustworthy as long as the CI workflow definitions and Kernel
// manifest it depends on weren't altered in the same PR being certified —
// letting auto-merge apply to a PR that edits those files would let the
// feature invalidate the very evidence chain that makes CERTIFIED mean
// anything. This is not "more approval friction"; it's the one
// precondition auto-merge's own trustworthiness depends on. Every other
// kind of change (features, refactors, tests, docs, config) auto-merges
// freely once CERTIFIED.
export const MERGE_BLOCKED_PATHS = [
  ...BLOCKED_PATHS,
  /(^|\/)CODEOWNERS$/i,
  /(^|\/)project-kernel\.json$/i,
];

export interface AutoMergePolicyInput {
  certificate: CompletionCertificate | undefined;
  // Whatever compareWorkspace()'s GitHub Compare API returned. Note: GitHub
  // itself caps how many files a single Compare API response lists (the
  // same underlying limit buildPullRequestBody in developerAgent.ts already
  // works around by only rendering the first 50 for display) — an
  // extremely large diff could theoretically have a guarded-path file
  // beyond what's returned here. Pre-existing property of compareWorkspace,
  // not a new gap this feature introduces.
  changedFiles: Array<{ filename: string }>;
  autoMergeEnabled: boolean;
}

export interface AutoMergePolicyResult {
  allowed: boolean;
  reason?: string;
}

export function shouldAutoMerge(input: AutoMergePolicyInput): AutoMergePolicyResult {
  if (input.certificate?.state !== 'CERTIFIED') {
    return { allowed: false, reason: '未認定(CERTIFIED)のため自動マージ対象外です' };
  }
  if (!input.autoMergeEnabled) {
    return { allowed: false, reason: 'このプロジェクトは自動マージがオプトインされていません' };
  }
  const blocked = input.changedFiles.find((file) => MERGE_BLOCKED_PATHS.some((pattern) => pattern.test(file.filename)));
  if (blocked) {
    return { allowed: false, reason: `CI/ガバナンスに関わる変更を含むため自動マージを拒否しました: ${blocked.filename}` };
  }
  return { allowed: true };
}

export type AutoMergeOutcome =
  | { merged: true; mergedAt: string; mergeMethod: MergeMethod }
  | { merged: false; readyForReview: boolean; reason: string };

// Never throws — every outcome is a soft, recorded result, matching how
// tryCreateDraftPr (developerAgent.ts) already treats PR-creation failures.
// A merge conflict, a still-pending required check and a disallowed merge
// method are all ordinary, expected outcomes here, not exceptional errors:
// the caller leaves the job exactly where today's baseline already leaves
// it (an open PR for a human to merge) — no regression, only a missed
// optimization on that one job.
export async function attemptAutoMerge(
  env: GitHubEnv,
  workspace: GitHubWorkspace,
  pullNumber: number,
  mergeMethod: MergeMethod,
): Promise<AutoMergeOutcome> {
  try {
    await markPullRequestReadyForReview(env, workspace, pullNumber);
  } catch (error) {
    return { merged: false, readyForReview: false, reason: `ready-for-review化に失敗しました: ${errorMessage(error)}` };
  }

  try {
    const result = await mergePullRequest(env, workspace, pullNumber, mergeMethod);
    // GitHub's merge endpoint only returns a 2xx status on an actual
    // successful merge (failures are 405/409/422, all caught below) — this
    // check is defensive, not currently reachable, in case that assumption
    // ever stops holding.
    if (!result.merged) return { merged: false, readyForReview: true, reason: result.message || 'マージAPIが merged:false を返しました' };
    return { merged: true, mergedAt: new Date().toISOString(), mergeMethod };
  } catch (error) {
    // Undraft already succeeded — a human reviewing later should see a
    // normal open PR, not a permanently-stuck draft, even though the merge
    // itself didn't complete.
    return { merged: false, readyForReview: true, reason: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'auto-merge attempt failed';
}
