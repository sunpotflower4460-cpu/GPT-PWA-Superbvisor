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
// module does NOT ship a LOCAL_FAST/ISOLATED/BROWSER implementation that
// pretends to run commands somewhere it cannot. It formalizes the ONE
// runtime that is real (CI) behind the shared interface, and leaves the
// others as typed-but-unimplemented — a future physical execution host
// (a separate service this Worker could call over HTTP, outside the
// Cloudflare Workers sandbox) is what would actually back them.
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
  runCommand(command: string): Promise<ExecutionResult>;
  inspectLogs(): Promise<ExecutionResult[]>;
  health(): Promise<{ available: boolean; detail?: string }>;
}

// The only concrete implementation shipped today. It does not distinguish
// "test" from "typecheck" from "build" the way a real local runner could
// (GitHub Actions reports named checks, not typed phases) — runTest,
// runTypecheck and runBuild all resolve to the SAME underlying CI
// assessment, differing only in the `command` label on the returned
// result, which is honest about what this actually is: one aggregate CI
// signal, not three independent runs. runCommand has no meaning for a
// CI-backed fabric (there is no way to run an arbitrary command against
// GitHub Actions on demand) and always reports 'unknown'.
export class CiExecutionFabric implements ExecutionFabric {
  readonly kind: ExecutionFabricKind = 'CI';

  constructor(private readonly checks: readonly CiCheckLike[], private readonly ciAvailable: boolean) {}

  async runTest(): Promise<ExecutionResult> {
    return this.fromChecks('ci: aggregate check status (no per-phase test runner exists in this architecture)');
  }

  async runTypecheck(): Promise<ExecutionResult> {
    return this.fromChecks('ci: aggregate check status (no per-phase typecheck runner exists in this architecture)');
  }

  async runBuild(): Promise<ExecutionResult> {
    return this.fromChecks('ci: aggregate check status (no per-phase build runner exists in this architecture)');
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

  private fromChecks(command: string): ExecutionResult {
    if (!this.checks.length) {
      return { status: 'unknown', command, exitCode: null, durationMs: null, failures: [] };
    }
    const pending = this.checks.some((check) => check.status !== 'completed');
    if (pending) return { status: 'pending', command, exitCode: null, durationMs: null, failures: [] };

    const failed = this.checks.filter((check) => !SUCCESS_CONCLUSIONS.has((check.conclusion || '').toLowerCase()));
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
