export type OperatingPlanTarget = 'IMPLEMENTED' | 'CI_GREEN' | 'REVIEW_READY' | 'MANUAL_ONLY' | 'CUSTOM';

// The declared Route plan (Goal/Route/Task separation) — an ordered list
// of named phases, sent to the Worker alongside a DeveloperJob/GuardianRun
// (see worker/src/routePlan.ts). Parsed from the same arrow-separated
// `workflow` text a user already writes for `standard手順`
// (defaultOperatingPlan's own default: "現状確認 → 未完了の特定 → …") — this
// is NOT an attempt to understand arbitrary free-text instructions (that
// would be exactly the kind of unreliable guess the design warns against);
// it only extracts the phases the user already wrote using a delimiter
// convention this UI already establishes and displays. A workflow with no
// arrow at all produces a single-node plan (the whole text, verbatim) —
// never a fabricated multi-step breakdown.
export interface RouteNode {
  id: string;
  label: string;
}

const ROUTE_SEPARATOR = /\s*(?:→|➡|->)\s*/;

export function parseRoutePlan(workflow: string): RouteNode[] {
  const segments = workflow
    .split(ROUTE_SEPARATOR)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.map((label, index) => ({ id: `node-${index + 1}`, label: label.slice(0, 200) }));
}

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

export function isAutopilotRouteWorkflow(workflow: string) {
  const value = workflow.trim();
  if (!value) return false;
  const hasRepeatedPass = /(?:\d+|[一二三四五六七八九十]+)\s*回/.test(value);
  const hasConditionalBranch = /(問題|不具合|失敗|エラー|大丈夫|問題なければ|問題がなければ).{0,20}(あれば|あったら|なら|場合|なければ|なかったら)/.test(value)
    || /(あれば|あったら|なければ|なかったら).{0,20}(追加|さらに|もう|次|進)/.test(value);
  const hasExplicitSequencing = /(そのあと|その後|次に|続いて|終わったら|完了したら)/.test(value);
  return hasRepeatedPass || (hasConditionalBranch && hasExplicitSequencing);
}

// The workflow text actually used to build a task/route from a plan — a
// blank saved workflow (never explicitly set, or cleared to whitespace)
// falls back to the standard default, same as formatOperatingPlanPrompt
// below. Anything that derives a routePlan (see parseRoutePlan) from a
// saved plan MUST go through this instead of reading plan.workflow raw:
// otherwise the actual dispatched task follows the default workflow while
// the declared route reports nothing, since a blank string still passes
// normalizeOperatingPlan's `typeof === 'string'` check and is never
// replaced by the default there.
export function effectiveWorkflow(plan: OperatingPlan): string {
  return plan.workflow.trim() || defaultOperatingPlan().workflow;
}

export function formatOperatingPlanPrompt(input: OperatingPlan) {
  const plan = normalizeOperatingPlan(input);
  const target = plan.target === 'CUSTOM'
    ? plan.customTarget.trim() || targetLabels.CUSTOM
    : targetLabels[plan.target];
  const workflow = effectiveWorkflow(plan);
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

  const routeContract = isAutopilotRouteWorkflow(workflow)
    ? `\n【AUTOPILOT ROUTE CONTRACT】\nこの標準手順には、順序・反復回数・条件分岐を含む自動運転ルートが指定されています。単なる参考メモではなく実行契約として扱ってください。\n- 書かれた順番を守り、前の工程が完了する前に後工程へ飛ばない。\n- 「3回デバッグ」「3回補強」のような回数指定は、同じ結果を数え直すのではなく、独立した確認/改善パスとして指定回数実行する。\n- 「問題があったら追加で数回」のような条件分岐は、実際の結果を確認してから発火させる。「数回」のように上限が曖昧な場合は、原則2〜3回の追加パスを上限にし、新しい実質的な問題が出なくなれば先へ進む。\n- 各パスで、発見事項 → 実施した修正/改善 → 再検証結果を区別して扱う。同じ確認を名前だけ変えて重複カウントしない。\n- CI成功はルート途中のチェックポイントになり得ます。CIが一度緑になっただけで、後続の機能追加・補強・UI/UX工程を省略して完成扱いしない。\n- 中断・復旧時は、完了済み工程を最初からやり直さず、最初の未完了工程/未完了パスから再開する。\n- ルートの全工程と条件分岐を消化し、到達地点の条件も満たした時だけ最終完了とする。\n- 作業報告では、現在のルート工程と「何回目/何回中」を可能な範囲で明示し、Supervisorが途中地点を判定しやすくする。\n`
    : '';

  return `【保存済み Operating Plan】\n到達地点: ${target}\n標準手順: ${workflow}\n\n実行ルール:\n${behavior || '- 保存済みの追加ルールなし'}\n${routeContract}\n停止してよいのは、課金・秘密情報・本人確認・不可逆な本番操作・大きな仕様判断など、本当に本人が必要な地点です。${custom}`;
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
