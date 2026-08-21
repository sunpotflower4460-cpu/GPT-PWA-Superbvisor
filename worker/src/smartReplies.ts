export interface SmartReplyEnv {
  OPENAI_API_KEY: string;
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

interface OpenAIResponse {
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  error?: { message?: string } | null;
}

export async function generateSmartReplies(
  body: SmartReplyRequest,
  env: SmartReplyEnv,
): Promise<{ ok: true; model: string; suggestions: SmartReplyItem[] } | { ok: false; status: number; error: string }> {
  if (!body?.project?.id || !body.project.goal) {
    return { ok: false, status: 400, error: 'project.id and project.goal are required' };
  }

  const model = env.SMART_REPLY_MODEL?.trim() || 'gpt-5.4-nano';
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: buildPrompt(body),
      max_output_tokens: 1400,
    }),
  });

  const raw = await response.text();
  let parsedResponse: OpenAIResponse | undefined;
  try {
    parsedResponse = raw ? JSON.parse(raw) as OpenAIResponse : undefined;
  } catch {
    parsedResponse = undefined;
  }

  if (!response.ok || !parsedResponse) {
    return {
      ok: false,
      status: response.status || 502,
      error: parsedResponse?.error?.message || raw || 'Smart Reply model request failed',
    };
  }

  const text = extractOutputText(parsedResponse);
  const parsed = parseSuggestionJson(text);
  if (!parsed.length) {
    return { ok: false, status: 502, error: 'Model returned no usable Smart Reply suggestions' };
  }

  return { ok: true, model, suggestions: parsed.slice(0, 5) };
}

function buildPrompt(body: SmartReplyRequest) {
  const project = body.project;
  return `あなたはスマホ用AI開発管制塔の「次の返答予測AI」です。\nユーザーは普段ChatGPTの通常Chatで開発を進め、毎回長文を打たず候補をタップしたいです。\n\nPROJECT: ${project.name}\nGOAL: ${project.goal}\nCURRENT: ${project.currentPhase}\nSTATUS: ${project.status}\nAUTOMATION: ${project.automationLevel}\nDEFINITION OF DONE:\n${project.definitionOfDone.map((item) => `- ${item}`).join('\n') || '- 未指定'}\nHUMAN BLOCKERS:\n${project.humanBlockers?.map((item) => `- ${item}`).join('\n') || '- なし'}\n\nCHATGPTの最後の返答:\n${body.lastAssistantMessage?.trim() || '未入力。プロジェクト状態だけから判断する。'}\n\n目的:\n- 次にユーザーがChatGPTへ返すと自然で開発が前進する候補を3〜5個作る。\n- 1位は最も推奨するもの。\n- 「OKお願いします」程度の意図でも、実際に送るpromptは現在地点とGoalを踏まえた強い指示に展開する。\n- AIだけで安全にできるテスト、デバッグ、レビュー、ドキュメント等は単なる継続確認で止まらない指示を好む。\n- 課金、秘密情報、本人確認、不可逆操作、大きな仕様変更などは勝手に承認しない。\n- エラーがあるなら同じ失敗を繰り返さず、原因確認→修正/別手法→再テストを含める。\n- 上限/長文化の兆候があれば引き継ぎを候補に入れる。\n\nJSONだけを返してください。Markdownコードフェンス不要。\n形式:\n{"suggestions":[{"label":"短いボタン名","reason":"なぜ推奨か1文","prompt":"ChatGPTへそのまま送れる完成した指示","confidence":0.0}]}\nconfidenceは0〜1。候補は重複させない。`;
}

function extractOutputText(response: OpenAIResponse) {
  const chunks: string[] = [];
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') chunks.push(content.text);
    }
  }
  return chunks.join('\n').trim();
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
        prompt: typeof item.prompt === 'string' ? item.prompt.slice(0, 8000) : '',
        confidence: typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : 0.7,
      }))
      .filter((item) => item.label && item.prompt);
  } catch {
    return [];
  }
}
