import { describe, expect, it } from 'vitest';
import { ChatBridgeEnv, getChatBridgeStatus, recordChatBridgeHeartbeat } from './chatBridge';

function fakeEnv() {
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
});
