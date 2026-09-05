import { describe, expect, it } from 'vitest';
import { CompletionCertificate, buildCompletionCertificate, describeCompletionOutcome, evaluateDeterministicCompletion, firstNonEmpty, pendingSemanticJudge } from './completionJudge';
import { DeveloperJob } from './developerAgent';

function baseCertificate(overrides: Partial<CompletionCertificate> = {}): CompletionCertificate {
  return {
    goal: 'PENDING',
    ci: 'PASS',
    guard: 'PASS',
    semanticReview: 'PENDING',
    blockingIssues: 0,
    knownLimitations: [],
    state: 'COMPLETION_CANDIDATE',
    ...overrides,
  };
}

function baseJob(overrides: Partial<DeveloperJob> = {}): DeveloperJob {
  return {
    id: 'job-1',
    repository: 'octocat/example',
    goal: 'Ship the thing',
    prompt: 'Implement the thing',
    definitionOfDone: [],
    model: 'deterministic',
    orchestratorProvider: 'deterministic',
    workspace: {
      repository: 'octocat/example',
      defaultBranch: 'main',
      branch: 'ai-dev-deck/thing-abcd1234',
      baseSha: 'base123',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    status: 'running',
    phase: 'handoff_ready',
    toolTurns: 0,
    maxToolTurns: 10,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    recoveryCount: 0,
    ciAutoReruns: 0,
    maxAutoCiReruns: 2,
    autoDispatch: false,
    autoMerge: false,
    ...overrides,
  };
}

describe('evaluateDeterministicCompletion', () => {
  it('never passes on job.status alone without review_ready CI evidence', () => {
    const result = evaluateDeterministicCompletion(baseJob({ status: 'completed', phase: 'handoff_ready' }));
    expect(result.pass).toBe(false);
    expect(result.ciPassing).toBe(false);
  });

  it('passes a plain job whose CI phase reached review_ready', () => {
    const result = evaluateDeterministicCompletion(baseJob({ status: 'completed', phase: 'review_ready' }));
    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('fails a job whose route has not reached its completion marker', () => {
    const result = evaluateDeterministicCompletion(baseJob({
      status: 'completed',
      phase: 'review_ready',
      prompt: '【AUTOPILOT ROUTE CONTRACT】 do three passes',
      autopilotRoute: { checkpoints: [] },
    }));
    expect(result.pass).toBe(false);
    expect(result.routeComplete).toBe(false);
  });

  it('passes a route job once completedAt is set', () => {
    const result = evaluateDeterministicCompletion(baseJob({
      status: 'completed',
      phase: 'review_ready',
      prompt: '【AUTOPILOT ROUTE CONTRACT】 do three passes',
      autopilotRoute: { checkpoints: [], completedAt: '2026-01-01T00:10:00.000Z' },
    }));
    expect(result.pass).toBe(true);
  });

  it('fails while a human approval is outstanding', () => {
    const result = evaluateDeterministicCompletion(baseJob({ phase: 'human_required' }));
    expect(result.pass).toBe(false);
    expect(result.humanApprovalOutstanding).toBe(true);
  });

  it('ignores a stale guard failure category from an earlier, since-passed run', () => {
    const result = evaluateDeterministicCompletion(baseJob({
      status: 'completed',
      phase: 'review_ready',
      failureCategory: 'GUARD_FAILURE',
    }));
    expect(result.guardPassing).toBe(true);
    expect(result.pass).toBe(true);
  });
});

describe('buildCompletionCertificate', () => {
  it('is NOT_CANDIDATE for a job still running', () => {
    expect(buildCompletionCertificate(baseJob()).state).toBe('NOT_CANDIDATE');
  });

  it('is COMPLETION_CANDIDATE, never CERTIFIED, once deterministic checks pass — semantic review and goal stay PENDING', () => {
    const certificate = buildCompletionCertificate(baseJob({ status: 'completed', phase: 'review_ready' }));
    expect(certificate.state).toBe('COMPLETION_CANDIDATE');
    expect(certificate.semanticReview).toBe('PENDING');
    // Deterministic evidence alone (CI green, route complete) never claims
    // the goal/definitionOfDone was actually satisfied — that requires a
    // real Semantic Judge, which doesn't exist yet. Only REJECTED reports
    // 'FAIL' (real negative evidence); a passing deterministic check has no
    // positive-evidence equivalent to report 'PASS' with.
    expect(certificate.goal).toBe('PENDING');
  });

  it('reports goal as FAIL only once deterministic checks actively contradict completion', () => {
    expect(buildCompletionCertificate(baseJob({ status: 'completed', phase: 'human_required' })).goal).toBe('FAIL');
  });

  it('reports guard as PASS once CI is green, and PENDING before any CI result exists', () => {
    expect(buildCompletionCertificate(baseJob({ status: 'completed', phase: 'review_ready' })).guard).toBe('PASS');
    expect(buildCompletionCertificate(baseJob({ phase: 'waiting_ci' })).guard).toBe('PENDING');
  });

  it('reports guard as FAIL only when the observed failure was guard/policy-specific', () => {
    const guardFailure = buildCompletionCertificate(baseJob({ phase: 'recovery_ready', failureCategory: 'GUARD_FAILURE' }));
    expect(guardFailure.guard).toBe('FAIL');

    const unrelatedFailure = buildCompletionCertificate(baseJob({ phase: 'recovery_ready', failureCategory: 'CODE_FAILURE' }));
    expect(unrelatedFailure.guard).toBe('PASS');
  });

  it('is REJECTED when the job reached a terminal phase but deterministic checks fail', () => {
    const certificate = buildCompletionCertificate(baseJob({ status: 'completed', phase: 'human_required' }));
    expect(certificate.state).toBe('REJECTED');
    expect(certificate.blockingIssues).toBeGreaterThan(0);
  });

  it('reports ci as PENDING for a job still in progress, not FAIL', () => {
    for (const phase of ['handoff_ready', 'waiting_chatgpt', 'waiting_ci'] as const) {
      expect(buildCompletionCertificate(baseJob({ phase })).ci).toBe('PENDING');
    }
  });

  it('reports ci as FAIL only once CI/recovery actually observed a problem', () => {
    expect(buildCompletionCertificate(baseJob({ phase: 'recovery_ready' })).ci).toBe('FAIL');
    expect(buildCompletionCertificate(baseJob({ phase: 'human_required' })).ci).toBe('FAIL');
  });

  it('reports ci as PASS once CI actually succeeded', () => {
    expect(buildCompletionCertificate(baseJob({ status: 'completed', phase: 'review_ready' })).ci).toBe('PASS');
  });
});

describe('pendingSemanticJudge', () => {
  it('reports PENDING rather than fabricating a PASS', async () => {
    const result = await pendingSemanticJudge.evaluate(baseJob(), evaluateDeterministicCompletion(baseJob()));
    expect(result.verdict).toBe('PENDING');
  });
});

describe('firstNonEmpty', () => {
  it('returns the first genuinely non-blank entry', () => {
    expect(firstNonEmpty(['first', 'second'])).toBe('first');
  });

  it('skips a leading empty or whitespace-only entry rather than returning it', () => {
    expect(firstNonEmpty(['', '  ', 'real reason'])).toBe('real reason');
  });

  it('returns undefined for an all-blank or empty list, or undefined input', () => {
    expect(firstNonEmpty(['', '   '])).toBeUndefined();
    expect(firstNonEmpty([])).toBeUndefined();
    expect(firstNonEmpty(undefined)).toBeUndefined();
  });
});

describe('describeCompletionOutcome', () => {
  // This is the shared implementation both developerAgent.ts's completion
  // push and guardianRunner.ts's finalize() push call — PR #51 shipped a
  // Guardian message that ignored completionCertificate entirely and always
  // reported success, contradicting the correct message the other caller
  // already sent for the exact same job moments earlier.
  it('returns the fallback message for a CERTIFIED certificate', () => {
    const certificate = baseCertificate({ state: 'CERTIFIED', semanticReview: 'PASS', goal: 'PASS' });
    expect(describeCompletionOutcome(certificate, 'fallback')).toBe('fallback');
  });

  it('returns the fallback message when no certificate is present yet', () => {
    expect(describeCompletionOutcome(undefined, 'fallback')).toBe('fallback');
  });

  it('reports the first known limitation for a REJECTED certificate, ignoring the fallback', () => {
    const certificate = baseCertificate({
      state: 'REJECTED',
      semanticReview: 'FAIL',
      goal: 'FAIL',
      knownLimitations: ['スコープ外の変更が含まれています'],
    });
    expect(describeCompletionOutcome(certificate, 'fallback')).toBe(
      'CI成功しましたが、完了判定レビューが要確認と報告しています: スコープ外の変更が含まれています',
    );
  });

  it('falls back to the raw semanticReview verdict when REJECTED but knownLimitations is all-blank', () => {
    const certificate = baseCertificate({ state: 'REJECTED', semanticReview: 'FAIL', knownLimitations: ['', '  '] });
    expect(describeCompletionOutcome(certificate, 'fallback')).toBe(
      'CI成功しましたが、完了判定レビューが要確認と報告しています: FAIL',
    );
  });
});
