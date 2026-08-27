// A minimal, deterministic Lifecycle Hook registry (design item #24:
// "HooksはLLM promptではなく、可能な限りdeterministic codeで処理する").
// This is infrastructure, not orchestration logic: it never decides what
// happens next in a DeveloperJob's flow (developerAgent.ts keeps doing
// that) — it only gives OTHER code (logging, a future push-notification
// channel, a future audit trail) a stable seam to observe named lifecycle
// events without editing developerAgent.ts's control flow again for every
// new observer. Registering zero handlers is a fully valid, no-op state;
// nothing about a job's outcome depends on any hook actually being
// registered.
export type HookName =
  | 'SESSION_START'
  | 'BEFORE_TASK'
  | 'AFTER_TASK'
  | 'BEFORE_WRITE'
  | 'AFTER_WRITE'
  | 'BEFORE_VALIDATION'
  | 'AFTER_VALIDATION'
  | 'TEST_FAILED'
  | 'CI_FAILED'
  | 'PRE_COMPACT'
  | 'POST_COMPACT'
  | 'BEFORE_STOP'
  | 'BEFORE_COMPLETE';

export const HOOK_NAMES: readonly HookName[] = [
  'SESSION_START',
  'BEFORE_TASK',
  'AFTER_TASK',
  'BEFORE_WRITE',
  'AFTER_WRITE',
  'BEFORE_VALIDATION',
  'AFTER_VALIDATION',
  'TEST_FAILED',
  'CI_FAILED',
  'PRE_COMPACT',
  'POST_COMPACT',
  'BEFORE_STOP',
  'BEFORE_COMPLETE',
];

export interface HookContext {
  jobId: string;
  repository: string;
  branch?: string;
  at: string;
  detail?: string;
}

export type HookHandler = (context: HookContext) => void | Promise<void>;

// A fresh registry per caller rather than one process-wide singleton: a
// Cloudflare Worker isolate can be reused across unrelated requests, so a
// module-level singleton would leak handlers registered for one request's
// job into another's. Callers that want a shared set of handlers (e.g. "log
// every hook") construct one registry and reuse it explicitly.
export class LifecycleHookRegistry {
  private readonly handlers = new Map<HookName, HookHandler[]>();

  on(name: HookName, handler: HookHandler): void {
    const existing = this.handlers.get(name) ?? [];
    existing.push(handler);
    this.handlers.set(name, existing);
  }

  // Runs every registered handler for `name` sequentially and never throws:
  // one handler's failure must not stop the others from running, and must
  // never propagate up into the DeveloperJob control flow that fired the
  // hook (mirrors GPT-template's scripts/guard/index.mjs runAll() — a
  // single unexpected failure isolated per-item, not fatal to the whole
  // run). Returns the handlers' outcomes for a caller that wants to log
  // failures, but callers are free to ignore the return value entirely.
  async run(name: HookName, context: HookContext): Promise<Array<{ ok: true } | { ok: false; error: string }>> {
    const handlers = this.handlers.get(name) ?? [];
    const results: Array<{ ok: true } | { ok: false; error: string }> = [];
    for (const handler of handlers) {
      try {
        await handler(context);
        results.push({ ok: true });
      } catch (error) {
        results.push({ ok: false, error: error instanceof Error ? error.message : 'Unknown lifecycle hook error' });
      }
    }
    return results;
  }

  handlerCount(name: HookName): number {
    return this.handlers.get(name)?.length ?? 0;
  }
}

// Convenience singleton for this Worker's own internal lifecycle events —
// see developerAgent.ts's hook call sites (BEFORE_TASK/AFTER_TASK/
// BEFORE_VALIDATION/CI_FAILED/BEFORE_COMPLETE). A module-level instance is
// safe here specifically because nothing in this codebase registers a
// handler on it by default: a Cloudflare Worker isolate being reused across
// unrelated requests only risks handler leakage once SOMETHING calls
// `hooks.on(...)`, which is a future caller's explicit decision (e.g.
// wiring a push-notification or audit-log channel), not an accident of
// this file importing cleanly.
export const hooks = new LifecycleHookRegistry();
