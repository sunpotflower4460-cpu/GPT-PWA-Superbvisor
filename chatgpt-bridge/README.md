# AI DEV DECK ChatGPT Bridge

This is the ChatGPT-side companion for AI DEV DECK Multi Chat Remote.

It is intentionally **not** another coding agent. The existing ChatGPT conversation remains the developer. This bridge only relays durable commands from the AI DEV DECK Worker into that same conversation.

## Flow

```text
AI DEV DECK PWA
  -> Supervisor Worker durable chat-command queue
  -> this MCP Apps bridge
  -> window.openai.sendFollowUpMessage(...)
  -> same ChatGPT conversation
  -> ChatGPT performs the actual repository work
```

The Worker token is held only by this MCP server. It is never placed in widget HTML or structured content.

## Why a ChatGPT App

Current ChatGPT Apps/MCP UI supports a widget posting a follow-up message into its host conversation through the standard follow-up messaging bridge (`ui/message`; ChatGPT compatibility API: `window.openai.sendFollowUpMessage`). The widget also uses app-only MCP tools for heartbeat, command claim, and delivery result reporting.

## Required environment

```bash
export SUPERVISOR_WORKER_URL="https://your-worker.example.workers.dev"
export SUPERVISOR_CLIENT_TOKEN="..."
export BRIDGE_ALLOWED_PROJECT_IDS="project-id-a,project-id-b"
export PORT=8788
```

`BRIDGE_ALLOWED_PROJECT_IDS` is required and fails closed when absent.

## Local run

```bash
cd chatgpt-bridge
npm install
npm run typecheck
npm start
```

The MCP endpoint is:

```text
http://localhost:8788/mcp
```

For ChatGPT developer-mode testing, expose the MCP endpoint through a secure HTTPS development tunnel and connect it as a private app/plugin.

## Attach one existing ChatGPT conversation

In the target development conversation, invoke the bridge tool with the same project ID stored in AI DEV DECK:

```text
connect_ai_dev_deck_bridge({ projectId: "...", projectName: "..." })
```

Once the widget is mounted it:

1. reports a per-project heartbeat;
2. polls for the next command for that project;
3. claims one command at a time;
4. sends it into the same ChatGPT conversation with `sendFollowUpMessage`;
5. reports delivered/failed back to the Worker;
6. waits before taking another command so multiple user turns are not dumped into an active response.

Multiple projects can each have their own bridge widget and heartbeat.

## Safety

- No ChatGPT cookies or session tokens are read or stored.
- No browser scraping or unofficial message-posting endpoint is used.
- Supervisor Worker credentials stay server-side.
- Project IDs are allowlisted server-side.
- The bridge does not write GitHub code itself.
- Merge and production deploy remain outside this bridge.

## Current limitation

The durable queue works while the PWA is closed, but the ChatGPT-side widget must still be mounted/alive for it to claim and inject commands. If ChatGPT unmounts or suspends the widget, commands remain queued and resume when the bridge becomes active again. This is not yet a guarantee of arbitrary server-initiated messages into a completely closed ChatGPT conversation.

Claimed commands become reclaimable after a stale-claim timeout so a crashed bridge does not permanently strand the queue.

## Production hardening still needed

- OAuth/private app authentication before public deployment
- stronger per-project coordination / Durable Object lock for competing bridge instances
- real-device and ChatGPT host E2E tests
- explicit bridge reconnect UX
- structured Autopilot route state persisted independently of chat text
