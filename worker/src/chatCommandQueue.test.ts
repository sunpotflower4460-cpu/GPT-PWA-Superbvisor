import { describe, expect, it } from 'vitest';
import {
  enqueueChatCommand,
  isClaimableCommand,
  normalizeChatUrl,
  sanitizePrompt,
  type ChatCommand,
  type ChatCommandEnv,
} from './chatCommandQueue';

const baseCommand: ChatCommand = {
  id: 'command-1',
  projectId: 'project-1',
  chatUrl: 'https://chatgpt.com/c/abc123',
  prompt: 'continue',
  status: 'queued',
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
};

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
});

describe('chat command idempotency', () => {
  it('returns the existing command when the same project dedupe key is queued again', async () => {
    const store = new Map<string, string>();
    const env = {
      SUPERVISOR_STATE: {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, value: string) => { store.set(key, value); },
        list: async ({ prefix = '' }: { prefix?: string }) => ({
          keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
          list_complete: true,
          cacheStatus: null,
        }),
      },
    } as unknown as ChatCommandEnv;

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
});

describe('chat command claim recovery', () => {
  it('allows queued commands to be claimed immediately', () => {
    expect(isClaimableCommand(baseCommand, Date.parse('2026-08-23T00:00:01.000Z'))).toBe(true);
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
});
