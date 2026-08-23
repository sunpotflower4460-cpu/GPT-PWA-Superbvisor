export interface ChatBridgeStatus {
  connected: boolean;
  bridgeId?: string;
  lastSeenAt?: string;
  capabilities: string[];
}

export interface ChatBridgeEnv {
  SUPERVISOR_STATE: KVNamespace;
}

const BRIDGE_KEY = 'chat-bridge:active';
const BRIDGE_TTL = 60 * 10;
const CONNECTED_WINDOW_MS = 90_000;

export async function recordChatBridgeHeartbeat(env: ChatBridgeEnv, input: { bridgeId: string; capabilities?: string[] }) {
  const bridgeId = input.bridgeId.trim().slice(0, 200);
  if (!bridgeId) throw new Error('bridgeId is required');
  const lastSeenAt = new Date().toISOString();
  const capabilities = [...new Set((input.capabilities ?? [])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim().slice(0, 100)))]
    .slice(0, 30);
  const status = { bridgeId, lastSeenAt, capabilities };
  await env.SUPERVISOR_STATE.put(BRIDGE_KEY, JSON.stringify(status), { expirationTtl: BRIDGE_TTL });
  return bridgeStatus(status);
}

export async function getChatBridgeStatus(env: ChatBridgeEnv): Promise<ChatBridgeStatus> {
  const raw = await env.SUPERVISOR_STATE.get(BRIDGE_KEY);
  if (!raw) return { connected: false, capabilities: [] };
  try {
    const value = JSON.parse(raw) as { bridgeId?: string; lastSeenAt?: string; capabilities?: string[] };
    return bridgeStatus(value);
  } catch {
    return { connected: false, capabilities: [] };
  }
}

function bridgeStatus(value: { bridgeId?: string; lastSeenAt?: string; capabilities?: string[] }): ChatBridgeStatus {
  const lastSeen = value.lastSeenAt ? new Date(value.lastSeenAt).getTime() : 0;
  const connected = Boolean(lastSeen) && Date.now() - lastSeen <= CONNECTED_WINDOW_MS;
  return {
    connected,
    bridgeId: value.bridgeId,
    lastSeenAt: value.lastSeenAt,
    capabilities: Array.isArray(value.capabilities) ? value.capabilities : [],
  };
}
