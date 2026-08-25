import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
import express from 'express';
import { createBridgeServer, normalizeBridgeConfig } from './bridgeApp.js';

const port = Number.parseInt(process.env.PORT || '8788', 10);
const config = normalizeBridgeConfig({
  supervisorWorkerUrl: process.env.SUPERVISOR_WORKER_URL,
  supervisorClientToken: process.env.SUPERVISOR_CLIENT_TOKEN,
  allowedProjectIds: process.env.BRIDGE_ALLOWED_PROJECT_IDS,
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'ai-dev-deck-chatgpt-bridge',
    mode: 'chatgpt-apps-sdk-local',
    workerConfigured: Boolean(config.supervisorWorkerUrl && config.supervisorClientToken),
    projectAllowlistConfigured: config.allowedProjectIds.length > 0,
  });
});

app.all('/mcp', async (req, res) => {
  const server = createBridgeServer(config);
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
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

app.listen(port, () => {
  console.log(`AI DEV DECK ChatGPT Bridge listening on http://localhost:${port}/mcp`);
});
