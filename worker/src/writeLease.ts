import {
  AtomicCoordinatorEnv,
  acquireCoordinatorLease,
  hasAtomicCoordinator,
  releaseCoordinatorLease,
  renewCoordinatorLease,
} from './projectCoordinator';

// The "worktree" binding design item #22 asks for (Task <-> Chat <-> Branch
// <-> Worktree <-> Runtime <-> write lease, one unit, never two Chats
// writing the same working tree) — reshaped for an architecture that has no
// local worktree at all (see developmentCheckpoint.ts's own note: every
// mutation goes through the GitHub REST API). The unit this system CAN
// actually protect is the branch itself: two DeveloperJobs (or a job and a
// manual/STEER-driven continuation) targeting the SAME branch is the real
// concurrent-write hazard here, not a local filesystem.
//
// Deliberately reuses ProjectCoordinator's existing generic lease primitive
// (acquire/renew/release — already used by guardianRunner.ts to serialize
// its own advance step) rather than inventing new distributed-lock
// machinery, per the design's own explicit guidance to build on what
// already exists.
//
// Best-effort by design, matching every other Kernel/Coordinator
// interaction in this codebase (see developerAgent.ts's kernel-detection
// and push-notification call sites): a lease that can't be acquired never
// blocks a job from being created, and a KV-only deployment (no
// PROJECT_COORDINATOR configured) simply has no protection to offer — this
// is advisory concurrency safety layered on top of a system that already
// works without it, not a hard precondition for writing at all.
//
// Deliberately NOT wired into developerAgent.ts's job-creation flow today:
// createWorkspace() already mints a brand-new, globally-unique branch name
// (BRANCH_PREFIX + random suffix) for every DeveloperJob, so two ordinary
// jobs structurally cannot collide on a branch today — acquiring a lease
// on a branch nothing else will ever request is a no-op that would only
// add a confusing, never-exercised "held_by_other" path to that flow. This
// primitive exists for what Phase K (Multi Chat / Worktree) actually
// needs: once multiple chats/agents can be assigned to the SAME branch
// (e.g. a task graph splitting one branch's work across Chat A/B), the
// dispatcher assigning that work is the real, honest call site — it
// should acquire here before handing a branch to a second chat while a
// first still holds it. Wiring this into single-writer code now, before
// that dispatcher exists, would be protecting against a hazard the
// codebase cannot currently produce.
const BRANCH_WRITE_LEASE_NAME = 'branch-write';
const DEFAULT_TTL_MS = 4 * 60_000;

export interface BranchWriteLease {
  scope: string;
  token: string;
  expiresAt: string;
}

export type AcquireBranchWriteLeaseResult =
  | { acquired: true; lease: BranchWriteLease }
  | { acquired: false; reason: 'held_by_other' | 'coordinator_unavailable' | 'request_failed'; heldBy?: string; expiresAt?: string; detail?: string };

export async function acquireBranchWriteLease(
  env: AtomicCoordinatorEnv,
  repository: string,
  branch: string,
  owner: string,
  ttlMs = DEFAULT_TTL_MS,
): Promise<AcquireBranchWriteLeaseResult> {
  if (!hasAtomicCoordinator(env)) return { acquired: false, reason: 'coordinator_unavailable' };
  const scope = branchLeaseScope(repository, branch);
  try {
    const result = await acquireCoordinatorLease(env, scope, { name: BRANCH_WRITE_LEASE_NAME, owner, ttlMs });
    if (!result.ok || !result.data.acquired || !result.data.lease) {
      return {
        acquired: false,
        reason: 'held_by_other',
        heldBy: result.data.lease?.owner,
        expiresAt: result.data.lease?.expiresAt,
      };
    }
    return { acquired: true, lease: { scope, token: result.data.lease.token, expiresAt: result.data.lease.expiresAt } };
  } catch (error) {
    return { acquired: false, reason: 'request_failed', detail: error instanceof Error ? error.message : 'lease acquire failed' };
  }
}

// Never throws — a renewal failure (lease lost, lost ownership race,
// coordinator unavailable) is reported, not thrown, so a caller in a
// polling loop (see developerAgent.ts's refreshDeveloperJob) can decide
// whether to keep going without protection rather than have the whole
// refresh cycle fail over an advisory lease.
export async function renewBranchWriteLease(
  env: AtomicCoordinatorEnv,
  lease: BranchWriteLease,
  ttlMs = DEFAULT_TTL_MS,
): Promise<{ renewed: boolean; lease?: BranchWriteLease }> {
  try {
    const result = await renewCoordinatorLease(env, lease.scope, { name: BRANCH_WRITE_LEASE_NAME, token: lease.token, ttlMs });
    if (!result.ok || !result.data.renewed || !result.data.lease) return { renewed: false };
    return { renewed: true, lease: { scope: lease.scope, token: result.data.lease.token, expiresAt: result.data.lease.expiresAt } };
  } catch {
    return { renewed: false };
  }
}

export async function releaseBranchWriteLease(env: AtomicCoordinatorEnv, lease: BranchWriteLease): Promise<void> {
  try {
    await releaseCoordinatorLease(env, lease.scope, { name: BRANCH_WRITE_LEASE_NAME, token: lease.token });
  } catch {
    // Best-effort: an unreleased lease simply expires on its own TTL.
  }
}

function branchLeaseScope(repository: string, branch: string) {
  return `branch-write:${repository}:${branch}`;
}
