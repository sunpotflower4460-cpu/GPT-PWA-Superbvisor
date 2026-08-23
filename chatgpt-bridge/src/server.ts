import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
import express from 'express';
import { z } from 'zod';

const SERVER_VERSION = '0.1.0';
const TEMPLATE_URI = 'ui://ai-dev-deck/chat-bridge-v1.html';
const DEFAULT_POLL_MS = 6_000;

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
}

function createServer() {
  const server = new McpServer({
    name: 'ai-dev-deck-chatgpt-bridge',
    version: SERVER_VERSION,
  });

  registerAppTool(
    server,
    'connect_ai_dev_deck_bridge',
    {
      title: 'Connect AI DEV DECK Bridge',
      description:
        'Use this when the user wants this ChatGPT development conversation to be remotely controlled from AI DEV DECK. ' +
        'It attaches a small bridge widget to this conversation. The widget receives queued commands for one allowed project and sends them back into this same ChatGPT conversation as follow-up messages.',
      inputSchema: {
        projectId: z.string().min(1).max(200).describe('AI DEV DECK project ID assigned to this ChatGPT conversation'),
        projectName: z.string().max(200).optional().describe('Human-readable project name shown in the bridge widget'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: TEMPLATE_URI } },
    },
    async ({ projectId, projectName }) => {
      assertAllowedProject(projectId);
      return {
        content: [{
          type: 'text' as const,
          text: `AI DEV DECK Bridge is attached to project ${projectName || projectId}. The bridge only relays commands into this ChatGPT conversation; repository work remains the responsibility of this ChatGPT.`,
        }],
        structuredContent: {
          projectId,
          projectName: projectName || projectId,
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
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async ({ projectId, bridgeId }) => {
      assertAllowedProject(projectId);
      const status = await supervisorFetch<Record<string, unknown>>('/api/chat-bridge/heartbeat', {
        method: 'POST',
        body: JSON.stringify({
          bridgeId,
          capabilities: ['claim-command', 'send-follow-up-message', 'report-result', `project:${projectId}`],
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
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async ({ projectId, bridgeId }) => {
      assertAllowedProject(projectId);
      const result = await supervisorFetch<{ command: ChatCommand | null }>('/api/chat-commands/claim', {
        method: 'POST',
        body: JSON.stringify({ projectId, bridgeId }),
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
    async ({ projectId, commandId, status, detail }) => {
      assertAllowedProject(projectId);
      const existing = await supervisorFetch<{ command: ChatCommand }>(`/api/chat-commands/${encodeURIComponent(commandId)}`, { method: 'GET' });
      if (existing.command.projectId !== projectId) throw new Error('Command does not belong to this project');
      const result = await supervisorFetch<{ command: ChatCommand }>(`/api/chat-commands/${encodeURIComponent(commandId)}/result`, {
        method: 'POST',
        body: JSON.stringify({ status, detail }),
      });
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

function toolJson(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

async function supervisorFetch<T>(path: string, init: RequestInit): Promise<T> {
  const baseUrl = requiredEnv('SUPERVISOR_WORKER_URL').replace(/\/$/, '');
  const token = requiredEnv('SUPERVISOR_CLIENT_TOKEN');
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; detail?: string };
  if (!response.ok) throw new Error(payload.detail || payload.error || `Supervisor request failed (${response.status})`);
  return payload;
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function assertAllowedProject(projectId: string) {
  const allowed = (process.env.BRIDGE_ALLOWED_PROJECT_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowed.length) throw new Error('BRIDGE_ALLOWED_PROJECT_IDS is not configured; bridge fails closed');
  if (!allowed.includes(projectId)) throw new Error(`Project is not allowed for this bridge: ${projectId}`);
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
    <button id="retry" hidden>今すぐ再確認</button>
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

  function bridgeId() {
    const pid = projectId() || 'unknown';
    const key = 'ai-dev-deck-bridge:' + pid;
    try {
      const existing = sessionStorage.getItem(key);
      if (existing) return existing;
      const id = 'chatgpt:' + pid + ':' + crypto.randomUUID().slice(0, 8);
      sessionStorage.setItem(key, id);
      return id;
    } catch {
      return 'chatgpt:' + pid + ':' + Math.random().toString(36).slice(2, 10);
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
    await callTool('ai_dev_deck_bridge_heartbeat', { projectId: projectId(), bridgeId: bridgeId() });
    lastHeartbeat = now;
    heartbeatEl.textContent = 'heartbeat ' + new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  }

  async function report(commandId, status, detail) {
    try {
      await callTool('ai_dev_deck_bridge_result', {
        projectId: projectId(),
        commandId,
        status,
        detail: detail || undefined,
      });
    } catch (error) {
      console.warn('AI DEV DECK result report failed', error);
    }
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
      if (!force && Date.now() < cooldownUntil) {
        setStatus('応答待ち', 'work');
        return;
      }
      const claimedResult = await callTool('ai_dev_deck_bridge_claim', { projectId: pid, bridgeId: bridgeId() });
      const data = structured(claimedResult);
      const command = data.command;
      if (!command || typeof command.prompt !== 'string' || !command.prompt.trim()) {
        setStatus('接続中', 'ok');
        lastEl.textContent = 'PWAからの指示を待機しています。';
        return;
      }

      setStatus('送信中', 'work');
      lastEl.textContent = command.prompt;
      try {
        await window.openai.sendFollowUpMessage({ prompt: command.prompt });
        await report(command.id, 'delivered', 'Sent through ChatGPT Apps SDK sendFollowUpMessage');
        setStatus('送信済み', 'ok');
        cooldownUntil = Date.now() + 30_000;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await report(command.id, 'failed', detail);
        setStatus('送信失敗', 'error');
        lastEl.textContent = detail;
        retryEl.hidden = false;
      }
    } catch (error) {
      setStatus('Bridge失敗', 'error');
      lastEl.textContent = error instanceof Error ? error.message : String(error);
      retryEl.hidden = false;
    } finally {
      processing = false;
    }
  }

  retryEl.addEventListener('click', () => {
    retryEl.hidden = true;
    cooldownUntil = 0;
    void tick(true);
  });

  function start() {
    projectEl.textContent = projectName() || 'project情報を待機中';
    void tick(true);
    timer = setInterval(() => void tick(false), ${DEFAULT_POLL_MS});
  }

  window.addEventListener('beforeunload', () => { if (timer) clearInterval(timer); });
  start();
})();
</script>
</body>
</html>`;
}

const port = Number.parseInt(process.env.PORT || '8788', 10);
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'ai-dev-deck-chatgpt-bridge',
    mode: 'chatgpt-apps-sdk',
    workerConfigured: Boolean(process.env.SUPERVISOR_WORKER_URL && process.env.SUPERVISOR_CLIENT_TOKEN),
    projectAllowlistConfigured: Boolean(process.env.BRIDGE_ALLOWED_PROJECT_IDS?.trim()),
  });
});

app.all('/mcp', async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP bridge error:', error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

app.listen(port, () => {
  console.log(`AI DEV DECK ChatGPT Bridge listening on http://localhost:${port}/mcp`);
});
