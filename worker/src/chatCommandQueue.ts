import {
  AtomicCoordinatorEnv,
  CoordinatorChatCommand,
  CoordinatorChatCommandStatus,
  CoordinatorCommandOverview,
  applyCommandResult,
  coordinatorFetch,
  hasAtomicCoordinator,
  isCoordinatorCommandClaimable,
  summarizeCoordinatorCommands,
} from './projectCoordinator';

export type ChatCommandStatus = CoordinatorChatCommandStatus;
export interface ChatCommand extends CoordinatorChatCommand {}
export interface ChatCommandOverviewSnapshot extends CoordinatorCommandOverview {
  approximate: boolean;
}

export interface ChatCommandEnv extends AtomicCoordinatorEnv {
  SUPERVISOR_STATE: KVNamespace;
}

export class ChatCommandConflictError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ChatCommandConflictError';
  }
}

export const INVALID_CHAT_COMMAND_ERROR = 'projectId, valid ChatGPT chatUrl and prompt are required';

const COMMAND_TTL = 60 * 60 * 24 * 14;
const COMMAND_PREFIX = 'chat-command:';
const PROJECT_PREFIX = 'chat-project:';
const DEDUPE_PREFIX = 'chat-dedupe:';
const KV_LIST_PAGE_SIZE = 1000;
const migratedProjects = new Set<string>();

export function normalizeChatUrl(value: string) {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') return null;
    if (host !== 'chatgpt.com' && !host.endsWith('.chatgpt.com') && host !== 'chat.openai.com') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function sanitizePrompt(value: string) {
  return value.trim().slice(0, 24_000);
}

export function isClaimableCommand(command: ChatCommand, now = Date.now()) {
  return isCoordinatorCommandClaimable(command, now);
}

export async function enqueueChatCommand(env: ChatCommandEnv, input: {
  projectId: string;
  projectName?: string;
  chatUrl: string;
  prompt: string;
  dedupeKey?: string;
}) {
  const projectId = input.projectId.trim().slice(0, 200);
  const chatUrl = normalizeChatUrl(input.chatUrl);
  const prompt = sanitizePrompt(input.prompt);
  const dedupeKey = input.dedupeKey?.trim().slice(0, 200) || undefined;
  if (!projectId || !chatUrl || !prompt) throw new Error(INVALID_CHAT_COMMAND_ERROR);

  if (hasAtomicCoordinator(env)) {
    await ensureCoordinatorCommandsMigrated(env, projectId);
    const result = await coordinatorFetch<{ command?: ChatCommand; error?: string }>(env, chatScope(projectId), '/commands/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        projectName: input.projectName?.trim().slice(0, 200) || undefined,
        chatUrl,
        prompt,
        dedupeKey,
      }),
    });
    if (result.status === 409) {
      throw new ChatCommandConflictError(result.data.error || 'chat_command_conflict', result.data.error || 'chat_command_conflict');
    }
    if (!result.ok || !result.data.command) throw new Error(result.data.error || `atomic_enqueue_failed_${result.status}`);
    await mirrorCommand(env, result.data.command);
    return result.data.command;
  }

  return enqueueChatCommandKv(env, {
    projectId,
    projectName: input.projectName,
    chatUrl,
    prompt,
    dedupeKey,
  });
}

export async function getChatCommand(env: ChatCommandEnv, id: string) {
  const raw = await env.SUPERVISOR_STATE.get(`${COMMAND_PREFIX}${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as ChatCommand; } catch { return null; }
}

export async function getProjectChatCommand(env: ChatCommandEnv, projectId: string, id: string) {
  const normalizedProjectId = projectId.trim().slice(0, 200);
  if (!normalizedProjectId || !id.trim()) return null;
  if (!hasAtomicCoordinator(env)) {
    const command = await getChatCommand(env, id);
    return command?.projectId === normalizedProjectId ? command : null;
  }

  await ensureCoordinatorCommandsMigrated(env, normalizedProjectId);
  const result = await coordinatorFetch<{ command?: ChatCommand; error?: string }>(
    env,
    chatScope(normalizedProjectId),
    `/commands/get?id=${encodeURIComponent(id)}`,
    { method: 'GET' },
  );
  if (result.status === 404) return null;
  if (!result.ok || !result.data.command) throw new Error(result.data.error || `atomic_get_failed_${result.status}`);
  await mirrorCommand(env, result.data.command);
  return result.data.command;
}

export async function listProjectChatCommands(env: ChatCommandEnv, projectId: string, limit = 30) {
  const normalizedProjectId = projectId.trim().slice(0, 200);
  if (!normalizedProjectId) return [];
  if (!hasAtomicCoordinator(env)) return listProjectChatCommandsKv(env, normalizedProjectId, limit);

  await ensureCoordinatorCommandsMigrated(env, normalizedProjectId);
  const cappedLimit = Math.max(1, Math.min(limit, 100));
  const result = await coordinatorFetch<{ commands?: ChatCommand[]; error?: string }>(
    env,
    chatScope(normalizedProjectId),
    `/commands/list?limit=${cappedLimit}`,
    { method: 'GET' },
  );
  if (!result.ok) throw new Error(result.data.error || `atomic_list_failed_${result.status}`);
  const commands = result.data.commands ?? [];
  await Promise.all(commands.map((command) => mirrorCommand(env, command)));
  return commands;
}

export async function getProjectChatCommandOverview(env: ChatCommandEnv, projectId: string): Promise<ChatCommandOverviewSnapshot> {
  const normalizedProjectId = projectId.trim().slice(0, 200);
  if (!normalizedProjectId) return { pendingCount: 0, failedCount: 0, totalCount: 0, approximate: false };

  if (hasAtomicCoordinator(env)) {
    await ensureCoordinatorCommandsMigrated(env, normalizedProjectId);
    const result = await coordinatorFetch<{ overview?: CoordinatorCommandOverview; error?: string }>(
      env,
      chatScope(normalizedProjectId),
      '/commands/overview',
      { method: 'GET' },
    );
    if (!result.ok || !result.data.overview) throw new Error(result.data.error || `atomic_overview_failed_${result.status}`);
    return { ...result.data.overview, approximate: false };
  }

  const commands = await listProjectChatCommandsKv(env, normalizedProjectId, 100);
  return { ...summarizeCoordinatorCommands(commands), approximate: commands.length >= 100 };
}

export async function claimNextChatCommand(env: ChatCommandEnv, bridgeId: string, projectId?: string) {
  const normalizedBridgeId = bridgeId.trim().slice(0, 200) || 'unknown-bridge';
  const normalizedProjectId = projectId?.trim().slice(0, 200) || '';

  if (hasAtomicCoordinator(env) && normalizedProjectId) {
    await ensureCoordinatorCommandsMigrated(env, normalizedProjectId);
    const result = await coordinatorFetch<{ command?: ChatCommand | null; error?: string }>(
      env,
      chatScope(normalizedProjectId),
      '/commands/claim',
      { method: 'POST', body: JSON.stringify({ bridgeId: normalizedBridgeId }) },
    );
    if (!result.ok) throw new Error(result.data.error || `atomic_claim_failed_${result.status}`);
    if (result.data.command) await mirrorCommand(env, result.data.command);
    return result.data.command ?? null;
  }

  const nowMs = Date.now();
  const candidate = normalizedProjectId
    ? await findProjectClaimCandidateKv(env, normalizedProjectId, normalizedBridgeId, nowMs)
    : findClaimCandidate(await listQueuedCommandsKv(env, 100), normalizedBridgeId, nowMs);
  if (!candidate) return null;
  if (candidate.status === 'claimed'
    && candidate.bridgeId === normalizedBridgeId
    && Boolean(candidate.claimedAt)
    && !isClaimableCommand(candidate, nowMs)) {
    return candidate;
  }

  const now = new Date(nowMs).toISOString();
  const recoveredStaleClaim = candidate.status === 'claimed';
  const claimed: ChatCommand = {
    ...candidate,
    status: 'claimed',
    bridgeId: normalizedBridgeId,
    claimedAt: now,
    updatedAt: now,
    nextAttemptAt: undefined,
    claimAttempts: (candidate.claimAttempts ?? 0) + 1,
    detail: recoveredStaleClaim ? 'Recovered a stale bridge claim and reassigned the command.' : candidate.detail,
  };
  await saveCommand(env, claimed);
  return claimed;
}

export async function updateChatCommandResult(env: ChatCommandEnv, id: string, input: {
  status: 'delivered' | 'failed' | 'cancelled';
  detail?: string;
  projectId?: string;
  bridgeId?: string;
}) {
  const projectId = input.projectId?.trim().slice(0, 200) || '';
  const bridgeId = input.bridgeId?.trim().slice(0, 200) || '';

  if (hasAtomicCoordinator(env) && projectId && bridgeId) {
    await ensureCoordinatorCommandsMigrated(env, projectId);
    const result = await coordinatorFetch<{ command?: ChatCommand; error?: string }>(env, chatScope(projectId), '/commands/result', {
      method: 'POST',
      body: JSON.stringify({ id, projectId, bridgeId, status: input.status, detail: input.detail }),
    });
    if (result.status === 404) return null;
    if (result.status === 409) throw new ChatCommandConflictError(result.data.error || 'chat_command_conflict', result.data.error || 'chat_command_conflict');
    if (!result.ok || !result.data.command) throw new Error(result.data.error || `atomic_result_failed_${result.status}`);
    await mirrorCommand(env, result.data.command);
    return result.data.command;
  }

  const current = await getChatCommand(env, id);
  if (!current) return null;
  if (projectId && current.projectId !== projectId) throw new ChatCommandConflictError('project_mismatch', 'project_mismatch');
  if (current.status === input.status && ['delivered', 'failed', 'cancelled'].includes(current.status)) {
    if (bridgeId && current.bridgeId && current.bridgeId !== bridgeId) {
      throw new ChatCommandConflictError('claim_owner_mismatch', 'claim_owner_mismatch');
    }
    return current;
  }
  if (current.status !== 'claimed') throw new ChatCommandConflictError('command_not_claimed', 'command_not_claimed');
  if (bridgeId && current.bridgeId !== bridgeId) throw new ChatCommandConflictError('claim_owner_mismatch', 'claim_owner_mismatch');
  const updated = applyCommandResult(current, input);
  await saveCommand(env, updated);
  return updated;
}

export async function retryChatCommand(env: ChatCommandEnv, projectId: string, id: string) {
  const normalizedProjectId = projectId.trim().slice(0, 200);
  if (!normalizedProjectId || !id.trim()) throw new Error('projectId and command id are required');

  if (hasAtomicCoordinator(env)) {
    await ensureCoordinatorCommandsMigrated(env, normalizedProjectId);
    const result = await coordinatorFetch<{ command?: ChatCommand; error?: string }>(env, chatScope(normalizedProjectId), '/commands/retry', {
      method: 'POST',
      body: JSON.stringify({ id, projectId: normalizedProjectId }),
    });
    if (result.status === 404) return null;
    if (result.status === 409) throw new ChatCommandConflictError(result.data.error || 'chat_command_conflict', result.data.error || 'chat_command_conflict');
    if (!result.ok || !result.data.command) throw new Error(result.data.error || `atomic_retry_failed_${result.status}`);
    await mirrorCommand(env, result.data.command);
    return result.data.command;
  }

  const current = await getChatCommand(env, id);
  if (!current) return null;
  if (current.projectId !== normalizedProjectId) throw new ChatCommandConflictError('project_mismatch', 'project_mismatch');
  if (current.status !== 'failed') throw new ChatCommandConflictError('only_failed_commands_can_retry', 'only_failed_commands_can_retry');
  const updated: ChatCommand = {
    ...current,
    status: 'queued',
    bridgeId: undefined,
    updatedAt: new Date().toISOString(),
    claimedAt: undefined,
    nextAttemptAt: undefined,
    deliveryFailures: 0,
    detail: 'Manual retry requested after delivery attempts were exhausted.',
  };
  await saveCommand(env, updated);
  return updated;
}

export async function cancelChatCommand(env: ChatCommandEnv, projectId: string, id: string, detail?: string) {
  const normalizedProjectId = projectId.trim().slice(0, 200);
  if (!normalizedProjectId || !id.trim()) throw new Error('projectId and command id are required');

  if (hasAtomicCoordinator(env)) {
    await ensureCoordinatorCommandsMigrated(env, normalizedProjectId);
    const result = await coordinatorFetch<{ command?: ChatCommand; error?: string }>(env, chatScope(normalizedProjectId), '/commands/cancel', {
      method: 'POST',
      body: JSON.stringify({ id, projectId: normalizedProjectId, detail }),
    });
    if (result.status === 404) return null;
    if (result.status === 409) throw new ChatCommandConflictError(result.data.error || 'chat_command_conflict', result.data.error || 'chat_command_conflict');
    if (!result.ok || !result.data.command) throw new Error(result.data.error || `atomic_cancel_failed_${result.status}`);
    await mirrorCommand(env, result.data.command);
    return result.data.command;
  }

  const current = await getChatCommand(env, id);
  if (!current) return null;
  if (current.projectId !== normalizedProjectId) throw new ChatCommandConflictError('project_mismatch', 'project_mismatch');
  if (current.status === 'cancelled') return current;
  if (current.status !== 'queued' && current.status !== 'failed') {
    throw new ChatCommandConflictError('only_queued_or_failed_commands_can_cancel', 'only_queued_or_failed_commands_can_cancel');
  }
  const updated: ChatCommand = {
    ...current,
    status: 'cancelled',
    bridgeId: undefined,
    claimedAt: undefined,
    nextAttemptAt: undefined,
    updatedAt: new Date().toISOString(),
    detail: detail?.trim().slice(0, 2000) || 'Cancelled before switching to manual ChatGPT fallback.',
  };
  await saveCommand(env, updated);
  return updated;
}

async function enqueueChatCommandKv(env: ChatCommandEnv, input: {
  projectId: string;
  projectName?: string;
  chatUrl: string;
  prompt: string;
  dedupeKey?: string;
}) {
  if (input.dedupeKey) {
    const existingId = await env.SUPERVISOR_STATE.get(dedupeStorageKey(input.projectId, input.dedupeKey));
    if (existingId) {
      const existing = await getChatCommand(env, existingId);
      if (existing) {
        if (!sameCommandPayload(existing, input)) {
          throw new ChatCommandConflictError('dedupe_payload_mismatch', 'dedupe_payload_mismatch');
        }
        return existing;
      }
    }
  }

  const now = new Date().toISOString();
  const command: ChatCommand = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    projectName: input.projectName?.trim().slice(0, 200) || undefined,
    chatUrl: input.chatUrl,
    prompt: input.prompt,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    claimAttempts: 0,
    deliveryFailures: 0,
    maxDeliveryAttempts: 3,
    dedupeKey: input.dedupeKey,
  };
  await mirrorCommand(env, command);
  return command;
}

async function listProjectChatCommandsKv(env: ChatCommandEnv, projectId: string, limit = 30) {
  const cappedLimit = Math.max(1, Math.min(limit, 100));
  const indexNames = await listProjectIndexNamesKv(env, projectId);
  const selectedNames = indexNames.slice(-cappedLimit);
  const commands = await Promise.all(selectedNames.map(async (name) => {
    const commandId = name.split(':').pop();
    return commandId ? getChatCommand(env, commandId) : null;
  }));
  return commands.filter((item): item is ChatCommand => Boolean(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function listProjectIndexNamesKv(env: ChatCommandEnv, projectId: string) {
  const names: string[] = [];
  let cursor: string | undefined;
  while (true) {
    const listed = await env.SUPERVISOR_STATE.list({
      prefix: `${PROJECT_PREFIX}${projectId}:`,
      limit: KV_LIST_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    names.push(...listed.keys.map(({ name }) => name));
    if (listed.list_complete) break;
    cursor = listed.cursor;
  }
  return names;
}

async function findProjectClaimCandidateKv(
  env: ChatCommandEnv,
  projectId: string,
  bridgeId: string,
  nowMs: number,
) {
  let cursor: string | undefined;
  let existingOwnedClaim: ChatCommand | undefined;
  let nextClaimable: ChatCommand | undefined;

  while (true) {
    const listed = await env.SUPERVISOR_STATE.list({
      prefix: `${PROJECT_PREFIX}${projectId}:`,
      limit: KV_LIST_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    const commands = await Promise.all(listed.keys.map(async ({ name }) => {
      const commandId = name.split(':').pop();
      return commandId ? getChatCommand(env, commandId) : null;
    }));

    for (const command of commands) {
      if (!command) continue;
      const isOwnedFreshClaim = command.status === 'claimed'
        && command.bridgeId === bridgeId
        && Boolean(command.claimedAt)
        && !isClaimableCommand(command, nowMs);
      if (isOwnedFreshClaim && (!existingOwnedClaim || (command.claimedAt || '') < (existingOwnedClaim.claimedAt || ''))) {
        existingOwnedClaim = command;
      }
      if (isClaimableCommand(command, nowMs) && (!nextClaimable || command.createdAt < nextClaimable.createdAt)) {
        nextClaimable = command;
      }
    }

    if (listed.list_complete) break;
    cursor = listed.cursor;
  }

  return existingOwnedClaim ?? nextClaimable ?? null;
}

function findClaimCandidate(commands: ChatCommand[], bridgeId: string, nowMs: number) {
  const existingOwnedClaim = commands
    .filter((command) => command.status === 'claimed'
      && command.bridgeId === bridgeId
      && Boolean(command.claimedAt)
      && !isClaimableCommand(command, nowMs))
    .sort((a, b) => (a.claimedAt || '').localeCompare(b.claimedAt || ''))[0];
  if (existingOwnedClaim) return existingOwnedClaim;

  return commands
    .filter((command) => isClaimableCommand(command, nowMs))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

async function listQueuedCommandsKv(env: ChatCommandEnv, limit: number) {
  const listed = await env.SUPERVISOR_STATE.list({ prefix: COMMAND_PREFIX, limit });
  const commands = await Promise.all(listed.keys.map(({ name }) => getChatCommand(env, name.slice(COMMAND_PREFIX.length))));
  return commands.filter((item): item is ChatCommand => Boolean(item));
}

async function ensureCoordinatorCommandsMigrated(env: ChatCommandEnv, projectId: string) {
  if (!hasAtomicCoordinator(env) || migratedProjects.has(projectId)) return;
  const legacy = await listProjectChatCommandsKv(env, projectId, 100);
  const result = await coordinatorFetch<{ ok?: boolean; error?: string }>(env, chatScope(projectId), '/commands/import', {
    method: 'POST',
    body: JSON.stringify({ commands: legacy }),
  });
  if (!result.ok) throw new Error(result.data.error || `atomic_command_migration_failed_${result.status}`);
  migratedProjects.add(projectId);
}

async function mirrorCommand(env: ChatCommandEnv, command: ChatCommand) {
  await saveCommand(env, command);
  await rememberProjectCommand(env, command);
  if (command.dedupeKey) {
    await env.SUPERVISOR_STATE.put(dedupeStorageKey(command.projectId, command.dedupeKey), command.id, { expirationTtl: COMMAND_TTL });
  }
}

async function saveCommand(env: ChatCommandEnv, command: ChatCommand) {
  await env.SUPERVISOR_STATE.put(`${COMMAND_PREFIX}${command.id}`, JSON.stringify(command), { expirationTtl: COMMAND_TTL });
}

async function rememberProjectCommand(env: ChatCommandEnv, command: ChatCommand) {
  const sortable = command.createdAt.replace(/[^0-9]/g, '').slice(0, 17);
  await env.SUPERVISOR_STATE.put(`${PROJECT_PREFIX}${command.projectId}:${sortable}:${command.id}`, command.id, { expirationTtl: COMMAND_TTL });
}

function sameCommandPayload(
  command: ChatCommand,
  input: { projectId: string; chatUrl: string; prompt: string },
) {
  return command.projectId === input.projectId
    && command.chatUrl === input.chatUrl
    && command.prompt === input.prompt;
}

function chatScope(projectId: string) {
  return `chat:${projectId}`;
}

function dedupeStorageKey(projectId: string, dedupeKeyValue: string) {
  return `${DEDUPE_PREFIX}${encodeURIComponent(projectId)}:${encodeURIComponent(dedupeKeyValue)}`;
}
