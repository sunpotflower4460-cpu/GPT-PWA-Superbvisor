import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOrchestrationModel, type OrchestrationEnv, type OrchestrationRequest } from './orchestrationModel';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const baseRequest: OrchestrationRequest = {
  mode: 'RECOVER',
  repository: 'owner/repo',
  branch: 'ai-dev-deck/task',
  goal: 'Ship safely',
  task: 'Fix CI',
  evidence: 'lint: failure',
  deterministicPrompt: 'deterministic fallback prompt',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runOrchestrationModel rate-limit detection', () => {
  it('reports rateLimited when the only configured provider is rate-limited on every attempt', async () => {
    const env: OrchestrationEnv = { DEEPSEEK_API_KEY: 'key' };
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: 'rate limited' } }, 429));
    vi.stubGlobal('fetch', fetchMock);

    const decision = await runOrchestrationModel(env, baseRequest);

    expect(decision.degraded).toBe(true);
    expect(decision.rateLimited).toBe(true);
    expect(decision.provider).toBe('deterministic');
    expect(decision.chatgptPrompt).toBe(baseRequest.deterministicPrompt);
    // MAX_PROVIDER_ATTEMPTS retries for the single configured provider.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not report rateLimited when providers fail for a mix of reasons', async () => {
    // deepseek is rate-limited (retryable, exhausts all attempts); openai
    // fails with an unrelated, non-retryable error (bad API key) on its
    // first attempt. Since not EVERY attempted provider's terminal failure
    // was specifically 429, this must not be misreported as "just wait for
    // the rate limit" — a bad key needs a human to fix it, not a retry.
    const env: OrchestrationEnv = { DEEPSEEK_API_KEY: 'key1', OPENAI_API_KEY: 'key2' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('deepseek.com')) return jsonResponse({ error: { message: 'rate limited' } }, 429);
      if (url.includes('openai.com')) return jsonResponse({ error: { message: 'invalid api key' } }, 401);
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const decision = await runOrchestrationModel(env, baseRequest);

    expect(decision.degraded).toBe(true);
    expect(decision.rateLimited).toBe(false);
  });

  it('does not report rateLimited when no provider is configured at all', async () => {
    const env: OrchestrationEnv = {};
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const decision = await runOrchestrationModel(env, baseRequest);

    expect(decision.degraded).toBe(true);
    expect(decision.rateLimited).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears rateLimited once a provider succeeds after a transient 429 retry', async () => {
    const env: OrchestrationEnv = { DEEPSEEK_API_KEY: 'key' };
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return jsonResponse({ error: { message: 'rate limited' } }, 429);
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({ classification: 'CI_CODE_FAILURE', summary: 'ok', chatgptPrompt: 'fix it', confidence: 0.8, humanRequired: [] }) } }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const decision = await runOrchestrationModel(env, baseRequest);

    expect(decision.degraded).toBe(false);
    expect(decision.rateLimited).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
