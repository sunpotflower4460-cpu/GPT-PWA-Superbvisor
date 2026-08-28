import { describe, expect, it } from 'vitest';
import { ChatBridgeEnv, getChatBridgeStatus, recordChatBridgeHeartbeat } from './chatBridge';

function fakeEnv() {
  const store = new Map<string, string>();
  const env = {
    SUPERVISOR_STATE: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => { store.set(key, value); },
      delete: async (key: string) => { store.delete(key); },
      list: async ({
        prefix = '',
        limit = 1000,
        cursor,
      }: {
        prefix?: string;
        limit?: number;
        cursor?: string;
      }) => {
        const matching = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
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
  } as unknown as ChatBridgeEnv;
  return { env, store };
}

describe('chat bridge heartbeat (Multi Chat / Specialist Chat)', () => {
  it('reports disconnected with no heartbeat recorded', async () => {
    const { env } = fakeEnv();
    expect((await getChatBridgeStatus(env, 'project-1')).connected).toBe(false);
  });

  it('does not let one bridge\'s heartbeat overwrite a different bridge\'s record', async () => {
    const { env } = fakeEnv();
    await recordChatBridgeHeartbeat(env, { projectId: 'project-1', bridgeId: 'bridge-a', chatUrl: 'https://chatgpt.com/c/chat-a' });
    await recordChatBridgeHeartbeat(env, { projectId: 'project-1', bridgeId: 'bridge-b', chatUrl: 'https://chatgpt.com/c/chat-b' });

    const statusA = await getChatBridgeStatus(env, 'project-1', 'https://chatgpt.com/c/chat-a');
    const statusB = await getChatBridgeStatus(env, 'project-1', 'https://chatgpt.com/c/chat-b');
    expect(statusA.connected).toBe(true);
    expect(statusA.bridgeId).toBe('bridge-a');
    expect(statusB.connected).toBe(true);
    expect(statusB.bridgeId).toBe('bridge-b');
  });

  it('reports a specific chat as disconnected even while a different chat in the same project is connected', async () => {
    // The exact scenario Codex flagged: one live default-chat tab must not
    // make a queued command targeting an offline specialist chat look fine.
    const { env } = fakeEnv();
    await recordChatBridgeHeartbeat(env, { projectId: 'project-1', bridgeId: 'bridge-default', chatUrl: 'https://chatgpt.com/c/default' });

    const specialistStatus = await getChatBridgeStatus(env, 'project-1', 'https://chatgpt.com/c/specialist');
    expect(specialistStatus.connected).toBe(false);

    const defaultStatus = await getChatBridgeStatus(env, 'project-1', 'https://chatgpt.com/c/default');
    expect(defaultStatus.connected).toBe(true);
  });

  it('falls back to the most-recently-seen bridge for the project when no chatUrl is given', async () => {
    const { env } = fakeEnv();
    await recordChatBridgeHeartbeat(env, { projectId: 'project-1', bridgeId: 'bridge-old', chatUrl: 'https://chatgpt.com/c/old' });
    await recordChatBridgeHeartbeat(env, { projectId: 'project-1', bridgeId: 'bridge-new', chatUrl: 'https://chatgpt.com/c/new' });

    const status = await getChatBridgeStatus(env, 'project-1');
    expect(status.connected).toBe(true);
    expect(status.bridgeId).toBe('bridge-new');
  });

  it('matches a chatUrl regardless of an insignificant fragment/trailing-slash difference from the stored value', async () => {
    const { env } = fakeEnv();
    await recordChatBridgeHeartbeat(env, { projectId: 'project-1', bridgeId: 'bridge-a', chatUrl: 'https://chatgpt.com/c/chat-a/' });

    const status = await getChatBridgeStatus(env, 'project-1', 'https://chatgpt.com/c/chat-a#section');
    expect(status.connected).toBe(true);
  });

  it('paginates past 1000 bridge keys instead of returning an arbitrary lexicographic slice', async () => {
    // Regression guard: KV's list() sorts by key name, not by recency, and
    // bridgeId is a random per-tab suffix unrelated to lastSeenAt. A
    // single-page-capped list() call could return only lexicographically-
    // early keys and never see the actually-connected target bridge just
    // because its random id happens to sort late. Bridge ids below are
    // deliberately early-sorting ("a...") except the real target, whose id
    // ("zzz-target") deliberately sorts after all of them.
    const { env, store } = fakeEnv();
    const now = new Date().toISOString();
    for (let index = 0; index < 1001; index += 1) {
      const bridgeId = `a-${String(index).padStart(4, '0')}`;
      store.set(`chat-bridge-project:project-1:bridge:${bridgeId}`, JSON.stringify({
        projectId: 'project-1',
        bridgeId,
        chatUrl: 'https://chatgpt.com/c/unrelated',
        lastSeenAt: now,
        capabilities: [],
      }));
    }
    store.set('chat-bridge-project:project-1:bridge:zzz-target', JSON.stringify({
      projectId: 'project-1',
      bridgeId: 'zzz-target',
      chatUrl: 'https://chatgpt.com/c/target',
      lastSeenAt: now,
      capabilities: [],
    }));

    const status = await getChatBridgeStatus(env, 'project-1', 'https://chatgpt.com/c/target');
    expect(status.connected).toBe(true);
    expect(status.bridgeId).toBe('zzz-target');
  });
});
