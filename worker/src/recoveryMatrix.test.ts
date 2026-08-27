import { describe, expect, it } from 'vitest';
import { recoveryStrategyPromptHint, recurringFailureSignature, resolveRecoveryStrategy } from './recoveryMatrix';

describe('recurringFailureSignature', () => {
  it('is independent of check order', () => {
    expect(recurringFailureSignature(['b', 'a'], 'CODE_FAILURE')).toBe(recurringFailureSignature(['a', 'b'], 'CODE_FAILURE'));
  });

  it('differs across categories for the same checks', () => {
    expect(recurringFailureSignature(['ci'], 'CODE_FAILURE')).not.toBe(recurringFailureSignature(['ci'], 'TEST_FAILURE'));
  });
});

describe('resolveRecoveryStrategy', () => {
  it('always asks a human for HUMAN_APPROVAL_REQUIRED, regardless of repeat count', () => {
    expect(resolveRecoveryStrategy({ category: 'HUMAN_APPROVAL_REQUIRED', sameFingerprintRepeatCount: 1 }).valueOf()).toBe('ASK_HUMAN');
    expect(resolveRecoveryStrategy({ category: 'HUMAN_APPROVAL_REQUIRED', sameFingerprintRepeatCount: 9 })).toBe('ASK_HUMAN');
  });

  it('retries a fresh code failure and escalates once it recurs enough', () => {
    expect(resolveRecoveryStrategy({ category: 'CODE_FAILURE', sameFingerprintRepeatCount: 1 })).toBe('RETRY');
    expect(resolveRecoveryStrategy({ category: 'CODE_FAILURE', sameFingerprintRepeatCount: 2 })).toBe('RETRY');
    expect(resolveRecoveryStrategy({ category: 'CODE_FAILURE', sameFingerprintRepeatCount: 3 })).toBe('TRY_ALTERNATIVE');
  });

  it('routes policy/guard failures to a kernel reload', () => {
    expect(resolveRecoveryStrategy({ category: 'GUARD_FAILURE', sameFingerprintRepeatCount: 1 })).toBe('RELOAD_KERNEL');
    expect(resolveRecoveryStrategy({ category: 'POLICY_FAILURE', sameFingerprintRepeatCount: 1 })).toBe('RELOAD_KERNEL');
  });

  it('routes environment/infra failures to an alternate runtime', () => {
    expect(resolveRecoveryStrategy({ category: 'ENV_FAILURE', sameFingerprintRepeatCount: 1 })).toBe('ALTERNATE_RUNTIME');
    expect(resolveRecoveryStrategy({ category: 'INFRA_FAILURE', sameFingerprintRepeatCount: 1 })).toBe('ALTERNATE_RUNTIME');
  });

  it('routes context pressure to a handoff checkpoint', () => {
    expect(resolveRecoveryStrategy({ category: 'CONTEXT_PRESSURE', sameFingerprintRepeatCount: 1 })).toBe('CREATE_HANDOFF');
  });

  it('does not retry rate limiting — the next scheduled refresh already covers it', () => {
    expect(resolveRecoveryStrategy({ category: 'RATE_LIMITED', sameFingerprintRepeatCount: 1 })).toBe('NONE');
  });

  it('escalates a recurring transient/CI-config failure to a human instead of retrying forever', () => {
    expect(resolveRecoveryStrategy({ category: 'TRANSIENT_FAILURE', sameFingerprintRepeatCount: 1 })).toBe('RETRY');
    expect(resolveRecoveryStrategy({ category: 'TRANSIENT_FAILURE', sameFingerprintRepeatCount: 3 })).toBe('ASK_HUMAN');
    expect(resolveRecoveryStrategy({ category: 'CI_CONFIG_FAILURE', sameFingerprintRepeatCount: 3 })).toBe('ASK_HUMAN');
  });

  it('treats an already-exhausted strategy as needing a human', () => {
    expect(resolveRecoveryStrategy({ category: 'STRATEGY_EXHAUSTED', sameFingerprintRepeatCount: 1 })).toBe('ASK_HUMAN');
  });
});

describe('recoveryStrategyPromptHint', () => {
  it('is non-empty only for strategies that need to change the prompt wording', () => {
    expect(recoveryStrategyPromptHint('TRY_ALTERNATIVE')).not.toBe('');
    expect(recoveryStrategyPromptHint('ALTERNATE_RUNTIME')).not.toBe('');
    expect(recoveryStrategyPromptHint('RELOAD_KERNEL')).not.toBe('');
    expect(recoveryStrategyPromptHint('RETRY')).toBe('');
    expect(recoveryStrategyPromptHint('ASK_HUMAN')).toBe('');
    expect(recoveryStrategyPromptHint('NONE')).toBe('');
  });

  it('gives CREATE_HANDOFF a real hint — no DeveloperJobPhase can carry this signal instead', () => {
    expect(recoveryStrategyPromptHint('CREATE_HANDOFF')).not.toBe('');
  });
});
