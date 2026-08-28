import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSemanticJudge } from './semanticJudge';
import { buildCompletionCertificateAsync, evaluateDeterministicCompletion } from './completionJudge';
import { DeveloperJob } from './developerAgent';

function baseJob(overrides: Partial<DeveloperJob> = {}): DeveloperJob {
  return {
    id: 'job-1',
    repository: 'octocat/example',
    goal: 'Ship the thing',
    prompt: 'Implement the thing',
    definitionOfDone: ['Add the feature', 'Add tests'],
    model: 'deterministic',
    orchestratorProvider: 'deterministic',
    workspace: {
      repository: 'octocat/example',
      defaultBranch: 'main',
      branch: 'ai-dev-deck/thing-abcd1234',
      baseSha: 'base123',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    status: 'completed',
    phase: 'review_ready',
    toolTurns: 0,
    maxToolTurns: 10,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    recoveryCount: 0,
    ciAutoReruns: 0,
    maxAutoCiReruns: 2,
    autoDispatch: false,
    changedFiles: [{ filename: 'src/thing.ts', status: 'modified', additions: 20, deletions: 3, changes: 23 }],
    outputText: 'Implemented the feature and added tests, CI is green.',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createSemanticJudge', () => {
  it('does not call the provider at all when the deterministic judge did not pass', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const judge = createSemanticJudge({ OPENAI_API_KEY: 'test-key' });

    const job = baseJob({ phase: 'human_required' });
    const result = await judge.evaluate(job, evaluateDeterministicCompletion(job));

    expect(result.verdict).toBe('PENDING');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports PENDING rather than fabricating a PASS when no provider is configured', async () => {
    const judge = createSemanticJudge({});
    const job = baseJob();
    const result = await judge.evaluate(job, evaluateDeterministicCompletion(job));
    expect(result.verdict).toBe('PENDING');
    expect(result.notes.join(' ')).toContain('Semantic Judge');
  });

  it('reports PENDING when the provider is unreachable, never a fabricated PASS', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const judge = createSemanticJudge({ OPENAI_API_KEY: 'test-key' });
    const job = baseJob();
    const result = await judge.evaluate(job, evaluateDeterministicCompletion(job));
    expect(result.verdict).toBe('PENDING');
  });

  it('returns the parsed PASS verdict from a well-formed provider response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({ verdict: 'PASS', notes: ['範囲内の変更のみ確認'] }) }] }],
    }), { status: 200 })));
    const judge = createSemanticJudge({ OPENAI_API_KEY: 'test-key' });
    const job = baseJob();
    const result = await judge.evaluate(job, evaluateDeterministicCompletion(job));
    expect(result.verdict).toBe('PASS');
    expect(result.notes).toEqual(['範囲内の変更のみ確認']);
  });

  it('returns FAIL when the provider reports a real contradiction', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({ verdict: 'FAIL', notes: ['テストが追加されていない'] }) }] }],
    }), { status: 200 })));
    const judge = createSemanticJudge({ OPENAI_API_KEY: 'test-key' });
    const job = baseJob();
    const result = await judge.evaluate(job, evaluateDeterministicCompletion(job));
    expect(result.verdict).toBe('FAIL');
  });

  it('falls back to PENDING when the provider response is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: [{ content: [{ type: 'output_text', text: 'not json at all' }] }],
    }), { status: 200 })));
    const judge = createSemanticJudge({ OPENAI_API_KEY: 'test-key' });
    const job = baseJob();
    const result = await judge.evaluate(job, evaluateDeterministicCompletion(job));
    expect(result.verdict).toBe('PENDING');
  });

  it('falls back to PENDING when the provider returns an out-of-set verdict string', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({ verdict: 'MAYBE', notes: [] }) }] }],
    }), { status: 200 })));
    const judge = createSemanticJudge({ OPENAI_API_KEY: 'test-key' });
    const job = baseJob();
    const result = await judge.evaluate(job, evaluateDeterministicCompletion(job));
    expect(result.verdict).toBe('PENDING');
  });
});

describe('buildCompletionCertificateAsync', () => {
  it('never calls the semantic judge for a job that is not even a completion candidate', async () => {
    const evaluate = vi.fn();
    const certificate = await buildCompletionCertificateAsync(baseJob({ status: 'running', phase: 'handoff_ready' }), { evaluate });
    expect(certificate.state).toBe('NOT_CANDIDATE');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('certifies only once the semantic judge itself returns PASS', async () => {
    const evaluate = vi.fn().mockResolvedValue({ verdict: 'PASS', notes: ['looks consistent'] });
    const certificate = await buildCompletionCertificateAsync(baseJob(), { evaluate });
    expect(certificate.state).toBe('CERTIFIED');
    expect(certificate.goal).toBe('PASS');
    expect(certificate.semanticReview).toBe('PASS');
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('downgrades an otherwise-passing deterministic result to REJECTED on a semantic FAIL', async () => {
    const evaluate = vi.fn().mockResolvedValue({ verdict: 'FAIL', notes: ['scope drift'] });
    const certificate = await buildCompletionCertificateAsync(baseJob(), { evaluate });
    expect(certificate.state).toBe('REJECTED');
    expect(certificate.goal).toBe('FAIL');
    expect(certificate.blockingIssues).toBe(1);
    expect(certificate.knownLimitations).toContain('scope drift');
  });

  it('stays COMPLETION_CANDIDATE, not CERTIFIED, while the semantic judge itself reports PENDING', async () => {
    const evaluate = vi.fn().mockResolvedValue({ verdict: 'PENDING', notes: ['provider unavailable'] });
    const certificate = await buildCompletionCertificateAsync(baseJob(), { evaluate });
    expect(certificate.state).toBe('COMPLETION_CANDIDATE');
    expect(certificate.goal).toBe('PENDING');
  });

  it('never invokes the semantic judge when deterministic checks already reject the job', async () => {
    const evaluate = vi.fn();
    const certificate = await buildCompletionCertificateAsync(baseJob({ phase: 'human_required' }), { evaluate });
    expect(certificate.state).toBe('REJECTED');
    expect(evaluate).not.toHaveBeenCalled();
  });
});
