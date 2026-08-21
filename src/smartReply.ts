import { DevProject, QuickAction, buildActionPrompt, quickActions } from './core';
import { SupervisorDecision, buildHandoffPacket, buildRecoveryPrompt, evaluateProject } from './supervisor';

export interface SmartReplySuggestion {
  id: string;
  label: string;
  reason: string;
  confidence: number;
  prompt: string;
}

export interface SmartReplyContext {
  lastAssistantMessage?: string;
  ciPassing?: boolean;
  workerFailed?: boolean;
  workerIncomplete?: boolean;
  contextPressure?: 'LOW' | 'MEDIUM' | 'HIGH';
  retryCount?: number;
}

function findAction(id: string): QuickAction {
  return quickActions.find((item) => item.id === id) ?? quickActions[0];
}

function suggestionFromAction(project: DevProject, actionId: string, reason: string, confidence: number): SmartReplySuggestion {
  const action = findAction(actionId);
  return {
    id: action.id,
    label: action.label,
    reason,
    confidence,
    prompt: buildActionPrompt(project, action),
  };
}

function normalized(value?: string) {
  return value?.toLowerCase().replace(/\s+/g, ' ') ?? '';
}

function addUnique(target: SmartReplySuggestion[], item: SmartReplySuggestion) {
  if (!target.some((existing) => existing.prompt === item.prompt || existing.id === item.id)) target.push(item);
}

export function suggestReplies(project: DevProject, context: SmartReplyContext = {}): SmartReplySuggestion[] {
  const message = normalized(context.lastAssistantMessage);
  const decision = evaluateProject(project, {
    ciPassing: context.ciPassing,
    workerFailed: context.workerFailed,
    workerIncomplete: context.workerIncomplete,
    contextPressure: context.contextPressure,
    retryCount: context.retryCount,
  });
  const suggestions: SmartReplySuggestion[] = [];

  if (decision.action === 'CREATE_HANDOFF') {
    addUnique(suggestions, {
      id: 'handoff',
      label: '🔄 新しいチャットへ引き継ぐ',
      reason: decision.reason,
      confidence: 0.98,
      prompt: buildHandoffPacket(project),
    });
  }

  if (decision.action === 'NUDGE_CHAT' || decision.action === 'RETRY' || decision.action === 'TRY_ALTERNATIVE') {
    addUnique(suggestions, {
      id: 'recovery',
      label: decision.action === 'TRY_ALTERNATIVE' ? '別手法で復旧して続ける' : '⏯ 停止地点から再開',
      reason: decision.reason,
      confidence: 0.96,
      prompt: buildRecoveryPrompt(project, decision),
    });
  }

  if (decision.action === 'ASK_HUMAN') {
    addUnique(suggestions, suggestionFromAction(project, 'status', '本人の操作が必要なので、まず必要事項を明確にするのが安全です。', 0.96));
  }

  if (/続け|進め|次に|よければ|しますか|可能です/.test(message)) {
    addUnique(suggestions, suggestionFromAction(project, 'continue', 'GPTが継続確認をしているため、そのまま進める返答が最短です。', 0.94));
  }

  if (/テスト|test|ci|デバッグ|debug|不具合|エラー/.test(message)) {
    addUnique(suggestions, suggestionFromAction(project, 'inspect-first', 'テスト・不具合の話題があるため、問題確認込みで進める指示が適しています。', 0.9));
  }

  if (/readme|ドキュメント|documentation|docs|レビュー|review|pr|pull request|マージ/.test(message)) {
    addUnique(suggestions, suggestionFromAction(project, 'manual-only', '仕上げ工程の話題なので、自動作業をまとめて完了させる指示が効率的です。', 0.88));
  }

  if (/上限|limit|context|長く|新しいチャット|引き継/.test(message)) {
    addUnique(suggestions, {
      id: 'handoff-message',
      label: '🔄 引き継ぎ文を作って移行',
      reason: '会話上限・長文化の兆候があります。',
      confidence: 0.93,
      prompt: buildHandoffPacket(project),
    });
  }

  if (/手動|本人|api key|secret|ログイン|認証|課金|apple|developer dashboard/.test(message)) {
    addUnique(suggestions, suggestionFromAction(project, 'status', '本人作業の可能性があるため、必要な手動項目だけ整理します。', 0.9));
  }

  addUnique(suggestions, suggestionFromAction(project, 'continue', '通常の開発継続に使う標準アクションです。', 0.78));
  addUnique(suggestions, suggestionFromAction(project, 'manual-only', 'AIだけで可能な残作業をまとめて進めたい場合の強めの指示です。', 0.75));
  addUnique(suggestions, suggestionFromAction(project, 'status', '作業状況を一度整理したい場合の安全な選択です。', 0.7));

  return suggestions.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}

export function explainDecision(decision: SupervisorDecision) {
  return `${decision.derivedStatus}: ${decision.reason}`;
}
