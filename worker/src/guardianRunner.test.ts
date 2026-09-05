import { describe, expect, it, vi } from 'vitest';
import { sendSupervisorPush } from './push';
import { getChatBridgeStatus } from './chatBridge';
import { checkBridgeStaleness, clearBridgeStallTracking, type GuardianEnv, type GuardianRun } from './guardianRunner';

vi.mock('./push', () => ({ sendSupervisorPush: vi.fn().mockResolvedValue({ sent: 0, failed: 0, disabled: true }) }));
vi.mock('./chatBridge', () => ({ getChatBridgeStatus: vi.fn() }));

function fakeEnv(): GuardianEnv {
  return { SUPERVISOR_STATE: {} } as unknown as GuardianEnv;
}

function baseRun(overrides: Partial<GuardianRun> = {}): GuardianRun {
  return {
    id: 'run-1',
    projectId: 'project-1',
    repository: 'octocat/example',
    goal: 'Ship the thing',
    prompt: 'Implement the thing',
    status: 'running',
    cycle: 1,
    maxCycles: 3,
    maxToolTurns: 10,
    maxMinutes: 180,
    currentDeveloperJobId: 'job-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const LONG_AGO = '2020-01-01T00:00:00.000Z'; // guaranteed to exceed BRIDGE_STALL_THRESHOLD_MS

describe('checkBridgeStaleness', () => {
  it('clears tracking fields and sends no push when the bridge is connected', async () => {
    vi.mocked(sendSupervisorPush).mockClear();
    vi.mocked(getChatBridgeStatus).mockResolvedValue({ connected: true, capabilities: [] });

    const run = baseRun({ bridgeDisconnectedSinceAt: LONG_AGO, bridgeStallNotifiedAt: LONG_AGO });
    const result = await checkBridgeStaleness(fakeEnv(), run);

    expect(result.bridgeDisconnectedSinceAt).toBeUndefined();
    expect(result.bridgeStallNotifiedAt).toBeUndefined();
    expect(sendSupervisorPush).not.toHaveBeenCalled();
  });

  it('is a no-op when already clear and connected', async () => {
    vi.mocked(sendSupervisorPush).mockClear();
    vi.mocked(getChatBridgeStatus).mockResolvedValue({ connected: true, capabilities: [] });

    const run = baseRun();
    const result = await checkBridgeStaleness(fakeEnv(), run);

    expect(result).toBe(run);
    expect(sendSupervisorPush).not.toHaveBeenCalled();
  });

  it('records the first observation of a disconnected bridge without pushing yet', async () => {
    vi.mocked(sendSupervisorPush).mockClear();
    vi.mocked(getChatBridgeStatus).mockResolvedValue({ connected: false, capabilities: [] });

    const run = baseRun();
    const result = await checkBridgeStaleness(fakeEnv(), run);

    expect(result.bridgeDisconnectedSinceAt).toBeTruthy();
    expect(result.bridgeStallNotifiedAt).toBeUndefined();
    expect(sendSupervisorPush).not.toHaveBeenCalled();
  });

  it('does not push while under the stall threshold', async () => {
    vi.mocked(sendSupervisorPush).mockClear();
    vi.mocked(getChatBridgeStatus).mockResolvedValue({ connected: false, capabilities: [] });

    const run = baseRun({ bridgeDisconnectedSinceAt: new Date().toISOString() });
    const result = await checkBridgeStaleness(fakeEnv(), run);

    expect(result.bridgeStallNotifiedAt).toBeUndefined();
    expect(sendSupervisorPush).not.toHaveBeenCalled();
  });

  it('pushes exactly once, and records bridgeStallNotifiedAt, once the disconnect exceeds the threshold', async () => {
    vi.mocked(sendSupervisorPush).mockClear();
    vi.mocked(getChatBridgeStatus).mockResolvedValue({ connected: false, capabilities: [] });

    const run = baseRun({ bridgeDisconnectedSinceAt: LONG_AGO, projectName: 'Example Project' });
    const result = await checkBridgeStaleness(fakeEnv(), run);

    expect(result.bridgeStallNotifiedAt).toBeTruthy();
    expect(sendSupervisorPush).toHaveBeenCalledTimes(1);
    const [, payload] = vi.mocked(sendSupervisorPush).mock.calls[0];
    expect(payload.kind).toBe('human');
    expect(payload.tag).toBe(`guardian-bridge-stall-${run.id}`);
  });

  it('does not push a second time for an ongoing stall already notified', async () => {
    vi.mocked(sendSupervisorPush).mockClear();
    vi.mocked(getChatBridgeStatus).mockResolvedValue({ connected: false, capabilities: [] });

    const run = baseRun({ bridgeDisconnectedSinceAt: LONG_AGO, bridgeStallNotifiedAt: LONG_AGO });
    const result = await checkBridgeStaleness(fakeEnv(), run);

    expect(result.bridgeStallNotifiedAt).toBe(LONG_AGO);
    expect(sendSupervisorPush).not.toHaveBeenCalled();
  });

  it('starts a fresh clock (no stale bridgeDisconnectedSinceAt reused) once reconnected then disconnected again', async () => {
    vi.mocked(sendSupervisorPush).mockClear();

    vi.mocked(getChatBridgeStatus).mockResolvedValueOnce({ connected: true, capabilities: [] });
    const reconnected = await checkBridgeStaleness(fakeEnv(), baseRun({ bridgeDisconnectedSinceAt: LONG_AGO, bridgeStallNotifiedAt: LONG_AGO }));
    expect(reconnected.bridgeDisconnectedSinceAt).toBeUndefined();
    expect(reconnected.bridgeStallNotifiedAt).toBeUndefined();

    vi.mocked(getChatBridgeStatus).mockResolvedValueOnce({ connected: false, capabilities: [] });
    const disconnectedAgain = await checkBridgeStaleness(fakeEnv(), reconnected);
    expect(disconnectedAgain.bridgeDisconnectedSinceAt).not.toBe(LONG_AGO);
    expect(disconnectedAgain.bridgeStallNotifiedAt).toBeUndefined();
    expect(sendSupervisorPush).not.toHaveBeenCalled();
  });

  it('skips entirely for a run with no projectId — nothing to check', async () => {
    vi.mocked(sendSupervisorPush).mockClear();
    vi.mocked(getChatBridgeStatus).mockClear();

    const run = baseRun({ projectId: undefined });
    const result = await checkBridgeStaleness(fakeEnv(), run);

    expect(result).toBe(run);
    expect(getChatBridgeStatus).not.toHaveBeenCalled();
    expect(sendSupervisorPush).not.toHaveBeenCalled();
  });

  it('never corrupts Guardian state when the bridge-status lookup itself fails', async () => {
    vi.mocked(sendSupervisorPush).mockClear();
    vi.mocked(getChatBridgeStatus).mockRejectedValue(new Error('KV unavailable'));

    const run = baseRun({ bridgeDisconnectedSinceAt: LONG_AGO });
    const result = await checkBridgeStaleness(fakeEnv(), run);

    expect(result).toBe(run);
    expect(sendSupervisorPush).not.toHaveBeenCalled();
  });
});

describe('clearBridgeStallTracking', () => {
  it('clears both fields when set', () => {
    const run = baseRun({ bridgeDisconnectedSinceAt: LONG_AGO, bridgeStallNotifiedAt: LONG_AGO });
    const result = clearBridgeStallTracking(run);
    expect(result.bridgeDisconnectedSinceAt).toBeUndefined();
    expect(result.bridgeStallNotifiedAt).toBeUndefined();
  });

  it('returns the same reference when already clear (no spurious KV write upstream)', () => {
    const run = baseRun();
    expect(clearBridgeStallTracking(run)).toBe(run);
  });
});
