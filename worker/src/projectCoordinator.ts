export type CoordinatorChatCommandStatus = 'queued' | 'claimed' | 'delivered' | 'failed' | 'cancelled';

export interface CoordinatorChatCommand {
  id: string;
  projectId: string;
  projectName?: string;
  chatUrl: string;
  prompt: string;
  status: CoordinatorChatCommandStatus;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  deliveredAt?: string;
  bridgeId?: string;
  detail?: string;
  claimAttempts?: number;
  deliveryFailures?: number;
  maxDeliveryAttempts?: number;
  nextAttemptAt?: string;
  dedupeKey?: string;
}

export interface CoordinatorCommandActivity {
  id: string;
  status: CoordinatorChatCommandStatus;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  bridgeId?: string;
  deliveryFailures?: number;
  nextAttemptAt?: string;
}

export interface CoordinatorCommandOverview {
  latest?: CoordinatorCommandActivity;
  unresolved?: CoordinatorCommandActivity;
  pendingCount: number;
  failedCount: number;
  totalCount: number;
}

export interface CoordinatorCloudState {
  revision: string;
  updatedAt: string;
  deviceId: string;
  data: unknown;
}

export interface CoordinatorLease {
  name: string;
  token: string;
  owner: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface AtomicCoordinatorEnv {
  PROJECT_COORDINATOR?: DurableObjectNamespace;
}

const COMMAND_PREFIX = 'command:';
const DEDUPE_PREFIX = 'dedupe:';
const LEASE_PREFIX = 'lease:';
const COMMANDS_MIGRATED_KEY = 'meta:commands-migrated-v2';
const STATE_KEY = 'client-state:v1';
const STATE_MIGRATED_KEY = 'meta:state-migrated-v1';
const COMMAND_RETENTION_MS = 14 * 24 * 60 * 60_000;
const CLAIM_STALE_MS = 2 * 60_000;
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 3;
const COMMAND_IMPORT_BATCH_SIZE = 20;
const MIN_LEASE_MS = 5_000;
const MAX_LEASE_MS = 10 * 60_000;

export class ProjectCoordinator {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    return this.state.blockConcurrencyWhile(() => this.handle(request));
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/commands/import' && request.method === 'POST') {
      const body = await readJson<{ commands?: CoordinatorChatCommand[]; finalize?: boolean }>(request);
      if (!body) return json({ error: 'invalid_command_import' }, 400);

      const migrated = await this.state.storage.get<boolean>(COMMANDS_MIGRATED_KEY);
      if (migrated) return json({ ok: true, migrated: true, imported: 0 });

      const commands = Array.isArray(body.commands) ? body.commands : [];
      if (commands.length > COMMAND_IMPORT_BATCH_SIZE) {
        return json({ error: 'command_import_batch_too_large', maxBatchSize: COMMAND_IMPORT_BATCH_SIZE }, 413);
      }

      let imported = 0;
      for (const command of commands) {
        if (!isStoredCommand(command) || isExpiredCommand(command)) continue;
        const key = `${COMMAND_PREFIX}${command.id}`;
        const existing = await this.state.storage.get<CoordinatorChatCommand>(key);
        if (!existing) {
          await this.state.storage.put(key, command);
          imported += 1;
        }

        if (!command.dedupeKey) continue;
        const indexKey = dedupeKey(command.dedupeKey);
        const indexedCommandId = await this.state.storage.get<string>(indexKey);
        if (!indexedCommandId || indexedCommandId === command.id) {
          await this.state.storage.put(indexKey, command.id);
          continue;
        }

        const indexedCommand = await this.state.storage.get<CoordinatorChatCommand>(`${COMMAND_PREFIX}${indexedCommandId}`);
        if (!indexedCommand || indexedCommand.createdAt < command.createdAt) {
          await this.state.storage.put(indexKey, command.id);
        }
      }

      if (body.finalize === true) await this.state.storage.put(COMMANDS_MIGRATED_KEY, true);
      return json({ ok: true, migrated: body.finalize === true, imported });
    }

    if (url.pathname === '/commands/enqueue' && request.method === 'POST') {
      const body = await readJson<{
        projectId?: string;
        projectName?: string;
        chatUrl?: string;
        prompt?: string;
        dedupeKey?: string;
      }>(request);
      if (!body?.projectId || !body.chatUrl || !body.prompt) return json({ error: 'invalid_command' }, 400);
      await this.cleanupCommands();

      if (body.dedupeKey) {
        const existingId = await this.state.storage.get<string>(dedupeKey(body.dedupeKey));
        if (existingId) {
          const existing = await this.state.storage.get<CoordinatorChatCommand>(`${COMMAND_PREFIX}${existingId}`);
          if (existing) {
            if (!sameCommandPayload(existing, body)) return json({ error: 'dedupe_payload_mismatch' }, 409);
            return json({ command: existing });
          }
        }
      }

      const now = new Date().toISOString();
      const command: CoordinatorChatCommand = {
        id: crypto.randomUUID(),
        projectId: body.projectId,
        projectName: body.projectName,
        chatUrl: body.chatUrl,
        prompt: body.prompt,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        claimAttempts: 0,
        deliveryFailures: 0,
        maxDeliveryAttempts: DEFAULT_MAX_DELIVERY_ATTEMPTS,
        dedupeKey: body.dedupeKey,
      };
      await this.state.storage.put(`${COMMAND_PREFIX}${command.id}`, command);
      if (command.dedupeKey) await this.state.storage.put(dedupeKey(command.dedupeKey), command.id);
      return json({ command }, 201);
    }

    if (url.pathname === '/commands/overview' && request.method === 'GET') {
      const commands = (await this.listCommands()).filter((command) => !isExpiredCommand(command));
      return json({ overview: summarizeCoordinatorCommands(commands) });
    }

    if (url.pathname === '/commands/list' && request.method === 'GET') {
      await this.cleanupCommands();
      const limit = clamp(Number(url.searchParams.get('limit') || 30), 1, 100);
      const commands = await this.listCommands();
      return json({ commands: commands.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit) });
    }

    if (url.pathname === '/commands/get' && request.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      const command = id ? await this.state.storage.get<CoordinatorChatCommand>(`${COMMAND_PREFIX}${id}`) : undefined;
      return command ? json({ command }) : json({ error: 'chat_command_not_found' }, 404);
    }

    if (url.pathname === '/commands/claim' && request.method === 'POST') {
      const body = await readJson<{ bridgeId?: string }>(request);
      const bridgeId = body?.bridgeId?.trim().slice(0, 200) || '';
      if (!bridgeId) return json({ error: 'bridgeId is required' }, 400);
      await this.cleanupCommands();
      const commands = await this.listCommands();
      const nowMs = Date.now();
      const existingOwnedClaim = commands
        .filter((command) => isFreshClaimOwnedByBridge(command, bridgeId, nowMs))
        .sort((a, b) => (a.claimedAt || '').localeCompare(b.claimedAt || ''))[0];
      if (existingOwnedClaim) return json({ command: existingOwnedClaim });

      const next = commands
        .filter((command) => isCoordinatorCommandClaimable(command, nowMs))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!next) return json({ command: null });

      const now = new Date(nowMs).toISOString();
      const recoveredStaleClaim = next.status === 'claimed';
      const claimed: CoordinatorChatCommand = {
        ...next,
        status: 'claimed',
        bridgeId,
        claimedAt: now,
        updatedAt: now,
        nextAttemptAt: undefined,
        claimAttempts: (next.claimAttempts ?? 0) + 1,
        detail: recoveredStaleClaim ? 'Recovered a stale bridge claim and reassigned the command.' : next.detail,
      };
      await this.state.storage.put(`${COMMAND_PREFIX}${claimed.id}`, claimed);
      return json({ command: claimed });
    }

    if (url.pathname === '/commands/result' && request.method === 'POST') {
      const body = await readJson<{
        id?: string;
        projectId?: string;
        bridgeId?: string;
        status?: 'delivered' | 'failed' | 'cancelled';
        detail?: string;
      }>(request);
      if (!body?.id || !body.projectId || !body.bridgeId || !body.status) return json({ error: 'invalid_result' }, 400);
      const current = await this.state.storage.get<CoordinatorChatCommand>(`${COMMAND_PREFIX}${body.id}`);
      if (!current) return json({ error: 'chat_command_not_found' }, 404);
      if (current.projectId !== body.projectId) return json({ error: 'project_mismatch' }, 409);

      if (current.status === body.status && (current.status === 'delivered' || current.status === 'failed' || current.status === 'cancelled')) {
        if (current.bridgeId && current.bridgeId !== body.bridgeId) return json({ error: 'claim_owner_mismatch', command: current }, 409);
        return json({ command: current });
      }
      if (current.status !== 'claimed') return json({ error: 'command_not_claimed', command: current }, 409);
      if (current.bridgeId !== body.bridgeId) return json({ error: 'claim_owner_mismatch', command: current }, 409);

      const updated = applyCommandResult(current, {
        status: body.status,
        detail: body.detail,
      });
      await this.state.storage.put(`${COMMAND_PREFIX}${updated.id}`, updated);
      return json({ command: updated });
    }

    if (url.pathname === '/commands/retry' && request.method === 'POST') {
      const body = await readJson<{ id?: string; projectId?: string }>(request);
      if (!body?.id || !body.projectId) return json({ error: 'id and projectId are required' }, 400);
      const current = await this.state.storage.get<CoordinatorChatCommand>(`${COMMAND_PREFIX}${body.id}`);
      if (!current) return json({ error: 'chat_command_not_found' }, 404);
      if (current.projectId !== body.projectId) return json({ error: 'project_mismatch' }, 409);
      if (current.status !== 'failed') return json({ error: 'only_failed_commands_can_retry', command: current }, 409);
      const now = new Date().toISOString();
      const updated: CoordinatorChatCommand = {
        ...current,
        status: 'queued',
        bridgeId: undefined,
        updatedAt: now,
        claimedAt: undefined,
        nextAttemptAt: undefined,
        deliveryFailures: 0,
        detail: 'Manual retry requested after delivery attempts were exhausted.',
      };
      await this.state.storage.put(`${COMMAND_PREFIX}${updated.id}`, updated);
      return json({ command: updated });
    }

    if (url.pathname === '/commands/cancel' && request.method === 'POST') {
      const body = await readJson<{ id?: string; projectId?: string; detail?: string }>(request);
      if (!body?.id || !body.projectId) return json({ error: 'id and projectId are required' }, 400);
      const current = await this.state.storage.get<CoordinatorChatCommand>(`${COMMAND_PREFIX}${body.id}`);
      if (!current) return json({ error: 'chat_command_not_found' }, 404);
      if (current.projectId !== body.projectId) return json({ error: 'project_mismatch' }, 409);
      if (current.status === 'cancelled') return json({ command: current });
      if (current.status !== 'queued' && current.status !== 'failed') {
        return json({ error: 'only_queued_or_failed_commands_can_cancel', command: current }, 409);
      }
      const updated: CoordinatorChatCommand = {
        ...current,
        status: 'cancelled',
        bridgeId: undefined,
        claimedAt: undefined,
        nextAttemptAt: undefined,
        updatedAt: new Date().toISOString(),
        detail: body.detail?.trim().slice(0, 2000) || 'Cancelled before switching to manual ChatGPT fallback.',
      };
      await this.state.storage.put(`${COMMAND_PREFIX}${updated.id}`, updated);
      return json({ command: updated });
    }

    if (url.pathname === '/state/import' && request.method === 'POST') {
      const migrated = await this.state.storage.get<boolean>(STATE_MIGRATED_KEY);
      if (!migrated) {
        const body = await readJson<{ state?: CoordinatorCloudState | null }>(request);
        if (body?.state && isStoredCloudState(body.state)) await this.state.storage.put(STATE_KEY, body.state);
        await this.state.storage.put(STATE_MIGRATED_KEY, true);
      }
      return json({ ok: true });
    }

    if (url.pathname === '/state/get' && request.method === 'GET') {
      const state = await this.state.storage.get<CoordinatorCloudState>(STATE_KEY);
      return state ? json({ state }) : json({ state: null }, 200);
    }

    if (url.pathname === '/state/save' && request.method === 'POST') {
      const body = await readJson<{
        deviceId?: string;
        baseRevision?: string | null;
        force?: boolean;
        data?: unknown;
      }>(request);
      if (!body?.deviceId?.trim()) return json({ error: 'deviceId is required' }, 400);
      const current = await this.state.storage.get<CoordinatorCloudState>(STATE_KEY);
      if (current && body.force !== true && body.baseRevision !== current.revision) {
        return json({
          error: 'revision_conflict',
          current: { revision: current.revision, updatedAt: current.updatedAt, deviceId: current.deviceId },
        }, 409);
      }
      const state: CoordinatorCloudState = {
        revision: crypto.randomUUID(),
        updatedAt: new Date().toISOString(),
        deviceId: body.deviceId.trim().slice(0, 128),
        data: body.data,
      };
      await this.state.storage.put(STATE_KEY, state);
      return json({ state });
    }

    if (url.pathname === '/state/delete' && request.method === 'DELETE') {
      await this.state.storage.delete(STATE_KEY);
      await this.state.storage.put(STATE_MIGRATED_KEY, true);
      return json({ ok: true });
    }

    if (url.pathname === '/lease/acquire' && request.method === 'POST') {
      const body = await readJson<{ name?: string; owner?: string; ttlMs?: number }>(request);
      const name = body?.name?.trim().slice(0, 160) || '';
      const owner = body?.owner?.trim().slice(0, 200) || '';
      if (!name || !owner) return json({ error: 'lease name and owner are required' }, 400);
      const nowMs = Date.now();
      const key = leaseKey(name);
      const current = await this.state.storage.get<CoordinatorLease>(key);
      if (current && new Date(current.expiresAt).getTime() > nowMs) {
        return json({ acquired: false, lease: current }, 409);
      }
      const ttlMs = clamp(Number(body?.ttlMs || 180_000), MIN_LEASE_MS, MAX_LEASE_MS);
      const lease: CoordinatorLease = {
        name,
        token: crypto.randomUUID(),
        owner,
        acquiredAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
      };
      await this.state.storage.put(key, lease);
      return json({ acquired: true, lease });
    }

    if (url.pathname === '/lease/renew' && request.method === 'POST') {
      const body = await readJson<{ name?: string; token?: string; ttlMs?: number }>(request);
      const name = body?.name?.trim().slice(0, 160) || '';
      const token = body?.token?.trim().slice(0, 200) || '';
      if (!name || !token) return json({ error: 'lease name and token are required' }, 400);
      const key = leaseKey(name);
      const current = await this.state.storage.get<CoordinatorLease>(key);
      if (!current || current.token !== token) return json({ error: 'lease_owner_mismatch' }, 409);
      const nowMs = Date.now();
      if (new Date(current.expiresAt).getTime() <= nowMs) return json({ error: 'lease_expired' }, 409);
      const ttlMs = clamp(Number(body?.ttlMs || 180_000), MIN_LEASE_MS, MAX_LEASE_MS);
      const lease = { ...current, expiresAt: new Date(nowMs + ttlMs).toISOString() };
      await this.state.storage.put(key, lease);
      return json({ renewed: true, lease });
    }

    if (url.pathname === '/lease/release' && request.method === 'POST') {
      const body = await readJson<{ name?: string; token?: string }>(request);
      const name = body?.name?.trim().slice(0, 160) || '';
      const token = body?.token?.trim().slice(0, 200) || '';
      if (!name || !token) return json({ error: 'lease name and token are required' }, 400);
      const key = leaseKey(name);
      const current = await this.state.storage.get<CoordinatorLease>(key);
      if (!current) return json({ released: true });
      if (current.token !== token) return json({ error: 'lease_owner_mismatch' }, 409);
      await this.state.storage.delete(key);
      return json({ released: true });
    }

    return json({ error: 'not_found' }, 404);
  }

  private async listCommands() {
    const stored = await this.state.storage.list<CoordinatorChatCommand>({ prefix: COMMAND_PREFIX });
    return [...stored.values()].filter(isStoredCommand);
  }

  private async cleanupCommands() {
    const stored = await this.state.storage.list<CoordinatorChatCommand>({ prefix: COMMAND_PREFIX });
    for (const [key, command] of stored) {
      if (!isStoredCommand(command) || !isExpiredCommand(command)) continue;
      await this.state.storage.delete(key);
      if (!command.dedupeKey) continue;
      const indexKey = dedupeKey(command.dedupeKey);
      const indexedCommandId = await this.state.storage.get<string>(indexKey);
      if (indexedCommandId === command.id) await this.state.storage.delete(indexKey);
    }
  }
}

export function summarizeCoordinatorCommands(commands: CoordinatorChatCommand[]): CoordinatorCommandOverview {
  const newestFirst = [...commands].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = newestFirst[0];
  const unresolved = newestFirst.find((command) => command.status === 'claimed' || command.status === 'queued' || command.status === 'failed');
  return {
    latest: latest ? commandActivity(latest) : undefined,
    unresolved: unresolved ? commandActivity(unresolved) : undefined,
    pendingCount: commands.filter((command) => command.status === 'queued' || command.status === 'claimed').length,
    failedCount: commands.filter((command) => command.status === 'failed').length,
    totalCount: commands.length,
  };
}

export function isCoordinatorCommandClaimable(command: CoordinatorChatCommand, now = Date.now()) {
  if (command.status === 'queued') {
    if (!command.nextAttemptAt) return true;
    const retryAt = new Date(command.nextAttemptAt).getTime();
    return !Number.isFinite(retryAt) || retryAt <= now;
  }
  if (command.status !== 'claimed' || !command.claimedAt) return false;
  const claimedAt = new Date(command.claimedAt).getTime();
  return Number.isFinite(claimedAt) && now - claimedAt >= CLAIM_STALE_MS;
}

function isFreshClaimOwnedByBridge(command: CoordinatorChatCommand, bridgeId: string, now = Date.now()) {
  if (command.status !== 'claimed' || command.bridgeId !== bridgeId || !command.claimedAt) return false;
  const claimedAt = new Date(command.claimedAt).getTime();
  return Number.isFinite(claimedAt) && now - claimedAt < CLAIM_STALE_MS;
}

export function applyCommandResult(
  current: CoordinatorChatCommand,
  input: { status: 'delivered' | 'failed' | 'cancelled'; detail?: string },
  nowMs = Date.now(),
): CoordinatorChatCommand {
  const now = new Date(nowMs).toISOString();
  const detail = input.detail?.trim().slice(0, 2000) || undefined;
  if (input.status === 'failed') {
    const deliveryFailures = (current.deliveryFailures ?? 0) + 1;
    const maxDeliveryAttempts = current.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS;
    if (deliveryFailures < maxDeliveryAttempts) {
      const backoffMs = Math.min(60_000, 5_000 * (4 ** Math.max(0, deliveryFailures - 1)));
      return {
        ...current,
        status: 'queued',
        bridgeId: undefined,
        updatedAt: now,
        claimedAt: undefined,
        nextAttemptAt: new Date(nowMs + backoffMs).toISOString(),
        deliveryFailures,
        maxDeliveryAttempts,
        detail: `${detail || 'ChatGPT delivery failed.'} Automatic retry ${deliveryFailures + 1}/${maxDeliveryAttempts} scheduled.`,
      };
    }
    return {
      ...current,
      status: 'failed',
      updatedAt: now,
      deliveryFailures,
      maxDeliveryAttempts,
      nextAttemptAt: undefined,
      detail: `${detail || 'ChatGPT delivery failed.'} Automatic delivery attempts exhausted (${deliveryFailures}/${maxDeliveryAttempts}).`,
    };
  }

  return {
    ...current,
    status: input.status,
    detail,
    deliveredAt: input.status === 'delivered' ? now : current.deliveredAt,
    updatedAt: now,
    nextAttemptAt: undefined,
  };
}

export function hasAtomicCoordinator(env: AtomicCoordinatorEnv) {
  return Boolean(env.PROJECT_COORDINATOR);
}

export async function coordinatorFetch<T>(
  env: AtomicCoordinatorEnv,
  scope: string,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: T }> {
  if (!env.PROJECT_COORDINATOR) throw new Error('PROJECT_COORDINATOR is not configured');
  const id = env.PROJECT_COORDINATOR.idFromName(scope);
  const stub = env.PROJECT_COORDINATOR.get(id);
  const response = await stub.fetch(new Request(`https://coordinator.internal${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  }));
  const data = await response.json().catch(() => ({})) as T;
  return { ok: response.ok, status: response.status, data };
}

export async function acquireCoordinatorLease(
  env: AtomicCoordinatorEnv,
  scope: string,
  input: { name: string; owner: string; ttlMs?: number },
) {
  return coordinatorFetch<{ acquired?: boolean; lease?: CoordinatorLease; error?: string }>(env, scope, '/lease/acquire', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function renewCoordinatorLease(
  env: AtomicCoordinatorEnv,
  scope: string,
  input: { name: string; token: string; ttlMs?: number },
) {
  return coordinatorFetch<{ renewed?: boolean; lease?: CoordinatorLease; error?: string }>(env, scope, '/lease/renew', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function releaseCoordinatorLease(
  env: AtomicCoordinatorEnv,
  scope: string,
  input: { name: string; token: string },
) {
  return coordinatorFetch<{ released?: boolean; error?: string }>(env, scope, '/lease/release', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

function commandActivity(command: CoordinatorChatCommand): CoordinatorCommandActivity {
  return {
    id: command.id,
    status: command.status,
    createdAt: command.createdAt,
    updatedAt: command.updatedAt,
    deliveredAt: command.deliveredAt,
    bridgeId: command.bridgeId,
    deliveryFailures: command.deliveryFailures,
    nextAttemptAt: command.nextAttemptAt,
  };
}

function sameCommandPayload(
  command: CoordinatorChatCommand,
  input: { projectId?: string; chatUrl?: string; prompt?: string },
) {
  return command.projectId === input.projectId
    && command.chatUrl === input.chatUrl
    && command.prompt === input.prompt;
}

function isStoredCommand(value: unknown): value is CoordinatorChatCommand {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<CoordinatorChatCommand>;
  return typeof item.id === 'string'
    && typeof item.projectId === 'string'
    && typeof item.chatUrl === 'string'
    && typeof item.prompt === 'string'
    && typeof item.status === 'string'
    && typeof item.createdAt === 'string'
    && typeof item.updatedAt === 'string';
}

function isExpiredCommand(command: CoordinatorChatCommand) {
  const createdAt = new Date(command.createdAt).getTime();
  return Number.isFinite(createdAt) && Date.now() - createdAt > COMMAND_RETENTION_MS;
}

function isStoredCloudState(value: unknown): value is CoordinatorCloudState {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<CoordinatorCloudState>;
  return typeof item.revision === 'string'
    && typeof item.updatedAt === 'string'
    && typeof item.deviceId === 'string'
    && 'data' in item;
}

function dedupeKey(value: string) {
  return `${DEDUPE_PREFIX}${encodeURIComponent(value)}`;
}

function leaseKey(value: string) {
  return `${LEASE_PREFIX}${encodeURIComponent(value)}`;
}

function clamp(value: number, min: number, max: number) {
  const integer = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.max(min, Math.min(max, integer));
}

async function readJson<T>(request: Request): Promise<T | null> {
  try { return await request.json<T>(); } catch { return null; }
}

function json(payload: unknown, status = 200) {
  return Response.json(payload, { status });
}
