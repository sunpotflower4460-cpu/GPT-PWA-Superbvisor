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

export async function recordChatBridgeHeartbeat(env: ChatBridgeEnv, input: { projectId: string; bridgeId: string; capabilities?: string[] }) {
  const projectId = sanitizeId(input.projectId);
  const bridgeId = sanitizeId(input.bridgeId);
  if (!projectId || !bridgeId) throw new Error('projectId and bridgeId are required');
  const lastSeenAt = new Date().toISOString();
  const capabilities = [...new Set((input.capabilities ?? [])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim().slice(0, 100)))]
    .slice(0, 30);
  const status = { projectId, bridgeId, lastSeenAt, capabilities };
  await env.SUPERVISOR_STATE.put(projectBridgeKey(projectId), JSON.stringify(status), { expirationTtl: BRIDGE_TTL });
  return bridgeStatus(status);
}

export async function getChatBridgeStatus(env: ChatBridgeEnv, projectId: string): Promise<ChatBridgeStatus> {
  const normalized = sanitizeId(projectId);
  if (!normalized) return { connected: false, capabilities: [] };
  const raw = await env.SUPERVISOR_STATE.get(projectBridgeKey(normalized));
  if (!raw) return { connected: false, projectId: normalized, capabilities: [] };
  try {
    const value = JSON.parse(raw) as { projectId?: string; bridgeId?: string; lastSeenAt?: string; capabilities?: string[] };
    return bridgeStatus(value);
  } catch {
    return { connected: false, projectId: normalized, capabilities: [] };
  }
}

function projectBridgeKey(projectId: string) {
  return `${BRIDGE_PREFIX}${projectId}:latest`;
}

function sanitizeId(value: string) {
  return value.trim().slice(0, 200).replace(/[^A-Za-z0-9._:-]/g, '_');
}

function bridgeStatus(value: { projectId?: string; bridgeId?: string; lastSeenAt?: string; capabilities?: string[] }): ChatBridgeStatus {
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
