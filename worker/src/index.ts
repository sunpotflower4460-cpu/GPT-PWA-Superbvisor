import { generateSmartReplies, SmartReplyRequest } from './smartReplies';
import { OrchestrationEnv, runOrchestrationModel } from './orchestrationModel';
import { buildGenericChatGptHandoff } from './orchestratorPolicy';
import {
  ChatCommandConflictError,
  cancelChatCommand,
  claimNextChatCommand,
  enqueueChatCommand,
  getChatCommand,
  getProjectChatCommand,
  listProjectChatCommands,
  retryChatCommand,
  updateChatCommandResult,
} from './chatCommandQueue';
import { getChatBridgeStatus, recordChatBridgeHeartbeat } from './chatBridge';
import { getChatControlOverview } from './chatControlOverview';
import {
  getVapidPublicKey,
  registerPushSubscription,
  sendSupervisorPush,
  unregisterPushSubscription,
} from './push';

interface Env extends OrchestrationEnv {
  SUPERVISOR_CLIENT_TOKEN: string;
  SMART_REPLY_MODEL?: string;
  ALLOWED_ORIGIN?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
  VAPID_SUBJECT?: string;
  SUPERVISOR_STATE: KVNamespace;
  PROJECT_COORDINATOR?: DurableObjectNamespace;
}

type JobStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'incomplete' | 'cancelled';

interface CreateJobBody {
  projectId: string;
  projectName?: string;
  goal: string;
  currentPhase?: string;
  definitionOfDone?: string[];
  prompt: string;
  model?: string;
  autoRecover?: boolean;
  maxAutoRetries?: number;
}

interface CompletionReport {
  summary: string;
  steps: string[];
  reachedStage: string;
  remaining: string[];
  humanRequired: string[];
  done: boolean;
}

interface StoredJob {
  id: string;
  kind: 'orchestration_handoff';
  phase: 'handoff_ready';
  projectId: string;
  projectName?: string;
  goal: string;
  currentPhase?: string;
  definitionOfDone: string[];
  prompt: string;
  model: string;
  orchestratorProvider: string;
  degradedOrchestration: boolean;
  handoffPrompt: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
  outputText: string;
  report: CompletionReport;
  autoRecover: false;
  maxAutoRetries: 0;
  retryCount: 0;
  rootJobId: string;
  checkpoint: {
    at: string;
    status: JobStatus;
    summary: string;
  };
}

const JOB_TTL_SECONDS = 60 * 60 * 24 * 14;
const MAX_OVERVIEW_PROJECTS = 30;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return json({
        ok: true,
        service: 'gpt-pwa-supervisor-worker',
        executor: 'chatgpt',
        orchestrationOnly: true,
        chatCommandBus: true,
        chatBridgeHeartbeat: true,
        atomicCoordinator: Boolean(env.PROJECT_COORDINATOR),
      }, 200, env, request);
    }

    if (url.pathname === '/webhooks/openai' && request.method === 'POST') {
      return json({ error: 'deprecated_background_executor', executor: 'chatgpt', orchestrationOnly: true }, 410, env, request);
    }

    if (!authorized(request, env)) {
      return json({ error: 'unauthorized' }, 401, env, request);
    }

    if (url.pathname === '/api/jobs' && request.method === 'POST') {
      return createOrchestrationJob(request, env);
    }

    if (url.pathname === '/api/smart-replies' && request.method === 'POST') {
      return createSmartReplies(request, env);
    }

    if (url.pathname === '/api/chat-commands' && request.method === 'POST') {
      return createChatCommand(request, env);
    }

    if (url.pathname === '/api/chat-commands/claim' && request.method === 'POST') {
      return claimChatCommand(request, env);
    }

    if (url.pathname === '/api/chat-control/overview' && request.method === 'POST') {
      return createChatControlOverview(request, env);
    }

    if (url.pathname === '/api/chat-bridge/status' && request.method === 'GET') {
      const projectId = url.searchParams.get('projectId')?.trim() || '';
      if (!projectId) return json({ error: 'projectId is required' }, 400, env, request);
      return json(await getChatBridgeStatus(env, projectId), 200, env, request);
    }

    if (url.pathname === '/api/chat-bridge/heartbeat' && request.method === 'POST') {
      const body = await readJson<{ projectId?: string; bridgeId?: string; capabilities?: string[] }>(request);
      try {
        const status = await recordChatBridgeHeartbeat(env, {
          projectId: body?.projectId || '',
          bridgeId: body?.bridgeId || '',
          capabilities: body?.capabilities,
        });
        return json(status, 200, env, request);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'invalid_bridge_heartbeat' }, 400, env, request);
      }
    }

    const chatCommandMatch = url.pathname.match(/^\/api\/chat-commands\/([^/]+)$/);
    if (chatCommandMatch && request.method === 'GET') {
      const id = decodeURIComponent(chatCommandMatch[1]);
      const projectId = url.searchParams.get('projectId')?.trim() || '';
      const command = projectId
        ? await getProjectChatCommand(env, projectId, id)
        : await getChatCommand(env, id);
      return command ? json({ command }, 200, env, request) : json({ error: 'chat_command_not_found' }, 404, env, request);
    }

    const chatCommandResultMatch = url.pathname.match(/^\/api\/chat-commands\/([^/]+)\/result$/);
    if (chatCommandResultMatch && request.method === 'POST') {
      return reportChatCommandResult(decodeURIComponent(chatCommandResultMatch[1]), request, env);
    }

    const chatCommandRetryMatch = url.pathname.match(/^\/api\/chat-commands\/([^/]+)\/retry$/);
    if (chatCommandRetryMatch && request.method === 'POST') {
      return retryFailedChatCommand(decodeURIComponent(chatCommandRetryMatch[1]), request, env);
    }

    const chatCommandCancelMatch = url.pathname.match(/^\/api\/chat-commands\/([^/]+)\/cancel$/);
    if (chatCommandCancelMatch && request.method === 'POST') {
      return cancelPendingChatCommand(decodeURIComponent(chatCommandCancelMatch[1]), request, env);
    }

    const projectCommandsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/chat-commands$/);
    if (projectCommandsMatch && request.method === 'GET') {
      const commands = await listProjectChatCommands(env, decodeURIComponent(projectCommandsMatch[1]), 40);
      return json({ commands }, 200, env, request);
    }

    if (url.pathname === '/api/push/public-key' && request.method === 'GET') {
      const publicKey = getVapidPublicKey(env);
      if (!publicKey) return json({ error: 'push_not_configured' }, 503, env, request);
      return json({ publicKey }, 200, env, request);
    }

    if (url.pathname === '/api/push/subscriptions' && request.method === 'POST') {
      const body = await readJson<unknown>(request);
      try {
        const subscription = await registerPushSubscription(env, body);
        return json({ ok: true, endpoint: subscription.endpoint }, 201, env, request);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'invalid_subscription' }, 400, env, request);
      }
    }

    if (url.pathname === '/api/push/subscriptions' && request.method === 'DELETE') {
      const body = await readJson<{ endpoint?: string }>(request);
      if (body?.endpoint) await unregisterPushSubscription(env, body.endpoint);
      return json({ ok: true }, 200, env, request);
    }

    if (url.pathname === '/api/push/test' && request.method === 'POST') {
      const result = await sendSupervisorPush(env, {
        title: 'AI DEV DECK',
        body: 'Push通知の接続テストに成功しました。',
        tag: 'devdeck-test',
        kind: 'info',
        url: './',
      });
      return json(result, 200, env, request);
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobMatch && request.method === 'GET') {
      return getJob(decodeURIComponent(jobMatch[1]), request, env);
    }

    const latestMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/latest$/);
    if (latestMatch && request.method === 'GET') {
      return getLatestProjectJob(decodeURIComponent(latestMatch[1]), request, env);
    }

    return json({ error: 'not_found' }, 404, env, request);
  },
};

async function createSmartReplies(request: Request, env: Env): Promise<Response> {
  const body = await readJson<SmartReplyRequest>(request);
  if (!body) return json({ error: 'invalid_json' }, 400, env, request);
  const result = await generateSmartReplies(body, env);
  if (!result.ok) return json({ error: result.error }, result.status, env, request);
  return json(result, 200, env, request);
}

async function createChatControlOverview(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ projectIds?: unknown }>(request);
  if (!Array.isArray(body?.projectIds)) return json({ error: 'projectIds must be an array' }, 400, env, request);
  const projectIds = [...new Set(body.projectIds
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().slice(0, 200))
    .filter(Boolean))];
  if (projectIds.length > MAX_OVERVIEW_PROJECTS) {
    return json({ error: `projectIds must contain at most ${MAX_OVERVIEW_PROJECTS} unique projects` }, 400, env, request);
  }
  if (!projectIds.length) return json({ projects: [] }, 200, env, request);
  const projects = await getChatControlOverview(env, projectIds);
  return json({ projects }, 200, env, request);
}

async function createChatCommand(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ projectId?: string; projectName?: string; chatUrl?: string; prompt?: string }>(request);
  try {
    const command = await enqueueChatCommand(env, {
      projectId: body?.projectId || '',
      projectName: body?.projectName,
      chatUrl: body?.chatUrl || '',
      prompt: body?.prompt || '',
    });
    return json({ command, transport: 'waiting_bridge' }, 202, env, request);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'invalid_chat_command' }, 400, env, request);
  }
}

async function claimChatCommand(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ bridgeId?: string; projectId?: string }>(request);
  if (!body?.bridgeId?.trim() || !body.projectId?.trim()) return json({ error: 'bridgeId and projectId are required' }, 400, env, request);
  try {
    const command = await claimNextChatCommand(env, body.bridgeId, body.projectId.trim());
    return json({ command }, 200, env, request);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'chat_command_claim_failed' }, 503, env, request);
  }
}

async function reportChatCommandResult(id: string, request: Request, env: Env): Promise<Response> {
  const body = await readJson<{
    projectId?: string;
    bridgeId?: string;
    status?: 'delivered' | 'failed' | 'cancelled';
    detail?: string;
  }>(request);
  if (!body?.projectId?.trim() || !body.bridgeId?.trim()) {
    return json({ error: 'projectId and bridgeId are required' }, 400, env, request);
  }
  if (!body.status || !['delivered', 'failed', 'cancelled'].includes(body.status)) {
    return json({ error: 'status must be delivered, failed or cancelled' }, 400, env, request);
  }
  try {
    const command = await updateChatCommandResult(env, id, {
      projectId: body.projectId,
      bridgeId: body.bridgeId,
      status: body.status,
      detail: body.detail,
    });
    return command ? json({ command }, 200, env, request) : json({ error: 'chat_command_not_found' }, 404, env, request);
  } catch (error) {
    if (error instanceof ChatCommandConflictError) return json({ error: error.code }, 409, env, request);
    return json({ error: error instanceof Error ? error.message : 'chat_command_result_failed' }, 503, env, request);
  }
}

async function retryFailedChatCommand(id: string, request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ projectId?: string }>(request);
  if (!body?.projectId?.trim()) return json({ error: 'projectId is required' }, 400, env, request);
  try {
    const command = await retryChatCommand(env, body.projectId, id);
    return command ? json({ command }, 200, env, request) : json({ error: 'chat_command_not_found' }, 404, env, request);
  } catch (error) {
    if (error instanceof ChatCommandConflictError) return json({ error: error.code }, 409, env, request);
    return json({ error: error instanceof Error ? error.message : 'chat_command_retry_failed' }, 503, env, request);
  }
}

async function cancelPendingChatCommand(id: string, request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ projectId?: string; detail?: string }>(request);
  if (!body?.projectId?.trim()) return json({ error: 'projectId is required' }, 400, env, request);
  try {
    const command = await cancelChatCommand(env, body.projectId, id, body.detail);
    return command ? json({ command }, 200, env, request) : json({ error: 'chat_command_not_found' }, 404, env, request);
  } catch (error) {
    if (error instanceof ChatCommandConflictError) return json({ error: error.code }, 409, env, request);
    return json({ error: error instanceof Error ? error.message : 'chat_command_cancel_failed' }, 503, env, request);
  }
}

async function createOrchestrationJob(request: Request, env: Env): Promise<Response> {
  const body = await readJson<CreateJobBody>(request);
  if (!body || !body.projectId?.trim() || !body.goal?.trim() || !body.prompt?.trim()) {
    return json({ error: 'projectId, goal and prompt are required' }, 400, env, request);
  }

  const deterministicPrompt = buildGenericChatGptHandoff({
    projectName: body.projectName,
    goal: body.goal,
    currentPhase: body.currentPhase,
    task: body.prompt,
    definitionOfDone: body.definitionOfDone,
  });
  const decision = await runOrchestrationModel(env, {
    mode: 'PLAN',
    repository: 'not-applicable',
    branch: 'not-applicable',
    goal: body.goal,
    task: body.prompt,
    evidence: `Project: ${body.projectName || body.projectId}\nCurrent phase: ${body.currentPhase || 'unknown'}\nThis is a non-GitHub orchestration handoff. The external API must not claim that implementation work was executed.`,
    deterministicPrompt,
  });

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const report: CompletionReport = {
    summary: decision.summary,
    steps: ['Supervisorが現在状態を整理', 'ChatGPTへ渡す実行指示を生成'],
    reachedStage: 'ChatGPT引き継ぎ準備完了',
    remaining: ['ChatGPTチャットで実作業を実行し、実際の結果を確認する'],
    humanRequired: decision.humanRequired,
    done: false,
  };
  const job: StoredJob = {
    id,
    kind: 'orchestration_handoff',
    phase: 'handoff_ready',
    projectId: body.projectId,
    projectName: body.projectName,
    goal: body.goal,
    currentPhase: body.currentPhase,
    definitionOfDone: (body.definitionOfDone ?? []).filter((item) => typeof item === 'string').slice(0, 30),
    prompt: body.prompt,
    model: decision.model,
    orchestratorProvider: decision.provider,
    degradedOrchestration: decision.degraded,
    handoffPrompt: decision.chatgptPrompt,
    status: 'completed',
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    outputText: decision.summary,
    report,
    autoRecover: false,
    maxAutoRetries: 0,
    retryCount: 0,
    rootJobId: id,
    checkpoint: { at: now, status: 'completed', summary: 'オーケストレーション指示の生成が完了しました。実作業はChatGPTへ引き継ぎます。' },
  };

  await persistJob(env, job);
  await env.SUPERVISOR_STATE.put(`project:${body.projectId}:latest`, job.id, { expirationTtl: JOB_TTL_SECONDS });
  await safePush(env, {
    title: `${body.projectName || 'AI DEV DECK'}: GPT指示を準備`,
    body: 'Supervisorが次の実行指示を準備しました。実作業はChatGPTで続けます。',
    tag: `orchestration-${job.id}`,
    projectId: body.projectId,
    kind: 'info',
    url: './',
  });
  return json({ job }, 202, env, request);
}

async function getJob(id: string, request: Request, env: Env): Promise<Response> {
  const job = await readJob(env, id);
  return job ? json({ job }, 200, env, request) : json({ error: 'job_not_found' }, 404, env, request);
}

async function getLatestProjectJob(projectId: string, request: Request, env: Env): Promise<Response> {
  const id = await env.SUPERVISOR_STATE.get(`project:${projectId}:latest`);
  if (!id) return json({ error: 'job_not_found' }, 404, env, request);
  return getJob(id, request, env);
}

async function safePush(env: Env, payload: Parameters<typeof sendSupervisorPush>[1]) {
  try { await sendSupervisorPush(env, payload); } catch { /* Push is best-effort; orchestration result stays durable. */ }
}

async function persistJob(env: Env, job: StoredJob) {
  await env.SUPERVISOR_STATE.put(`job:${job.id}`, JSON.stringify(job), { expirationTtl: JOB_TTL_SECONDS });
}

async function readJob(env: Env, id: string): Promise<StoredJob | null> {
  const raw = await env.SUPERVISOR_STATE.get(`job:${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as StoredJob; } catch { return null; }
}

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