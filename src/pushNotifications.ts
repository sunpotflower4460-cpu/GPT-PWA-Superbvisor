import { WorkerConnection, loadWorkerConnection } from './backgroundWorker';

export interface PushState {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
}

export async function getPushState(): Promise<PushState> {
  if (!supportsPush()) return { supported: false, permission: 'unsupported', subscribed: false };
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return { supported: true, permission: Notification.permission, subscribed: Boolean(subscription) };
}

export async function enablePushNotifications(connection: WorkerConnection = loadWorkerConnection()) {
  validateConnection(connection);
  if (!supportsPush()) throw new Error('このブラウザー/PWAはWeb Pushに対応していません。');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('通知が許可されていません。');

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const publicKey = await getVapidPublicKey(connection);
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(publicKey),
    });
  }

  await api(connection, '/api/push/subscriptions', {
    method: 'POST',
    body: JSON.stringify(subscription.toJSON()),
  });
  return subscription;
}

export async function disablePushNotifications(connection: WorkerConnection = loadWorkerConnection()) {
  if (!supportsPush()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  if (connection.baseUrl && connection.token) {
    await api(connection, '/api/push/subscriptions', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }).catch(() => undefined);
  }
  await subscription.unsubscribe();
}

export async function sendTestPush(connection: WorkerConnection = loadWorkerConnection()) {
  validateConnection(connection);
  return api<{ sent: number; failed: number; disabled?: boolean }>(connection, '/api/push/test', { method: 'POST' });
}

async function getVapidPublicKey(connection: WorkerConnection) {
  const result = await api<{ publicKey: string }>(connection, '/api/push/public-key', { method: 'GET' });
  if (!result.publicKey) throw new Error('WorkerにVAPID公開鍵が設定されていません。');
  return result.publicKey;
}

async function api<T = unknown>(connection: WorkerConnection, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${connection.baseUrl.trim().replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.token.trim()}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; detail?: string };
  if (!response.ok) throw new Error(payload.detail || payload.error || `Push API error (${response.status})`);
  return payload;
}

function supportsPush() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function validateConnection(connection: WorkerConnection) {
  if (!connection.baseUrl.trim() || !connection.token.trim()) throw new Error('先にBackground Workerの接続設定を保存してください。');
}

function base64UrlToBytes(value: string) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
