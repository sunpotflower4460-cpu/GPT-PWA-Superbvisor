import { normalizeChatUrl } from './chatUrl';

export interface ChatBridgeStatus {
  connected: boolean;
  projectId?: string;
  bridgeId?: string;
  lastSeenAt?: string;
  capabilities: string[];
}

export interface ChatBridgeEnv {
  SUPERVISOR_STATE: KVNamespace;
}

const BRIDGE_PREFIX = 'chat-bridge-project:';
const BRIDGE_TTL = 60 * 10;
const CONNECTED_WINDOW_MS = 90_000;
const KV_LIST_PAGE_SIZE = 1000;
// A sanity backstop (100k bridge keys), not a realistic ceiling — exists so
// a malformed/malicious response can't spin listProjectBridges into an
// infinite loop, same pattern as githubExecutor.ts's MAX_JOB_PAGES.
const MAX_BRIDGE_LIST_PAGES = 100;

interface StoredBridge {
  projectId?: string;
  bridgeId?: string;
  chatUrl?: string;
  lastSeenAt?: string;
  capabilities?: string[];
}

// Multi Chat / Specialist Chat: more than one Bridge (one per open chat) can
// legitimately be connected to the same project at once now, so heartbeats
// are stored per-bridgeId rather than overwriting a single "latest" record
// — the earlier single-record design meant one live default-chat tab could
// mark the whole project connected even while the SPECIFIC specialist chat
// a queued command targets was offline (see getChatBridgeStatus's own
// comment for how a caller asks about one specific chat).
export async function recordChatBridgeHeartbeat(env: ChatBridgeEnv, input: { projectId?: string; bridgeId: string; chatUrl?: string; capabilities?: string[] }) {
  const capabilities = [...new Set((input.capabilities ?? [])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim().slice(0, 100)))]
    .slice(0, 30);
  const projectCapability = capabilities.find((item) => item.startsWith('project:'));
  const projectId = sanitizeId(input.projectId || projectCapability?.slice('project:'.length) || '');
  const bridgeId = sanitizeId(input.bridgeId);
  if (!projectId || !bridgeId) throw new Error('projectId and bridgeId are required');
  const chatUrl = input.chatUrl ? normalizeChatUrl(input.chatUrl) ?? undefined : undefined;
  const lastSeenAt = new Date().toISOString();
  const status: StoredBridge = { projectId, bridgeId, chatUrl, lastSeenAt, capabilities };
  await env.SUPERVISOR_STATE.put(projectBridgeKey(projectId, bridgeId), JSON.stringify(status), { expirationTtl: BRIDGE_TTL });
  return bridgeStatus(status);
}

// chatUrl scopes the answer to one specific chat: "is the Bridge for THIS
// conversation connected", not "is any Bridge for this project connected".
// Without this, a project dispatching to several chats could report
// everything as fine off the strength of one unrelated chat's heartbeat
// while the one a queued command actually needs sat offline. Absent
// chatUrl (or no bridge matching it) falls back to the most-recently-seen
// bridge for the whole project — the same aggregate answer this always
// gave, still meaningful for a general "is anything connected at all" check
// with no specific command in view.
export async function getChatBridgeStatus(env: ChatBridgeEnv, projectId: string, chatUrl?: string): Promise<ChatBridgeStatus> {
  const normalizedProjectId = sanitizeId(projectId);
  if (!normalizedProjectId) return { connected: false, capabilities: [] };
  const normalizedChatUrl = chatUrl ? normalizeChatUrl(chatUrl) ?? undefined : undefined;

  const bridges = await listProjectBridges(env, normalizedProjectId);
  if (!bridges.length) return { connected: false, projectId: normalizedProjectId, capabilities: [] };

  if (normalizedChatUrl) {
    const matching = bridges.filter((bridge) => bridge.chatUrl === normalizedChatUrl);
    if (matching.length) return bridgeStatus(mostRecentlySeen(matching));
    return { connected: false, projectId: normalizedProjectId, capabilities: [] };
  }

  return bridgeStatus(mostRecentlySeen(bridges));
}

// Paginates rather than trusting a single capped list() call: KV's list()
// returns keys in LEXICOGRAPHIC order by key name, not by recency, and
// bridgeId (a random per-tab/session suffix, see bridgeApp.ts's
// createBridgeId) has no relationship to lastSeenAt. A single-page cap
// would return an arbitrary lexicographic slice once a project accumulates
// more bridge keys than the cap — the actually-most-recent, actually-
// connected bridge for a requested chatUrl could simply never be fetched,
// silently reporting it disconnected. Same cursor-loop pattern
// chatCommandQueue.ts already uses for the identical risk elsewhere.
async function listProjectBridges(env: ChatBridgeEnv, projectId: string): Promise<StoredBridge[]> {
  const bridges: StoredBridge[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_BRIDGE_LIST_PAGES; page += 1) {
    const listed = await env.SUPERVISOR_STATE.list({
      prefix: `${BRIDGE_PREFIX}${projectId}:bridge:`,
      limit: KV_LIST_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    const values = await Promise.all(listed.keys.map(({ name }) => env.SUPERVISOR_STATE.get(name)));
    for (const raw of values) {
      if (!raw) continue;
      try { bridges.push(JSON.parse(raw) as StoredBridge); } catch { /* skip malformed */ }
    }
    if (listed.list_complete) break;
    cursor = listed.cursor;
  }
  return bridges;
}

function mostRecentlySeen(bridges: StoredBridge[]): StoredBridge {
  return bridges.reduce((latest, bridge) => ((bridge.lastSeenAt || '') > (latest.lastSeenAt || '') ? bridge : latest));
}

function projectBridgeKey(projectId: string, bridgeId: string) {
  return `${BRIDGE_PREFIX}${projectId}:bridge:${bridgeId}`;
}

function sanitizeId(value: string) {
  return value.trim().slice(0, 200).replace(/[^A-Za-z0-9._:-]/g, '_');
}

function bridgeStatus(value: StoredBridge): ChatBridgeStatus {
  const lastSeen = value.lastSeenAt ? new Date(value.lastSeenAt).getTime() : 0;
  const connected = Boolean(lastSeen) && Date.now() - lastSeen <= CONNECTED_WINDOW_MS;
  return {
    connected,
    projectId: value.projectId,
    bridgeId: value.bridgeId,
    lastSeenAt: value.lastSeenAt,
    capabilities: Array.isArray(value.capabilities) ? value.capabilities : [],
  };
}
