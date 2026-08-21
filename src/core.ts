import { buildOperatingPlanPrompt } from './operatingPlan';

export type ProjectStatus =
  | 'RUNNING'
  | 'WAITING_AI'
  | 'WAITING_USER'
  | 'STALLED'
  | 'ERROR'
  | 'RATE_LIMITED'
  | 'CONTEXT_LIMIT'
  | 'COMPLETED';

export type ExecutionMode = 'CHAT' | 'WORK' | 'API_WORKER';
export type AutomationLevel = 'OFF' | 'ASSIST' | 'AUTO' | 'GUARDIAN';
export type MilestoneState = 'TODO' | 'ACTIVE' | 'DONE' | 'BLOCKED';

export interface Milestone {
  id: string;
  title: string;
  state: MilestoneState;
}

export interface TimelineEvent {
  id: string;
  at: string;
  kind: 'info' | 'success' | 'warning' | 'error' | 'human';
  message: string;
}

export interface DevProject {
  id: string;
  name: string;
  goal: string;
  definitionOfDone: string[];
  githubUrl?: string;
  chatUrl?: string;
  workUrl?: string;
  status: ProjectStatus;
  executionMode: ExecutionMode;
  automationLevel: AutomationLevel;
  progress: number;
  currentPhase: string;
  lastActivityAt: string;
  humanBlockers: string[];
  milestones: Milestone[];
  timeline: TimelineEvent[];
}

export interface QuickAction {
  id: string;
  label: string;
  intent: string;
}

const STORAGE_KEY = 'gpt-pwa-supervisor.projects.v1';

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

export const quickActions: QuickAction[] = [
  {
    id: 'continue',
    label: '▶ そのまま進める',
    intent: '現在の方針を維持し、AIだけで可能な次工程を連続して進める',
  },
  {
    id: 'inspect-first',
    label: '問題点も確認して進める',
    intent: '先に未完了・不具合・リスクを確認し、必要な修正をしてから次工程へ進む',
  },
  {
    id: 'manual-only',
    label: '手動作業だけになるまで',
    intent: 'コード・テスト・デバッグ・レビュー・ドキュメントなどAIだけで可能な作業を完了し、本人しかできない手動作業だけの状態まで進める',
  },
  {
    id: 'resume',
    label: '⏯ 中断から再開',
    intent: '前回作業が途中停止した可能性を考慮し、完了済みを確認して重複を避け、未完了地点から再開する',
  },
  {
    id: 'status',
    label: '状況を詳しく確認',
    intent: '現在地点、完了済み、残課題、ブロッカー、次の推奨工程を簡潔に整理する',
  },
];

export function createProject(input: Pick<DevProject, 'name' | 'goal'> & Partial<DevProject>): DevProject {
  return {
    id: uid(),
    name: input.name,
    goal: input.goal,
    definitionOfDone: input.definitionOfDone ?? [
      '主要機能が実装済み',
      '既知の重大エラーがない',
      'テスト・検証が完了',
      '残りが本人しかできない手動作業のみ、または完成',
    ],
    githubUrl: input.githubUrl,
    chatUrl: input.chatUrl,
    workUrl: input.workUrl,
    status: input.status ?? 'WAITING_AI',
    executionMode: input.executionMode ?? 'CHAT',
    automationLevel: input.automationLevel ?? 'ASSIST',
    progress: input.progress ?? 0,
    currentPhase: input.currentPhase ?? '開始待ち',
    lastActivityAt: input.lastActivityAt ?? now(),
    humanBlockers: input.humanBlockers ?? [],
    milestones: input.milestones ?? [
      { id: uid(), title: '現状確認', state: 'ACTIVE' },
      { id: uid(), title: '実装・修正', state: 'TODO' },
      { id: uid(), title: 'テスト・デバッグ', state: 'TODO' },
      { id: uid(), title: '最終レビュー', state: 'TODO' },
      { id: uid(), title: '手動作業抽出 / 完成判定', state: 'TODO' },
    ],
    timeline: input.timeline ?? [
      { id: uid(), at: now(), kind: 'info', message: 'プロジェクトを登録' },
    ],
  };
}

export function loadProjects(): DevProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveProjects(projects: DevProject[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

export function isLikelyStalled(project: DevProject, thresholdMinutes = 20) {
  if (!['RUNNING', 'WAITING_AI'].includes(project.status)) return false;
  const elapsed = Date.now() - new Date(project.lastActivityAt).getTime();
  return elapsed > thresholdMinutes * 60_000;
}

export function buildActionPrompt(project: DevProject, action: QuickAction) {
  const done = project.definitionOfDone.map((item) => `- ${item}`).join('\n');
  const blockers = project.humanBlockers.length
    ? project.humanBlockers.map((item) => `- ${item}`).join('\n')
    : '- 現時点で登録なし';
  const operatingPlan = buildOperatingPlanPrompt(project.id);

  return `以下の開発プロジェクトを継続してください。\n\n【最終目標】\n${project.goal}\n\n【現在地点】\n${project.currentPhase}\n\n${operatingPlan}\n\n【今回の意図】\n${action.intent}\n\n【完成条件】\n${done}\n\n【既知の本人待ち】\n${blockers}\n\n共通ガードレール:\n1. AIだけで安全に実行できる作業は、Operating Planの到達地点まで可能な範囲で連続して進める。\n2. 課金、秘密情報、本人確認、不可逆な外部操作、大きな仕様判断など本人が必要な地点では止める。\n3. Workへの切替、API Background、GitHub Guardianなどコストや権限が増える実行モードへは、アプリ上の明示操作なしに勝手に昇格しない。\n4. 完成・成功は、実際に確認できたテスト、CI、差分などの根拠に基づいて判定する。\n\nOperating Planと今回の意図が衝突する場合は、安全制約を優先しつつ今回の明示指示を優先してください。`;
}

export function statusLabel(status: ProjectStatus) {
  const labels: Record<ProjectStatus, string> = {
    RUNNING: '稼働中',
    WAITING_AI: 'AI待ち',
    WAITING_USER: 'あなた待ち',
    STALLED: '停止疑い',
    ERROR: 'エラー',
    RATE_LIMITED: '上限待ち',
    CONTEXT_LIMIT: '引き継ぎ推奨',
    COMPLETED: '完了',
  };
  return labels[status];
}
