import { describe, expect, it } from 'vitest';
import { ProjectCoordinator } from './projectCoordinator';

function createCoordinator() {
  const values = new Map<string, unknown>();
  let tail: Promise<unknown> = Promise.resolve();
  const storage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
    list: async <T>({ prefix = '' }: { prefix?: string } = {}) => new Map(
      [...values.entries()].filter(([key]) => key.startsWith(prefix)) as Array<[string, T]>,
    ),
  };
  const state = {
    storage,
    blockConcurrencyWhile: <T>(callback: () => Promise<T>) => {
      const run = tail.then(callback, callback);
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  } as unknown as DurableObjectState;
  return new ProjectCoordinator(state);
}

async function post(coordinator: ProjectCoordinator, path: string, body: unknown) {
  return coordinator.fetch(new Request(`https://coordinator.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('ProjectCoordinator command atomicity', () => {
  it('deduplicates simultaneous enqueue requests with the same key', async () => {
    const coordinator = createCoordinator();
    const body = {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/example',
      prompt: 'continue',
      dedupeKey: 'route:step-1',
    };
    const [a, b] = await Promise.all([
      post(coordinator, '/commands/enqueue', body),
      post(coordinator, '/commands/enqueue', body),
    ]);
    const first = await a.json() as { command: { id: string } };
    const second = await b.json() as { command: { id: string } };
    expect(first.command.id).toBe(second.command.id);
  });

  it('lets only one bridge own a simultaneous claim', async () => {
    const coordinator = createCoordinator();
    await post(coordinator, '/commands/enqueue', {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/example',
      prompt: 'continue',
    });
    const [a, b] = await Promise.all([
      post(coordinator, '/commands/claim', { bridgeId: 'bridge-a' }),
      post(coordinator, '/commands/claim', { bridgeId: 'bridge-b' }),
    ]);
    const claimed = [
      (await a.json() as { command: unknown }).command,
      (await b.json() as { command: unknown }).command,
    ].filter(Boolean);
    expect(claimed).toHaveLength(1);
  });

  it('rejects a delivery result from a bridge that does not own the claim', async () => {
    const coordinator = createCoordinator();
    const queued = await post(coordinator, '/commands/enqueue', {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/example',
      prompt: 'continue',
    });
    const id = (await queued.json() as { command: { id: string } }).command.id;
    await post(coordinator, '/commands/claim', { bridgeId: 'bridge-a' });
    const response = await post(coordinator, '/commands/result', {
      id,
      projectId: 'project-1',
      bridgeId: 'bridge-b',
      status: 'delivered',
    });
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toBe('claim_owner_mismatch');
  });

  it('releases bridge ownership when a failed delivery is queued for retry', async () => {
    const coordinator = createCoordinator();
    const queued = await post(coordinator, '/commands/enqueue', {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/example',
      prompt: 'continue',
    });
    const id = (await queued.json() as { command: { id: string } }).command.id;
    await post(coordinator, '/commands/claim', { bridgeId: 'bridge-a' });
    const failed = await post(coordinator, '/commands/result', {
      id,
      projectId: 'project-1',
      bridgeId: 'bridge-a',
      status: 'failed',
      detail: 'temporary host failure',
    });
    const updated = (await failed.json() as { command: { status: string; bridgeId?: string; nextAttemptAt?: string } }).command;
    expect(updated.status).toBe('queued');
    expect(updated.bridgeId).toBeUndefined();
    expect(updated.nextAttemptAt).toBeTruthy();
  });
});

describe('ProjectCoordinator state atomicity', () => {
  it('accepts only one simultaneous save from the same base revision', async () => {
    const coordinator = createCoordinator();
    const statePayload = {
      schema: 'gpt-pwa-supervisor.backup',
      version: 1,
      data: { projects: [], operatingPlans: {}, handoffs: [], notifications: [], watchdog: {} },
    };
    const [a, b] = await Promise.all([
      post(coordinator, '/state/save', { deviceId: 'device-a', baseRevision: null, data: statePayload }),
      post(coordinator, '/state/save', { deviceId: 'device-b', baseRevision: null, data: statePayload }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });
});

describe('ProjectCoordinator execution lease', () => {
  it('allows only one concurrent guardian advance owner', async () => {
    const coordinator = createCoordinator();
    const [a, b] = await Promise.all([
      post(coordinator, '/lease/acquire', { name: 'guardian-advance', owner: 'cron', ttlMs: 60_000 }),
      post(coordinator, '/lease/acquire', { name: 'guardian-advance', owner: 'manual-refresh', ttlMs: 60_000 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it('rejects release from a non-owner token and permits reacquire after owner release', async () => {
    const coordinator = createCoordinator();
    const acquired = await post(coordinator, '/lease/acquire', { name: 'guardian-advance', owner: 'cron', ttlMs: 60_000 });
    const lease = (await acquired.json() as { lease: { token: string } }).lease;

    const wrongRelease = await post(coordinator, '/lease/release', { name: 'guardian-advance', token: 'wrong-token' });
    expect(wrongRelease.status).toBe(409);

    const release = await post(coordinator, '/lease/release', { name: 'guardian-advance', token: lease.token });
    expect(release.status).toBe(200);

    const reacquire = await post(coordinator, '/lease/acquire', { name: 'guardian-advance', owner: 'manual-refresh', ttlMs: 60_000 });
    expect(reacquire.status).toBe(200);
  });
});
