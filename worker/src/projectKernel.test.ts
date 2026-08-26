import { describe, expect, it } from 'vitest';
import { parseProjectKernel } from './projectKernel';

const validManifest = {
  schemaVersion: 1,
  kind: 'ai-project-kernel',
  paths: {
    soul: 'docs/00-soul/SOUL.md',
    features: 'docs/03-scope/FEATURES.md',
  },
  capabilities: {
    structuredStatus: true,
    structuredGuard: true,
  },
  contextRouting: {
    core: ['docs/00-soul/SOUL.md'],
    scoped: ['craft/INDEX.md'],
    onDemand: ['docs/05-handoff/HANDOFF.md'],
  },
  runtime: {
    status: 'npm run status -- --json',
  },
  validation: {
    strategies: [
      {
        type: 'pull_request',
        checks: [
          { name: 'guard', category: 'GUARD_FAILURE' },
          { name: 'check-approval', category: 'HUMAN_APPROVAL_REQUIRED' },
        ],
      },
    ],
  },
};

describe('parseProjectKernel', () => {
  it('accepts the schema v1 foundation and preserves validation categories', () => {
    const parsed = parseProjectKernel(JSON.stringify(validManifest));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.kind).toBe('ai-project-kernel');
    expect(parsed.validation?.strategies[0].type).toBe('pull_request');
    expect(parsed.validation?.strategies[0].checks[1].category).toBe('HUMAN_APPROVAL_REQUIRED');
  });

  it('rejects unsupported schemas without guessing', () => {
    expect(() => parseProjectKernel(JSON.stringify({ ...validManifest, schemaVersion: 2 })))
      .toThrow('Unsupported Project Kernel schema');
  });

  it('rejects repository path traversal', () => {
    expect(() => parseProjectKernel(JSON.stringify({
      ...validManifest,
      paths: { soul: '../secrets.txt' },
    }))).toThrow('unsafe repository path');
  });

  it('rejects malformed validation strategies', () => {
    expect(() => parseProjectKernel(JSON.stringify({
      ...validManifest,
      validation: { strategies: [{ type: 'magic', checks: [] }] },
    }))).toThrow('type is invalid');
  });

  it('ignores unknown top-level fields for forward compatibility', () => {
    const parsed = parseProjectKernel(JSON.stringify({
      ...validManifest,
      futureCapability: { enabled: true },
    }));
    expect(parsed.kind).toBe('ai-project-kernel');
  });
});
