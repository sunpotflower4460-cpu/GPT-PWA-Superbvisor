# AI DEV DECK ChatGPT Bridge

ChatGPT側に置く、AI DEV DECK Multi Chat Remote用の小さなApps SDK / MCP companionです。

これは別のコーディングAIではありません。**既存のChatGPT開発チャットが実行者のまま**で、このBridgeはPWA/Workerに保存された次ターン指示を、その同じ会話へ中継するだけです。

## Flow

```text
AI DEV DECK PWA
  -> Supervisor Worker durable chat-command queue
  -> ChatGPT Apps Bridge
  -> window.openai.sendFollowUpMessage(...)
  -> same ChatGPT conversation
  -> ChatGPT performs repository work
```

Supervisor Worker tokenはMCPサーバー側だけが保持し、Widget HTML / structuredContentには渡しません。

## Why a ChatGPT App

ChatGPT Apps/MCP UIではWidgetからhost conversationへfollow-up messageを送れます。ChatGPT互換APIは `window.openai.sendFollowUpMessage(...)` です。

Widgetはさらにapp-only MCP toolsを使って以下だけを行います。

- heartbeat
- command claim
- delivery result

GitHub編集・実装・debugはBridgeではなくChatGPT本体が行います。

## Recommended hosting: Cloudflare Worker

スマホPWAの補助Bridgeとして常駐Nodeサーバーを別途管理しなくて済むよう、Cloudflare Worker entryを同梱しています。

Cloudflare側は現在SDK v2 stateless handlerを新規MCPの推奨経路としていますが、このBridgeはOpenAI Apps SDKのSDK v1 server定義を利用しているため、まずCloudflare公式の `createLegacyMcpHandler` compatibility laneで動かします。これは移行用経路なので、Apps SDK側との互換を確認しながら将来SDK v2へ移行します。

### 1. Install / verify

```bash
cd chatgpt-bridge
npm install
npm run check
```

`check` はTypeScript typecheckとWrangler dry-run bundleを実行します。

### 2. Configure Worker secrets

```bash
npx wrangler secret put SUPERVISOR_WORKER_URL
npx wrangler secret put SUPERVISOR_CLIENT_TOKEN
npx wrangler secret put BRIDGE_ALLOWED_PROJECT_IDS
```

入力例:

```text
SUPERVISOR_WORKER_URL
https://your-supervisor-worker.workers.dev

BRIDGE_ALLOWED_PROJECT_IDS
project-id-a,project-id-b
```

`BRIDGE_ALLOWED_PROJECT_IDS` は必須で、未設定時はfail closedです。

### 3. Deploy

```bash
npm run deploy:cloudflare
```

公開後のendpoint:

```text
https://<your-bridge-worker>.workers.dev/mcp
```

health:

```text
https://<your-bridge-worker>.workers.dev/health
```

### 4. Connect to ChatGPT developer/private app

ChatGPTのDeveloper Mode / private appで上記 `/mcp` endpointを接続します。

公開配布用アプリとして使う段階ではOAuth等の本番向け認証を追加してください。現段階は自分の開発チャットを遠隔操作するprivate/developer用途を優先しています。

## Local Express fallback

ローカル確認用には従来どおりExpress版も使えます。

```bash
export SUPERVISOR_WORKER_URL="https://your-worker.example.workers.dev"
export SUPERVISOR_CLIENT_TOKEN="..."
export BRIDGE_ALLOWED_PROJECT_IDS="project-id-a,project-id-b"
export PORT=8788

npm start
```

MCP endpoint:

```text
http://localhost:8788/mcp
```

ChatGPTから試す場合はHTTPS development tunnelで公開してください。

Cloudflare版とExpress版は `src/bridgeApp.ts` の同じtool/resource/widget定義を共有します。

## Attach one existing ChatGPT conversation

対象の既存開発チャットで、PWAの「Bridgeを接続」から生成される指示を一度送ります。

内部的には以下のtoolを同じproject IDで呼びます。

```text
connect_ai_dev_deck_bridge({ projectId: "...", projectName: "..." })
```

Widgetがmountされると:

1. project単位でheartbeatを送る
2. そのprojectの次commandをpoll
3. 一度に1commandだけclaim
4. `sendFollowUpMessage` で同じChatGPT会話へ送る
5. delivered / failedをWorkerへ返す
6. 次のuser turnを連投しないようcooldown

複数projectはそれぞれ独立したBridge heartbeatを持てます。

## Background resilience

- PWAを閉じてもcommandはSupervisor Worker KVに残る
- ChatGPT Widgetが一時的に消えてもqueued commandは失われない
- Bridgeがclaim直後に落ちた場合、stale claimは一定時間後に再claim可能
- project AのBridgeがproject Bのcommandをclaimしない

## Safety

- ChatGPT cookie / session tokenを取得・保存しない
- browser scrapingをしない
- 非公式message投稿endpointを使わない
- Supervisor Worker credentialsはserver-sideのみ
- Project ID allowlist必須
- Bridge自身はGitHub codeを書かない
- 自動merge / production deployなし

## Current platform limitation

**PWA/Workerだけで、完全に閉じている任意のChatGPT既存会話をサーバー側から強制的に起動して投稿する仕組みではありません。**

Queueはバックグラウンドで保持できますが、ChatGPT側Widgetがmount/aliveである時にclaimして会話へ送ります。ChatGPTがWidgetをunmount/suspendした場合はQueueで待ち、Bridgeが再びactiveになった時に再開します。

これは過大評価せず、実際のChatGPT host E2Eで挙動を確認しながら改善します。

## Files

```text
src/bridgeApp.ts   shared Apps SDK tools/resource/widget
src/server.ts      local Express / Streamable HTTP runtime
src/cloudflare.ts  Cloudflare Worker runtime
wrangler.jsonc     lightweight Worker deployment config
```

## Production hardening still needed

- real ChatGPT developer/private app E2E
- real iPhone/Android PWA E2E
- public distribution時のOAuth
- per-project atomic lock / idempotency for competing bridge instances
- structured Autopilot route progress persisted independently of chat text
- reconnect / suspended-widget UX validation
