import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const SERVER_VERSION = '0.1.0';
const TEMPLATE_URI = 'ui://ai-dev-deck/chat-bridge-v1.html';
const DEFAULT_POLL_MS = 6_000;
const SUPERVISOR_REQUEST_TIMEOUT_MS = 12_000;

export interface BridgeRuntimeConfig {
  supervisorWorkerUrl: string;
  supervisorClientToken: string;
  allowedProjectIds: string[];
}

type ChatCommandStatus = 'queued' | 'claimed' | 'delivered' | 'failed' | 'cancelled';

interface ChatCommand {
  id: string;
  projectId: string;
  projectName?: string;
  chatUrl: string;
  prompt: string;
  status: ChatCommandStatus;
  createdAt: string;
  updatedAt: string;
  bridgeId?: string;
  deliveryFailures?: number;
  maxDeliveryAttempts?: number;
  nextAttemptAt?: string;
}

export function createBridgeServer(configInput: BridgeRuntimeConfig) {
  const config = normalizeConfig(configInput);
  const server = new McpServer({
    name: 'ai-dev-deck-chatgpt-bridge',
    version: SERVER_VERSION,
  });

  const assertAllowedProject = (projectId: string) => {
    if (!config.allowedProjectIds.length) throw new Error('BRIDGE_ALLOWED_PROJECT_IDS is not configured; bridge fails closed');
    if (!config.allowedProjectIds.includes(projectId)) throw new Error(`Project is not allowed for this bridge: ${projectId}`);
  };

  const supervisorFetch = async <T>(path: string, init: RequestInit): Promise<T> => {
    if (!config.supervisorWorkerUrl || !config.supervisorClientToken) throw new Error('Supervisor Worker bridge connection is not configured');

    const controller = new AbortController();
    const upstreamSignal = init.signal;
    let timedOut = false;
    const forwardAbort = () => controller.abort();
    if (upstreamSignal?.aborted) controller.abort();
    else upstreamSignal?.addEventListener('abort', forwardAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, SUPERVISOR_REQUEST_TIMEOUT_MS);

    try {
      let response: Response;
      try {
        response = await fetch(`${config.supervisorWorkerUrl}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${config.supervisorClientToken}`,
            'Content-Type': 'application/json',
            ...(init.headers ?? {}),
          },
        });
      } catch (error) {
        if (timedOut) throw new Error('Supervisor Worker bridge request timed out after 12 seconds');
        throw error instanceof Error ? error : new Error('Supervisor Worker bridge request failed');
      }

      let payload: T & { error?: string; detail?: string };
      try {
        payload = await response.json() as T & { error?: string; detail?: string };
      } catch (error) {
        if (timedOut) throw new Error('Supervisor Worker bridge response body timed out after 12 seconds');
        throw error instanceof Error ? error : new Error('Supervisor Worker bridge returned invalid JSON');
      }
      if (!response.ok) throw new Error(payload.detail || payload.error || `Supervisor request failed (${response.status})`);
      return payload;
    } finally {
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener('abort', forwardAbort);
    }
  };

  registerAppTool(
    server,
    'connect_ai_dev_deck_bridge',
    {
      title: 'Connect AI DEV DECK Bridge',
      description:
        'Use this when the user wants this ChatGPT development conversation to be remotely controlled from AI DEV DECK. ' +
        'It attaches a small bridge widget to this conversation. The widget receives queued commands for one allowed project and sends them back into this same ChatGPT conversation as follow-up messages. ' +
        "If the user is dedicating this specific conversation to one declared Route phase of a Multi Chat / Specialist Chat project (as opposed to being the project's only/default chat), pass that phase's own chatUrl as `chatUrl` so only commands destined for THIS chat are claimed here.",
      inputSchema: {
        projectId: z.string().min(1).max(200).describe('AI DEV DECK project ID assigned to this ChatGPT conversation'),
        projectName: z.string().max(200).optional().describe('Human-readable project name shown in the bridge widget'),
        // Multi Chat / Specialist Chat: this conversation's OWN chatUrl, as
        // declared by the user for a specific Route phase — never inferred
        // (a ChatGPT tool call has no reliable way to introspect its own
        // hosting page's public URL). Optional and backward compatible: a
        // bridge connected without it claims from the project-wide pool
        // exactly as before, correct for the common single-chat-per-project
        // case.
        chatUrl: z.string().max(2000).optional().describe('This conversation\'s own ChatGPT URL, if the user is dedicating it to one declared Route phase of a multi-chat project'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: TEMPLATE_URI } },
    },
    async ({ projectId, projectName, chatUrl }) => {
      assertAllowedProject(projectId);
      return {
        content: [{
          type: 'text' as const,
          text: `AI DEV DECK Bridge is attached to project ${projectName || projectId}. The bridge only relays commands into this ChatGPT conversation; repository work remains the responsibility of this ChatGPT.`,
        }],
        structuredContent: {
          projectId,
          projectName: projectName || projectId,
          chatUrl: chatUrl || undefined,
          pollIntervalMs: DEFAULT_POLL_MS,
          bridgeMode: 'same-conversation-follow-up',
        },
      };
    },
  );

  registerAppTool(
    server,
    'ai_dev_deck_bridge_heartbeat',
    {
      title: 'AI DEV DECK Bridge Heartbeat',
      description: 'Internal app-only heartbeat for the AI DEV DECK ChatGPT bridge.',
      inputSchema: {
        projectId: z.string().min(1).max(200),
        bridgeId: z.string().min(1).max(200),
        // Multi Chat / Specialist Chat: reported so the Chat Control
        // overview can tell THIS chat's connection status apart from any
        // other chat connected to the same project — see
        // connect_ai_dev_deck_bridge's own comment.
        chatUrl: z.string().max(2000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async ({ projectId, bridgeId, chatUrl }) => {
      assertAllowedProject(projectId);
      const status = await supervisorFetch<Record<string, unknown>>('/api/chat-bridge/heartbeat', {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          bridgeId,
          chatUrl: chatUrl || undefined,
          capabilities: ['claim-command', 'send-follow-up-message', 'report-result', 'retry-command', 'delivery-receipt', `project:${projectId}`],
        }),
      });
      return toolJson({ ok: true, status });
    },
  );

  registerAppTool(
    server,
    'ai_dev_deck_bridge_claim',
    {
      title: 'Claim AI DEV DECK Chat Command',
      description: 'Internal app-only tool that claims the next queued command for this project.',
      inputSchema: {
        projectId: z.string().min(1).max(200),
        bridgeId: z.string().min(1).max(200),
        // Multi Chat / Specialist Chat: this bridge's own chatUrl, when the
        // widget was connected with one — see connect_ai_dev_deck_bridge's
        // own comment. Optional/backward compatible.
        chatUrl: z.string().max(2000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async ({ projectId, bridgeId, chatUrl }) => {
      assertAllowedProject(projectId);
      const result = await supervisorFetch<{ command: ChatCommand | null }>('/api/chat-commands/claim', {
        method: 'POST',
        body: JSON.stringify({ projectId, bridgeId, chatUrl: chatUrl || undefined }),
      });
      if (result.command && result.command.projectId !== projectId) {
        throw new Error('Supervisor returned a command for a different project');
      }
      return toolJson({ command: result.command });
    },
  );

  registerAppTool(
    server,
    'ai_dev_deck_bridge_result',
    {
      title: 'Report AI DEV DECK Chat Command Result',
      description: 'Internal app-only tool that reports whether a claimed command was delivered into the ChatGPT conversation.',
      inputSchema: {
        projectId: z.string().min(1).max(200),
        bridgeId: z.string().min(1).max(200),
        commandId: z.string().min(1).max(200),
        status: z.enum(['delivered', 'failed', 'cancelled']),
        detail: z.string().max(2000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async ({ projectId, bridgeId, commandId, status, detail }) => {
      assertAllowedProject(projectId);
      const result = await supervisorFetch<{ command: ChatCommand }>(`/api/chat-commands/${encodeURIComponent(commandId)}/result`, {
        method: 'POST',
        body: JSON.stringify({ projectId, bridgeId, status, detail }),
      });
      if (result.command.projectId !== projectId) throw new Error('Supervisor returned a command for a different project');
      return toolJson({ command: result.command });
    },
  );

  registerAppTool(
    server,
    'ai_dev_deck_bridge_retry',
    {
      title: 'Retry AI DEV DECK Chat Command',
      description: 'Internal app-only tool that requeues a terminal failed command after automatic delivery retries were exhausted.',
      inputSchema: {
        projectId: z.string().min(1).max(200),
        commandId: z.string().min(1).max(200),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async ({ projectId, commandId }) => {
      assertAllowedProject(projectId);
      const result = await supervisorFetch<{ command: ChatCommand }>(`/api/chat-commands/${encodeURIComponent(commandId)}/retry`, {
        method: 'POST',
        body: JSON.stringify({ projectId }),
      });
      if (result.command.projectId !== projectId) throw new Error('Supervisor returned a command for a different project');
      return toolJson({ command: result.command });
    },
  );

  registerAppResource(
    server,
    'AI DEV DECK Chat Bridge',
    TEMPLATE_URI,
    {
      mimeType: RESOURCE_MIME_TYPE,
      description: 'AI DEV DECK same-conversation command bridge widget',
    },
    async () => ({
      contents: [{
        uri: TEMPLATE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: bridgeWidgetHtml(),
        _meta: {
          ui: {
            prefersBorder: true,
            csp: {
              connectDomains: [],
              resourceDomains: [],
            },
          },
          'openai/widgetDescription': 'Keeps this ChatGPT development conversation connected to the AI DEV DECK command queue.',
        },
      }],
    }),
  );

  return server;
}

export function normalizeBridgeConfig(input: {
  supervisorWorkerUrl?: string;
  supervisorClientToken?: string;
  allowedProjectIds?: string | string[];
}): BridgeRuntimeConfig {
  const allowedProjectIds = Array.isArray(input.allowedProjectIds)
    ? input.allowedProjectIds
    : (input.allowedProjectIds || '').split(',');
  return normalizeConfig({
    supervisorWorkerUrl: input.supervisorWorkerUrl || '',
    supervisorClientToken: input.supervisorClientToken || '',
    allowedProjectIds,
  });
}

function normalizeConfig(input: BridgeRuntimeConfig): BridgeRuntimeConfig {
  return {
    supervisorWorkerUrl: input.supervisorWorkerUrl.trim().replace(/\/$/, ''),
    supervisorClientToken: input.supervisorClientToken.trim(),
    allowedProjectIds: [...new Set(input.allowedProjectIds.map((value) => value.trim()).filter(Boolean))],
  };
}

function toolJson(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function bridgeWidgetHtml() {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 12px; background: transparent; color: inherit; }
    .card { border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 14px; padding: 12px; background: color-mix(in srgb, Canvas 94%, transparent); }
    .top { display:flex; justify-content:space-between; gap:10px; align-items:center; }
    .title { font-weight: 750; font-size: 13px; }
    .project { margin-top: 3px; opacity:.68; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .status { border-radius:999px; padding:5px 8px; font-size:10px; font-weight:750; background:color-mix(in srgb, currentColor 8%, transparent); white-space:nowrap; }
    .status.ok { color:#15803d; background:#dcfce7; }
    .status.work { color:#b45309; background:#fef3c7; }
    .status.error { color:#b91c1c; background:#fee2e2; }
    .meta { display:flex; gap:10px; flex-wrap:wrap; margin-top:10px; opacity:.68; font-size:10px; }
    .last { margin-top:9px; font-size:11px; line-height:1.45; opacity:.8; white-space:pre-wrap; max-height:54px; overflow:hidden; }
    button { margin-top:10px; border:0; border-radius:10px; padding:8px 10px; font:inherit; font-size:11px; font-weight:700; cursor:pointer; }
  </style>
</head>
<body>
  <section class="card">
    <div class="top">
      <div style="min-width:0"><div class="title">AI DEV DECK Bridge</div><div class="project" id="project">接続準備中</div></div>
      <span class="status" id="status">初期化中</span>
    </div>
    <div class="meta"><span id="bridge"></span><span id="heartbeat"></span></div>
    <div class="last" id="last">PWAからの指示を待機します。</div>
    <button id="retry" hidden>今すぐ再試行</button>
  </section>
<script>
(() => {
  const statusEl = document.getElementById('status');
  const projectEl = document.getElementById('project');
  const bridgeEl = document.getElementById('bridge');
  const heartbeatEl = document.getElementById('heartbeat');
  const lastEl = document.getElementById('last');
  const retryEl = document.getElementById('retry');
  let processing = false;
  let lastHeartbeat = 0;
  let cooldownUntil = 0;
  let timer = null;
  let lastFailedCommandId = '';
  let cachedBridgeProjectId = '';
  let cachedBridgeId = '';
  let cachedDeliveryReceipt = null;

  function input() {
    return window.openai?.toolInput || {};
  }

  function projectId() {
    const value = input().projectId;
    return typeof value === 'string' ? value : '';
  }

  function projectName() {
    const value = input().projectName;
    return typeof value === 'string' && value ? value : projectId();
  }

  function chatUrl() {
    const value = input().chatUrl;
    return typeof value === 'string' && value ? value : undefined;
  }

  function createBridgeId(pid) {
    const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
    return 'chatgpt:' + pid + ':' + suffix;
  }

  function bridgeId() {
    const pid = projectId() || 'unknown';
    if (cachedBridgeId && cachedBridgeProjectId === pid) return cachedBridgeId;

    cachedBridgeProjectId = pid;
    cachedBridgeId = '';
    const key = 'ai-dev-deck-bridge:' + pid;
    try {
      const existing = sessionStorage.getItem(key);
      if (existing) {
        cachedBridgeId = existing;
      } else {
        cachedBridgeId = createBridgeId(pid);
        sessionStorage.setItem(key, cachedBridgeId);
      }
    } catch {
      cachedBridgeId = createBridgeId(pid);
    }
    return cachedBridgeId;
  }

  function receiptKey() {
    // Scoped by bridgeId, not just projectId: bridgeId is cached in
    // sessionStorage (stable across reloads of THIS tab, distinct from any
    // other tab's), while the receipt itself is read/written through
    // localStorage AND sessionStorage — localStorage is shared across every
    // tab on the same origin. With Multi Chat / Specialist Chat, more than
    // one Bridge tab can now be open for the same project at once; without
    // this, one tab's saveReceipt/clearReceipt would silently clobber
    // another's, and stale-claim recovery could resend a prompt the OTHER
    // tab already delivered.
    return 'ai-dev-deck-delivery-receipt:' + (projectId() || 'unknown') + ':' + bridgeId();
  }

  function legacyReceiptKey() {
    return 'ai-dev-deck-delivery-receipt:' + (projectId() || 'unknown');
  }

  function readReceipt() {
    const pid = projectId() || 'unknown';
    if (cachedDeliveryReceipt) {
      if (!cachedDeliveryReceipt.projectId || cachedDeliveryReceipt.projectId === pid) return cachedDeliveryReceipt;
      cachedDeliveryReceipt = null;
    }
    for (const storage of [window.localStorage, window.sessionStorage]) {
      try {
        const raw = storage.getItem(receiptKey());
        if (raw) {
          const parsed = JSON.parse(raw);
          cachedDeliveryReceipt = { ...parsed, projectId: parsed.projectId || pid };
          return cachedDeliveryReceipt;
        }
      } catch {}
    }
    // Migration for a receipt saved by a widget version from before
    // receiptKey() was bridgeId-scoped: it sits under the old project-only
    // key. Without this, a delivery that succeeded but hadn't yet reported
    // its result at the exact moment this version rolled out would become
    // permanently invisible to THIS tab, so stale-claim recovery could
    // later resend a prompt that was already posted. Adopt it only if it's
    // actually this tab's own receipt (its own bridgeId field matches),
    // then move it to the new key so a different tab won't also adopt it.
    for (const storage of [window.localStorage, window.sessionStorage]) {
      try {
        const raw = storage.getItem(legacyReceiptKey());
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed.bridgeId !== bridgeId()) continue;
        cachedDeliveryReceipt = { ...parsed, projectId: parsed.projectId || pid };
        saveReceipt(cachedDeliveryReceipt);
        try { storage.removeItem(legacyReceiptKey()); } catch {}
        return cachedDeliveryReceipt;
      } catch {}
    }
    return null;
  }

  function saveReceipt(receipt) {
    cachedDeliveryReceipt = receipt;
    for (const storage of [window.localStorage, window.sessionStorage]) {
      try { storage.setItem(receiptKey(), JSON.stringify(receipt)); return; } catch {}
    }
  }

  function clearReceipt() {
    cachedDeliveryReceipt = null;
    for (const storage of [window.localStorage, window.sessionStorage]) {
      try { storage.removeItem(receiptKey()); } catch {}
    }
  }

  function setStatus(text, tone) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (tone ? ' ' + tone : '');
  }

  function structured(result) {
    if (!result) return {};
    if (typeof result === 'string') {
      try { return JSON.parse(result); } catch { return {}; }
    }
    if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
    return result;
  }

  async function callTool(name, args) {
    if (!window.openai?.callTool) throw new Error('ChatGPT callTool is unavailable');
    return window.openai.callTool(name, args);
  }

  async function heartbeat(force) {
    if (!projectId()) return;
    const now = Date.now();
    if (!force && now - lastHeartbeat < 25_000) return;
    await callTool('ai_dev_deck_bridge_heartbeat', { projectId: projectId(), bridgeId: bridgeId(), chatUrl: chatUrl() });
    lastHeartbeat = now;
    heartbeatEl.textContent = 'heartbeat ' + new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  }

  async function report(commandId, status, detail, ownerBridgeId) {
    const result = await callTool('ai_dev_deck_bridge_result', {
      projectId: projectId(),
      bridgeId: ownerBridgeId || bridgeId(),
      commandId,
      status,
      detail: detail || undefined,
    });
    return structured(result).command || null;
  }

  async function flushReceipt() {
    const receipt = readReceipt();
    if (!receipt || !receipt.commandId || !receipt.bridgeId) return true;
    try {
      await report(receipt.commandId, 'delivered', receipt.detail || 'Recovered persisted delivery receipt', receipt.bridgeId);
      clearReceipt();
      setStatus('送信済み', 'ok');
      return true;
    } catch (error) {
      setStatus('結果同期待ち', 'work');
      lastEl.textContent = 'ChatGPTへの送信は完了済みです。Workerへの送達確認だけを再同期しています。';
      console.warn('AI DEV DECK delivery receipt sync failed', error);
      return false;
    }
  }

  function deliveryPrompt(command) {
    return '[AI DEV DECK COMMAND ID: ' + command.id + ']\n' + command.prompt +
      '\n\n同じAI DEV DECK COMMAND IDの指示をこの会話ですでに実行済みなら、重複実行せず現在状態だけ確認してください。';
  }

  async function tick(force) {
    if (processing) return;
    const pid = projectId();
    if (!pid) {
      setStatus('project待ち', 'error');
      return;
    }
    if (!window.openai?.sendFollowUpMessage || !window.openai?.callTool) {
      setStatus('Host非対応', 'error');
      lastEl.textContent = 'このChatGPT hostでは必要なApps SDK APIが利用できません。';
      retryEl.hidden = false;
      return;
    }
    projectEl.textContent = projectName();
    bridgeEl.textContent = bridgeId();
    processing = true;
    try {
      await heartbeat(force);
      if (!await flushReceipt()) return;
      if (!force && Date.now() < cooldownUntil) {
        setStatus('応答待ち', 'work');
        return;
      }
      const claimedResult = await callTool('ai_dev_deck_bridge_claim', { projectId: pid, bridgeId: bridgeId(), chatUrl: chatUrl() });
      const data = structured(claimedResult);
      const command = data.command;
      if (!command || typeof command.prompt !== 'string' || !command.prompt.trim()) {
        setStatus('接続中', 'ok');
        lastEl.textContent = 'PWAからの指示を待機しています。';
        return;
      }

      lastFailedCommandId = '';
      retryEl.hidden = true;
      setStatus('送信中', 'work');
      lastEl.textContent = command.prompt;

      try {
        await window.openai.sendFollowUpMessage({ prompt: deliveryPrompt(command) });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        try {
          const updated = await report(command.id, 'failed', detail, bridgeId());
          if (updated && updated.status === 'queued') {
            setStatus('自動再試行待ち', 'work');
            lastEl.textContent = detail + '\nWorkerが安全なバックオフ後に再配送します。';
            cooldownUntil = Date.now() + 6_000;
          } else {
            lastFailedCommandId = command.id;
            setStatus('送信失敗', 'error');
            lastEl.textContent = detail;
            retryEl.hidden = false;
          }
        } catch (reportError) {
          setStatus('送信失敗', 'error');
          lastEl.textContent = detail + '\n結果報告にも失敗しました。stale claim回収後に再試行されます。';
          console.warn('AI DEV DECK failed-delivery report failed', reportError);
        }
        return;
      }

      const receipt = {
        projectId: pid,
        commandId: command.id,
        bridgeId: bridgeId(),
        detail: 'Sent through ChatGPT Apps SDK sendFollowUpMessage',
      };
      saveReceipt(receipt);
      try {
        await report(command.id, 'delivered', receipt.detail, receipt.bridgeId);
        clearReceipt();
        setStatus('送信済み', 'ok');
        cooldownUntil = Date.now() + 30_000;
      } catch (error) {
        setStatus('結果同期待ち', 'work');
        lastEl.textContent = 'ChatGPTへの送信は成功しました。送達確認だけを再同期します。';
        console.warn('AI DEV DECK delivered receipt report failed', error);
      }
    } catch (error) {
      setStatus('Bridge失敗', 'error');
      lastEl.textContent = error instanceof Error ? error.message : String(error);
      retryEl.hidden = false;
    } finally {
      processing = false;
    }
  }

  retryEl.addEventListener('click', async () => {
    retryEl.hidden = true;
    cooldownUntil = 0;
    if (lastFailedCommandId) {
      processing = true;
      try {
        await callTool('ai_dev_deck_bridge_retry', { projectId: projectId(), commandId: lastFailedCommandId });
        lastFailedCommandId = '';
      } catch (error) {
        setStatus('再試行失敗', 'error');
        lastEl.textContent = error instanceof Error ? error.message : String(error);
        retryEl.hidden = false;
        processing = false;
        return;
      }
      processing = false;
    }
    void tick(true);
  });

  function start() {
    projectEl.textContent = projectName() || 'project情報を待機中';
    void tick(true);
    timer = setInterval(() => void tick(false), ${DEFAULT_POLL_MS});
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void tick(false);
  });
  window.addEventListener('online', () => void tick(false));
  window.addEventListener('pageshow', () => void tick(false));
  window.addEventListener('beforeunload', () => { if (timer) clearInterval(timer); });
  start();
})();
</script>
</body>
</html>`;
}
