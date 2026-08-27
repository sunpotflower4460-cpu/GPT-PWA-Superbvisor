import { CiCheckLike, SUCCESS_CONCLUSIONS } from './orchestratorPolicy';

// The design's Execution Fabric abstraction (LOCAL_FAST / ISOLATED /
// BROWSER / CI), with one deliberate, explicit gap: this Worker runs on
// Cloudflare Workers, which has no filesystem and no subprocess/exec
// capability of any kind (confirmed — there is no child_process, no
// filesystem API, nothing resembling one, anywhere in worker/src). Every
// mutation and every piece of test/build evidence available to this Worker
// already comes through the GitHub REST API — GitHub Actions CI is the
// only real execution this system has ever had. Per the design's own
// instruction ("Do NOT fake a local runtime that does not exist"), this
// module does NOT ship a LOCAL_FAST/ISOLATED implementation that pretends
// to run commands somewhere it cannot, or a BROWSER `kind` that pretends
// to launch and drive a browser itself. It formalizes the ONE fabric that
// is real (CI) behind the shared interface, and leaves LOCAL_FAST/ISOLATED
// (and a true browser-driving BROWSER kind) as typed-but-unimplemented — a
// future physical execution host (a separate service this Worker could
// call over HTTP, outside the Cloudflare Workers sandbox) is what would
// actually back them.
//
// CiExecutionFabric's runBrowser() below is NOT that — it stays kind:
// 'CI'. It isolates a target repo's OWN browser/visual-test CI job (e.g. a
// Playwright job that repo's maintainers already run in their GitHub
// Actions) by check name, the same way runTest/runTypecheck/runBuild
// isolate their phases. It surfaces evidence a browser test already
// produced; it never opens a browser itself. A repo with no browser-named
// CI check simply gets the same "no per-phase runner exists" aggregate
// fallback as any other phase.
export type ExecutionFabricKind = 'LOCAL_FAST' | 'ISOLATED' | 'BROWSER' | 'CI';

export interface ExecutionFailure {
  file?: string;
  line?: number;
  message: string;
}

// The structured-JSON shape the design calls for in place of raw terminal
// dumps — orchestratorPolicy.ts already renders CiCheckLike[] as
// "name: conclusion (url)" lines for prompts; this is the same evidence,
// reshaped into the fields a caller can act on programmatically instead of
// re-parsing prose.
export interface ExecutionResult {
  status: 'passed' | 'failed' | 'pending' | 'unknown';
  command: string;
  exitCode: number | null;
  durationMs: number | null;
  failures: ExecutionFailure[];
  artifact?: string;
}

export interface ExecutionFabric {
  kind: ExecutionFabricKind;
  runTest(): Promise<ExecutionResult>;
  runTypecheck(): Promise<ExecutionResult>;
  runBuild(): Promise<ExecutionResult>;
  // Browser/visual evidence (Playwright, Cypress, screenshot diffing, …).
  // On a CI-backed fabric this is still just a named-check lookup, same as
  // runTest/runTypecheck/runBuild below — it does NOT launch a browser
  // itself. The actual browser driving has to happen in the target repo's
  // own CI job (this Worker has no more ability to launch Playwright than
  // it does to run `npm test` — see the module's own top comment); this
  // method only surfaces whatever evidence that job already produced.
  runBrowser(): Promise<ExecutionResult>;
  runCommand(command: string): Promise<ExecutionResult>;
  inspectLogs(): Promise<ExecutionResult[]>;
  health(): Promise<{ available: boolean; detail?: string }>;
}

// GitHub Actions reports named checks, not typed phases, so this Worker
// cannot know for certain which check is "the test phase" — but a repo's
// own check names are frequently informative (a job literally named
// "worker-check" that runs typecheck+test+dry-run in one step won't match
// anything, but "test", "unit-tests", "typecheck" etc. will). runTest/
// runTypecheck/runBuild each first try to isolate checks whose name
// matches that phase's keywords (PHASE_KEYWORDS below); when that yields a
// real subset, the result reflects ONLY those checks — genuinely more
// precise evidence than the aggregate. When no check name matches (the
// common case for a repo with one combined CI job), it falls back to the
// full aggregate, same as before, with a `command` label that says so
// rather than silently pretending the fallback is precise. This is a
// heuristic over check *names*, not a real per-phase runner — see the
// module's own top comment on why no per-phase runner exists here at all.
// runCommand has no meaning for a CI-backed fabric (there is no way to run
// an arbitrary command against GitHub Actions on demand) and always
// reports 'unknown'.
const PHASE_KEYWORDS: Record<'test' | 'typecheck' | 'build' | 'browser', string[]> = {
  test: ['test', 'spec', 'unit', 'jest', 'vitest', 'pytest'],
  typecheck: ['typecheck', 'type-check', 'tsc', 'mypy'],
  build: ['build', 'compile', 'bundle', 'dry-run', 'dryrun'],
  browser: ['browser', 'e2e', 'playwright', 'cypress', 'visual', 'screenshot', 'ui-test'],
};

export class CiExecutionFabric implements ExecutionFabric {
  readonly kind: ExecutionFabricKind = 'CI';

  constructor(private readonly checks: readonly CiCheckLike[], private readonly ciAvailable: boolean) {}

  async runTest(): Promise<ExecutionResult> {
    return this.fromChecksForPhase('test', PHASE_KEYWORDS.test);
  }

  async runTypecheck(): Promise<ExecutionResult> {
    return this.fromChecksForPhase('typecheck', PHASE_KEYWORDS.typecheck);
  }

  async runBuild(): Promise<ExecutionResult> {
    return this.fromChecksForPhase('build', PHASE_KEYWORDS.build);
  }

  async runBrowser(): Promise<ExecutionResult> {
    return this.fromChecksForPhase('browser', PHASE_KEYWORDS.browser);
  }

  async runCommand(command: string): Promise<ExecutionResult> {
    return {
      status: 'unknown',
      command,
      exitCode: null,
      durationMs: null,
      failures: [{ message: 'CiExecutionFabric cannot run an arbitrary command — only aggregate GitHub Actions check status is available.' }],
    };
  }

  async inspectLogs(): Promise<ExecutionResult[]> {
    return this.checks.map((check) => ({
      status: mapConclusion(check.conclusion, check.status),
      command: check.name,
      exitCode: null,
      durationMs: null,
      failures: check.conclusion && !SUCCESS_CONCLUSIONS.has(check.conclusion.toLowerCase()) ? [{ message: `${check.name}: ${check.conclusion} — ${check.url}` }] : [],
      artifact: check.url,
    }));
  }

  async health(): Promise<{ available: boolean; detail?: string }> {
    return this.ciAvailable
      ? { available: true }
      : { available: false, detail: 'No CI run has been observed for the current head yet.' };
  }

  private fromChecksForPhase(phase: string, keywords: readonly string[]): ExecutionResult {
    const matching = this.checks.filter((check) => keywords.some((keyword) => check.name.toLowerCase().includes(keyword)));
    if (matching.length) {
      return this.fromChecksSubset(matching, `ci: checks matching "${phase}" by name (${matching.map((check) => check.name).join(', ')})`);
    }
    return this.fromChecksSubset(
      this.checks,
      `ci: aggregate check status (no check name matched "${phase}" — falling back to all checks)`,
    );
  }

  private fromChecksSubset(checks: readonly CiCheckLike[], command: string): ExecutionResult {
    if (!checks.length) {
      return { status: 'unknown', command, exitCode: null, durationMs: null, failures: [] };
    }
    const pending = checks.some((check) => check.status !== 'completed');
    if (pending) return { status: 'pending', command, exitCode: null, durationMs: null, failures: [] };

    const failed = checks.filter((check) => !SUCCESS_CONCLUSIONS.has((check.conclusion || '').toLowerCase()));
    return {
      status: failed.length ? 'failed' : 'passed',
      command,
      exitCode: failed.length ? 1 : 0,
      durationMs: null,
      failures: failed.map((check) => ({ message: `${check.name}: ${check.conclusion || check.status} — ${check.url}` })),
    };
  }
}

// Convenience factory over the one shape of data this Worker actually has:
// a DeveloperJob's already-fetched CI checks (see developerAgent.ts). Kept
// separate from developerAgent.ts itself to avoid a circular import
// (developerAgent.ts already imports enough from orchestratorPolicy.ts et
// al.) — callers needing a fabric for a job pass job.ciChecks/job.phase in
// directly.
export function createCiExecutionFabric(ciChecks: readonly CiCheckLike[] | undefined, ciObserved: boolean): CiExecutionFabric {
  return new CiExecutionFabric(ciChecks ?? [], ciObserved);
}

function mapConclusion(conclusion: string | null, status: string): ExecutionResult['status'] {
  if (status !== 'completed') return 'pending';
  if (!conclusion) return 'unknown';
  return SUCCESS_CONCLUSIONS.has(conclusion.toLowerCase()) ? 'passed' : 'failed';
}
