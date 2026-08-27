import { describe, expect, it } from 'vitest';
import { LifecycleHookRegistry } from './lifecycleHooks';

const ctx = { jobId: 'job-1', repository: 'octocat/example', at: '2026-01-01T00:00:00.000Z' };

describe('LifecycleHookRegistry', () => {
  it('is a no-op when nothing is registered', async () => {
    const registry = new LifecycleHookRegistry();
    await expect(registry.run('BEFORE_TASK', ctx)).resolves.toEqual([]);
  });

  it('runs every registered handler for a hook, in order', async () => {
    const registry = new LifecycleHookRegistry();
    const calls: string[] = [];
    registry.on('AFTER_TASK', () => { calls.push('first'); });
    registry.on('AFTER_TASK', async () => { calls.push('second'); });
    await registry.run('AFTER_TASK', ctx);
    expect(calls).toEqual(['first', 'second']);
  });

  it('isolates one failing handler from the others and never throws', async () => {
    const registry = new LifecycleHookRegistry();
    const calls: string[] = [];
    registry.on('CI_FAILED', () => { throw new Error('boom'); });
    registry.on('CI_FAILED', () => { calls.push('still ran'); });
    const results = await registry.run('CI_FAILED', ctx);
    expect(calls).toEqual(['still ran']);
    expect(results).toEqual([{ ok: false, error: 'boom' }, { ok: true }]);
  });

  it('only fires handlers registered for the matching hook name', async () => {
    const registry = new LifecycleHookRegistry();
    let fired = false;
    registry.on('BEFORE_COMPLETE', () => { fired = true; });
    await registry.run('BEFORE_TASK', ctx);
    expect(fired).toBe(false);
    expect(registry.handlerCount('BEFORE_COMPLETE')).toBe(1);
    expect(registry.handlerCount('BEFORE_TASK')).toBe(0);
  });
});
