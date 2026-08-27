import { describe, expect, it } from 'vitest';
import {
  advanceRoutePhaseIndex,
  extractRoutePhaseIndex,
  parseRoutePlanInput,
  resolveCurrentRouteNode,
  resolveRouteDispatchChatUrl,
  routePhaseIdInstruction,
} from './routePlan';

describe('parseRoutePlanInput', () => {
  it('returns undefined for non-array input', () => {
    expect(parseRoutePlanInput(undefined)).toBeUndefined();
    expect(parseRoutePlanInput(null)).toBeUndefined();
    expect(parseRoutePlanInput('not an array')).toBeUndefined();
    expect(parseRoutePlanInput({ id: '1', label: 'a' })).toBeUndefined();
  });

  it('returns undefined for an empty array, not an empty result', () => {
    expect(parseRoutePlanInput([])).toBeUndefined();
  });

  it('parses valid nodes and trims whitespace', () => {
    expect(parseRoutePlanInput([
      { id: ' node-1 ', label: ' 現状確認 ' },
      { id: 'node-2', label: '実装' },
    ])).toEqual([
      { id: 'node-1', label: '現状確認' },
      { id: 'node-2', label: '実装' },
    ]);
  });

  it('drops malformed entries without failing the whole array', () => {
    expect(parseRoutePlanInput([
      { id: 'node-1', label: '現状確認' },
      { id: 123, label: 'bad id type' },
      { id: 'node-3', label: '' },
      { label: 'missing id' },
      null,
      'not an object',
      { id: 'node-4', label: '実装' },
    ])).toEqual([
      { id: 'node-1', label: '現状確認' },
      { id: 'node-4', label: '実装' },
    ]);
  });

  it('caps at 20 nodes and truncates overlong labels/ids', () => {
    const input = Array.from({ length: 25 }, (_, i) => ({ id: `node-${i}`, label: 'x'.repeat(300) }));
    const result = parseRoutePlanInput(input);
    expect(result).toHaveLength(20);
    expect(result?.[0].label.length).toBe(200);
  });

  it('accepts a valid https chatgpt.com chatUrl per node', () => {
    expect(parseRoutePlanInput([
      { id: 'node-1', label: '実装', chatUrl: 'https://chatgpt.com/c/abc-123' },
    ])).toEqual([
      { id: 'node-1', label: '実装', chatUrl: 'https://chatgpt.com/c/abc-123' },
    ]);
  });

  it('drops an invalid or non-ChatGPT chatUrl instead of failing the node', () => {
    expect(parseRoutePlanInput([
      { id: 'node-1', label: '実装', chatUrl: 'https://evil.example.com/steal' },
      { id: 'node-2', label: 'テスト', chatUrl: 'not a url' },
    ])).toEqual([
      { id: 'node-1', label: '実装' },
      { id: 'node-2', label: 'テスト' },
    ]);
  });
});

describe('resolveCurrentRouteNode', () => {
  const plan = [
    { id: 'a', label: '現状確認' },
    { id: 'b', label: '実装' },
    { id: 'c', label: 'テスト' },
  ];

  it('returns undefined for no declared route', () => {
    expect(resolveCurrentRouteNode(undefined, 0)).toBeUndefined();
    expect(resolveCurrentRouteNode([], 5)).toBeUndefined();
  });

  it('maps the phase index directly onto the declared plan', () => {
    expect(resolveCurrentRouteNode(plan, 0)).toEqual(plan[0]);
    expect(resolveCurrentRouteNode(plan, 1)).toEqual(plan[1]);
    expect(resolveCurrentRouteNode(plan, 2)).toEqual(plan[2]);
  });

  it('caps at the last declared phase for an out-of-range index', () => {
    expect(resolveCurrentRouteNode(plan, 10)).toEqual(plan[2]);
  });

  it('never goes negative for a malformed negative index', () => {
    expect(resolveCurrentRouteNode(plan, -5)).toEqual(plan[0]);
  });
});

describe('extractRoutePhaseIndex', () => {
  const plan = [
    { id: 'inspect', label: '現状確認' },
    { id: 'implement', label: '実装' },
    { id: 'test', label: 'テスト' },
  ];

  it('returns undefined with no declared route', () => {
    expect(extractRoutePhaseIndex(undefined, '[ROUTE_PHASE_ID: implement]')).toBeUndefined();
    expect(extractRoutePhaseIndex([], '[ROUTE_PHASE_ID: implement]')).toBeUndefined();
  });

  it('returns undefined with no commit message', () => {
    expect(extractRoutePhaseIndex(plan, undefined)).toBeUndefined();
  });

  it('returns undefined when the commit message has no marker', () => {
    expect(extractRoutePhaseIndex(plan, 'fix: adjust the widget')).toBeUndefined();
  });

  it('matches an exact known id and returns its index', () => {
    expect(extractRoutePhaseIndex(plan, 'work in progress\n\n[ROUTE_PHASE_ID: implement]')).toBe(1);
    expect(extractRoutePhaseIndex(plan, '[ROUTE_PHASE_ID: test]')).toBe(2);
  });

  it('is a closed-set exact match, not free-text interpretation — an unknown id yields undefined', () => {
    expect(extractRoutePhaseIndex(plan, '[ROUTE_PHASE_ID: hallucinated-phase]')).toBeUndefined();
  });

  it('does not match on the phase LABEL, only the id', () => {
    expect(extractRoutePhaseIndex(plan, '[ROUTE_PHASE_ID: 実装]')).toBeUndefined();
  });
});

describe('advanceRoutePhaseIndex', () => {
  it('stays put when nothing was reported', () => {
    expect(advanceRoutePhaseIndex(1, undefined)).toBe(1);
  });

  it('advances forward when a later phase is reported', () => {
    expect(advanceRoutePhaseIndex(0, 2)).toBe(2);
  });

  it('never regresses on a stale/out-of-order earlier-phase report', () => {
    expect(advanceRoutePhaseIndex(2, 0)).toBe(2);
  });

  it('stays put when the same phase is reported again', () => {
    expect(advanceRoutePhaseIndex(1, 1)).toBe(1);
  });
});

describe('routePhaseIdInstruction', () => {
  it('is empty for a job with no declared route', () => {
    expect(routePhaseIdInstruction(undefined)).toBe('');
    expect(routePhaseIdInstruction([])).toBe('');
  });

  it('lists every declared id/label pair and asks for the ROUTE_PHASE_ID marker', () => {
    const plan = [
      { id: 'inspect', label: '現状確認' },
      { id: 'implement', label: '実装' },
    ];
    const instruction = routePhaseIdInstruction(plan);
    expect(instruction).toContain('ROUTE_PHASE_ID');
    expect(instruction).toContain('inspect: 現状確認');
    expect(instruction).toContain('implement: 実装');
  });
});

describe('resolveRouteDispatchChatUrl', () => {
  it('uses the current phase\'s bound chatUrl when one is declared', () => {
    const plan = [
      { id: 'a', label: '設計', chatUrl: 'https://chatgpt.com/c/design' },
      { id: 'b', label: '実装', chatUrl: 'https://chatgpt.com/c/impl' },
    ];
    expect(resolveRouteDispatchChatUrl(plan, 0, 'https://chatgpt.com/c/default')).toBe('https://chatgpt.com/c/design');
    expect(resolveRouteDispatchChatUrl(plan, 1, 'https://chatgpt.com/c/default')).toBe('https://chatgpt.com/c/impl');
  });

  it('falls back to the job default chatUrl when the current phase declares none', () => {
    const plan = [{ id: 'a', label: '設計' }];
    expect(resolveRouteDispatchChatUrl(plan, 0, 'https://chatgpt.com/c/default')).toBe('https://chatgpt.com/c/default');
  });

  it('falls back to the job default chatUrl when no route is declared at all', () => {
    expect(resolveRouteDispatchChatUrl(undefined, 0, 'https://chatgpt.com/c/default')).toBe('https://chatgpt.com/c/default');
  });

  it('returns undefined when neither a phase chatUrl nor a job default exists', () => {
    expect(resolveRouteDispatchChatUrl(undefined, 0, undefined)).toBeUndefined();
  });
});
