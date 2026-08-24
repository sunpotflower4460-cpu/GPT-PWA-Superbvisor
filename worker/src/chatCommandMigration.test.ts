import { describe, expect, it } from 'vitest';
import {
  claimNextChatCommand,
  getProjectChatCommandOverview,
  listProjectChatCommands,
  type ChatCommand,
  type ChatCommandEnv,
} from './chatCommandQueue';
import { ProjectCoordinator } from './projectCoordinator';

function createAtomicMigrationHarness() {
  const kv = new Map<string, string>();
  const coordinatorValues = new Map<string, unknown>();
  const importBodies: Array<{ commands?: ChatCommand[]; finalize?: boolean }> = [];
  let tail: Promise<unknown> = Promise.resolve();

  const coordinatorState = {
    storage: {
      get: async <T>(key: string) => coordinatorValues.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { coordinatorValues.set(key, value); },
      delete: async (key: string) => coordinatorValues.delete(key),
      list: async <T>({
        prefix = '',
        limit = Number.POSITIVE_INFINITY,
        startAfter,
      }: {
        prefix?: string;
        limit?: number;
        startAfter?: string;
      } = {}) => {
        const matching = [...coordinatorValues.entries()]
          .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit) as Array<[string, T]>;
        return new Map(matching);
      },
    },
    blockConcurrencyWhile: <T>(callback: () => Promise<T>) => {
      const run = tail.then(callback, callback);
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  } as unknown as DurableObjectState;
  const coordinator = new ProjectCoordinator(coordinatorState);

  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        if (url.pathname === '/commands/import') {
          importBodies.push(await request.clone().json() as { commands?: ChatCommand[]; finalize?: boolean });
        }
        return coordinator.fetch(request);
      },
    }),
  } as unknown as DurableObjectNamespace;

  const env = {
    PROJECT_COORDINATOR: namespace,
    SUPERVISOR_STATE: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => { kv.set(key, value); },
      delete: async (key: string) => { kv.delete(key); },
      list: async ({
        prefix = '',
        limit = 1000,
        cursor,
      }: {
        prefix?: string;
        limit?: number;
        cursor?: string;
      }) => {
        const matching = [...kv.keys()].filter((key) => key.startsWith(prefix)).sort();
        const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
        const page = matching.slice(offset, offset + limit);
        const nextOffset = offset + page.length;
        const listComplete = nextOffset >= matching.length;
        return {
          keys: page.map((name) => ({ name })),
          list_complete: listComplete,
          ...(listComplete ? {} : { cursor: String(nextOffset) }),
          cacheStatus: null,
        };
      },
    },
  } as unknown as ChatCommandEnv;

  return { env, kv, coordinatorValues, importBodies };
}

function seedLegacyCommand(
  kv: Map<string, string>,
  projectId: string,
  command: ChatCommand,
) {
  kv.set(`chat-command:${command.id}`, JSON.stringify(command));
  const sortable = command.createdAt.replace(/[^0-9]/g, '').slice(0, 17);
  kv.set(`chat-project:${projectId}:${sortable}:${command.id}`, command.id);
}

describe('KV to ProjectCoordinator migration', () => {
  it('imports complete legacy history in bounded batches before finalize so work older than the newest 100 remains claimable', async () => {
    const { env, kv, coordinatorValues, importBodies } = createAtomicMigrationHarness();
    const projectId = 'migration-long-history-v2';
    const baseTime = Date.now() - (3 * 60 * 60_000);
    const legacy: ChatCommand[] = [];

    for (let index = 0; index < 125; index += 1) {
      const createdAt = new Date(baseTime + (index * 60_000)).toISOString();
      const command: ChatCommand = {
        id: `legacy-${String(index).padStart(3, '0')}`,
        projectId,
        chatUrl: 'https://chatgpt.com/c/migration-test',
        prompt: index === 0 ? 'old queued work that must survive migration' : `terminal history ${index}`,
        status: index === 0 ? 'queued' : 'delivered',
        createdAt,
        updatedAt: createdAt,
        claimAttempts: 0,
        deliveryFailures: 0,
        maxDeliveryAttempts: 3,
        dedupeKey: `legacy:${index}`,
      };
      legacy.push(command);
      seedLegacyCommand(kv, projectId, command);
    }

    const claimed = await claimNextChatCommand(env, 'bridge-after-migration', projectId);

    expect(claimed?.id).toBe('legacy-000');
    expect(claimed?.status).toBe('claimed');
    expect(coordinatorValues.get('meta:commands-migrated-v2')).toBe(true);

    const overview = await getProjectChatCommandOverview(env, projectId);
    expect(overview.totalCount).toBe(125);
    expect(overview.pendingCount).toBe(1);
    expect(overview.approximate).toBe(false);

    const recent = await listProjectChatCommands(env, projectId, 1);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.id).toBe('legacy-124');

    const dataBatches = importBodies.filter((body) => (body.commands?.length ?? 0) > 0);
    const finalizes = importBodies.filter((body) => body.finalize === true);
    expect(dataBatches.length).toBeGreaterThan(1);
    expect(dataBatches.every((body) => (body.commands?.length ?? 0) <= 20)).toBe(true);
    expect(finalizes).toHaveLength(1);
    expect(finalizes[0]?.commands).toEqual([]);

    const importedIds = dataBatches.flatMap((body) => body.commands ?? []).map((command) => command.id);
    expect(new Set(importedIds).size).toBe(125);
    expect(importedIds).toContain('legacy-000');
    expect(importedIds).toContain('legacy-124');
  });
});