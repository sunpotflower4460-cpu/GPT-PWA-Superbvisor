import { DevProject } from './core';
import { WorkerConnection, loadWorkerConnection } from './backgroundWorker';

export type ChatCommandStatus = 'queued' | 'claimed' | 'delivered' | 'failed' | 'cancelled';

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
}

export interface ChatBridgeStatus {
  connected: boolean;
  projectId?: string;
  bridgeId?: string;
  lastSeenAt?: string;
  capabilities: string[];
}

export function chatCommandStatusLabel(status: ChatCommandStatus) {
  if (status === 'queued') return '送信待ち';
  if (status === 'claimed') return 'Bridge処理中';
  if (status === 'delivered') return '送信済み';
  if (status === 'failed') return '送信失敗';
  return '取消';
}

export async function enqueueProjectChatCommand(
  project: DevProject,
  prompt: string,
  connection: WorkerConnection = loadWorkerConnection(),
) {
  if (!project.chatUrl?.trim()) throw new Error('この案件にはChatGPTチャットURLが登録されていません。');
  return workerFetch<{ command: ChatCommand; transport: 'waiting_bridge' }>(connection, '/api/chat-commands', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.id,
      projectName: project.name,
      chatUrl: project.chatUrl,
      prompt,
    }),
  });
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

async function workerFetch<T>(connection: WorkerConnection, path: string, init: RequestInit): Promise<T> {
  const baseUrl = connection.baseUrl.trim().replace(/\/$/, '');
  if (!baseUrl) throw new Error('Supervisor Worker URLが未設定です。');
  if (!connection.token.trim()) throw new Error('Supervisor Worker接続トークンが未設定です。');

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.token.trim()}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; detail?: string };
  if (!response.ok) throw new Error(payload.detail || payload.error || `Chat command request failed (${response.status})`);
  return payload;
}
