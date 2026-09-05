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
    autoMerge: false,
    changedFiles: [{ filename: 'src/thing.ts', status: 'modified', additions: 20, deletions: 3, changes: 23 }],
    outputText: 'Implemented the feature and added tests, CI is green.',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const GITHUB_ENV = { GITHUB_TOKEN: 'gh-token', GITHUB_ALLOWED_REPOS: 'octocat/example' };

function base64(text: string) {
  return Buffer.from(text, 'utf-8').toString('base64');
}

// Routes by hostname so a single stubbed fetch can serve both the GitHub
// Contents API call (fetchHandoffContent) and the orchestration provider
// call (requestOrchestrationText) within the same test.
function routedFetch(routes: { github?: () => Response; provider?: () => Response }) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('api.github.com')) {
      if (!routes.github) throw new Error(`unexpected GitHub API call: ${url}`);
      return routes.github();
    }
    if (!routes.provider) throw new Error(`unexpected provider call: ${url}`);
    return routes.provider();
  });
}

function passResponse(notes: string[] = ['ok']) {
  return new Response(JSON.stringify({
    output: [{ content: [{ type: 'output_text', text: JSON.stringify({ verdict: 'PASS', notes }) }] }],
  }), { status: 200 });
}

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

  it('does not attempt a HANDOFF.md fetch at all when the job has no kernelManifest', async () => {
    const fetchSpy = routedFetch({ provider: () => passResponse() });
    vi.stubGlobal('fetch', fetchSpy);
    const judge = createSemanticJudge({ OPENAI_API_KEY: 'test-key' });
    const result = await judge.evaluate(baseJob(), evaluateDeterministicCompletion(baseJob()));
    expect(result.verdict).toBe('PASS');
    expect(fetchSpy.mock.calls.every(([input]) => !String(input).includes('api.github.com'))).toBe(true);
  });

  it('fetches real HANDOFF.md content and includes it in the prompt for a KERNEL_AWARE job', async () => {
    const handoffText = 'P4自己監査: 目標をすべて満たし、テストも追加済みです。';
    const fetchSpy = routedFetch({
      github: () => new Response(JSON.stringify({ type: 'file', sha: 'abc', size: handoffText.length, content: base64(handoffText), encoding: 'base64' }), { status: 200 }),
      provider: () => passResponse(),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const judge = createSemanticJudge({ OPENAI_API_KEY: 'test-key', ...GITHUB_ENV });
    const job = baseJob({
      kernelManifest: { schemaVersion: 1, kind: 'ai-project-kernel', paths: { handoff: 'docs/05-handoff/HANDOFF.md' }, capabilities: {} },
      lastHeadSha: 'deadbeef',
      changedFiles: [{ filename: 'docs/05-handoff/HANDOFF.md', status: 'modified', additions: 5, deletions: 1, changes: 6 }],
    });
    const result = await judge.evaluate(job, evaluateDeterministicCompletion(job));
    expect(result.verdict).toBe('PASS');

    const providerCall = fetchSpy.mock.calls.find(([input]) => String(input).includes('api.openai.com'));
    const providerBody = JSON.parse(String(providerCall?.[1]?.body));
    expect(providerBody.input as string).toContain(handoffText);
    expect(providerBody.input as string).toContain('HANDOFF.md');
  });

  // Regression guard: a FIXED delimiter string (the very first version of
  // this isolation fix) can be defeated by a HANDOFF.md that simply
  // contains that literal string, closing the quoted section early and
  // leaving the rest to be read as ordinary prompt text. The real
  // delimiter must be unpredictable per call (a nonce), so this asserts
  // it's actually random and actually shared between the system prompt
  // (which tells the model what the real marker looks like) and the user
  // prompt (which uses it) — not a static, greppable string.
  it('wraps HANDOFF.md content in a random per-call nonce delimiter, not a fixed/predictable one', async () => {
    const handoffText = 'ordinary handoff content';
    const fetchSpy = routedFetch({
      github: () => new Response(JSON.stringify({ type: 'file', sha: 'abc', size: handoffText.length, content: base64(handoffText), encoding: 'base64' }), { status: 200 }),
      provider: () => passResponse(),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const judge = createSemanticJudge({ OPENAI_API_KEY: 'test-key', ...GITHUB_ENV });
    const job = baseJob({
      kernelManifest: { schemaVersion: 1, kind: 'ai-project-kernel', paths: { handoff: 'docs/05-handoff/HANDOFF.md' }, capabilities: {} },
      changedFiles: [{ filename: 'docs/05-handoff/HANDOFF.md', status: 'modified', additions: 5, deletions: 1, changes: 6 }],
    });
    await judge.evaluate(job, evaluateDeterministicCompletion(job));

    const providerCall = fetchSpy.mock.calls.find(([input]) => String(input).includes('api.openai.com'));
    const providerBody = JSON.parse(String(providerCall?.[1]?.body));
    expect(providerBody.input as string).not.toContain('<<<HANDOFF_START>>>');
    const startMatch = (providerBody.input as string).match(/<<<HANDOFF_([0-9a-f-]{36})_START>>>/);
    expect(startMatch).not.toBeNull();
    const nonce = startMatch![1];
    expect(providerBody.input as string).toContain(`<<<HANDOFF_${nonce}_END>>>`);
    // The system prompt (instructions) must reference the SAME nonce so
    // the model actually knows what the real boundary looks like.
    expect(providerBody.instructions as string).toContain(`<<<HANDOFF_${nonce}_START>>>`);
  });

  it('includes the specific dispatched TASK (job.prompt), distinct from the broad project GOAL, in the prompt', async () => {
    const fetchSpy = routedFetch({ provider: () => passResponse() });
    vi.stubGlobal('fetch', fetchSpy);
    const judge = createSemanticJudge({ OPENAI_API_KEY: 'test-key' });
    const job = baseJob({ goal: 'Ship the whole thing', prompt: 'Just fix the narrow typo in the README' });
    await judge.evaluate(job, evaluateDeterministicCompletion(job));

    const providerCall = fetchSpy.mock.calls.find(([input]) => String(input).includes('api.openai.com'));
    const providerBody = JSON.parse(String(providerCall?.[1]?.body));
    expect(providerBody.input as string).toContain('Ship the whole thing');
    expect(providerBody.input as string).toContain('Just fix the narrow typo in the README');
  });

  it('does not attempt a HANDOFF.md fetch at all when the declared handoff path was not touched by this job (stale-content guard)', async () => {
    const fetchSpy = routedFetch({
      github: () => { throw new Error('must not fetch a HANDOFF.md this job never touched'); },
      provider: () => passResponse(),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const judge = createSemanticJudge({ OPENAI_API_KEY: 'test-key', ...GITHUB_ENV });
    const job = baseJob({
      kernelManifest: { schemaVersion: 1, kind: 'ai-project-kernel', paths: { handoff: 'docs/05-handoff/HANDOFF.md' }, capabilities: {} },
      changedFiles: [{ filename: 'src/thing.ts', status: 'modified', additions: 20, deletions: 3, changes: 23 }],
    });
    const result = await judge.evaluate(job, evaluateDeterministicCompletion(job));
    expect(result.verdict).toBe('PASS');
    expect(fetchSpy.mock.calls.every(([input]) => !String(input).includes('api.github.com'))).toBe(true);
  });

  it('falls back gracefully (still calls the provider, no crash) when the HANDOFF.md fetch fails', async () => {
    const fetchSpy = routedFetch({
      github: () => new Response('not found', { status: 404 }),
      provider: () => passResponse(),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const judge = createSemanticJudge({ OPENAI_API_KEY: 'test-key', ...GITHUB_ENV });
    const job = baseJob({
      kernelManifest: { schemaVersion: 1, kind: 'ai-project-kernel', paths: { handoff: 'docs/05-handoff/HANDOFF.md' }, capabilities: {} },
      changedFiles: [{ filename: 'docs/05-handoff/HANDOFF.md', status: 'modified', additions: 5, deletions: 1, changes: 6 }],
    });
    const result = await judge.evaluate(job, evaluateDeterministicCompletion(job));
    expect(result.verdict).toBe('PASS');
  });

  // Regression guard: JSON.parse succeeds (without throwing) on any valid
  // JSON value, not just objects — a degenerate provider response of the
  // literal `null`, a bare number, or a bare string must degrade to
  // PENDING like every other malformed-response case, not throw an
  // uncaught TypeError from reading `.verdict` off a non-object.
  it.each(['null', '42', '"just a string"', '[]'])('falls back to PENDING without throwing when the provider response is the JSON value %s', async (value) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: [{ content: [{ type: 'output_text', text: value }] }],
    }), { status: 200 })));
    const judge = createSemanticJudge({ OPENAI_API_KEY: 'test-key' });
    const job = baseJob();
    await expect(judge.evaluate(job, evaluateDeterministicCompletion(job))).resolves.toEqual(
      expect.objectContaining({ verdict: 'PENDING' }),
    );
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
