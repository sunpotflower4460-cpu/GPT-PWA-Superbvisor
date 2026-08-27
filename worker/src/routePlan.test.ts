import { describe, expect, it } from 'vitest';
import { parseRoutePlanInput } from './routePlan';

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
});
