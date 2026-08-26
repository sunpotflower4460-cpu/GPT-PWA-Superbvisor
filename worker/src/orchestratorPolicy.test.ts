import { describe, expect, it } from 'vitest';
import {
  AUTOPILOT_ROUTE_COMPLETE_MARKER,
  AUTOPILOT_ROUTE_HEADER,
  assessCi,
  buildAutopilotRouteContinuationPrompt,
  buildChatGptHandoff,
  buildGenericChatGptHandoff,
  buildRecoveryPrompt,
  failureFingerprint,
  hasAutopilotRouteCompletionMarker,
  hasAutopilotRouteContract,
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

  it('treats a plain failure as human-required when the Kernel declares that check name HUMAN_APPROVAL_REQUIRED', () => {
    // GitHub-native: require-human-approval.yml's check-approval job calls
    // core.setFailed(), which reports a plain `failure` conclusion — never
    // `action_required`. Without the Kernel override this would otherwise
    // be indistinguishable from a real code failure.
    const humanRequiredCheckNames = new Set(['check-approval']);
    expect(assessCi([{ ...base, name: 'check-approval', conclusion: 'failure' }], humanRequiredCheckNames).state)
      .toBe('HUMAN_REQUIRED');
  });

  it('does not widen the override to other checks by name', () => {
    const humanRequiredCheckNames = new Set(['check-approval']);
    expect(assessCi([{ ...base, name: 'guard', conclusion: 'failure' }], humanRequiredCheckNames).state)
      .toBe('CODE_FAILURE');
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

  it('makes the ChatGPT executor boundary explicit in GitHub initial and recovery prompts', () => {
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

  it('makes generic non-GitHub handoffs orchestration-only too', () => {
    const prompt = buildGenericChatGptHandoff({
      projectName: 'Research', goal: 'Finish safely', currentPhase: 'analysis', task: 'Continue', definitionOfDone: ['Evidence checked'],
    });
    expect(prompt).toContain('実行主体は、このChatGPTチャット');
    expect(prompt).toContain('監督・整理・次手生成だけを担当');
    expect(prompt).toContain('外部APIの要約だけを根拠に完成扱いせず');
  });
});

describe('autopilot route contract', () => {
  const routeTask = `Plan\n${AUTOPILOT_ROUTE_HEADER}\n3回デバッグ → 問題があれば追加 → 機能追加 → 3回補強 → UIUXを3回`;

  it('detects route contracts and completion markers explicitly', () => {
    expect(hasAutopilotRouteContract(routeTask)).toBe(true);
    expect(hasAutopilotRouteContract('ordinary task')).toBe(false);
    expect(hasAutopilotRouteCompletionMarker(`feat: final ${AUTOPILOT_ROUTE_COMPLETE_MARKER}`)).toBe(true);
    expect(hasAutopilotRouteCompletionMarker('feat: intermediate')).toBe(false);
  });

  it('keeps later route stages alive after an intermediate green CI', () => {
    const prompt = buildAutopilotRouteContinuationPrompt({
      repository: 'owner/repo',
      branch: 'ai-dev-deck/task',
      goal: 'Finish route',
      originalTask: routeTask,
      headSha: 'abc123',
      checks: [base],
    });
    expect(prompt).toContain('CI成功だけでは完了扱いにしません');
    expect(prompt).toContain('最初の未完了工程/未完了パスから続行');
    expect(prompt).toContain(AUTOPILOT_ROUTE_COMPLETE_MARKER);
  });

  it('preserves route progress rules through recovery prompts', () => {
    const prompt = buildRecoveryPrompt({
      repository: 'owner/repo',
      branch: 'ai-dev-deck/task',
      goal: 'Finish route',
      originalTask: routeTask,
      headSha: 'abc123',
      checks: [{ ...base, conclusion: 'failure' }],
    });
    expect(prompt).toContain('完了済み工程を最初から再実行せず');
    expect(prompt).toContain('後続工程が残っている限り最終完了ではありません');
  });
});
