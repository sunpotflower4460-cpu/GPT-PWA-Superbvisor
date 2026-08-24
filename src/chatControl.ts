import { DevProject } from './core';
import { WorkerConnection, loadWorkerConnection } from './backgroundWorker';

export type ChatCommandStatus = 'queued' | 'claimed' | 'delivered' | 'failed' | 'cancelled';
export type ChatProjectActivity =
  | 'DELIVERING'
  | 'RETRY_SCHEDULED'
  | 'QUEUED'
  | 'WAITING_BRIDGE'
  | 'NEEDS_ATTENTION'
  | 'DELIVERED'
  | 'CONNECTED_IDLE'
  | 'BRIDGE_OFFLINE'
  | 'OVERVIEW_ERROR';

export interface ChatCommand {
  id: string;
  projectId: string;
  projectName?: string;
  chatUrl: string;
  prompt: string;
  status: ChatCommandStatus;
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
}

export interface ChatBridgeStatus {
  connected: boolean;
  projectId?: string;
  bridgeId?: string;
  lastSeenAt?: string;
  capabilities: string[];
}

export interface ChatProjectOverview {
  projectId: string;
  activity: ChatProjectActivity;
  bridgeConnected: boolean;
  bridgeId?: string;
  bridgeLastSeenAt?: string;
  pendingRecentCount: number;
  failedRecentCount: number;
  latestCommandStatus?: ChatCommandStatus;
  latestCommandAt?: string;
  activeCommandId?: string;
  nextAttemptAt?: string;
  approximate: boolean;
  error?: string;
}

const OVERVIEW_BATCH_SIZE = 30;
const WORKER_REQUEST_TIMEOUT_MS = 12_000;
const IDEMPOTENT_TRANSPORT_ATTEMPTS = 2;

class WorkerRequestError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
    this.name = 'WorkerRequestError';
  }
}

export function chatCommandStatusLabel(status: ChatCommandStatus) {
  if (status === 'queued') return '送信待ち';
  if (status === 'claimed') return 'Bridge処理中';
  if (status === 'delivered') return '送信済み';
  if (status === 'failed') return '送信失敗';
  return '取消';
}

export function chatProjectActivityLabel(activity: ChatProjectActivity) {
  if (activity === 'DELIVERING') return '配送中';
  if (activity === 'RETRY_SCHEDULED') return '再試行待ち';
  if (activity === 'QUEUED') return '送信待ち';
  if (activity === 'WAITING_BRIDGE') return 'Bridge待ち';
  if (activity === 'NEEDS_ATTENTION') return '要確認';
  if (activity === 'DELIVERED') return '送信済み';
  if (activity === 'CONNECTED_IDLE') return '接続中';
  if (activity === 'OVERVIEW_ERROR') return '状態取得失敗';
  return 'Bridge offline';
}

export async function enqueueProjectChatCommand(
  project: DevProject,
  prompt: string,
  connection: WorkerConnection = loadWorkerConnection(),
) {
  if (!project.chatUrl?.trim()) throw new Error('この案件にはChatGPTチャットURLが登録されていません。');
  const dedupeKey = createClientCommandDedupeKey(project.id);
  return retryIdempotentTransport(() => workerFetch<{ command: ChatCommand; transport: 'waiting_bridge' }>(connection, '/api/chat-commands', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.id,
      projectName: project.name,
      chatUrl: project.chatUrl,
      prompt,
      dedupeKey,
    }),
  }));
}

export async function retryProjectChatCommand(
  projectId: string,
  commandId: string,
  connection: WorkerConnection = loadWorkerConnection(),
) {
  return workerFetch<{ command: ChatCommand }>(connection, `/api/chat-commands/${encodeURIComponent(commandId)}/retry`, {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
}

export async function cancelProjectChatCommand(
  projectId: string,
  commandId: string,
  connection: WorkerConnection = loadWorkerConnection(),
) {
  return retryIdempotentTransport(() => workerFetch<{ command: ChatCommand }>(connection, `/api/chat-commands/${encodeURIComponent(commandId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      detail: 'Cancelled by PWA before switching this command to manual ChatGPT fallback.',
    }),
  }));
}

export async function listProjectChatCommands(
  projectId: string,
  connection: WorkerConnection = loadWorkerConnection(),
) {
  return workerFetch<{ commands: ChatCommand[] }>(connection, `/api/projects/${encodeURIComponent(projectId)}/chat-commands`, { method: 'GET' });
}

export async function getChatBridgeStatus(
  projectId: string,
  connection: WorkerConnection = loadWorkerConnection(),
) {
  return workerFetch<ChatBridgeStatus>(connection, `/api/chat-bridge/status?projectId=${encodeURIComponent(projectId)}`, { method: 'GET' });
}

export async function getChatControlOverview(
  projectIds: string[],
  connection: WorkerConnection = loadWorkerConnection(),
) {
  const unique = [...new Set(projectIds.map((value) => value.trim()).filter(Boolean))];
  if (!unique.length) return { projects: [] as ChatProjectOverview[] };

  const batches: string[][] = [];
  for (let offset = 0; offset < unique.length; offset += OVERVIEW_BATCH_SIZE) {
    batches.push(unique.slice(offset, offset + OVERVIEW_BATCH_SIZE));
  }

  const results = await Promise.allSettled(batches.map((batch) => workerFetch<{ projects: ChatProjectOverview[] }>(
    connection,
    '/api/chat-control/overview',
    { method: 'POST', body: JSON.stringify({ projectIds: batch }) },
  )));

  const projects = results.flatMap((result, index): ChatProjectOverview[] => {
    if (result.status === 'fulfilled') return result.value.projects;
    const error = result.reason instanceof Error ? result.reason.message : 'chat_overview_batch_failed';
    return batches[index].map((projectId) => ({
      projectId,
      activity: 'OVERVIEW_ERROR',
      bridgeConnected: false,
      pendingRecentCount: 0,
      failedRecentCount: 0,
      approximate: true,
      error,
    }));
  });

  return { projects };
}

async function retryIdempotentTransport<T>(operation: () => Promise<T>) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= IDEMPOTENT_TRANSPORT_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!(error instanceof WorkerRequestError) || !error.retryable || attempt >= IDEMPOTENT_TRANSPORT_ATTEMPTS) throw error;
      await delay(250 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Supervisor Workerへの再試行に失敗しました。');
}

async function workerFetch<T>(connection: WorkerConnection, path: string, init: RequestInit): Promise<T> {
  const baseUrl = connection.baseUrl.trim().replace(/\/$/, '');
  if (!baseUrl) throw new Error('Supervisor Worker URLが未設定です。');
  if (!connection.token.trim()) throw new Error('Supervisor Worker接続トークンが未設定です。');

  const controller = new AbortController();
  const upstreamSignal = init.signal;
  let timedOut = false;
  const forwardAbort = () => controller.abort();
  if (upstreamSignal?.aborted) controller.abort();
  else upstreamSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, WORKER_REQUEST_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${connection.token.trim()}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      if (timedOut) {
        throw new WorkerRequestError('Supervisor Workerへの通信が12秒でタイムアウトしました。', 0, true);
      }
      if (upstreamSignal?.aborted) throw error instanceof Error ? error : new Error('Supervisor Workerへの通信を中止しました。');
      throw new WorkerRequestError(
        error instanceof Error ? `Supervisor Workerへ接続できませんでした: ${error.message}` : 'Supervisor Workerへ接続できませんでした。',
        0,
        true,
      );
    }

    const payload = await response.json().catch(() => ({})) as T & { error?: string; detail?: string };
    if (!response.ok) {
      throw new WorkerRequestError(
        payload.detail || payload.error || `Chat command request failed (${response.status})`,
        response.status,
        isRetryableStatus(response.status),
      );
    }
    return payload;
  } finally {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener('abort', forwardAbort);
  }
}

function createClientCommandDedupeKey(projectId: string) {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `pwa:${projectId.slice(0, 80)}:${suffix}`.slice(0, 200);
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}