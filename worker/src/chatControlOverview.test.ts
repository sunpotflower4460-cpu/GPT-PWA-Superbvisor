import { describe, expect, it } from 'vitest';
import { deriveChatProjectOverview } from './chatControlOverview';
import type { ChatBridgeStatus } from './chatBridge';
import type { ChatCommand } from './chatCommandQueue';

const now = Date.parse('2026-08-23T11:00:00.000Z');
const bridgeOn: ChatBridgeStatus = {
  connected: true,
  projectId: 'project-1',
  bridgeId: 'bridge-1',
  lastSeenAt: '2026-08-23T10:59:30.000Z',
  capabilities: [],
};
const bridgeOff: ChatBridgeStatus = {
  connected: false,
  projectId: 'project-1',
  capabilities: [],
};

function command(overrides: Partial<ChatCommand>): ChatCommand {
  return {
    id: overrides.id || 'command-1',
    projectId: 'project-1',
    chatUrl: 'https://chatgpt.com/c/example',
    prompt: 'continue',
    status: overrides.status || 'queued',
    createdAt: overrides.createdAt || '2026-08-23T10:58:00.000Z',
    updatedAt: overrides.updatedAt || '2026-08-23T10:58:00.000Z',
    ...overrides,
  };
}

describe('multi-chat overview activity', () => {
  it('shows an actively claimed command as delivering', () => {
    const overview = deriveChatProjectOverview('project-1', [command({ status: 'claimed' })], bridgeOn, now);
    expect(overview.activity).toBe('DELIVERING');
    expect(overview.pendingRecentCount).toBe(1);
  });

  it('shows a queued retry with a future attempt time as retry scheduled', () => {
    const overview = deriveChatProjectOverview('project-1', [command({
      status: 'queued',
      deliveryFailures: 1,
      nextAttemptAt: '2026-08-23T11:00:30.000Z',
    })], bridgeOn, now);
    expect(overview.activity).toBe('RETRY_SCHEDULED');
  });

  it('distinguishes queued work waiting for an offline bridge', () => {
    const overview = deriveChatProjectOverview('project-1', [command({ status: 'queued' })], bridgeOff, now);
    expect(overview.activity).toBe('WAITING_BRIDGE');
  });

  it('surfaces the newest unresolved failed command as needing attention', () => {
    const overview = deriveChatProjectOverview('project-1', [
      command({ id: 'old-failed', status: 'failed', createdAt: '2026-08-23T10:55:00.000Z' }),
      command({ id: 'new-failed', status: 'failed', createdAt: '2026-08-23T10:59:00.000Z' }),
    ], bridgeOn, now);
    expect(overview.activity).toBe('NEEDS_ATTENTION');
    expect(overview.activeCommandId).toBe('new-failed');
    expect(overview.failedRecentCount).toBe(2);
  });

  it('shows a recent successful delivery before falling back to connected idle', () => {
    const recent = deriveChatProjectOverview('project-1', [command({
      status: 'delivered',
      updatedAt: '2026-08-23T10:59:30.000Z',
    })], bridgeOn, now);
    const old = deriveChatProjectOverview('project-1', [command({
      status: 'delivered',
      updatedAt: '2026-08-23T10:50:00.000Z',
    })], bridgeOn, now);
    expect(recent.activity).toBe('DELIVERED');
    expect(old.activity).toBe('CONNECTED_IDLE');
  });
});
