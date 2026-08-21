import { Webhook } from 'standardwebhooks';

interface Env {
  OPENAI_API_KEY: string;
  OPENAI_WEBHOOK_SECRET: string;
  SUPERVISOR_CLIENT_TOKEN: string;
  OPENAI_MODEL?: string;
  ALLOWED_ORIGIN?: string;
  SUPERVISOR_STATE: KVNamespace;
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
}

interface OpenAIResponseRecord {
  id: string;
  status?: JobStatus | string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: { code?: string; message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  metadata?: Record<string, string> | null;
}

interface StoredJob {
  id: string;
  projectId: string;
  projectName?: string;
  goal: string;
  currentPhase?: string;
  definitionOfDone: string[];
  model: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  outputText?: string;
  error?: string;
  checkpoint?: {
    at: string;
    status: JobStatus;
    summary: string;
  };
}

interface WebhookEvent {
  type: string;
  data?: { id?: string };
}

const JOB_TTL_SECONDS = 60 * 60 * 24 * 14;
const EVENT_TTL_SECONDS = 60 * 60 * 24;
const FINAL_STATUSES = new Set<JobStatus>(['completed', 'failed', 'incomplete', 'cancelled']);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, service: 'gpt-pwa-supervisor-worker' }, 200, env, request);
    }

    if (url.pathname === '/webhooks/openai' && request.method === 'POST') {
      return handleOpenAIWebhook(request, env);
    }

    if (!authorized(request, env)) {
      return json({ error: 'unauthorized' }, 401, env, request);
    }

    if (url.pathname === '/api/jobs' && request.method === 'POST') {
      return createJob(request, env);
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

async function createJob(request: Request, env: Env): Promise<Response> {
  const body = await readJson<CreateJobBody>(request);
  if (!body || !body.projectId?.trim() || !body.goal?.trim() || !body.prompt?.trim()) {
    return json({ error: 'projectId, goal and prompt are required' }, 400, env, request);
  }

  const model = body.model?.trim() || env.OPENAI_MODEL?.trim() || 'gpt-5.6-luna';
  const response = await openAI<OpenAIResponseRecord>(env, '/responses', {
    method: 'POST',
    body: {
      model,
      background: true,
      input: buildWorkerInput(body),
      metadata: {
        devdeck_project_id: body.projectId.slice(0, 64),
        devdeck_project_name: (body.projectName || body.projectId).slice(0, 64),
      },
    },
  });

  if (!response.ok || !response.data?.id) {
    return json(
      { error: 'openai_create_failed', detail: response.error || 'Unknown OpenAI error' },
      response.status || 502,
      env,
      request,
    );
  }

  const now = new Date().toISOString();
  const status = normalizeStatus(response.data.status);
  const job: StoredJob = {
    id: response.data.id,
    projectId: body.projectId,
    projectName: body.projectName,
    goal: body.goal,
    currentPhase: body.currentPhase,
    definitionOfDone: body.definitionOfDone ?? [],
    model,
    status,
    createdAt: now,
    updatedAt: now,
  };

  await persistJob(env, job);
  await env.SUPERVISOR_STATE.put(`project:${body.projectId}:latest`, job.id, { expirationTtl: JOB_TTL_SECONDS });

  return json({ job }, 202, env, request);
}

async function getJob(id: string, request: Request, env: Env): Promise<Response> {
  let job = await readJob(env, id);
  if (!job) return json({ error: 'job_not_found' }, 404, env, request);

  if (!FINAL_STATUSES.has(job.status)) {
    job = await refreshJobFromOpenAI(env, job);
  }

  return json({ job }, 200, env, request);
}

async function getLatestProjectJob(projectId: string, request: Request, env: Env): Promise<Response> {
  const id = await env.SUPERVISOR_STATE.get(`project:${projectId}:latest`);
  if (!id) return json({ error: 'job_not_found' }, 404, env, request);
  return getJob(id, request, env);
}

async function handleOpenAIWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.OPENAI_WEBHOOK_SECRET) return new Response('Webhook secret is not configured', { status: 503 });

  const rawBody = await request.text();
  const webhookId = request.headers.get('webhook-id');
  const webhookTimestamp = request.headers.get('webhook-timestamp');
  const webhookSignature = request.headers.get('webhook-signature');

  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return new Response('Missing webhook signature headers', { status: 400 });
  }

  let event: WebhookEvent;
  try {
    const verifier = new Webhook(env.OPENAI_WEBHOOK_SECRET);
    event = verifier.verify(rawBody, {
      'webhook-id': webhookId,
      'webhook-timestamp': webhookTimestamp,
      'webhook-signature': webhookSignature,
    }) as WebhookEvent;
  } catch {
    return new Response('Invalid webhook signature', { status: 400 });
  }

  const dedupeKey = `event:${webhookId}`;
  if (await env.SUPERVISOR_STATE.get(dedupeKey)) {
    return Response.json({ ok: true, duplicate: true });
  }

  const responseId = event.data?.id;
  if (responseId && event.type.startsWith('response.')) {
    const existing = await readJob(env, responseId);
    if (existing) await refreshJobFromOpenAI(env, existing);
  }

  await env.SUPERVISOR_STATE.put(dedupeKey, event.type, { expirationTtl: EVENT_TTL_SECONDS });
  return Response.json({ ok: true });
}

async function refreshJobFromOpenAI(env: Env, job: StoredJob): Promise<StoredJob> {
  const response = await openAI<OpenAIResponseRecord>(env, `/responses/${encodeURIComponent(job.id)}`, { method: 'GET' });
  if (!response.ok || !response.data) {
    const failed: StoredJob = {
      ...job,
      updatedAt: new Date().toISOString(),
      error: response.error || `OpenAI retrieve failed (${response.status})`,
    };
    await persistJob(env, failed);
    return failed;
  }

  const now = new Date().toISOString();
  const status = normalizeStatus(response.data.status);
  const outputText = extractOutputText(response.data);
  const error = response.data.error?.message || response.data.incomplete_details?.reason;
  const final = FINAL_STATUSES.has(status);
  const updated: StoredJob = {
    ...job,
    status,
    updatedAt: now,
    completedAt: final ? now : job.completedAt,
    outputText: outputText || job.outputText,
    error: error || undefined,
    checkpoint: final
      ? {
          at: now,
          status,
          summary: checkpointSummary(outputText, error, status),
        }
      : job.checkpoint,
  };

  await persistJob(env, updated);
  return updated;
}

function buildWorkerInput(body: CreateJobBody): string {
  const done = body.definitionOfDone?.length
    ? body.definitionOfDone.map((item) => `- ${item}`).join('\n')
    : '- ユーザーが指定した最終目標を満たす';

  return `あなたはAI DEV DECKのBackground Workerです。\n\n【プロジェクト】\n${body.projectName || body.projectId}\n\n【最終目標】\n${body.goal}\n\n【現在地点】\n${body.currentPhase || '未指定'}\n\n【完成条件】\n${done}\n\n【今回の指示】\n${body.prompt}\n\nルール:\n- 完了済み作業を推測で繰り返さず、与えられた情報から必要な次工程を進める。\n- エラーがある場合は原因を分析し、同じ失敗を漫然と繰り返さない。\n- 課金、秘密情報、本人確認、不可逆な外部操作、大きな仕様変更など本人判断が必要な内容は明示する。\n- 最後に必ず、実施した手順・到達地点・残作業・本人が必要なことを簡潔にまとめる。\n- 実際にアクセスできない外部システムを操作したと偽らない。`;
}

function extractOutputText(response: OpenAIResponseRecord): string {
  const chunks: string[] = [];
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') chunks.push(content.text);
    }
  }
  return chunks.join('\n').trim();
}

function checkpointSummary(output: string, error: string | undefined, status: JobStatus): string {
  if (error) return `${status}: ${error}`.slice(0, 1200);
  if (!output) return `${status}: output text was empty`;
  return output.replace(/\s+/g, ' ').trim().slice(0, 1200);
}

function normalizeStatus(value?: string): JobStatus {
  if (value === 'completed' || value === 'failed' || value === 'incomplete' || value === 'cancelled' || value === 'in_progress') {
    return value;
  }
  return 'queued';
}

async function persistJob(env: Env, job: StoredJob) {
  await env.SUPERVISOR_STATE.put(`job:${job.id}`, JSON.stringify(job), { expirationTtl: JOB_TTL_SECONDS });
}

async function readJob(env: Env, id: string): Promise<StoredJob | null> {
  const raw = await env.SUPERVISOR_STATE.get(`job:${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredJob;
  } catch {
    return null;
  }
}

async function openAI<T>(
  env: Env,
  path: string,
  options: { method: 'GET' | 'POST'; body?: unknown },
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  try {
    const response = await fetch(`https://api.openai.com/v1${path}`, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      const message = isObject(parsed) && isObject(parsed.error) && typeof parsed.error.message === 'string'
        ? parsed.error.message
        : text || `OpenAI request failed (${response.status})`;
      return { ok: false, status: response.status, error: message };
    }

    return { ok: true, status: response.status, data: parsed as T };
  } catch (error) {
    return { ok: false, status: 502, error: error instanceof Error ? error.message : 'Network error' };
  }
}

function authorized(request: Request, env: Env) {
  if (!env.SUPERVISOR_CLIENT_TOKEN) return false;
  return request.headers.get('authorization') === `Bearer ${env.SUPERVISOR_CLIENT_TOKEN}`;
}

function corsHeaders(env: Env, request: Request): HeadersInit {
  const origin = request.headers.get('origin');
  const configured = env.ALLOWED_ORIGIN?.trim();
  const allowedOrigin = configured && origin === configured ? configured : configured || 'null';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
}

function json(payload: unknown, status: number, env: Env, request: Request) {
  return Response.json(payload, { status, headers: corsHeaders(env, request) });
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return await request.json<T>();
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}
