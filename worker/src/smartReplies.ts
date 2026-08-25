import { OrchestrationEnv, requestOrchestrationText } from './orchestrationModel';

export interface SmartReplyEnv extends OrchestrationEnv {
  SMART_REPLY_MODEL?: string;
}

export interface SmartReplyRequest {
  project: {
    id: string;
    name: string;
    goal: string;
    currentPhase: string;
    status: string;
    automationLevel: string;
    definitionOfDone: string[];
    humanBlockers?: string[];
  };
  lastAssistantMessage?: string;
}

export interface SmartReplyItem {
  label: string;
  reason: string;
  prompt: string;
  confidence: number;
}

export async function generateSmartReplies(
  body: SmartReplyRequest,
  env: SmartReplyEnv,
): Promise<{ ok: true; model: string; suggestions: SmartReplyItem[] } | { ok: false; status: number; error: string }> {
  if (!body?.project?.id || !body.project.goal) {
    return { ok: false, status: 400, error: 'project.id and project.goal are required' };
  }

  const result = await requestOrchestrationText(env, {
    system: `あなたはAI DEV DECKのオーケストレーション専用「次の返答予測AI」です。実装・コード編集・外部操作は行いません。実作業の実行主体はChatGPTチャットです。ユーザーが次にChatGPTへ送る候補を3〜5個作ってください。JSONだけを返し、形式は {"suggestions":[{"label":"短いボタン名","reason":"理由1文","prompt":"ChatGPTへそのまま送れる完成指示","confidence":0.0}]}。候補は重複させず、エラー時は原因確認→修正/別手段→再テストを含む候補を優先してください。`,
    user: buildPrompt(body),
    maxTokens: 1400,
    requireJson: true,
  });

  if (result) {
    const suggestions = parseSuggestionJson(result.text);
    if (suggestions.length) {
      return { ok: true, model: `${result.provider}/${result.model}`, suggestions: suggestions.slice(0, 5) };
    }
  }

  // Smart Reply is a convenience feature. Provider outage must not block the supervisor UI.
  return { ok: true, model: 'deterministic', suggestions: deterministicSuggestions(body) };
}

function buildPrompt(body: SmartReplyRequest) {
  const project = body.project;
  return `PROJECT: ${project.name}\nGOAL: ${project.goal}\nCURRENT: ${project.currentPhase}\nSTATUS: ${project.status}\nAUTOMATION: ${project.automationLevel}\nDEFINITION OF DONE:\n${project.definitionOfDone.map((item) => `- ${item}`).join('\n') || '- 未指定'}\nHUMAN BLOCKERS:\n${project.humanBlockers?.map((item) => `- ${item}`).join('\n') || '- なし'}\n\nCHATGPTの最後の返答:\n${body.lastAssistantMessage?.trim() || '未入力。プロジェクト状態だけから判断する。'}\n\n目的:\n- 次にユーザーがChatGPTへ返すと自然で開発が前進する候補を3〜5個作る。\n- 1位は最も推奨するもの。\n- 「OKお願いします」程度の意図でも、実際に送るpromptは現在地点とGoalを踏まえた強い指示に展開する。\n- ChatGPTだけで安全にできるテスト、デバッグ、レビュー、ドキュメント等は単なる継続確認で止まらない指示を好む。\n- 外部APIへ実装を委譲する指示は作らない。APIは監督・状態整理のみ。\n- 課金、秘密情報、本人確認、不可逆操作、大きな仕様変更などは勝手に承認しない。\n- エラーがあるなら同じ失敗を繰り返さず、原因確認→修正/別手法→再テストを含める。`;
}

function parseSuggestionJson(text: string): SmartReplyItem[] {
  const candidate = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(candidate) as { suggestions?: unknown };
    if (!Array.isArray(parsed.suggestions)) return [];
    return parsed.suggestions
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        label: typeof item.label === 'string' ? item.label.slice(0, 80) : '',
        reason: typeof item.reason === 'string' ? item.reason.slice(0, 300) : '',
        prompt: executorSafePrompt(typeof item.prompt === 'string' ? item.prompt.slice(0, 8000) : ''),
        confidence: typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : 0.7,
      }))
      .filter((item) => item.label && item.prompt);
  } catch {
    return [];
  }
}

function deterministicSuggestions(body: SmartReplyRequest): SmartReplyItem[] {
  const p = body.project;
  const prefix = `この作業の実行主体はこのChatGPTです。外部APIはオーケストレーション専用として扱ってください。\n\n最終目標: ${p.goal}\n現在地点: ${p.currentPhase}\n`;
  return [
    {
      label: '問題点も確認して続行',
      reason: 'Provider障害時でも安全に前進できる標準候補です。',
      prompt: `${prefix}\n現在の未完了・不具合・リスクを実際に確認し、安全に実行できる修正・テスト・デバッグを進めてください。失敗したら原因を切り分け、別手段または修正後に再検証してください。`,
      confidence: 0.72,
    },
    {
      label: '手動作業だけまで',
      reason: 'AIでできる残作業をまとめて進めます。',
      prompt: `${prefix}\nコード・テスト・デバッグ・レビュー・ドキュメントなど、このChatGPTだけで安全に可能な作業を連続して進め、本人しかできない手動作業だけの状態まで近づけてください。`,
      confidence: 0.68,
    },
    {
      label: '現在地を再確認',
      reason: '状態が不明な時の安全な再同期候補です。',
      prompt: `${prefix}\n現在の実際の状態、完了済み、残課題、失敗中の処理、次に実行すべき1〜3手を証拠ベースで確認してください。外部APIの自己申告だけで完成扱いしないでください。`,
      confidence: 0.62,
    },
  ];
}

function executorSafePrompt(prompt: string) {
  const prefix = '重要: 実作業の実行主体はこのChatGPTです。外部APIはオーケストレーション専用です。\n\n';
  return `${prefix}${prompt.trim()}`;
}
