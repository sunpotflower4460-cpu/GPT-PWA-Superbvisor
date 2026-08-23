import { ChatBridgeEnv, ChatBridgeStatus, getChatBridgeStatus } from './chatBridge';
import { ChatCommand, ChatCommandEnv, listProjectChatCommands } from './chatCommandQueue';

export type ChatProjectActivity =
  | 'DELIVERING'
  | 'RETRY_SCHEDULED'
  | 'QUEUED'
  | 'WAITING_BRIDGE'
  | 'NEEDS_ATTENTION'
  | 'DELIVERED'
  | 'CONNECTED_IDLE'
  | 'BRIDGE_OFFLINE';

export interface ChatProjectOverview {
  projectId: string;
  activity: ChatProjectActivity;
  bridgeConnected: boolean;
  bridgeId?: string;
  bridgeLastSeenAt?: string;
  pendingRecentCount: number;
  failedRecentCount: number;
  latestCommandStatus?: ChatCommand['status'];
  latestCommandAt?: string;
  activeCommandId?: string;
  nextAttemptAt?: string;
  approximate: boolean;
  error?: string;
}

interface ChatControlOverviewEnv extends ChatCommandEnv, ChatBridgeEnv {}

const OVERVIEW_COMMAND_LIMIT = 40;
const RECENT_DELIVERY_MS = 90_000;

export async function getChatControlOverview(env: ChatControlOverviewEnv, projectIds: string[]) {
  return Promise.all(projectIds.map(async (projectId): Promise<ChatProjectOverview> => {
    try {
      const [commands, bridge] = await Promise.all([
        listProjectChatCommands(env, projectId, OVERVIEW_COMMAND_LIMIT),
        getChatBridgeStatus(env, projectId),
      ]);
      return deriveChatProjectOverview(projectId, commands, bridge, Date.now(), commands.length >= OVERVIEW_COMMAND_LIMIT);
    } catch (error) {
      return {
        projectId,
        activity: 'BRIDGE_OFFLINE',
        bridgeConnected: false,
        pendingRecentCount: 0,
        failedRecentCount: 0,
        approximate: true,
        error: error instanceof Error ? error.message : 'chat_overview_failed',
      };
    }
  }));
}

export function deriveChatProjectOverview(
  projectId: string,
  commands: ChatCommand[],
  bridge: ChatBridgeStatus,
  nowMs = Date.now(),
  approximate = false,
): ChatProjectOverview {
  const newestFirst = [...commands].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = newestFirst[0];
  const unresolved = newestFirst.find((command) => command.status === 'claimed' || command.status === 'queued' || command.status === 'failed');
  const pendingRecentCount = commands.filter((command) => command.status === 'queued' || command.status === 'claimed').length;
  const failedRecentCount = commands.filter((command) => command.status === 'failed').length;

  let activity: ChatProjectActivity;
  if (unresolved?.status === 'claimed') {
    activity = 'DELIVERING';
  } else if (unresolved?.status === 'failed') {
    activity = 'NEEDS_ATTENTION';
  } else if (unresolved?.status === 'queued') {
    const retryAt = unresolved.nextAttemptAt ? new Date(unresolved.nextAttemptAt).getTime() : 0;
    const retryScheduled = Boolean(unresolved.deliveryFailures)
      && Number.isFinite(retryAt)
      && retryAt > nowMs;
    activity = retryScheduled ? 'RETRY_SCHEDULED' : bridge.connected ? 'QUEUED' : 'WAITING_BRIDGE';
  } else {
    const latestAt = latest?.updatedAt || latest?.deliveredAt || latest?.createdAt;
    const latestMs = latestAt ? new Date(latestAt).getTime() : 0;
    const recentlyDelivered = latest?.status === 'delivered'
      && Number.isFinite(latestMs)
      && nowMs - latestMs <= RECENT_DELIVERY_MS;
    activity = recentlyDelivered ? 'DELIVERED' : bridge.connected ? 'CONNECTED_IDLE' : 'BRIDGE_OFFLINE';
  }

  return {
    projectId,
    activity,
    bridgeConnected: bridge.connected,
    bridgeId: bridge.bridgeId,
    bridgeLastSeenAt: bridge.lastSeenAt,
    pendingRecentCount,
    failedRecentCount,
    latestCommandStatus: latest?.status,
    latestCommandAt: latest?.updatedAt || latest?.createdAt,
    activeCommandId: unresolved?.id,
    nextAttemptAt: unresolved?.nextAttemptAt,
    approximate,
  };
}
