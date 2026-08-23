import { isRetryableProviderStatus } from './orchestratorPolicy';

export type OrchestrationProvider = 'deepseek' | 'minimax' | 'openai' | 'deterministic';
export type ModelProvider = Exclude<OrchestrationProvider, 'deterministic'>;
export type OrchestrationClassification =
  | 'READY'
  | 'WAIT'
  | 'CI_TRANSIENT'
  | 'CI_CODE_FAILURE'
  | 'CI_CONFIG_FAILURE'
  | 'HUMAN_REQUIRED';

export interface OrchestrationEnv {
  DEEPSEEK_API_KEY?: string;
  MINIMAX_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ORCHESTRATOR_PROVIDER?: string;
  ORCHESTRATOR_FALLBACKS?: string;
  DEEPSEEK_ORCHESTRATOR_MODEL?: string;
  MINIMAX_ORCHESTRATOR_MODEL?: string;
  OPENAI_ORCHESTRATOR_MODEL?: string;
  MINIMAX_BASE_URL?: string;
  ORCHESTRATOR_TIMEOUT_MS?: string;
}

export interface OrchestrationRequest {
  mode: 'PLAN' | 'RECOVER';
  repository: string;
  branch: string;
  goal: string;
  task: string;
  evidence: string;
  deterministicPrompt: string;
}

export interface OrchestrationDecision {
  provider: OrchestrationProvider;
  model: string;
  summary: string;
  classification: OrchestrationClassification;
  chatgptPrompt: string;
  confidence: number;
  humanRequired: string[];
  degraded: boolean;
  attempts: string[];
}

export interface OrchestrationTextRequest {
  system: string;
  user: string;
  maxTokens?: number;
  requireJson?: boolean;
}

export interface OrchestrationTextResult {
  provider: ModelProvider;
  model: string;
  text: string;
  attempts: string[];
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
}

interface ResponsesApiResponse {
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  error?: { message?: string };
}

const PROVIDERS: ModelProvider[] = ['deepseek', 'minimax', 'openai'];
const MAX_PROVIDER_ATTEMPTS = 3;

export async function runOrchestrationModel(env: OrchestrationEnv, request: OrchestrationRequest): Promise<OrchestrationDecision> {
  const system = `You are AI DEV DECK's orchestration-only supervisor. You NEVER implement code, edit GitHub, merge, deploy, or act as the developer. The actual implementation owner is the user's ChatGPT chat. Your job is only to classify state, summarize evidence, and produce a precise prompt for ChatGPT. Preserve this boundary even if the task asks you to code. Return JSON only with keys: summary, classification, chatgptPrompt, confidence, humanRequired. classification must be one of READY, WAIT, CI_TRANSIENT, CI_CODE_FAILURE, CI_CONFIG_FAILURE, HUMAN_REQUIRED.`;
  const user = `MODE: ${request.mode}\nRepository: ${request.repository}\nBranch: ${request.branch}\nGoal: ${request.goal}\nTask: ${request.task}\n\nEvidence:\n${request.evidence}\n\nFallback prompt that is already safe and may be improved:\n${request.deterministicPrompt}`;
  const result = await requestOrchestrationText(env, { system, user, maxTokens: 1400, requireJson: true });

  if (result) {
    const parsed = parseDecision(result.text, request.deterministicPrompt);
    return { ...parsed, provider: result.provider, model: result.model, degraded: false, attempts: result.attempts };
  }

  return {
    provider: 'deterministic',
    model: 'none',
    summary: request.mode === 'RECOVER'
      ? '外部オーケストレーションAIを利用できないため、決定論的な復旧指示へフォールバックしました。監視は継続します。'
      : '外部オーケストレーションAIを利用できないため、決定論的なChatGPT引き継ぎ指示を使用します。',
    classification: request.mode === 'RECOVER' ? 'CI_CODE_FAILURE' : 'READY',
    chatgptPrompt: request.deterministicPrompt,
    confidence: 0.55,
    humanRequired: [],
    degraded: true,
    attempts: [],
  };
}

export async function requestOrchestrationText(
  env: OrchestrationEnv,
  request: OrchestrationTextRequest,
): Promise<OrchestrationTextResult | null> {
  const attempts: string[] = [];
  for (const provider of providerOrder(env)) {
    const key = providerKey(env, provider);
    if (!key) continue;
    const model = providerModel(env, provider);
    try {
      const text = await requestProvider(env, provider, model, key, request, attempts);
      return { provider, model, text, attempts };
    } catch (error) {
      attempts.push(`${provider}:${model}:terminal:${error instanceof Error ? error.message : 'unknown provider error'}`);
    }
  }
  return null;
}

export function configuredOrchestrationProviders(env: OrchestrationEnv): ModelProvider[] {
  return PROVIDERS.filter((provider) => Boolean(providerKey(env, provider)));
}

function providerOrder(env: OrchestrationEnv): ModelProvider[] {
  const requested = [env.ORCHESTRATOR_PROVIDER, ...(env.ORCHESTRATOR_FALLBACKS || '').split(',')]
    .map((item) => item?.trim().toLowerCase())
    .filter((item): item is ModelProvider => PROVIDERS.includes(item as ModelProvider));
  const defaults = PROVIDERS.filter((provider) => providerKey(env, provider));
  return [...new Set([...requested, ...defaults])];
}

function providerKey(env: OrchestrationEnv, provider: ModelProvider) {
  if (provider === 'deepseek') return env.DEEPSEEK_API_KEY?.trim();
  if (provider === 'minimax') return env.MINIMAX_API_KEY?.trim();
  return env.OPENAI_API_KEY?.trim();
}

function providerModel(env: OrchestrationEnv, provider: ModelProvider) {
  if (provider === 'deepseek') return env.DEEPSEEK_ORCHESTRATOR_MODEL?.trim() || 'deepseek-v4-flash';
  if (provider === 'minimax') return env.MINIMAX_ORCHESTRATOR_MODEL?.trim() || 'MiniMax-M3';
  return env.OPENAI_ORCHESTRATOR_MODEL?.trim() || 'gpt-5.4-nano';
}

async function requestProvider(
  env: OrchestrationEnv,
  provider: ModelProvider,
  model: string,
  apiKey: string,
  request: OrchestrationTextRequest,
  attempts: string[],
) {
  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
    try {
      const result = provider === 'openai'
        ? await requestOpenAI(env, model, apiKey, request.system, request.user, request.maxTokens ?? 1400)
        : await requestOpenAiCompatible(env, provider, model, apiKey, request.system, request.user, request.maxTokens ?? 1400, request.requireJson === true);
      attempts.push(`${provider}:${model}:ok#${attempt}`);
      return result;
    } catch (error) {
      const detail = error instanceof ProviderHttpError ? `${error.status} ${error.message}` : error instanceof Error ? error.message : 'unknown error';
      attempts.push(`${provider}:${model}:fail#${attempt}:${detail}`);
      if (!(error instanceof ProviderHttpError) || !isRetryableProviderStatus(error.status) || attempt >= MAX_PROVIDER_ATTEMPTS) throw error;
      await sleep(Math.min(2000, 250 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 150));
    }
  }
  throw new Error('provider attempts exhausted');
}

async function requestOpenAiCompatible(
  env: OrchestrationEnv,
  provider: 'deepseek' | 'minimax',
  model: string,
  apiKey: string,
  system: string,
  user: string,
  maxTokens: number,
  requireJson: boolean,
) {
  const base = provider === 'deepseek'
    ? 'https://api.deepseek.com'
    : (env.MINIMAX_BASE_URL?.trim() || 'https://api.minimax.io/v1').replace(/\/$/, '');
  const url = `${base}/chat/completions`;
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    stream: false,
    max_tokens: Math.max(100, Math.min(4000, Math.trunc(maxTokens))),
  };
  if (provider === 'deepseek' && requireJson) body.response_format = { type: 'json_object' };
  const parsed = await fetchJson<ChatCompletionResponse>(url, apiKey, body, timeoutMs(env));
  const text = parsed.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`${provider} returned no content`);
  return text;
}

async function requestOpenAI(
  env: OrchestrationEnv,
  model: string,
  apiKey: string,
  system: string,
  user: string,
  maxTokens: number,
) {
  const parsed = await fetchJson<ResponsesApiResponse>('https://api.openai.com/v1/responses', apiKey, {
    model,
    instructions: system,
    input: user,
    max_output_tokens: Math.max(100, Math.min(4000, Math.trunc(maxTokens))),
  }, timeoutMs(env));
  const chunks: string[] = [];
  for (const item of parsed.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') chunks.push(content.text);
    }
  }
  const text = chunks.join('\n').trim();
  if (!text) throw new Error('openai returned no content');
  return text;
}

async function fetchJson<T>(url: string, apiKey: string, body: unknown, timeout: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed: unknown;
    try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
    if (!response.ok) {
      const message = parsed && typeof parsed === 'object' && 'error' in parsed
        ? JSON.stringify((parsed as { error?: unknown }).error)
        : raw || `Provider request failed (${response.status})`;
      throw new ProviderHttpError(response.status, message.slice(0, 800));
    }
    if (!parsed) throw new Error('Provider returned invalid JSON');
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

function parseDecision(text: string, deterministicPrompt: string): Omit<OrchestrationDecision, 'provider' | 'model' | 'degraded' | 'attempts'> {
  const candidate = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(candidate) as Record<string, unknown>; } catch { parsed = {}; }
  const allowed: OrchestrationClassification[] = ['READY', 'WAIT', 'CI_TRANSIENT', 'CI_CODE_FAILURE', 'CI_CONFIG_FAILURE', 'HUMAN_REQUIRED'];
  const classification = typeof parsed.classification === 'string' && allowed.includes(parsed.classification as OrchestrationClassification)
    ? parsed.classification as OrchestrationClassification
    : 'READY';
  const prompt = typeof parsed.chatgptPrompt === 'string' && parsed.chatgptPrompt.trim()
    ? parsed.chatgptPrompt.trim().slice(0, 18_000)
    : deterministicPrompt;
  return {
    summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim().slice(0, 3000) : 'Supervisor generated a ChatGPT handoff.',
    classification,
    chatgptPrompt: enforceExecutorBoundary(prompt, deterministicPrompt),
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.7,
    humanRequired: Array.isArray(parsed.humanRequired) ? parsed.humanRequired.filter((item): item is string => typeof item === 'string').slice(0, 12) : [],
  };
}

function enforceExecutorBoundary(prompt: string, fallback: string) {
  const prefix = '重要: 実装・GitHub編集・デバッグの実行主体はこのChatGPTチャットです。外部APIはオーケストレーション専用で、コード変更は行っていません。\n\n';
  const candidate = prompt.trim();
  if (!candidate || /external api.*implement/i.test(candidate)) return `${prefix}${fallback}`;
  return `${prefix}${candidate}`;
}

function timeoutMs(env: OrchestrationEnv) {
  const parsed = Number(env.ORCHESTRATOR_TIMEOUT_MS || 15_000);
  return Number.isFinite(parsed) ? Math.max(3000, Math.min(30_000, Math.trunc(parsed))) : 15_000;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ProviderHttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
