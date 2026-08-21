import { Webhook } from 'standardwebhooks';
import baseWorker from './index';
import {
  CreateDeveloperJobBody,
  createDeveloperJob,
  getDeveloperJob,
  getLatestDeveloperJob,
  handleDeveloperResponse,
} from './developerAgent';

interface Env {
  OPENAI_API_KEY: string;
  OPENAI_WEBHOOK_SECRET: string;
  SUPERVISOR_CLIENT_TOKEN: string;
  OPENAI_MODEL?: string;
  SMART_REPLY_MODEL?: string;
  ALLOWED_ORIGIN?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
  VAPID_SUBJECT?: string;
  GITHUB_TOKEN?: string;
  GITHUB_ALLOWED_REPOS?: string;
  SUPERVISOR_STATE: KVNamespace;
}

interface WebhookEvent {
  type: string;
  data?: { id?: string };
}

const DEV_EVENT_TTL = 60 * 60 * 24;

type BaseWorkerFetch = typeof baseWorker.fetch;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/webhooks/openai' && request.method === 'POST') {
      const handled = await maybeHandleDeveloperWebhook(request.clone(), env);
      if (handled) return handled;
      return (baseWorker.fetch as BaseWorkerFetch)(request as never, env as never);
    }

    if (url.pathname.startsWith('/api/developer-') || url.pathname.startsWith('/api/github-agent')) {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env, request) });
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401, env, request);
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

    const latest = url.pathname.match(/^\/api\/developer-projects\/([^/]+)\/latest$/);
    if (latest && request.method === 'GET') {
      const job = await getLatestDeveloperJob(env, decodeURIComponent(latest[1]));
      return job ? json({ job }, 200, env, request) : json({ error: 'developer_job_not_found' }, 404, env, request);
    }

    if (url.pathname === '/api/github-agent/config' && request.method === 'GET') {
      const repositories = (env.GITHUB_ALLOWED_REPOS || '').split(',').map((item) => item.trim()).filter(Boolean);
      return json({ configured: Boolean(env.GITHUB_TOKEN?.trim()) && repositories.length > 0, repositories }, 200, env, request);
    }

    return (baseWorker.fetch as BaseWorkerFetch)(request as never, env as never);
  },
};

async function maybeHandleDeveloperWebhook(request: Request, env: Env): Promise<Response | null> {
  if (!env.OPENAI_WEBHOOK_SECRET) return null;
  const rawBody = await request.text();
  const webhookId = request.headers.get('webhook-id');
  const webhookTimestamp = request.headers.get('webhook-timestamp');
  const webhookSignature = request.headers.get('webhook-signature');
  if (!webhookId || !webhookTimestamp || !webhookSignature) return null;

  let event: WebhookEvent;
  try {
    const verifier = new Webhook(env.OPENAI_WEBHOOK_SECRET);
    event = verifier.verify(rawBody, {
      'webhook-id': webhookId,
      'webhook-timestamp': webhookTimestamp,
      'webhook-signature': webhookSignature,
    }) as WebhookEvent;
  } catch {
    return null;
  }

  const responseId = event.data?.id;
  if (!responseId || !event.type.startsWith('response.')) return null;
  const mapped = await env.SUPERVISOR_STATE.get(`developer-response:${responseId}`);
  if (!mapped) return null;

  const dedupe = `developer-event:${webhookId}`;
  if (await env.SUPERVISOR_STATE.get(dedupe)) return Response.json({ ok: true, duplicate: true, developer: true });

  try {
    await handleDeveloperResponse(env, responseId);
    await env.SUPERVISOR_STATE.put(dedupe, event.type, { expirationTtl: DEV_EVENT_TTL });
    return Response.json({ ok: true, developer: true });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'developer_webhook_failed' }, { status: 500 });
  }
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
