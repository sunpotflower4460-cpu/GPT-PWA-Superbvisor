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
  claimAttempts?: number;
  dedupeKey?: string;
}

export interface ChatCommandEnv {
  SUPERVISOR_STATE: KVNamespace;
}

const COMMAND_TTL = 60 * 60 * 24 * 14;
const COMMAND_PREFIX = 'chat-command:';
const PROJECT_PREFIX = 'chat-project:';
const DEDUPE_PREFIX = 'chat-dedupe:';
const CLAIM_STALE_MS = 2 * 60_000;

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
  if (command.status === 'queued') return true;
  if (command.status !== 'claimed' || !command.claimedAt) return false;
  const claimedAt = new Date(command.claimedAt).getTime();
  return Number.isFinite(claimedAt) && now - claimedAt >= CLAIM_STALE_MS;
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
  if (!projectId || !chatUrl || !prompt) throw new Error('projectId, valid ChatGPT chatUrl and prompt are required');

  if (dedupeKey) {
    const existingId = await env.SUPERVISOR_STATE.get(dedupeStorageKey(projectId, dedupeKey));
    if (existingId) {
      const existing = await getChatCommand(env, existingId);
      if (existing) return existing;
    }
  }

  const now = new Date().toISOString();
  const command: ChatCommand = {
    id: crypto.randomUUID(),
    projectId,
    projectName: input.projectName?.trim().slice(0, 200) || undefined,
    chatUrl,
    prompt,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    claimAttempts: 0,
    dedupeKey,
  };
  await saveCommand(env, command);
  await rememberProjectCommand(env, command);
  if (dedupeKey) {
    await env.SUPERVISOR_STATE.put(dedupeStorageKey(projectId, dedupeKey), command.id, { expirationTtl: COMMAND_TTL });
  }
  return command;
}

export async function getChatCommand(env: ChatCommandEnv, id: string) {
  const raw = await env.SUPERVISOR_STATE.get(`${COMMAND_PREFIX}${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as ChatCommand; } catch { return null; }
}

export async function listProjectChatCommands(env: ChatCommandEnv, projectId: string, limit = 30) {
  const listed = await env.SUPERVISOR_STATE.list({ prefix: `${PROJECT_PREFIX}${projectId}:`, limit: Math.max(1, Math.min(limit, 100)) });
  const commands = await Promise.all(listed.keys.map(async ({ name }) => {
    const commandId = name.split(':').pop();
    return commandId ? getChatCommand(env, commandId) : null;
  }));
  return commands.filter((item): item is ChatCommand => Boolean(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function claimNextChatCommand(env: ChatCommandEnv, bridgeId: string, projectId?: string) {
  const commands = projectId
    ? await listProjectChatCommands(env, projectId, 100)
    : await listQueuedCommands(env, 100);
  const next = commands.filter((command) => isClaimableCommand(command)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!next) return null;

  const now = new Date().toISOString();
  const recoveredStaleClaim = next.status === 'claimed';
  const claimed: ChatCommand = {
    ...next,
    status: 'claimed',
    bridgeId: bridgeId.trim().slice(0, 200) || 'unknown-bridge',
    claimedAt: now,
    updatedAt: now,
    claimAttempts: (next.claimAttempts ?? 0) + 1,
    detail: recoveredStaleClaim ? 'Recovered a stale bridge claim and reassigned the command.' : next.detail,
  };
  await saveCommand(env, claimed);
  return claimed;
}

export async function updateChatCommandResult(env: ChatCommandEnv, id: string, input: { status: 'delivered' | 'failed' | 'cancelled'; detail?: string }) {
  const current = await getChatCommand(env, id);
  if (!current) return null;
  const now = new Date().toISOString();
  const updated: ChatCommand = {
    ...current,
    status: input.status,
    detail: input.detail?.trim().slice(0, 2000) || undefined,
    deliveredAt: input.status === 'delivered' ? now : current.deliveredAt,
    updatedAt: now,
  };
  await saveCommand(env, updated);
  return updated;
}

async function listQueuedCommands(env: ChatCommandEnv, limit: number) {
  const listed = await env.SUPERVISOR_STATE.list({ prefix: COMMAND_PREFIX, limit });
  const commands = await Promise.all(listed.keys.map(({ name }) => getChatCommand(env, name.slice(COMMAND_PREFIX.length))));
  return commands.filter((item): item is ChatCommand => Boolean(item));
}

async function saveCommand(env: ChatCommandEnv, command: ChatCommand) {
  await env.SUPERVISOR_STATE.put(`${COMMAND_PREFIX}${command.id}`, JSON.stringify(command), { expirationTtl: COMMAND_TTL });
}

async function rememberProjectCommand(env: ChatCommandEnv, command: ChatCommand) {
  const sortable = command.createdAt.replace(/[^0-9]/g, '').slice(0, 17);
  await env.SUPERVISOR_STATE.put(`${PROJECT_PREFIX}${command.projectId}:${sortable}:${command.id}`, command.id, { expirationTtl: COMMAND_TTL });
}

function dedupeStorageKey(projectId: string, dedupeKey: string) {
  return `${DEDUPE_PREFIX}${encodeURIComponent(projectId)}:${encodeURIComponent(dedupeKey)}`;
}
