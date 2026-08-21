export type OperatingPlanTarget = 'IMPLEMENTED' | 'CI_GREEN' | 'REVIEW_READY' | 'MANUAL_ONLY' | 'CUSTOM';

export interface OperatingPlan {
  target: OperatingPlanTarget;
  customTarget: string;
  workflow: string;
  continueWithoutConfirmation: boolean;
  inspectBeforeWork: boolean;
  validateAndTest: boolean;
  recoverFromFailure: boolean;
  selfReview: boolean;
  finalReport: boolean;
  customInstructions: string;
  updatedAt: string;
}

const STORAGE_KEY = 'gpt-pwa-supervisor.operating-plans.v1';

export const targetLabels: Record<OperatingPlanTarget, string> = {
  IMPLEMENTED: '実装まで',
  CI_GREEN: 'CI成功まで',
  REVIEW_READY: 'レビューできる状態まで',
  MANUAL_ONLY: '本人しかできない作業だけになるまで',
  CUSTOM: 'カスタム到達地点',
};

export function defaultOperatingPlan(): OperatingPlan {
  return {
    target: 'MANUAL_ONLY',
    customTarget: '',
    workflow: '現状確認 → 未完了の特定 → 実装・修正 → テスト/デバッグ → 自己レビュー → 残作業と本人作業の切り分け',
    continueWithoutConfirmation: true,
    inspectBeforeWork: true,
    validateAndTest: true,
    recoverFromFailure: true,
    selfReview: true,
    finalReport: true,
    customInstructions: '',
    updatedAt: new Date(0).toISOString(),
  };
}

export function loadOperatingPlans(): Record<string, OperatingPlan> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, OperatingPlan>;
  } catch {
    return {};
  }
}

export function getOperatingPlan(projectId: string): OperatingPlan {
  const saved = loadOperatingPlans()[projectId];
  return normalizeOperatingPlan(saved);
}

export function saveOperatingPlan(projectId: string, plan: OperatingPlan) {
  const plans = loadOperatingPlans();
  plans[projectId] = normalizeOperatingPlan({ ...plan, updatedAt: new Date().toISOString() });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(plans));
}

export function buildOperatingPlanPrompt(projectId: string) {
  return formatOperatingPlanPrompt(getOperatingPlan(projectId));
}

export function formatOperatingPlanPrompt(input: OperatingPlan) {
  const plan = normalizeOperatingPlan(input);
  const target = plan.target === 'CUSTOM'
    ? plan.customTarget.trim() || targetLabels.CUSTOM
    : targetLabels[plan.target];
  const behavior = [
    plan.inspectBeforeWork && '最初に現状・成果物・既完了作業を確認し、重複作業を避ける。',
    plan.continueWithoutConfirmation && 'AIだけで安全に進められる途中工程では、毎回の確認待ちで止まらず連続して進める。',
    plan.validateAndTest && '実装後は可能なテスト・型チェック・ビルド・検証を実施し、根拠のない完成扱いをしない。',
    plan.recoverFromFailure && '失敗時は原因を特定し、同じ操作を漫然と繰り返さず修正または別アプローチで再試行する。',
    plan.selfReview && '停止前に差分・副作用・未完了・安全性を自己レビューする。',
    plan.finalReport && '最後に実施内容、到達地点、残作業、本人が必要なことを短く整理する。',
  ].filter(Boolean).map((item) => `- ${item}`).join('\n');

  const custom = plan.customInstructions.trim()
    ? `\n【案件固有ルール】\n${plan.customInstructions.trim()}\n`
    : '';

  return `【保存済み Operating Plan】\n到達地点: ${target}\n標準手順: ${plan.workflow.trim() || defaultOperatingPlan().workflow}\n\n実行ルール:\n${behavior || '- 保存済みの追加ルールなし'}\n\n停止してよいのは、課金・秘密情報・本人確認・不可逆な本番操作・大きな仕様判断など、本当に本人が必要な地点です。${custom}`;
}

function normalizeOperatingPlan(input?: Partial<OperatingPlan> | null): OperatingPlan {
  const fallback = defaultOperatingPlan();
  const target = input?.target && input.target in targetLabels ? input.target : fallback.target;
  return {
    target,
    customTarget: typeof input?.customTarget === 'string' ? input.customTarget : fallback.customTarget,
    workflow: typeof input?.workflow === 'string' ? input.workflow : fallback.workflow,
    continueWithoutConfirmation: typeof input?.continueWithoutConfirmation === 'boolean' ? input.continueWithoutConfirmation : fallback.continueWithoutConfirmation,
    inspectBeforeWork: typeof input?.inspectBeforeWork === 'boolean' ? input.inspectBeforeWork : fallback.inspectBeforeWork,
    validateAndTest: typeof input?.validateAndTest === 'boolean' ? input.validateAndTest : fallback.validateAndTest,
    recoverFromFailure: typeof input?.recoverFromFailure === 'boolean' ? input.recoverFromFailure : fallback.recoverFromFailure,
    selfReview: typeof input?.selfReview === 'boolean' ? input.selfReview : fallback.selfReview,
    finalReport: typeof input?.finalReport === 'boolean' ? input.finalReport : fallback.finalReport,
    customInstructions: typeof input?.customInstructions === 'string' ? input.customInstructions : fallback.customInstructions,
    updatedAt: typeof input?.updatedAt === 'string' ? input.updatedAt : fallback.updatedAt,
  };
}
