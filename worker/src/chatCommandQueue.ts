import {
  AtomicCoordinatorEnv,
  CoordinatorChatCommand,
  CoordinatorChatCommandKind,
  CoordinatorChatCommandStatus,
  CoordinatorCommandOverview,
  applyCommandResult,
  coordinatorFetch,
  hasAtomicCoordinator,
  isBetterClaimCandidate,
  isCoordinatorCommandClaimable,
  summarizeCoordinatorCommands,
} from './projectCoordinator';

export type ChatCommandStatus = CoordinatorChatCommandStatus;
export type ChatCommandKind = CoordinatorChatCommandKind;
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
export const INVALID_CLAIM_CHAT_URL_ERROR = 'chatUrl, when provided, must be a valid ChatGPT chatUrl';

const COMMAND_TTL = 60 * 60 * 24 * 14;
const MIN_KV_EXPIRATION_TTL = 60;
const COMMAND_PREFIX = 'chat-command:';
const PROJECT_PREFIX = 'chat-project:';
const DEDUPE_PREFIX = 'chat-dedupe:';
const KV_LIST_PAGE_SIZE = 1000;
const KV_MIGRATION_PAGE_SIZE = 200;
const COORDINATOR_IMPORT_BATCH_SIZE = 20;
const migratedProjects = new Set<string>();

export function normalizeChatUrl(value: string) {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') return null;
    if (host !== 'chatgpt.com' && !host.endsWith('.chatgpt.com') && host !== 'chat.openai.com') return null;
    // A fragment is never sent to the server and can't identify a
    // different conversation resource; a trailing slash is likewise
    // insignificant here. Both are discarded so two spellings of the SAME
    // conversation (e.g. copied from different UI surfaces, or with/without
    // a "#section" ChatGPT sometimes appends) compare equal — this value is
    // used as an exact-match identity key for Multi Chat / Specialist Chat
    // claim scoping (see claimNextChatCommand), and a meaningless spelling
    // difference there means a correctly-connected Bridge polls forever
    // while its own commands sit queued, unmatched.
    url.hash = '';
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.origin}${path}${url.search}`;
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
  // Absent means NEXT (ordinary follow-up work) — see
  // CoordinatorChatCommandKind's own comment for why STEER claims ahead of
  // NEXT regardless of queue age.
  kind?: ChatCommandKind;
}) {
  const projectId = input.projectId.trim().slice(0, 200);
  const chatUrl = normalizeChatUrl(input.chatUrl);
  const prompt = sanitizePrompt(input.prompt);
  const dedupeKey = input.dedupeKey?.trim().slice(0, 200) || undefined;
  const kind = input.kind === 'STEER' ? 'STEER' : input.kind === 'NEXT' ? 'NEXT' : undefined;
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
        kind,
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
    kind,
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

// chatUrl is the calling Bridge's OWN current conversation (e.g.
// window.location.href from the ChatGPT tab it's running in), optional for
// backward compatibility with an older Bridge build that never sends it.
// When present, only a command destined for that EXACT chat is eligible —
// see Multi Chat / Specialist Chat: without this, a project dispatching to
// several distinct chats has all their commands sitting in one shared
// project-wide pool, and whichever Bridge tab happens to poll first can
// claim (and thus receive, in its OWN conversation) a command meant for a
// different chat entirely. Absent chatUrl preserves the original
// project-wide claim pool exactly — the correct behavior for the common
// case of one chat per project. A NON-EMPTY chatUrl that fails validation
// throws rather than silently degrading to "absent" (indistinguishable
// from "no chatUrl given at all") — chatUrl is a value the user/ChatGPT
// hand-typed at Bridge-connect time, never auto-discovered, so a plausible
// typo (e.g. missing "https://") must not silently reopen the exact
// cross-chat misdelivery race this scoping exists to close.
export async function claimNextChatCommand(env: ChatCommandEnv, bridgeId: string, projectId?: string, chatUrl?: string) {
  const normalizedBridgeId = bridgeId.trim().slice(0, 200) || 'unknown-bridge';
  const normalizedProjectId = projectId?.trim().slice(0, 200) || '';
  const trimmedChatUrl = chatUrl?.trim();
  if (trimmedChatUrl && !normalizeChatUrl(trimmedChatUrl)) throw new Error(INVALID_CLAIM_CHAT_URL_ERROR);
  const normalizedChatUrl = trimmedChatUrl ? normalizeChatUrl(trimmedChatUrl) ?? undefined : undefined;

  if (hasAtomicCoordinator(env) && normalizedProjectId) {
    await ensureCoordinatorCommandsMigrated(env, normalizedProjectId);
    const result = await coordinatorFetch<{ command?: ChatCommand | null; error?: string }>(
      env,
      chatScope(normalizedProjectId),
      '/commands/claim',
      { method: 'POST', body: JSON.stringify({ bridgeId: normalizedBridgeId, chatUrl: normalizedChatUrl }) },
    );
    if (!result.ok) throw new Error(result.data.error || `atomic_claim_failed_${result.status}`);
    if (result.data.command) await mirrorCommand(env, result.data.command);
    return result.data.command ?? null;
  }

  const nowMs = Date.now();
  const candidate = normalizedProjectId
    ? await findProjectClaimCandidateKv(env, normalizedProjectId, normalizedBridgeId, nowMs, normalizedChatUrl)
    : findClaimCandidate(await listQueuedCommandsKv(env, 100), normalizedBridgeId, nowMs, normalizedChatUrl);
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
  kind?: ChatCommandKind;
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
    kind: input.kind,
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
  chatUrl?: string,
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
      if (chatUrl && command.chatUrl !== chatUrl) continue;
      const isOwnedFreshClaim = command.status === 'claimed'
        && command.bridgeId === bridgeId
        && Boolean(command.claimedAt)
        && !isClaimableCommand(command, nowMs);
      if (isOwnedFreshClaim && (!existingOwnedClaim || (command.claimedAt || '') < (existingOwnedClaim.claimedAt || ''))) {
        existingOwnedClaim = command;
      }
      if (isClaimableCommand(command, nowMs) && isBetterClaimCandidate(command, nextClaimable)) {
        nextClaimable = command;
      }
    }

    if (listed.list_complete) break;
    cursor = listed.cursor;
  }

  return existingOwnedClaim ?? nextClaimable ?? null;
}

function findClaimCandidate(commands: ChatCommand[], bridgeId: string, nowMs: number, chatUrl?: string) {
  const scoped = chatUrl ? commands.filter((command) => command.chatUrl === chatUrl) : commands;
  const existingOwnedClaim = scoped
    .filter((command) => command.status === 'claimed'
      && command.bridgeId === bridgeId
      && Boolean(command.claimedAt)
      && !isClaimableCommand(command, nowMs))
    .sort((a, b) => (a.claimedAt || '').localeCompare(b.claimedAt || ''))[0];
  if (existingOwnedClaim) return existingOwnedClaim;

  return scoped
    .filter((command) => isClaimableCommand(command, nowMs))
    .reduce<ChatCommand | undefined>((best, command) => (isBetterClaimCandidate(command, best) ? command : best), undefined) ?? null;
}

async function listQueuedCommandsKv(env: ChatCommandEnv, limit: number) {
  const listed = await env.SUPERVISOR_STATE.list({ prefix: COMMAND_PREFIX, limit });
  const commands = await Promise.all(listed.keys.map(({ name }) => getChatCommand(env, name.slice(COMMAND_PREFIX.length))));
  return commands.filter((item): item is ChatCommand => Boolean(item));
}

async function ensureCoordinatorCommandsMigrated(env: ChatCommandEnv, projectId: string) {
  if (!hasAtomicCoordinator(env) || migratedProjects.has(projectId)) return;

  const nowMs = Date.now();
  const migrationGaps: string[] = [];
  let cursor: string | undefined;
  while (true) {
    const listed = await env.SUPERVISOR_STATE.list({
      prefix: `${PROJECT_PREFIX}${projectId}:`,
      limit: KV_MIGRATION_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });

    for (let offset = 0; offset < listed.keys.length; offset += COORDINATOR_IMPORT_BATCH_SIZE) {
      const batchKeys = listed.keys.slice(offset, offset + COORDINATOR_IMPORT_BATCH_SIZE);
      const resolved = await Promise.all(batchKeys.map(async ({ name }) => {
        const commandId = name.split(':').pop() || '';
        const command = commandId ? await getChatCommand(env, commandId) : null;
        return { name, commandId, command };
      }));
      const commands: ChatCommand[] = [];

      for (const item of resolved) {
        if (!item.command) {
          if (isProjectIndexWithinRetention(item.name, nowMs)) {
            migrationGaps.push(item.commandId || item.name);
          }
          continue;
        }
        if (item.command.projectId !== projectId) {
          if (isProjectIndexWithinRetention(item.name, nowMs)) {
            migrationGaps.push(`project_mismatch:${item.commandId || item.name}`);
          }
          continue;
        }
        commands.push(item.command);
      }
      if (!commands.length) continue;

      const result = await coordinatorFetch<{ ok?: boolean; migrated?: boolean; error?: string }>(
        env,
        chatScope(projectId),
        '/commands/import',
        { method: 'POST', body: JSON.stringify({ commands }) },
      );
      if (!result.ok) throw new Error(result.data.error || `atomic_command_migration_failed_${result.status}`);
      if (result.data.migrated) {
        migratedProjects.add(projectId);
        return;
      }
    }

    if (listed.list_complete) break;
    cursor = listed.cursor;
  }

  if (migrationGaps.length) {
    throw new Error(`atomic_command_migration_incomplete:${migrationGaps.slice(0, 5).join(',')}`);
  }

  const finalize = await coordinatorFetch<{ ok?: boolean; migrated?: boolean; error?: string }>(
    env,
    chatScope(projectId),
    '/commands/import',
    { method: 'POST', body: JSON.stringify({ commands: [], finalize: true }) },
  );
  if (!finalize.ok || finalize.data.migrated !== true) {
    throw new Error(finalize.data.error || `atomic_command_migration_finalize_failed_${finalize.status}`);
  }
  migratedProjects.add(projectId);
}

async function mirrorCommand(env: ChatCommandEnv, command: ChatCommand) {
  await saveCommand(env, command);
  await rememberProjectCommand(env, command);
  if (command.dedupeKey) {
    await env.SUPERVISOR_STATE.put(dedupeStorageKey(command.projectId, command.dedupeKey), command.id, {
      expirationTtl: commandExpirationTtl(command),
    });
  }
}

async function saveCommand(env: ChatCommandEnv, command: ChatCommand) {
  await env.SUPERVISOR_STATE.put(`${COMMAND_PREFIX}${command.id}`, JSON.stringify(command), {
    expirationTtl: commandExpirationTtl(command),
  });
}

async function rememberProjectCommand(env: ChatCommandEnv, command: ChatCommand) {
  const sortable = command.createdAt.replace(/[^0-9]/g, '').slice(0, 17);
  await env.SUPERVISOR_STATE.put(`${PROJECT_PREFIX}${command.projectId}:${sortable}:${command.id}`, command.id, {
    expirationTtl: commandExpirationTtl(command),
  });
}

function commandExpirationTtl(command: ChatCommand) {
  const createdAt = new Date(command.createdAt).getTime();
  if (!Number.isFinite(createdAt)) return COMMAND_TTL;
  const remainingSeconds = Math.ceil((createdAt + (COMMAND_TTL * 1000) - Date.now()) / 1000);
  return Math.max(MIN_KV_EXPIRATION_TTL, Math.min(COMMAND_TTL, remainingSeconds));
}

function isProjectIndexWithinRetention(indexName: string, nowMs: number) {
  const createdAt = projectIndexCreatedAtMs(indexName);
  return createdAt === null || nowMs - createdAt <= COMMAND_TTL * 1000;
}

function projectIndexCreatedAtMs(indexName: string) {
  const commandSeparator = indexName.lastIndexOf(':');
  if (commandSeparator <= 0) return null;
  const timestampSeparator = indexName.lastIndexOf(':', commandSeparator - 1);
  if (timestampSeparator <= 0) return null;
  const value = indexName.slice(timestampSeparator + 1, commandSeparator);
  if (!/^\d{17}$/.test(value)) return null;

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const millisecond = Number(value.slice(14, 17));
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
    || date.getUTCMilliseconds() !== millisecond) {
    return null;
  }
  return timestamp;
}

// Kept in sync with projectCoordinator.ts's sameCommandPayload: a dedupe hit
// must also agree on `kind`, or a retried call asking for a different kind
// than the original silently inherits the original's kind instead of being
// treated as a mismatch. 'NEXT' and absent are the same value.
function sameCommandPayload(
  command: ChatCommand,
  input: { projectId: string; chatUrl: string; prompt: string; kind?: ChatCommandKind },
) {
  return command.projectId === input.projectId
    && command.chatUrl === input.chatUrl
    && command.prompt === input.prompt
    && normalizeKind(command.kind) === normalizeKind(input.kind);
}

function normalizeKind(kind: ChatCommandKind | undefined): ChatCommandKind {
  return kind === 'STEER' ? 'STEER' : 'NEXT';
}

function chatScope(projectId: string) {
  return `chat:${projectId}`;
}

function dedupeStorageKey(projectId: string, dedupeKeyValue: string) {
  return `${DEDUPE_PREFIX}${encodeURIComponent(projectId)}:${encodeURIComponent(dedupeKeyValue)}`;
}
