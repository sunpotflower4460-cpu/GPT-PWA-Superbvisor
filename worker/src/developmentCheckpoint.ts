import { DeveloperJob } from './developerAgent';
import { ContextPressureLevel, deriveContextPressure } from './contextPressure';
import { resolveRouteDispatchChatUrl } from './routePlan';

// The structured, queryable checkpoint the design calls for
// (DevelopmentCheckpoint), derived on read from a DeveloperJob rather than
// stored as its own persisted shape. DeveloperJob's flat field bag is
// already the actual source of truth, persisted in KV and read/written by
// every code path in developerAgent.ts — introducing a second, independently
// persisted checkpoint object would mean keeping two representations of the
// same job in sync, a real source of drift bugs. Building this as a pure
// projection instead means it can never disagree with the job it was built
// from, and adding/reshaping a field here never requires a storage
// migration.
//
// worktree stays permanently null/omitted with an explicit note rather than
// silently absent: this system has no local git worktree at all (every
// mutation goes through the GitHub REST API — see githubExecutor.ts and
// docs/ARCHITECTURE.md), so "no worktree" is a true architectural fact, not
// a gap to fill in later. See also writeLease.ts, which uses the branch
// itself (not a worktree) as the unit a concurrent-write lease binds to.
export interface DevelopmentCheckpoint {
  goal: string;
  // routeId/routeNode/route are the design's Route layer, kept distinct
  // from Goal and Task on purpose (see routePlan.ts's own comment on why
  // the declared plan and the self-reported progress against it are two
  // separate things, never merged). routeId is set whenever the job has
  // EITHER a declared plan or self-reported route progress. `route` is the
  // declared plan (job.routePlan, an ordered list of phase labels — empty
  // when no plan was declared). `routeNode` is the most recently
  // self-reported step from orchestratorPolicy.ts's AutopilotRouteState —
  // free text ChatGPT wrote into a commit message, never validated against
  // `route`, since the Worker cannot verify that self-report is accurate.
  routeId?: string;
  route: string[];
  routeNode?: string;
  // Multi Chat / Specialist Chat: the chat the NEXT auto-dispatch would
  // actually target — the current declared phase's bound chatUrl (job's
  // Worker-owned routePhaseIndex, see routePlan.ts's
  // resolveRouteDispatchChatUrl) if one exists, otherwise the job's default
  // chatUrl. undefined means there is nowhere to dispatch to at all.
  dispatchChatUrl?: string;
  task: string;
  repository: string;
  branch: string;
  baseSha: string;
  headSha?: string;
  worktree: null;
  verifiedDone: string[];
  activeWork: string[];
  validation: {
    ci?: 'PENDING' | 'PASSING' | 'FAILING' | 'UNKNOWN';
    guard?: 'PASSING' | 'FAILING' | 'UNKNOWN';
  };
  decisions: string[];
  blockers: string[];
  recentFailures: string[];
  nextAction: string;
  // Advisory proxy for how long-running this job's conversation likely is
  // — see contextPressure.ts's own note on why this is not a real
  // token-count measurement.
  contextPressure: ContextPressureLevel;
  // Chronological log of real state transitions (see developerAgent.ts's
  // appendTrace) — capped, oldest-dropped-first.
  trace: Array<{ event: string; at: string; detail?: string }>;
  createdAt: string;
  updatedAt: string;
}

export function buildDevelopmentCheckpoint(job: DeveloperJob): DevelopmentCheckpoint {
  const progress = job.autopilotRoute;
  const routeId = progress || job.routePlan?.length ? job.id : undefined;
  const route = (job.routePlan ?? []).map((node) => node.label);
  const routeNode = progress ? [...progress.checkpoints].reverse().find((checkpoint) => checkpoint.step)?.step : undefined;

  const verifiedDone = (progress?.checkpoints ?? [])
    .filter((checkpoint) => checkpoint.step)
    .map((checkpoint) => `${checkpoint.step} (${checkpoint.headSha.slice(0, 7)})`);

  const activeWork = job.status === 'running' || job.status === 'starting'
    ? [job.prompt.slice(0, 400)]
    : [];

  const ci: DevelopmentCheckpoint['validation']['ci'] = job.phase === 'waiting_ci'
    ? 'PENDING'
    : job.phase === 'review_ready'
      ? 'PASSING'
      : job.phase === 'recovery_ready' || job.phase === 'human_required'
        ? 'FAILING'
        : 'UNKNOWN';
  // Guarded by `ci !== 'PASSING'`, not just the presence of a guard-related
  // failureCategory: that field persists from the most recent recovery even
  // after a later successful CI run (job.failureCategory is never cleared
  // on success), so without this check a job that already fixed its guard
  // violation and reached review_ready would still project a live guard
  // failure here. completionJudge.ts's evaluateDeterministicCompletion()
  // guards the same way (guardPassing = ciPassing || ...) for the same
  // reason — keep both in agreement.
  const guardFailing = job.failureCategory === 'GUARD_FAILURE' || job.failureCategory === 'POLICY_FAILURE';
  const guard = guardFailing && ci !== 'PASSING' ? 'FAILING' : 'UNKNOWN';

  const blockers: string[] = [];
  if (job.phase === 'human_required') blockers.push(job.error || 'Human approval required.');
  if (job.lastDispatchError) blockers.push(`Chat Control Bus dispatch failed: ${job.lastDispatchError}`);

  const recentFailures: string[] = [];
  if (job.failureCategory && job.error) {
    recentFailures.push(`[${job.failureCategory}]${job.recurringFailureCount && job.recurringFailureCount > 1 ? ` (x${job.recurringFailureCount})` : ''} ${job.error}`);
  }

  const nextAction = job.phase === 'review_ready'
    ? (job.pullRequest ? `Human review of Draft PR #${job.pullRequest.number}.` : 'Human review of the completed branch.')
    : job.phase === 'human_required'
      ? (job.error || 'Waiting on a human decision.')
      : (job.handoffPrompt?.slice(0, 400) || job.outputText?.slice(0, 400) || 'Waiting for the next observable change.');

  return {
    goal: job.goal,
    routeId,
    route,
    routeNode,
    dispatchChatUrl: resolveRouteDispatchChatUrl(job.routePlan, job.routePhaseIndex ?? 0, job.chatUrl),
    task: job.prompt,
    repository: job.repository,
    branch: job.workspace.branch,
    baseSha: job.workspace.baseSha,
    headSha: job.lastHeadSha,
    worktree: null,
    verifiedDone,
    activeWork,
    validation: { ci, guard },
    // Always empty today: DeveloperJob carries no structured decision log
    // (only free-text outputText/handoffPrompt). Left as a real field
    // rather than dropped so a future structured-decision source (e.g. a
    // Kernel-aware DECISIONS.md read via contextAssembler.ts) has
    // somewhere to attach without another shape change.
    decisions: [],
    blockers,
    recentFailures,
    nextAction,
    contextPressure: deriveContextPressure({
      recoveryCount: job.recoveryCount,
      routeCheckpointCount: progress?.checkpoints.length ?? 0,
    }),
    trace: job.trace ?? [],
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
