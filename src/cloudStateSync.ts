import { WorkerConnection, loadWorkerConnection } from './backgroundWorker';

export interface CloudStateRecord<T = unknown> {
  revision: string;
  updatedAt: string;
  deviceId: string;
  data: T;
}

export interface CloudStateConflict {
  revision: string;
  updatedAt: string;
  deviceId: string;
}

export type PushCloudStateResult<T> =
  | { ok: true; state: CloudStateRecord<T> }
  | { ok: false; conflict: true; current?: CloudStateConflict };

const DEVICE_ID_KEY = 'gpt-pwa-supervisor.device-id.v1';
const REVISION_KEY = 'gpt-pwa-supervisor.cloud-revision.v1';

export function getDeviceId() {
  let value = localStorage.getItem(DEVICE_ID_KEY)?.trim();
  if (!value) {
    value = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, value);
  }
  return value;
}

export function getKnownCloudRevision() {
  return localStorage.getItem(REVISION_KEY)?.trim() || null;
}

export function rememberCloudRevision(revision?: string | null) {
  if (revision?.trim()) localStorage.setItem(REVISION_KEY, revision.trim());
  else localStorage.removeItem(REVISION_KEY);
}

export async function getCloudState<T>(connection: WorkerConnection = loadWorkerConnection()): Promise<CloudStateRecord<T> | null> {
  validateConnection(connection);
  const response = await fetch(`${normalizeBaseUrl(connection.baseUrl)}/api/state-sync`, {
    method: 'GET',
    headers: authHeaders(connection),
  });
  if (response.status === 404) return null;
  const payload = await readPayload<{ state?: CloudStateRecord<T>; error?: string }>(response);
  if (!response.ok || !payload.state) throw new Error(payload.error || `Cloud sync request failed (${response.status})`);
  rememberCloudRevision(payload.state.revision);
  return payload.state;
}

export async function pushCloudState<T>(
  data: T,
  options: { force?: boolean; baseRevision?: string | null } = {},
  connection: WorkerConnection = loadWorkerConnection(),
): Promise<PushCloudStateResult<T>> {
  validateConnection(connection);
  const response = await fetch(`${normalizeBaseUrl(connection.baseUrl)}/api/state-sync`, {
    method: 'POST',
    headers: authHeaders(connection),
    body: JSON.stringify({
      deviceId: getDeviceId(),
      baseRevision: options.baseRevision === undefined ? getKnownCloudRevision() : options.baseRevision,
      force: options.force === true,
      data,
    }),
  });
  const payload = await readPayload<{ state?: CloudStateRecord<T>; error?: string; current?: CloudStateConflict }>(response);
  if (response.status === 409) return { ok: false, conflict: true, current: payload.current };
  if (!response.ok || !payload.state) throw new Error(payload.error || `Cloud sync request failed (${response.status})`);
  rememberCloudRevision(payload.state.revision);
  return { ok: true, state: payload.state };
}

export async function deleteCloudState(connection: WorkerConnection = loadWorkerConnection()) {
  validateConnection(connection);
  const response = await fetch(`${normalizeBaseUrl(connection.baseUrl)}/api/state-sync`, {
    method: 'DELETE',
    headers: authHeaders(connection),
  });
  const payload = await readPayload<{ ok?: boolean; error?: string }>(response);
  if (!response.ok) throw new Error(payload.error || `Cloud sync request failed (${response.status})`);
  rememberCloudRevision(null);
}

function validateConnection(connection: WorkerConnection) {
  if (!connection.baseUrl.trim() || !connection.token.trim()) {
    throw new Error('先にBackground Workerの接続設定を保存してください。');
  }
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/$/, '');
}

function authHeaders(connection: WorkerConnection): HeadersInit {
  return {
    Authorization: `Bearer ${connection.token.trim()}`,
    'Content-Type': 'application/json',
  };
}

async function readPayload<T>(response: Response): Promise<T> {
  return response.json().catch(() => ({})) as Promise<T>;
}
