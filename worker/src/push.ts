import { buildPushHTTPRequest } from '@pushforge/builder';

export interface PushEnv {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
  VAPID_SUBJECT?: string;
  SUPERVISOR_STATE: KVNamespace;
}

export interface StoredPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface SupervisorPushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  projectId?: string;
  kind?: 'complete' | 'error' | 'human' | 'info';
}

const PREFIX = 'push-sub:';

export function getVapidPublicKey(env: PushEnv) {
  return env.VAPID_PUBLIC_KEY?.trim() || '';
}

export async function registerPushSubscription(env: PushEnv, value: unknown) {
  const subscription = validateSubscription(value);
  if (!subscription) throw new Error('Invalid push subscription');
  const key = await subscriptionKey(subscription.endpoint);
  const now = new Date().toISOString();
  const existing = await env.SUPERVISOR_STATE.get(`${PREFIX}${key}`);
  let createdAt = now;
  if (existing) {
    try { createdAt = (JSON.parse(existing) as StoredPushSubscription).createdAt || now; } catch { /* ignore */ }
  }
  const stored: StoredPushSubscription = { ...subscription, createdAt, updatedAt: now };
  await env.SUPERVISOR_STATE.put(`${PREFIX}${key}`, JSON.stringify(stored));
  return stored;
}

export async function unregisterPushSubscription(env: PushEnv, endpoint: string) {
  if (!endpoint?.startsWith('https://')) return;
  await env.SUPERVISOR_STATE.delete(`${PREFIX}${await subscriptionKey(endpoint)}`);
}

export async function sendSupervisorPush(env: PushEnv, payload: SupervisorPushPayload) {
  const privateJWKText = env.VAPID_PRIVATE_JWK?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!privateJWKText || !subject || !getVapidPublicKey(env)) return { sent: 0, failed: 0, disabled: true };

  let privateJWK: JsonWebKey;
  try { privateJWK = JSON.parse(privateJWKText) as JsonWebKey; }
  catch { throw new Error('VAPID_PRIVATE_JWK must be valid JSON'); }

  const listed = await env.SUPERVISOR_STATE.list({ prefix: PREFIX, limit: 100 });
  let sent = 0;
  let failed = 0;

  await Promise.all(listed.keys.map(async ({ name }) => {
    const raw = await env.SUPERVISOR_STATE.get(name);
    if (!raw) return;
    let subscription: StoredPushSubscription;
    try { subscription = JSON.parse(raw) as StoredPushSubscription; }
    catch { await env.SUPERVISOR_STATE.delete(name); return; }

    const data: Record<string, string> = { url: payload.url || './' };
    if (payload.projectId) data.projectId = payload.projectId;
    if (payload.kind) data.kind = payload.kind;

    const pushPayload: Record<string, unknown> = {
      title: payload.title,
      body: payload.body,
      icon: './icon.svg',
      badge: './icon.svg',
      data,
    };
    if (payload.tag) pushPayload.tag = payload.tag;

    try {
      const request = await buildPushHTTPRequest({
        privateJWK,
        subscription,
        message: {
          payload: pushPayload,
          adminContact: subject,
          options: {
            ttl: 3600,
            urgency: payload.kind === 'error' || payload.kind === 'human' ? 'high' : 'normal',
          },
        },
      });
      const response = await fetch(request.endpoint, { method: 'POST', headers: request.headers, body: request.body });
      if (response.ok || response.status === 201) sent += 1;
      else {
        failed += 1;
        if (response.status === 404 || response.status === 410) await env.SUPERVISOR_STATE.delete(name);
      }
    } catch {
      failed += 1;
    }
  }));

  return { sent, failed, disabled: false };
}

function validateSubscription(value: unknown): StoredPushSubscription | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (typeof item.endpoint !== 'string' || !item.endpoint.startsWith('https://')) return null;
  const keys = item.keys;
  if (!keys || typeof keys !== 'object') return null;
  const typedKeys = keys as Record<string, unknown>;
  if (typeof typedKeys.p256dh !== 'string' || typeof typedKeys.auth !== 'string') return null;
  return {
    endpoint: item.endpoint,
    expirationTime: typeof item.expirationTime === 'number' || item.expirationTime === null ? item.expirationTime as number | null : undefined,
    keys: { p256dh: typedKeys.p256dh, auth: typedKeys.auth },
  };
}

async function subscriptionKey(endpoint: string) {
  const bytes = new TextEncoder().encode(endpoint);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
