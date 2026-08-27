import { describe, expect, it } from 'vitest';
import { buildDevelopmentCheckpoint } from './developmentCheckpoint';
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

describe('buildDevelopmentCheckpoint', () => {
  it('always reports worktree as null — no local worktree exists in this architecture', () => {
    expect(buildDevelopmentCheckpoint(baseJob()).worktree).toBeNull();
  });

  it('derives validation.ci from job phase', () => {
    expect(buildDevelopmentCheckpoint(baseJob({ phase: 'waiting_ci' })).validation.ci).toBe('PENDING');
    expect(buildDevelopmentCheckpoint(baseJob({ phase: 'review_ready' })).validation.ci).toBe('PASSING');
    expect(buildDevelopmentCheckpoint(baseJob({ phase: 'recovery_ready' })).validation.ci).toBe('FAILING');
    expect(buildDevelopmentCheckpoint(baseJob({ phase: 'handoff_ready' })).validation.ci).toBe('UNKNOWN');
  });

  it('does not report a stale guard failure once CI has since passed', () => {
    // failureCategory persists from the most recent recovery even after a
    // later successful CI run — a review_ready job that already fixed its
    // guard violation must not still project a live guard failure.
    const checkpoint = buildDevelopmentCheckpoint(baseJob({
      status: 'completed',
      phase: 'review_ready',
      failureCategory: 'GUARD_FAILURE',
    }));
    expect(checkpoint.validation.guard).toBe('UNKNOWN');
  });

  it('reports a currently-active guard failure', () => {
    const checkpoint = buildDevelopmentCheckpoint(baseJob({
      phase: 'recovery_ready',
      failureCategory: 'POLICY_FAILURE',
    }));
    expect(checkpoint.validation.guard).toBe('FAILING');
  });

  it('surfaces a human_required phase as a blocker', () => {
    const checkpoint = buildDevelopmentCheckpoint(baseJob({ phase: 'human_required', error: 'Needs sign-off.' }));
    expect(checkpoint.blockers).toContain('Needs sign-off.');
  });

  it('folds route checkpoints into verifiedDone', () => {
    const checkpoint = buildDevelopmentCheckpoint(baseJob({
      autopilotRoute: {
        checkpoints: [
          { headSha: 'abcdef1234567', reachedAt: '2026-01-01T00:01:00.000Z', step: 'debug pass 1/3' },
          { headSha: 'bbbbbb1234567', reachedAt: '2026-01-01T00:02:00.000Z' },
        ],
      },
    }));
    expect(checkpoint.routeId).toBe('job-1');
    expect(checkpoint.routeNode).toBe('debug pass 1/3');
    expect(checkpoint.verifiedDone).toEqual(['debug pass 1/3 (abcdef1)']);
  });

  it('reports no route fields for an ordinary job', () => {
    const checkpoint = buildDevelopmentCheckpoint(baseJob());
    expect(checkpoint.routeId).toBeUndefined();
    expect(checkpoint.routeNode).toBeUndefined();
  });

  it('labels a repeated failure with its recurrence count', () => {
    const checkpoint = buildDevelopmentCheckpoint(baseJob({
      failureCategory: 'CODE_FAILURE',
      error: 'tests failing',
      recurringFailureCount: 3,
    }));
    expect(checkpoint.recentFailures[0]).toContain('x3');
  });
});
