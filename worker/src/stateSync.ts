export interface StateSyncEnv {
  SUPERVISOR_STATE: KVNamespace;
}

export interface CloudStateRecord {
  revision: string;
  updatedAt: string;
  deviceId: string;
  data: unknown;
}

export interface SaveCloudStateBody {
  deviceId?: string;
  baseRevision?: string | null;
  force?: boolean;
  data?: unknown;
}

export type SaveCloudStateResult =
  | { ok: true; state: CloudStateRecord }
  | { ok: false; status: 400 | 409 | 413; error: string; current?: Pick<CloudStateRecord, 'revision' | 'updatedAt' | 'deviceId'> };

const STATE_KEY = 'client-state:v1';
const MAX_STATE_BYTES = 900_000;

export async function getCloudState(env: StateSyncEnv): Promise<CloudStateRecord | null> {
  const raw = await env.SUPERVISOR_STATE.get(STATE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CloudStateRecord;
    if (!isStoredState(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveCloudState(env: StateSyncEnv, body: SaveCloudStateBody): Promise<SaveCloudStateResult> {
  if (!body.deviceId?.trim()) return { ok: false, status: 400, error: 'deviceId is required' };
  if (!isBackupEnvelope(body.data)) return { ok: false, status: 400, error: 'invalid_backup_payload' };

  const encoded = new TextEncoder().encode(JSON.stringify(body.data));
  if (encoded.byteLength > MAX_STATE_BYTES) {
    return { ok: false, status: 413, error: 'state_payload_too_large' };
  }

  const current = await getCloudState(env);
  if (current && body.force !== true && body.baseRevision !== current.revision) {
    return {
      ok: false,
      status: 409,
      error: 'revision_conflict',
      current: { revision: current.revision, updatedAt: current.updatedAt, deviceId: current.deviceId },
    };
  }

  const state: CloudStateRecord = {
    revision: crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
    deviceId: body.deviceId.trim().slice(0, 128),
    data: body.data,
  };
  await env.SUPERVISOR_STATE.put(STATE_KEY, JSON.stringify(state));
  return { ok: true, state };
}

export async function deleteCloudState(env: StateSyncEnv) {
  await env.SUPERVISOR_STATE.delete(STATE_KEY);
}

function isStoredState(value: unknown): value is CloudStateRecord {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<CloudStateRecord>;
  return typeof item.revision === 'string' && typeof item.updatedAt === 'string'
    && typeof item.deviceId === 'string' && isBackupEnvelope(item.data);
}

function isBackupEnvelope(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const item = value as { schema?: unknown; version?: unknown; data?: unknown };
  if (item.schema !== 'gpt-pwa-supervisor.backup' || item.version !== 1) return false;
  if (!item.data || typeof item.data !== 'object' || Array.isArray(item.data)) return false;
  const data = item.data as { projects?: unknown; operatingPlans?: unknown; handoffs?: unknown; notifications?: unknown; watchdog?: unknown };
  return Array.isArray(data.projects)
    && Boolean(data.operatingPlans && typeof data.operatingPlans === 'object' && !Array.isArray(data.operatingPlans))
    && Array.isArray(data.handoffs)
    && Array.isArray(data.notifications)
    && Boolean(data.watchdog && typeof data.watchdog === 'object' && !Array.isArray(data.watchdog));
}
