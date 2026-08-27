import { describe, expect, it } from 'vitest';
import { ProjectCoordinator } from './projectCoordinator';
import { acquireBranchWriteLease, releaseBranchWriteLease, renewBranchWriteLease } from './writeLease';
import type { AtomicCoordinatorEnv } from './projectCoordinator';

// Each scope (branch-write:<repository>:<branch>) maps to its OWN
// ProjectCoordinator instance with its own storage, matching real Durable
// Objects (a different idFromName() is a genuinely different physical
// object) — unlike a single-shared-instance test double, this correctly
// exercises that two different branches never see each other's lease.
function createMultiScopeCoordinatorEnv(): AtomicCoordinatorEnv {
  const coordinators = new Map<string, ProjectCoordinator>();
  function coordinatorFor(scope: string) {
    let existing = coordinators.get(scope);
    if (!existing) {
      const values = new Map<string, unknown>();
      let tail: Promise<unknown> = Promise.resolve();
      const state = {
        storage: {
          get: async <T>(key: string) => values.get(key) as T | undefined,
          put: async (key: string, value: unknown) => { values.set(key, value); },
          delete: async (key: string) => values.delete(key),
          list: async <T>({ prefix = '' }: { prefix?: string } = {}) => new Map(
            [...values.entries()].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>,
          ),
        },
        blockConcurrencyWhile: <T>(callback: () => Promise<T>) => {
          const run = tail.then(callback, callback);
          tail = run.then(() => undefined, () => undefined);
          return run;
        },
      } as unknown as DurableObjectState;
      existing = new ProjectCoordinator(state);
      coordinators.set(scope, existing);
    }
    return existing;
  }

  return {
    PROJECT_COORDINATOR: {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: (id: { name: string }) => ({
        fetch: (request: Request) => coordinatorFor(id.name).fetch(request),
      }),
    } as unknown as DurableObjectNamespace,
  };
}

describe('acquireBranchWriteLease', () => {
  it('is unavailable without an atomic coordinator', async () => {
    const result = await acquireBranchWriteLease({}, 'octocat/example', 'feature-branch', 'job-1');
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.reason).toBe('coordinator_unavailable');
  });

  it('acquires a lease for a branch with no existing holder', async () => {
    const env = createMultiScopeCoordinatorEnv();
    const result = await acquireBranchWriteLease(env, 'octocat/example', 'feature-branch', 'job-1');
    expect(result.acquired).toBe(true);
  });

  it('refuses a second job on the same branch while the first lease is held', async () => {
    const env = createMultiScopeCoordinatorEnv();
    const first = await acquireBranchWriteLease(env, 'octocat/example', 'feature-branch', 'job-1');
    expect(first.acquired).toBe(true);

    const second = await acquireBranchWriteLease(env, 'octocat/example', 'feature-branch', 'job-2');
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.reason).toBe('held_by_other');
  });

  it('lets two different branches acquire independently', async () => {
    const env = createMultiScopeCoordinatorEnv();
    const first = await acquireBranchWriteLease(env, 'octocat/example', 'branch-a', 'job-1');
    const second = await acquireBranchWriteLease(env, 'octocat/example', 'branch-b', 'job-2');
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(true);
  });
});

describe('renewBranchWriteLease / releaseBranchWriteLease', () => {
  it('renews a held lease', async () => {
    const env = createMultiScopeCoordinatorEnv();
    const acquired = await acquireBranchWriteLease(env, 'octocat/example', 'feature-branch', 'job-1');
    if (!acquired.acquired) throw new Error('expected acquisition to succeed');

    const renewed = await renewBranchWriteLease(env, acquired.lease);
    expect(renewed.renewed).toBe(true);
  });

  it('lets a new job acquire the branch after the holder releases it', async () => {
    const env = createMultiScopeCoordinatorEnv();
    const acquired = await acquireBranchWriteLease(env, 'octocat/example', 'feature-branch', 'job-1');
    if (!acquired.acquired) throw new Error('expected acquisition to succeed');

    await releaseBranchWriteLease(env, acquired.lease);
    const second = await acquireBranchWriteLease(env, 'octocat/example', 'feature-branch', 'job-2');
    expect(second.acquired).toBe(true);
  });

  it('does not throw when renewing/releasing a lease that is no longer valid', async () => {
    const env = createMultiScopeCoordinatorEnv();
    const stale = { scope: 'branch-write:octocat/example:gone', token: 'not-a-real-token', expiresAt: new Date().toISOString() };
    await expect(renewBranchWriteLease(env, stale)).resolves.toEqual({ renewed: false });
    await expect(releaseBranchWriteLease(env, stale)).resolves.toBeUndefined();
  });
});
