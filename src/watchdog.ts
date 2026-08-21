import { DevProject } from './core';
import { SupervisorEvidence, buildRecoveryPrompt, evaluateProject } from './supervisor';

export type WatchdogAction = 'NONE' | 'NUDGE' | 'RETRY' | 'ALTERNATIVE' | 'HANDOFF' | 'HUMAN';

export interface WatchdogState {
  projectId: string;
  retryCount: number;
  alternativeCount: number;
  lastObservedAt: string;
  lastActionAt?: string;
  lastAction?: WatchdogAction;
  lastNotifiedAt?: string;
  lastNotificationKey?: string;
}

export interface WatchdogFinding {
  needsAttention: boolean;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'HUMAN';
  title: string;
  detail: string;
  recommendedAction: WatchdogAction;
  prompt?: string;
  nextState: WatchdogState;
}

const STORAGE_KEY = 'gpt-pwa-supervisor.watchdog.v1';

export function loadWatchdogStates(): Record<string, WatchdogState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export function saveWatchdogStates(states: Record<string, WatchdogState>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(states));
}

export function defaultWatchdogState(projectId: string): WatchdogState {
  return {
    projectId,
    retryCount: 0,
    alternativeCount: 0,
    lastObservedAt: new Date().toISOString(),
  };
}

export function inspectProject(
  project: DevProject,
  previous: WatchdogState = defaultWatchdogState(project.id),
  evidence: SupervisorEvidence = {},
): WatchdogFinding {
  const decision = evaluateProject(project, {
    ...evidence,
    retryCount: evidence.retryCount ?? previous.retryCount + previous.alternativeCount,
  });
  const now = new Date().toISOString();
  const nextState: WatchdogState = { ...previous, lastObservedAt: now };

  if (decision.action === 'ASK_HUMAN') {
    return {
      needsAttention: true,
      severity: 'HUMAN',
      title: 'あなたの操作が必要',
      detail: decision.reason,
      recommendedAction: 'HUMAN',
      nextState,
    };
  }

  if (decision.action === 'CREATE_HANDOFF') {
    return {
      needsAttention: true,
      severity: 'WARNING',
      title: 'チャット引き継ぎ推奨',
      detail: decision.reason,
      recommendedAction: 'HANDOFF',
      nextState,
    };
  }

  if (decision.action === 'NUDGE_CHAT') {
    return {
      needsAttention: true,
      severity: 'WARNING',
      title: 'Chatが止まっている可能性',
      detail: decision.reason,
      recommendedAction: 'NUDGE',
      prompt: buildRecoveryPrompt(project, decision),
      nextState,
    };
  }

  if (decision.action === 'RETRY') {
    return {
      needsAttention: true,
      severity: 'WARNING',
      title: '再試行が必要',
      detail: decision.reason,
      recommendedAction: 'RETRY',
      prompt: buildRecoveryPrompt(project, decision),
      nextState,
    };
  }

  if (decision.action === 'TRY_ALTERNATIVE') {
    return {
      needsAttention: true,
      severity: 'ERROR',
      title: '別アプローチへ切替',
      detail: decision.reason,
      recommendedAction: 'ALTERNATIVE',
      prompt: buildRecoveryPrompt(project, decision),
      nextState,
    };
  }

  if (project.status === 'ERROR') {
    return {
      needsAttention: true,
      severity: 'ERROR',
      title: 'エラーを検出',
      detail: 'Supervisorの復旧判断が必要です。',
      recommendedAction: 'RETRY',
      prompt: buildRecoveryPrompt(project, decision),
      nextState,
    };
  }

  return {
    needsAttention: false,
    severity: 'INFO',
    title: '正常',
    detail: decision.reason,
    recommendedAction: 'NONE',
    nextState,
  };
}

export function recordWatchdogAction(previous: WatchdogState, action: WatchdogAction): WatchdogState {
  const now = new Date().toISOString();
  return {
    ...previous,
    retryCount: action === 'RETRY' ? previous.retryCount + 1 : previous.retryCount,
    alternativeCount: action === 'ALTERNATIVE' ? previous.alternativeCount + 1 : previous.alternativeCount,
    lastAction: action,
    lastActionAt: now,
  };
}

export function notificationKey(finding: WatchdogFinding) {
  return `${finding.severity}:${finding.recommendedAction}:${finding.title}`;
}

export function shouldNotify(finding: WatchdogFinding, previous?: WatchdogState) {
  if (!finding.needsAttention) return false;
  if (!previous?.lastNotifiedAt) return true;
  const elapsed = Date.now() - new Date(previous.lastNotifiedAt).getTime();
  return elapsed > 15 * 60_000 || previous.lastNotificationKey !== notificationKey(finding);
}

export function recordNotification(previous: WatchdogState, finding: WatchdogFinding): WatchdogState {
  return {
    ...previous,
    lastNotifiedAt: new Date().toISOString(),
    lastNotificationKey: notificationKey(finding),
  };
}
