import { describe, expect, it } from 'vitest';
import { deriveChatProjectOverview, getChatControlOverview } from './chatControlOverview';
import { recordChatBridgeHeartbeat } from './chatBridge';
import type { ChatBridgeStatus } from './chatBridge';
import { enqueueChatCommand } from './chatCommandQueue';
import type { ChatCommandEnv, ChatCommandOverviewSnapshot } from './chatCommandQueue';
import type { CoordinatorCommandActivity } from './projectCoordinator';

const now = Date.parse('2026-08-23T11:00:00.000Z');
const bridgeOn: ChatBridgeStatus = {
  connected: true,
  projectId: 'project-1',
  bridgeId: 'bridge-1',
  lastSeenAt: '2026-08-23T10:59:30.000Z',
  capabilities: [],
};
const bridgeOff: ChatBridgeStatus = {
  connected: false,
  projectId: 'project-1',
  capabilities: [],
};

function command(overrides: Partial<CoordinatorCommandActivity>): CoordinatorCommandActivity {
  return {
    id: overrides.id || 'command-1',
    status: overrides.status || 'queued',
    createdAt: overrides.createdAt || '2026-08-23T10:58:00.000Z',
    updatedAt: overrides.updatedAt || '2026-08-23T10:58:00.000Z',
    ...overrides,
  };
}

function snapshot(input: {
  latest?: CoordinatorCommandActivity;
  unresolved?: CoordinatorCommandActivity;
  pendingCount?: number;
  failedCount?: number;
  approximate?: boolean;
}): ChatCommandOverviewSnapshot {
  return {
    latest: input.latest || input.unresolved,
    unresolved: input.unresolved,
    pendingCount: input.pendingCount || 0,
    failedCount: input.failedCount || 0,
    totalCount: Math.max(input.pendingCount || 0, input.failedCount || 0, input.latest || input.unresolved ? 1 : 0),
    approximate: Boolean(input.approximate),
  };
}

describe('multi-chat overview activity', () => {
  it('shows an actively claimed command as delivering', () => {
    const overview = deriveChatProjectOverview('project-1', snapshot({
      unresolved: command({ status: 'claimed' }),
      pendingCount: 1,
    }), bridgeOn, now);
    expect(overview.activity).toBe('DELIVERING');
    expect(overview.pendingRecentCount).toBe(1);
  });

  it('shows a queued retry with a future attempt time as retry scheduled', () => {
    const overview = deriveChatProjectOverview('project-1', snapshot({
      unresolved: command({
        status: 'queued',
        deliveryFailures: 1,
        nextAttemptAt: '2026-08-23T11:00:30.000Z',
      }),
      pendingCount: 1,
    }), bridgeOn, now);
    expect(overview.activity).toBe('RETRY_SCHEDULED');
  });

  it('distinguishes queued work waiting for an offline bridge', () => {
    const overview = deriveChatProjectOverview('project-1', snapshot({
      unresolved: command({ status: 'queued' }),
      pendingCount: 1,
    }), bridgeOff, now);
    expect(overview.activity).toBe('WAITING_BRIDGE');
  });

  it('surfaces an unresolved failed command as needing attention', () => {
    const failed = command({ id: 'new-failed', status: 'failed', createdAt: '2026-08-23T10:59:00.000Z' });
    const overview = deriveChatProjectOverview('project-1', snapshot({
      latest: failed,
      unresolved: failed,
      failedCount: 2,
    }), bridgeOn, now);
    expect(overview.activity).toBe('NEEDS_ATTENTION');
    expect(overview.activeCommandId).toBe('new-failed');
    expect(overview.failedRecentCount).toBe(2);
  });

  it('shows a recent successful delivery before falling back to connected idle', () => {
    const recent = deriveChatProjectOverview('project-1', snapshot({
      latest: command({ status: 'delivered', updatedAt: '2026-08-23T10:59:30.000Z' }),
    }), bridgeOn, now);
    const old = deriveChatProjectOverview('project-1', snapshot({
      latest: command({ status: 'delivered', updatedAt: '2026-08-23T10:50:00.000Z' }),
    }), bridgeOn, now);
    expect(recent.activity).toBe('DELIVERED');
    expect(old.activity).toBe('CONNECTED_IDLE');
  });

  it('reports WAITING_BRIDGE for a queued command targeting an offline specialist chat, even while the project\'s default chat is connected', async () => {
    // End-to-end regression guard for the exact scenario Codex flagged:
    // deriveChatProjectOverview's own bridge.connected input must actually
    // reflect the SPECIFIC chat the unresolved command targets, not merely
    // "is anything for this project connected".
    const store = new Map<string, string>();
    const env = {
      SUPERVISOR_STATE: {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, value: string) => { store.set(key, value); },
        delete: async (key: string) => { store.delete(key); },
        list: async ({ prefix = '', limit = 1000 }: { prefix?: string; limit?: number }) => {
          const matching = [...store.keys()].filter((key) => key.startsWith(prefix)).sort().slice(0, limit);
          return { keys: matching.map((name) => ({ name })), list_complete: true, cacheStatus: null };
        },
      },
    } as unknown as ChatCommandEnv;

    await recordChatBridgeHeartbeat(env, { projectId: 'project-1', bridgeId: 'bridge-default', chatUrl: 'https://chatgpt.com/c/default' });
    await enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/specialist',
      prompt: 'work for the specialist chat, which has no connected Bridge',
    });

    const [overview] = await getChatControlOverview(env, ['project-1']);
    expect(overview.activity).toBe('WAITING_BRIDGE');
    expect(overview.bridgeConnected).toBe(false);
  });

  it('does not mislabel an overview transport failure as an offline Bridge', async () => {
    const env = {
      SUPERVISOR_STATE: {
        get: async () => null,
        put: async () => undefined,
        list: async () => { throw new Error('overview storage unavailable'); },
      },
    } as unknown as ChatCommandEnv;

    const [overview] = await getChatControlOverview(env, ['project-1']);
    expect(overview.activity).toBe('OVERVIEW_ERROR');
    expect(overview.error).toContain('overview storage unavailable');
  });
});