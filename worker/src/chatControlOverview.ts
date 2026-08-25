import { ChatBridgeEnv, ChatBridgeStatus, getChatBridgeStatus } from './chatBridge';
import {
  ChatCommandEnv,
  ChatCommandOverviewSnapshot,
  ChatCommandStatus,
  getProjectChatCommandOverview,
} from './chatCommandQueue';

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

interface ChatControlOverviewEnv extends ChatCommandEnv, ChatBridgeEnv {}

const RECENT_DELIVERY_MS = 90_000;

export async function getChatControlOverview(env: ChatControlOverviewEnv, projectIds: string[]) {
  return Promise.all(projectIds.map(async (projectId): Promise<ChatProjectOverview> => {
    try {
      const [commandOverview, bridge] = await Promise.all([
        getProjectChatCommandOverview(env, projectId),
        getChatBridgeStatus(env, projectId),
      ]);
      return deriveChatProjectOverview(projectId, commandOverview, bridge, Date.now());
    } catch (error) {
      return {
        projectId,
        activity: 'OVERVIEW_ERROR',
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
  commandOverview: ChatCommandOverviewSnapshot,
  bridge: ChatBridgeStatus,
  nowMs = Date.now(),
): ChatProjectOverview {
  const { latest, unresolved } = commandOverview;

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
    pendingRecentCount: commandOverview.pendingCount,
    failedRecentCount: commandOverview.failedCount,
    latestCommandStatus: latest?.status,
    latestCommandAt: latest?.updatedAt || latest?.createdAt,
    activeCommandId: unresolved?.id,
    nextAttemptAt: unresolved?.nextAttemptAt,
    approximate: commandOverview.approximate,
  };
}
