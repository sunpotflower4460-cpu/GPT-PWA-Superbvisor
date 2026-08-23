import { describe, expect, it } from 'vitest';
import { normalizeChatUrl, sanitizePrompt } from './chatCommandQueue';

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
