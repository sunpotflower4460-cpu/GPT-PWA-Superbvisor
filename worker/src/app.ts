import baseWorker from './index';
export { ProjectCoordinator } from './projectCoordinator';
import {
  CreateDeveloperJobBody,
  createDeveloperJob,
  getDeveloperJob,
  getLatestDeveloperJob,
} from './developerAgent';
import { buildDevelopmentCheckpoint } from './developmentCheckpoint';
import { buildCompletionCertificate } from './completionJudge';
import { createCiExecutionFabric } from './executionFabric';
import { getWorkflowRunJobs } from './githubExecutor';
import {
  CreateGuardianRunBody,
  advanceGuardianRun,
  createGuardianRun,
  getGuardianRun,
  getLatestGuardianRun,
  sweepGuardianRuns,
} from './guardianRunner';
import { OrchestrationEnv } from './orchestrationModel';
import {
  SaveCloudStateBody,
  deleteCloudState,
  getCloudState,
  saveCloudState,
} from './stateSync';

interface Env extends OrchestrationEnv {
  SUPERVISOR_CLIENT_TOKEN: string;
  SMART_REPLY_MODEL?: string;
  ALLOWED_ORIGIN?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
  VAPID_SUBJECT?: string;
  GITHUB_TOKEN?: string;
  GITHUB_ALLOWED_REPOS?: string;
  SUPERVISOR_STATE: KVNamespace;
  PROJECT_COORDINATOR?: DurableObjectNamespace;
}

type BaseWorkerFetch = typeof baseWorker.fetch;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (
      url.pathname.startsWith('/api/developer-') ||
      url.pathname.startsWith('/api/github-agent') ||
      url.pathname.startsWith('/api/guardian-') ||
      url.pathname.startsWith('/api/state-sync')
    ) {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env, request) });
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401, env, request);
    }

    if (url.pathname === '/api/state-sync' && request.method === 'GET') {
      try {
        const state = await getCloudState(env);
        return state ? json({ state }, 200, env, request) : json({ error: 'cloud_state_not_found' }, 404, env, request);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'cloud_state_read_failed' }, 503, env, request);
      }
    }

    if (url.pathname === '/api/state-sync' && request.method === 'POST') {
      const body = await readJson<SaveCloudStateBody>(request);
      if (!body) return json({ error: 'invalid_json' }, 400, env, request);
      const result = await saveCloudState(env, body);
      if (!result.ok) return json({ error: result.error, current: result.current }, result.status, env, request);
      return json({ state: result.state }, 200, env, request);
    }

    if (url.pathname === '/api/state-sync' && request.method === 'DELETE') {
      try {
        await deleteCloudState(env);
        return json({ ok: true }, 200, env, request);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'cloud_state_delete_failed' }, 503, env, request);
      }
    }

    if (url.pathname === '/api/developer-jobs' && request.method === 'POST') {
      const body = await readJson<CreateDeveloperJobBody>(request);
      if (!body) return json({ error: 'invalid_json' }, 400, env, request);
      try {
        const job = await createDeveloperJob(env, body);
        return json({ job }, job.status === 'failed' ? 502 : 202, env, request);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'developer_job_failed' }, 400, env, request);
      }
    }

    const developerJob = url.pathname.match(/^\/api\/developer-jobs\/([^/]+)$/);
    if (developerJob && request.method === 'GET') {
      const job = await getDeveloperJob(env, decodeURIComponent(developerJob[1]));
      return job ? json({ job }, 200, env, request) : json({ error: 'developer_job_not_found' }, 404, env, request);
    }

    const developerCheckpoint = url.pathname.match(/^\/api\/developer-jobs\/([^/]+)\/checkpoint$/);
    if (developerCheckpoint && request.method === 'GET') {
      const job = await getDeveloperJob(env, decodeURIComponent(developerCheckpoint[1]));
      if (!job) return json({ error: 'developer_job_not_found' }, 404, env, request);
      return json({ checkpoint: buildDevelopmentCheckpoint(job) }, 200, env, request);
    }

    const developerCompletion = url.pathname.match(/^\/api\/developer-jobs\/([^/]+)\/completion$/);
    if (developerCompletion && request.method === 'GET') {
      const job = await getDeveloperJob(env, decodeURIComponent(developerCompletion[1]));
      if (!job) return json({ error: 'developer_job_not_found' }, 404, env, request);
      return json({ completion: buildCompletionCertificate(job) }, 200, env, request);
    }

    const developerExecutionLogs = url.pathname.match(/^\/api\/developer-jobs\/([^/]+)\/execution\/logs$/);
    if (developerExecutionLogs && request.method === 'GET') {
      const job = await getDeveloperJob(env, decodeURIComponent(developerExecutionLogs[1]));
      if (!job) return json({ error: 'developer_job_not_found' }, 404, env, request);
      // CI is the only Execution Fabric this Worker actually has — see
      // executionFabric.ts's own note on why LOCAL_FAST/ISOLATED are not
      // faked here. `phases` isolates evidence by check name when the
      // target repo's own CI check names allow it (e.g. a job literally
      // named "playwright" surfaces under `browser`).
      //
      // job.ciChecks is workflow-RUN-level (getBranchWorkflowRuns — one
      // entry per GitHub Actions workflow, e.g. a single entry named "CI"),
      // not per-job. That's the right granularity for assessCi()'s overall
      // pass/fail/pending gating, but it is USELESS for phase isolation on
      // a repo (like this one) that runs several jobs inside one workflow
      // — every job.name would be the same generic workflow name and
      // PHASE_KEYWORDS would never match anything but the aggregate
      // fallback. Fetch the actual job-level names for each known run
      // (same getWorkflowRunJobs used elsewhere for Kernel category
      // matching) so `phases` reflects real per-job evidence; best-effort
      // per run (a run whose jobs fail to fetch just falls out of the
      // phase view, same pattern as the CI-failure reconciliation in
      // developerAgent.ts), falling back to the workflow-run-level list
      // only if no job-level data could be fetched at all.
      const runs = job.ciChecks ?? [];
      const jobLevelResults = await Promise.allSettled(runs.map((run) => getWorkflowRunJobs(env, job.repository, run.id)));
      const jobLevelChecks = jobLevelResults.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
      const checksForFabric = jobLevelChecks.length ? jobLevelChecks : runs;
      const fabric = createCiExecutionFabric(checksForFabric, Boolean(runs.length));
      const [test, typecheck, build, browser, logs] = await Promise.all([
        fabric.runTest(),
        fabric.runTypecheck(),
        fabric.runBuild(),
        fabric.runBrowser(),
        fabric.inspectLogs(),
      ]);
      return json({ kind: fabric.kind, phases: { test, typecheck, build, browser }, logs }, 200, env, request);
    }

    const latestDeveloper = url.pathname.match(/^\/api\/developer-projects\/([^/]+)\/latest$/);
    if (latestDeveloper && request.method === 'GET') {
      const job = await getLatestDeveloperJob(env, decodeURIComponent(latestDeveloper[1]));
      return job ? json({ job }, 200, env, request) : json({ error: 'developer_job_not_found' }, 404, env, request);
    }

    if (url.pathname === '/api/github-agent/config' && request.method === 'GET') {
      const repositories = (env.GITHUB_ALLOWED_REPOS || '').split(',').map((item) => item.trim()).filter(Boolean);
      const availableProviders = [
        env.DEEPSEEK_API_KEY?.trim() ? 'deepseek' : '',
        env.MINIMAX_API_KEY?.trim() ? 'minimax' : '',
        env.OPENAI_API_KEY?.trim() ? 'openai' : '',
      ].filter(Boolean);
      return json({
        configured: Boolean(env.GITHUB_TOKEN?.trim()) && repositories.length > 0,
        repositories,
        executor: 'chatgpt',
        orchestrationOnly: true,
        atomicCoordinator: Boolean(env.PROJECT_COORDINATOR),
        primaryProvider: env.ORCHESTRATOR_PROVIDER?.trim() || 'deepseek',
        availableProviders,
        deterministicFallback: true,
      }, 200, env, request);
    }

    if (url.pathname === '/api/guardian-runs' && request.method === 'POST') {
      const body = await readJson<CreateGuardianRunBody>(request);
      if (!body) return json({ error: 'invalid_json' }, 400, env, request);
      try {
        const run = await createGuardianRun(env, body);
        return json({ run }, run.status === 'failed' ? 502 : 202, env, request);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'guardian_run_failed' }, 400, env, request);
      }
    }

    const guardianRun = url.pathname.match(/^\/api\/guardian-runs\/([^/]+)$/);
    if (guardianRun && request.method === 'GET') {
      try {
        const run = await advanceGuardianRun(env, decodeURIComponent(guardianRun[1]), { force: true });
        return json({ run }, 200, env, request);
      } catch (error) {
        const existing = await getGuardianRun(env, decodeURIComponent(guardianRun[1]));
        if (!existing) return json({ error: 'guardian_run_not_found' }, 404, env, request);
        return json({ run: existing, warning: error instanceof Error ? error.message : 'guardian_refresh_failed' }, 200, env, request);
      }
    }

    const latestGuardian = url.pathname.match(/^\/api\/guardian-projects\/([^/]+)\/latest$/);
    if (latestGuardian && request.method === 'GET') {
      const projectId = decodeURIComponent(latestGuardian[1]);
      const latest = await getLatestGuardianRun(env, projectId);
      if (!latest) return json({ error: 'guardian_run_not_found' }, 404, env, request);
      try {
        const run = await advanceGuardianRun(env, latest.id, { force: true });
        return json({ run }, 200, env, request);
      } catch (error) {
        return json({ run: latest, warning: error instanceof Error ? error.message : 'guardian_refresh_failed' }, 200, env, request);
      }
    }

    return (baseWorker.fetch as BaseWorkerFetch)(request as never, env as never);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Cron remains useful even while ChatGPT is not open: it monitors branch/CI state and prepares recovery handoffs.
    ctx.waitUntil(sweepGuardianRuns(env));
  },
};

function authorized(request: Request, env: Env) {
  return Boolean(env.SUPERVISOR_CLIENT_TOKEN) && request.headers.get('authorization') === `Bearer ${env.SUPERVISOR_CLIENT_TOKEN}`;
}

function corsHeaders(env: Env, request: Request): HeadersInit {
  const origin = request.headers.get('origin');
  const configured = env.ALLOWED_ORIGIN?.trim();
  const allowedOrigin = configured && origin === configured ? configured : configured || 'null';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    Vary: 'Origin',
  };
}

function json(payload: unknown, status: number, env: Env, request: Request) {
  return Response.json(payload, { status, headers: corsHeaders(env, request) });
}

async function readJson<T>(request: Request): Promise<T | null> {
  try { return await request.json<T>(); } catch { return null; }
}
