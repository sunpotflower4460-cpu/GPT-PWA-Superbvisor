# AI DEV DECK ChatGPT Bridge

ChatGPT側に置く、AI DEV DECK Multi Chat Remote用の小さなApps SDK / MCP companionです。

これは別のコーディングAIではありません。**既存のChatGPT開発チャットが実行者のまま**で、このBridgeはPWA/Workerに保存された次ターン指示を、その同じ会話へ中継するだけです。

## Flow

```text
AI DEV DECK PWA
  -> Supervisor Worker
  -> ProjectCoordinator / durable chat-command queue
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
- failed command retry

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

- PWAを閉じてもcommandはWorker側のdurable queueに残る
  - `PROJECT_COORDINATOR` 有効時はSQLite-backed Durable Objectがauthoritative
  - KVはmigration / history mirror / compatibility fallback
- ChatGPT Widgetが一時的に消えてもqueued commandは失われない
- Bridgeがclaim直後に落ちた場合、stale claimは一定時間後に再claim可能
- project AのBridgeがproject Bのcommandをclaimしない
- Web Storageが利用できないWidget sandboxでも、Widget生存中はBridge IDをメモリに固定し、heartbeat / claim / resultのowner identityを変えない
- `visibilitychange` で前面復帰した時、`online` でネット復帰した時、`pageshow` で復帰した時は次のintervalを待たずpollへ再入場する
- 復帰時tickは通常cooldownを尊重し、直前command後の連投防止を回避しない
- ChatGPT送信成功後にWorker ackだけ失敗した場合はdelivery receiptを保存し、本文の即再送よりack再同期を優先する

## Atomic claim / retry boundary

productionで `PROJECT_COORDINATOR` が有効な場合、command ownershipはproject単位のSQLite-backed Durable Objectで調停します。

- 同じdedupe keyの同時enqueueを1 commandへ集約
- 同じcommandを同時に2 Bridgeへclaimさせない
- stale/non-owner Bridgeのresult overwriteを409拒否
- transient delivery failureを同じcommand IDのままbackoff再試行
- retry/requeue時は古いBridge ownershipを解放
- terminal failed commandは同じIDのまま明示retry可能
- PWAのmanual fallback cancelとBridge claimも同じCoordinator境界で直列化

`PROJECT_COORDINATOR` が未設定の場合はKV compatibility fallbackで基本動作しますが、**atomic multi-device / multi-Bridge guaranteeとは扱いません**。

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

また、`sendFollowUpMessage` 成功とChatGPT hostの完全なモデル実行完了は同一transactionではありません。command IDとdelivery receiptで重複実行リスクを減らしますが、host境界を跨ぐ完全なexactly-onceを偽装しません。

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
- reconnect / suspended-widget UX validation
- host境界を跨ぐdelivery receipt recoveryの実機確認

このうち **real E2E・real-device E2E・reconnect/suspended-widget検証・delivery receipt recovery**
(4項目)の検証手順は [`../docs/E2E_VERIFICATION.md`](../docs/E2E_VERIFICATION.md) を参照してください。
**public distribution時のOAuthはこの手順書の対象外**で、別途対応が必要です。
