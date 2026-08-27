import { describe, expect, it } from 'vitest';
import { deriveContextPressure } from './contextPressure';

describe('deriveContextPressure', () => {
  it('is LOW for a fresh job', () => {
    expect(deriveContextPressure({ recoveryCount: 0, routeCheckpointCount: 0 })).toBe('LOW');
  });

  it('rises to MEDIUM once the combined signal crosses the first threshold', () => {
    expect(deriveContextPressure({ recoveryCount: 4, routeCheckpointCount: 0 })).toBe('LOW');
    expect(deriveContextPressure({ recoveryCount: 5, routeCheckpointCount: 0 })).toBe('MEDIUM');
    expect(deriveContextPressure({ recoveryCount: 2, routeCheckpointCount: 3 })).toBe('MEDIUM');
  });

  it('rises to HIGH once the combined signal crosses the second threshold', () => {
    expect(deriveContextPressure({ recoveryCount: 11, routeCheckpointCount: 0 })).toBe('MEDIUM');
    expect(deriveContextPressure({ recoveryCount: 12, routeCheckpointCount: 0 })).toBe('HIGH');
    expect(deriveContextPressure({ recoveryCount: 6, routeCheckpointCount: 6 })).toBe('HIGH');
  });

  it('never goes negative from unexpected negative input', () => {
    expect(deriveContextPressure({ recoveryCount: -5, routeCheckpointCount: -5 })).toBe('LOW');
  });
});
