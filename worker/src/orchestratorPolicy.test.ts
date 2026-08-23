import { describe, expect, it } from 'vitest';
import {
  assessCi,
  buildChatGptHandoff,
  buildRecoveryPrompt,
  failureFingerprint,
  isRetryableProviderStatus,
} from './orchestratorPolicy';

const base = {
  id: 1,
  name: 'CI',
  status: 'completed',
  conclusion: 'success' as string | null,
  url: 'https://github.com/example/repo/actions/runs/1',
  headSha: 'abc123',
};

describe('assessCi', () => {
  it('does not assume success when no run exists', () => {
    expect(assessCi([]).state).toBe('NO_RUN');
  });

  it('keeps running while a check is pending', () => {
    expect(assessCi([{ ...base, status: 'in_progress', conclusion: null }]).state).toBe('PENDING');
  });

  it('treats ordinary failures as code failures', () => {
    expect(assessCi([{ ...base, conclusion: 'failure' }]).state).toBe('CODE_FAILURE');
  });

  it('separates transient infrastructure-like conclusions', () => {
    expect(assessCi([{ ...base, conclusion: 'timed_out' }]).state).toBe('TRANSIENT_FAILURE');
    expect(assessCi([{ ...base, conclusion: 'cancelled' }]).state).toBe('TRANSIENT_FAILURE');
  });

  it('requires human action when GitHub says action_required', () => {
    expect(assessCi([{ ...base, conclusion: 'action_required' }]).state).toBe('HUMAN_REQUIRED');
  });

  it('accepts success/neutral/skipped as non-blocking completed checks', () => {
    expect(assessCi([
      base,
      { ...base, id: 2, name: 'Lint', conclusion: 'neutral' },
      { ...base, id: 3, name: 'Optional', conclusion: 'skipped' },
    ]).state).toBe('SUCCESS');
  });
});

describe('recovery safety', () => {
  it('creates stable fingerprints for the same head/check state', () => {
    const a = failureFingerprint('abc', [{ ...base, conclusion: 'failure' }]);
    const b = failureFingerprint('abc', [{ ...base, conclusion: 'failure' }]);
    expect(a).toBe(b);
  });

  it('changes fingerprint when the head changes', () => {
    expect(failureFingerprint('abc', [base])).not.toBe(failureFingerprint('def', [base]));
  });

  it('only retries provider statuses that are plausibly transient', () => {
    expect(isRetryableProviderStatus(429)).toBe(true);
    expect(isRetryableProviderStatus(503)).toBe(true);
    expect(isRetryableProviderStatus(400)).toBe(false);
    expect(isRetryableProviderStatus(401)).toBe(false);
  });

  it('makes the ChatGPT executor boundary explicit in initial and recovery prompts', () => {
    const initial = buildChatGptHandoff({
      repository: 'owner/repo', branch: 'ai-dev-deck/task', defaultBranch: 'main', goal: 'Ship safely', task: 'Fix CI',
    });
    const recovery = buildRecoveryPrompt({
      repository: 'owner/repo', branch: 'ai-dev-deck/task', goal: 'Ship safely', originalTask: 'Fix CI', headSha: 'abc', checks: [{ ...base, conclusion: 'failure' }],
    });
    expect(initial).toContain('実装担当は、このChatGPTチャット');
    expect(initial).toContain('外部APIは実装を行いません');
    expect(recovery).toContain('実装修正担当は、このChatGPTチャット');
  });
});
