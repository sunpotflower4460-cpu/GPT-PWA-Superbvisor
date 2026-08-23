import { createLegacyMcpHandler } from 'agents/mcp';
import { createBridgeServer, normalizeBridgeConfig } from './bridgeApp.js';

interface Env {
  SUPERVISOR_WORKER_URL?: string;
  SUPERVISOR_CLIENT_TOKEN?: string;
  BRIDGE_ALLOWED_PROJECT_IDS?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
    const url = new URL(request.url);
    const config = normalizeBridgeConfig({
      supervisorWorkerUrl: env.SUPERVISOR_WORKER_URL,
      supervisorClientToken: env.SUPERVISOR_CLIENT_TOKEN,
      allowedProjectIds: env.BRIDGE_ALLOWED_PROJECT_IDS,
    });

    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({
        ok: true,
        service: 'ai-dev-deck-chatgpt-bridge',
        mode: 'chatgpt-apps-sdk-cloudflare-legacy-v1',
        workerConfigured: Boolean(config.supervisorWorkerUrl && config.supervisorClientToken),
        projectAllowlistConfigured: config.allowedProjectIds.length > 0,
      });
    }

    if (url.pathname !== '/mcp') {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }

    const server = createBridgeServer(config);
    const handler = createLegacyMcpHandler(server);
    return handler(request, env, ctx as never);
  },
};
