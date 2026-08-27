import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleKernelContext } from './contextAssembler';
import { parseProjectKernel } from './projectKernel';
import type { GitHubEnv } from './githubExecutor';

const env: GitHubEnv = {
  GITHUB_TOKEN: 'test-token',
  GITHUB_ALLOWED_REPOS: 'octocat/example',
};

const manifest = parseProjectKernel(JSON.stringify({
  schemaVersion: 1,
  kind: 'ai-project-kernel',
  paths: {
    soul: 'docs/00-soul/SOUL.md',
    features: 'docs/03-scope/FEATURES.md',
    uiJudgments: 'docs/04-design/UI_JUDGMENTS.md',
    decisions: 'docs/02-decisions/DECISIONS.md',
    handoff: 'docs/05-handoff/HANDOFF.md',
  },
  capabilities: {},
  contextRouting: {
    core: ['soul', 'features'],
    scoped: ['uiJudgments', 'decisions'],
    onDemand: ['handoff'],
  },
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fileResponse(content: string, sha = 'sha-1') {
  return jsonResponse({
    type: 'file',
    sha,
    size: content.length,
    encoding: 'base64',
    content: Buffer.from(content, 'utf-8').toString('base64'),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('assembleKernelContext', () => {
  it('always fetches CORE and skips SCOPED sections the task text does not mention', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('SOUL.md')) return fileResponse('# soul content');
      if (url.includes('FEATURES.md')) return fileResponse('# features content');
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await assembleKernelContext({
      env,
      repository: 'octocat/example',
      ref: 'main',
      manifest,
      task: 'Fix the login bug',
    });

    expect(result.sections.map((section) => section.key)).toEqual(['soul', 'features']);
    expect(result.text).toContain('soul content');
    expect(result.omittedOnDemandKeys).toEqual(['handoff']);
  });

  it('includes a SCOPED section when the task text mentions a matching keyword', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('SOUL.md')) return fileResponse('soul');
      if (url.includes('FEATURES.md')) return fileResponse('features');
      if (url.includes('UI_JUDGMENTS.md')) return fileResponse('ui judgments content');
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await assembleKernelContext({
      env,
      repository: 'octocat/example',
      ref: 'main',
      manifest,
      task: 'Redesign the settings screen UI',
    });

    expect(result.sections.map((section) => section.key)).toContain('uiJudgments');
    expect(result.sections.map((section) => section.key)).not.toContain('decisions');
  });

  it('silently skips a declared path that does not exist in the repo', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('SOUL.md')) return jsonResponse({ message: 'Not Found' }, 404);
      if (url.includes('FEATURES.md')) return fileResponse('features');
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await assembleKernelContext({
      env,
      repository: 'octocat/example',
      ref: 'main',
      manifest,
      task: 'anything',
    });

    expect(result.sections.map((section) => section.key)).toEqual(['features']);
  });

  it('truncates a section that exceeds its share of the budget', async () => {
    const longContent = 'x'.repeat(5000);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('SOUL.md')) return fileResponse(longContent);
      if (url.includes('FEATURES.md')) return fileResponse('features');
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await assembleKernelContext({
      env,
      repository: 'octocat/example',
      ref: 'main',
      manifest,
      task: 'anything',
      budgetChars: 2000,
    });

    const soul = result.sections.find((section) => section.key === 'soul');
    expect(soul?.truncated).toBe(true);
    expect(soul?.content.length).toBeLessThan(longContent.length);
  });

  it('reports omittedForBudgetKeys once the budget is exhausted', async () => {
    const longContent = 'x'.repeat(2000);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('SOUL.md')) return fileResponse(longContent);
      if (url.includes('FEATURES.md')) return fileResponse(longContent);
      throw new Error(`unexpected fetch beyond budget: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    // Both CORE entries plus a now-relevant SCOPED entry (task mentions
    // "UI") compete for a deliberately small budget — CORE entries always
    // run first, leaving nothing for the SCOPED one.
    const result = await assembleKernelContext({
      env,
      repository: 'octocat/example',
      ref: 'main',
      manifest,
      task: 'Redesign the UI',
      budgetChars: 1000,
    });

    expect(result.sections.map((section) => section.key)).toEqual(['soul', 'features']);
    expect(result.omittedForBudgetKeys).toContain('uiJudgments');
  });

  it('never reports usedChars above budgetChars even when several sections truncate back-to-back', async () => {
    // Each truncated section's own "…(truncated, N more characters
    // omitted)" notice is appended AFTER slicing to its allowance, so its
    // real length can exceed the allowance by the notice's own length.
    // With a small budget and two large CORE sections in a row, that
    // overshoot used to drive `remaining` negative and inflate usedChars
    // past budgetChars.
    const longContent = 'x'.repeat(2000);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('SOUL.md')) return fileResponse(longContent);
      if (url.includes('FEATURES.md')) return fileResponse(longContent);
      throw new Error(`unexpected fetch beyond budget: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await assembleKernelContext({
      env,
      repository: 'octocat/example',
      ref: 'main',
      manifest,
      task: 'anything',
      budgetChars: 1000,
    });

    expect(result.usedChars).toBeLessThanOrEqual(result.budgetChars);
  });

  it('keeps the actual rendered text within budget, including section headers and separators', async () => {
    // Headers ("### [TIER] key (path)\n") and the "\n\n" join separator
    // between sections are real characters in the prompt this produces —
    // if they're never deducted from the budget, `text.length` can exceed
    // `budgetChars` even when `usedChars` claims otherwise.
    const longContent = 'x'.repeat(5000);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('SOUL.md')) return fileResponse(longContent);
      if (url.includes('FEATURES.md')) return fileResponse(longContent);
      throw new Error(`unexpected fetch beyond budget: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const budgetChars = 2000;
    const result = await assembleKernelContext({
      env,
      repository: 'octocat/example',
      ref: 'main',
      manifest,
      task: 'anything',
      budgetChars,
    });

    // A small, bounded slack remains acceptable: each truncated section's
    // own notice ("…(truncated, N more characters omitted)") is appended
    // after slicing to its allowance (a soft budget, not a byte-exact cap —
    // see the module's own top comment) — but that slack is at most a few
    // dozen characters per section, never the unbounded overshoot header/
    // separator accounting would otherwise allow.
    const maxAcceptableSlack = 80 * result.sections.length;
    expect(result.text.length).toBeLessThanOrEqual(budgetChars + maxAcceptableSlack);
  });
});
