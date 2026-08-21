import { DevProject } from './core';
import { SupervisorEvidence, buildRecoveryPrompt, evaluateProject } from './supervisor';

export interface WatchdogState {
  projectId: string;
  retryCount: number;
  alternativeCount: number;
  lastObservedAt: string;
  lastActionAt?: string;
  lastAction?: string;
}

export interface WatchdogFinding {
  needsAttention: boolean;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'HUMAN';
  title: string;
  detail: string;
  recommendedAction: 'NONE' | 'NUDGE' | 'RETRY' | 'ALTERNATIVE' | 'HANDOFF' | 'HUMAN';
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
  const baseState: WatchdogState = { ...previous, lastObservedAt: now };

  if (decision.action === 'ASK_HUMAN') {
    return {
      needsAttention: true,
      severity: 'HUMAN',
      title: 'あなたの操作が必要',
      detail: decision.reason,
      recommendedAction: 'HUMAN',
      nextState: { ...baseState, lastAction: 'HUMAN', lastActionAt: now },
    };
  }

  if (decision.action === 'CREATE_HANDOFF') {
    return {
      needsAttention: true,
      severity: 'WARNING',
      title: 'チャット引き継ぎ推奨',
      detail: decision.reason,
      recommendedAction: 'HANDOFF',
      nextState: { ...baseState, lastAction: 'HANDOFF', lastActionAt: now },
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
      nextState: { ...baseState, lastAction: 'NUDGE', lastActionAt: now },
    };
  }

  if (decision.action === 'RETRY') {
    const nextState = {
      ...baseState,
      retryCount: previous.retryCount + 1,
      lastAction: 'RETRY',
      lastActionAt: now,
    };
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
    const nextState = {
      ...baseState,
      alternativeCount: previous.alternativeCount + 1,
      lastAction: 'ALTERNATIVE',
      lastActionAt: now,
    };
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
      nextState: baseState,
    };
  }

  return {
    needsAttention: false,
    severity: 'INFO',
    title: '正常',
    detail: decision.reason,
    recommendedAction: 'NONE',
    nextState: baseState,
  };
}

export function shouldNotify(finding: WatchdogFinding, previous?: WatchdogState) {
  if (!finding.needsAttention) return false;
  if (!previous?.lastActionAt) return true;
  const elapsed = Date.now() - new Date(previous.lastActionAt).getTime();
  return elapsed > 15 * 60_000 || previous.lastAction !== finding.recommendedAction;
}
