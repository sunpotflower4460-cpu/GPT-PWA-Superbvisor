import { describe, expect, it } from 'vitest';
import {
  ChatCommandConflictError,
  INVALID_CHAT_COMMAND_ERROR,
  INVALID_CLAIM_CHAT_URL_ERROR,
  cancelChatCommand,
  claimNextChatCommand,
  enqueueChatCommand,
  isClaimableCommand,
  listProjectChatCommands,
  normalizeChatUrl,
  sanitizePrompt,
  updateChatCommandResult,
  type ChatCommand,
  type ChatCommandEnv,
} from './chatCommandQueue';
import { applyCommandResult } from './projectCoordinator';

const baseCommand: ChatCommand = {
  id: 'command-1',
  projectId: 'project-1',
  chatUrl: 'https://chatgpt.com/c/abc123',
  prompt: 'continue',
  status: 'queued',
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
};

function fakeEnv() {
  const store = new Map<string, string>();
  const ttlByKey = new Map<string, number | undefined>();
  const env = {
    SUPERVISOR_STATE: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
        store.set(key, value);
        ttlByKey.set(key, options?.expirationTtl);
      },
      delete: async (key: string) => { store.delete(key); },
      list: async ({
        prefix = '',
        limit = 100,
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
  } as unknown as ChatCommandEnv;
  return { env, store, ttlByKey };
}

describe('chat command validation', () => {
  it('accepts canonical ChatGPT conversation URLs', () => {
    expect(normalizeChatUrl('https://chatgpt.com/c/abc123')).toBe('https://chatgpt.com/c/abc123');
    expect(normalizeChatUrl('https://chat.openai.com/c/legacy')).toBe('https://chat.openai.com/c/legacy');
  });

  it('rejects non-ChatGPT destinations and insecure URLs', () => {
    expect(normalizeChatUrl('https://example.com/c/abc')).toBeNull();
    expect(normalizeChatUrl('http://chatgpt.com/c/abc')).toBeNull();
    expect(normalizeChatUrl('javascript:alert(1)')).toBeNull();
  });

  it('trims prompts and caps payload size', () => {
    expect(sanitizePrompt('  continue  ')).toBe('continue');
    expect(sanitizePrompt('x'.repeat(30_000))).toHaveLength(24_000);
  });

  it('uses one exported invalid-command error contract for HTTP classification', async () => {
    const { env } = fakeEnv();
    await expect(enqueueChatCommand(env, {
      projectId: '',
      chatUrl: 'https://chatgpt.com/c/abc123',
      prompt: 'continue',
    })).rejects.toThrow(INVALID_CHAT_COMMAND_ERROR);
  });
});

describe('chat command idempotency', () => {
  it('returns the existing command when the same project dedupe key is queued again', async () => {
    const { env } = fakeEnv();
    const first = await enqueueChatCommand(env, {
      projectId: 'project-1',
      projectName: 'Project One',
      chatUrl: 'https://chatgpt.com/c/abc123',
      prompt: 'continue route',
      dedupeKey: 'developer:job-1:phase-a',
    });
    const second = await enqueueChatCommand(env, {
      projectId: 'project-1',
      projectName: 'Project One',
      chatUrl: 'https://chatgpt.com/c/abc123',
      prompt: 'continue route',
      dedupeKey: 'developer:job-1:phase-a',
    });

    expect(second.id).toBe(first.id);
    expect(second.dedupeKey).toBe('developer:job-1:phase-a');
  });

  it('rejects reuse of a KV dedupe key for a different prompt or ChatGPT URL', async () => {
    const { env } = fakeEnv();
    await enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/abc123',
      prompt: 'continue route',
      dedupeKey: 'developer:job-1:phase-a',
    });

    await expect(enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/abc123',
      prompt: 'different route',
      dedupeKey: 'developer:job-1:phase-a',
    })).rejects.toMatchObject({
      name: 'ChatCommandConflictError',
      code: 'dedupe_payload_mismatch',
    });

    await expect(enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/other',
      prompt: 'continue route',
      dedupeKey: 'developer:job-1:phase-a',
    })).rejects.toMatchObject({
      name: 'ChatCommandConflictError',
      code: 'dedupe_payload_mismatch',
    });
  });

  it('rejects reuse of a KV dedupe key when kind changes from NEXT to STEER', async () => {
    const { env } = fakeEnv();
    await enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/abc123',
      prompt: 'continue route',
      dedupeKey: 'developer:job-1:phase-a',
    });

    // Same dedupeKey and prompt, but this call actually wants STEER — must
    // not silently return the original NEXT command.
    await expect(enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/abc123',
      prompt: 'continue route',
      dedupeKey: 'developer:job-1:phase-a',
      kind: 'STEER',
    })).rejects.toMatchObject({
      name: 'ChatCommandConflictError',
      code: 'dedupe_payload_mismatch',
    });
  });
});

describe('chat command NEXT/STEER priority (KV fallback path)', () => {
  it('claims a STEER command ahead of an older queued NEXT command', async () => {
    const { env } = fakeEnv();
    await enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/abc123',
      prompt: 'ordinary follow-up work',
    });
    const steer = await enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/abc123',
      prompt: "don't touch the auth file right now",
      kind: 'STEER',
    });

    const claimed = await claimNextChatCommand(env, 'bridge-a', 'project-1');
    expect(claimed?.id).toBe(steer.id);
    expect(claimed?.kind).toBe('STEER');
  });
});

describe('chat command claim chatUrl scoping (Multi Chat / Specialist Chat)', () => {
  it('only claims a command destined for the calling bridge\'s own chatUrl when one is given', async () => {
    const { env } = fakeEnv();
    const forChatA = await enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/chat-a',
      prompt: 'work for chat A',
    });
    await enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/chat-b',
      prompt: 'work for chat B',
    });

    // A bridge polling from chat B must never receive chat A's command, even
    // though chat A's command is older/would otherwise win the claim race.
    const claimedByB = await claimNextChatCommand(env, 'bridge-b', 'project-1', 'https://chatgpt.com/c/chat-b');
    expect(claimedByB?.chatUrl).toBe('https://chatgpt.com/c/chat-b');

    const claimedByA = await claimNextChatCommand(env, 'bridge-a', 'project-1', 'https://chatgpt.com/c/chat-a');
    expect(claimedByA?.id).toBe(forChatA.id);
  });

  it('returns null for a chat with nothing queued for it, even while other chats in the same project have work', async () => {
    const { env } = fakeEnv();
    await enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/chat-a',
      prompt: 'work for chat A',
    });

    const claimed = await claimNextChatCommand(env, 'bridge-c', 'project-1', 'https://chatgpt.com/c/chat-c');
    expect(claimed).toBeNull();
  });

  it('falls back to the project-wide pool when no chatUrl is given, unchanged from before this existed', async () => {
    const { env } = fakeEnv();
    const command = await enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/chat-a',
      prompt: 'work for chat A',
    });

    const claimed = await claimNextChatCommand(env, 'bridge-legacy', 'project-1');
    expect(claimed?.id).toBe(command.id);
  });

  it('only recovers a stale owned claim if it was for the same chatUrl', async () => {
    const { env } = fakeEnv();
    const command = await enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/chat-a',
      prompt: 'work for chat A',
    });
    // bridge-a claims it, then a stale-claim scenario is simulated by a
    // second call from the SAME bridgeId but scoped to a DIFFERENT chatUrl
    // (e.g. a reused bridgeId after the tab navigated to another chat) —
    // it must not recover chat A's claim into a chat-B-scoped call.
    await claimNextChatCommand(env, 'bridge-a', 'project-1', 'https://chatgpt.com/c/chat-a');
    const claimedForOtherChat = await claimNextChatCommand(env, 'bridge-a', 'project-1', 'https://chatgpt.com/c/chat-b');
    expect(claimedForOtherChat).toBeNull();
  });

  it('rejects a malformed chatUrl instead of silently falling back to the unscoped project-wide pool', async () => {
    // Regression guard: an earlier version coerced a non-empty-but-invalid
    // chatUrl straight to undefined (same as "not given at all"), which
    // would have silently reopened the exact cross-chat misdelivery race
    // this scoping exists to close whenever the user mistyped a chatUrl at
    // Bridge-connect time (e.g. missing "https://").
    const { env } = fakeEnv();
    await enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/chat-a',
      prompt: 'work for chat A',
    });
    await expect(claimNextChatCommand(env, 'bridge-b', 'project-1', 'chatgpt.com/c/chat-b'))
      .rejects.toThrow(INVALID_CLAIM_CHAT_URL_ERROR);
  });
});

describe('chat command claim recovery', () => {
  it('allows queued commands to be claimed immediately', () => {
    expect(isClaimableCommand(baseCommand, Date.parse('2026-08-23T00:00:01.000Z'))).toBe(true);
  });

  it('respects retry backoff for a requeued command', () => {
    const retrying = { ...baseCommand, nextAttemptAt: '2026-08-23T00:00:10.000Z' };
    expect(isClaimableCommand(retrying, Date.parse('2026-08-23T00:00:09.000Z'))).toBe(false);
    expect(isClaimableCommand(retrying, Date.parse('2026-08-23T00:00:10.000Z'))).toBe(true);
  });

  it('does not steal a fresh claim from another active bridge', () => {
    expect(isClaimableCommand({
      ...baseCommand,
      status: 'claimed',
      claimedAt: '2026-08-23T00:01:00.000Z',
    }, Date.parse('2026-08-23T00:02:00.000Z'))).toBe(false);
  });

  it('recovers a claim after the bridge has been silent for two minutes', () => {
    expect(isClaimableCommand({
      ...baseCommand,
      status: 'claimed',
      claimedAt: '2026-08-23T00:01:00.000Z',
    }, Date.parse('2026-08-23T00:03:01.000Z'))).toBe(true);
  });

  it('never reclaims terminal commands', () => {
    expect(isClaimableCommand({ ...baseCommand, status: 'delivered' }, Date.parse('2026-08-23T00:10:00.000Z'))).toBe(false);
    expect(isClaimableCommand({ ...baseCommand, status: 'failed' }, Date.parse('2026-08-23T00:10:00.000Z'))).toBe(false);
  });

  it('returns the same fresh KV claim to the same bridge after a lost response', async () => {
    const { env } = fakeEnv();
    const first = await enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/abc123',
      prompt: 'first',
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/abc123',
      prompt: 'second',
    });

    const firstClaim = await claimNextChatCommand(env, 'bridge-a', 'project-1');
    const repeatedClaim = await claimNextChatCommand(env, 'bridge-a', 'project-1');
    expect(firstClaim?.id).toBe(first.id);
    expect(repeatedClaim?.id).toBe(first.id);
    expect(first.id).not.toBe(second.id);
  });

  it('paginates KV project history so work after the first 1000 index entries remains visible and claimable', async () => {
    const { env, store } = fakeEnv();
    for (let index = 0; index < 1001; index += 1) {
      const id = `history-${String(index).padStart(4, '0')}`;
      const command: ChatCommand = {
        ...baseCommand,
        id,
        status: 'delivered',
        prompt: `history ${index}`,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      };
      store.set(`chat-command:${id}`, JSON.stringify(command));
      store.set(`chat-project:project-1:${String(index).padStart(17, '0')}:${id}`, id);
    }

    const queued: ChatCommand = {
      ...baseCommand,
      id: 'queued-after-pagination',
      prompt: 'continue after long history',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
    };
    store.set(`chat-command:${queued.id}`, JSON.stringify(queued));
    store.set(`chat-project:project-1:${'9'.repeat(17)}:${queued.id}`, queued.id);

    const latest = await listProjectChatCommands(env, 'project-1', 3);
    expect(latest[0]?.id).toBe(queued.id);

    const claimed = await claimNextChatCommand(env, 'bridge-a', 'project-1');
    expect(claimed?.id).toBe(queued.id);
    expect(claimed?.status).toBe('claimed');
  });
});

describe('chat command delivery recovery', () => {
  it('requeues transient delivery failures with backoff before terminal failure', () => {
    const claimed: ChatCommand = {
      ...baseCommand,
      status: 'claimed',
      bridgeId: 'bridge-a',
      claimedAt: '2026-08-23T00:00:00.000Z',
      deliveryFailures: 0,
      maxDeliveryAttempts: 3,
    };
    const first = applyCommandResult(claimed, { status: 'failed', detail: 'host unavailable' }, Date.parse('2026-08-23T00:00:01.000Z'));
    expect(first.status).toBe('queued');
    expect(first.bridgeId).toBeUndefined();
    expect(first.deliveryFailures).toBe(1);
    expect(first.nextAttemptAt).toBe('2026-08-23T00:00:06.000Z');

    const exhausted = applyCommandResult({ ...claimed, deliveryFailures: 2 }, { status: 'failed', detail: 'still unavailable' }, Date.parse('2026-08-23T00:01:00.000Z'));
    expect(exhausted.status).toBe('failed');
    expect(exhausted.deliveryFailures).toBe(3);
    expect(exhausted.nextAttemptAt).toBeUndefined();
  });

  it('does not extend the original 14-day KV retention window when an old command is updated', async () => {
    const { env, store, ttlByKey } = fakeEnv();
    const createdAt = new Date(Date.now() - (13 * 24 * 60 * 60_000)).toISOString();
    const claimed: ChatCommand = {
      ...baseCommand,
      id: 'old-claimed-command',
      status: 'claimed',
      bridgeId: 'bridge-a',
      claimedAt: new Date().toISOString(),
      createdAt,
      updatedAt: createdAt,
    };
    store.set(`chat-command:${claimed.id}`, JSON.stringify(claimed));

    const delivered = await updateChatCommandResult(env, claimed.id, {
      projectId: 'project-1',
      bridgeId: 'bridge-a',
      status: 'delivered',
    });
    expect(delivered?.status).toBe('delivered');

    const ttl = ttlByKey.get(`chat-command:${claimed.id}`);
    expect(ttl).toBeDefined();
    expect(ttl).toBeGreaterThanOrEqual(60);
    expect(ttl).toBeLessThanOrEqual((24 * 60 * 60) + 5);
  });

  it('rejects a result from a bridge that no longer owns the claim', async () => {
    const { env } = fakeEnv();
    const queued = await enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/abc123',
      prompt: 'continue',
    });
    const claimed = await claimNextChatCommand(env, 'bridge-a', 'project-1');
    expect(claimed?.id).toBe(queued.id);

    await expect(updateChatCommandResult(env, queued.id, {
      projectId: 'project-1',
      bridgeId: 'bridge-b',
      status: 'delivered',
    })).rejects.toBeInstanceOf(ChatCommandConflictError);
  });

  it('keeps terminal KV result retries idempotent only for the original claim owner', async () => {
    const { env } = fakeEnv();
    const queued = await enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/abc123',
      prompt: 'continue',
    });
    await claimNextChatCommand(env, 'bridge-a', 'project-1');
    const delivered = await updateChatCommandResult(env, queued.id, {
      projectId: 'project-1',
      bridgeId: 'bridge-a',
      status: 'delivered',
    });
    expect(delivered?.status).toBe('delivered');

    const ownerRetry = await updateChatCommandResult(env, queued.id, {
      projectId: 'project-1',
      bridgeId: 'bridge-a',
      status: 'delivered',
    });
    expect(ownerRetry?.status).toBe('delivered');

    await expect(updateChatCommandResult(env, queued.id, {
      projectId: 'project-1',
      bridgeId: 'bridge-b',
      status: 'delivered',
    })).rejects.toMatchObject({
      name: 'ChatCommandConflictError',
      code: 'claim_owner_mismatch',
    });
  });

  it('cancels queued work before a manual fallback so it cannot be claimed later', async () => {
    const { env } = fakeEnv();
    const queued = await enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/abc123',
      prompt: 'continue manually',
    });

    const cancelled = await cancelChatCommand(env, 'project-1', queued.id, 'manual fallback');
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.bridgeId).toBeUndefined();
    expect(await claimNextChatCommand(env, 'bridge-a', 'project-1')).toBeNull();
  });

  it('refuses to cancel work that a bridge already owns', async () => {
    const { env } = fakeEnv();
    const queued = await enqueueChatCommand(env, {
      projectId: 'project-1',
      chatUrl: 'https://chatgpt.com/c/abc123',
      prompt: 'continue',
    });
    await claimNextChatCommand(env, 'bridge-a', 'project-1');

    await expect(cancelChatCommand(env, 'project-1', queued.id)).rejects.toBeInstanceOf(ChatCommandConflictError);
  });
});