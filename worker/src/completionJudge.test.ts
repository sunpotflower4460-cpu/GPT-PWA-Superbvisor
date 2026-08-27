import { describe, expect, it } from 'vitest';
import { buildCompletionCertificate, evaluateDeterministicCompletion, pendingSemanticJudge } from './completionJudge';
import { DeveloperJob } from './developerAgent';

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

  it('is COMPLETION_CANDIDATE, never CERTIFIED, once deterministic checks pass — semantic review stays PENDING', () => {
    const certificate = buildCompletionCertificate(baseJob({ status: 'completed', phase: 'review_ready' }));
    expect(certificate.state).toBe('COMPLETION_CANDIDATE');
    expect(certificate.semanticReview).toBe('PENDING');
    expect(certificate.goal).toBe('PASS');
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
