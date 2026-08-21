# Background Worker

AI DEV DECKの任意実行層です。通常運転はChatGPT Chatを優先し、端末を閉じても止めたくない工程だけOpenAI Responses APIのbackground modeへ明示的に昇格します。

## できること

- OpenAI APIキーをPWA/ブラウザへ置かない
- Responses APIのbackground responseを開始
- PWAを閉じてもOpenAI側で処理を継続
- OpenAI webhookを署名検証して受信
- completed / failed / incomplete / cancelled を反映
- Cloudflare KVへJob / Checkpointを保存
- failed / incomplete時の上限付きAuto Recovery（明示ON・最大2回）
- Goal / DoD / 最終Chat返答から任意のLLM Smart Replyを生成
- 完了時に構造化されたDEVDECK_REPORT_JSONを保存
- Web Pushを使い、PWAが閉じていてもBackground完了・停止を通知

現段階ではBackground WorkerへGitHub書き込み権限を自動付与していません。したがって、アクセスできない外部システムを操作したと偽らないようWorker promptにも制約があります。

## 1. Install

```bash
cd worker
npm install
```

## 2. Cloudflare Worker設定

`wrangler.example.jsonc` を `wrangler.jsonc` にコピーします。

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

KV namespaceを作成し、返されたIDを `wrangler.jsonc` の `SUPERVISOR_STATE` に設定します。

```bash
npx wrangler kv namespace create SUPERVISOR_STATE
```

`ALLOWED_ORIGIN` は実際にPWAを公開するOriginへ変更します。

例:

```text
https://sunpotflower4460-cpu.github.io
```

## 3. OpenAI / app secrets

以下はGitHubへコミットせず、Worker secretとして登録します。

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put OPENAI_WEBHOOK_SECRET
npx wrangler secret put SUPERVISOR_CLIENT_TOKEN
```

`SUPERVISOR_CLIENT_TOKEN` はOpenAI APIキーとは別の、このPWA専用アクセストークンです。十分長いランダム値を使います。

macOS例:

```bash
openssl rand -hex 32
```

## 4. Web Push / VAPID

PushForgeでVAPID key pairを生成します。

```bash
npx @pushforge/builder vapid
```

出力されるもの:

- public key: PWAがPush subscriptionを作るために使用
- private key: JWK形式。Workerだけが保持

`wrangler.jsonc` の `vars` に次を設定します。

```jsonc
{
  "VAPID_PUBLIC_KEY": "<public key>",
  "VAPID_SUBJECT": "mailto:you@example.com"
}
```

private JWKはファイルへ書かず、1行JSONのままSecretへ登録します。

```bash
npx wrangler secret put VAPID_PRIVATE_JWK
```

入力例の形:

```json
{"kty":"EC","crv":"P-256","x":"...","y":"...","d":"..."}
```

PWA公開後は、通知Inboxの **Pushを有効化** をタップします。ブラウザーの通知許可後、購読情報がWorkerのKVへ保存されます。その後 **テスト** で端末通知を確認できます。

Pushを使わない場合、VAPID設定は省略可能です。Background Worker本体はそのまま動きます。

## 5. Deploy

```bash
npm run typecheck
npm run deploy
```

Worker URLが発行されたら、PWAの ⚡ Background Worker → Worker接続設定 にURLと `SUPERVISOR_CLIENT_TOKEN` を入力します。

OpenAI APIキーやVAPID private keyをPWAへ入力する必要はありません。

## 6. OpenAI webhook

OpenAI Platform側でWebhook endpointを作り、次を指定します。

```text
https://<your-worker>/webhooks/openai
```

主に利用するイベント:

- `response.completed`
- `response.failed`
- `response.incomplete`
- `response.cancelled`

Webhook signing secretを `OPENAI_WEBHOOK_SECRET` としてWorkerへ登録します。

Workerはraw bodyと `webhook-id` / `webhook-timestamp` / `webhook-signature` を使ってStandard Webhooks形式の署名を検証し、重複WebhookもKVで除外します。

Webhookが一時的に取りこぼされた場合でも、PWAがJob状態を取得した時にfailed / incompleteを確認すれば、Auto Recovery条件を再評価します。

## API

### Health

```http
GET /health
```

### Start background job

```http
POST /api/jobs
Authorization: Bearer <SUPERVISOR_CLIENT_TOKEN>
Content-Type: application/json
```

例:

```json
{
  "projectId": "project-id",
  "projectName": "SNS-AI",
  "goal": "本人しかできない手動設定だけの状態まで仕上げる",
  "currentPhase": "E2E確認",
  "definitionOfDone": ["テストPASS", "重大エラーなし"],
  "prompt": "残作業を確認して次工程を進める",
  "autoRecover": true,
  "maxAutoRetries": 2
}
```

### Get job

```http
GET /api/jobs/<response-id>
Authorization: Bearer <SUPERVISOR_CLIENT_TOKEN>
```

### Latest job for project

```http
GET /api/projects/<project-id>/latest
Authorization: Bearer <SUPERVISOR_CLIENT_TOKEN>
```

### LLM Smart Reply

```http
POST /api/smart-replies
Authorization: Bearer <SUPERVISOR_CLIENT_TOKEN>
```

通常はPWA内の無料rule-based Smart Replyを使い、必要な時だけこのAPIを呼びます。

### Push public key

```http
GET /api/push/public-key
Authorization: Bearer <SUPERVISOR_CLIENT_TOKEN>
```

### Register / remove Push subscription

```http
POST /api/push/subscriptions
DELETE /api/push/subscriptions
Authorization: Bearer <SUPERVISOR_CLIENT_TOKEN>
```

### Test Push

```http
POST /api/push/test
Authorization: Bearer <SUPERVISOR_CLIENT_TOKEN>
```

## Cost / safety

- Background Workerはユーザーが明示的に開始した時だけAPI処理を開始します。
- `OPENAI_MODEL` でBackgroundモデルを変更できます。サンプルは `gpt-5.6-luna`。
- `SMART_REPLY_MODEL` でSmart Replyモデルを変更できます。サンプルは `gpt-5.4-nano`。
- Auto RecoveryはJobごとに明示ONが必要で、コード側でも最大2回に制限します。
- Chat → Worker / Workへの勝手な昇格はしません。
- PushはBackground Jobが最終状態へ到達した時だけ送信し、同じJob/statusの重複送信をKVで抑止します。
- 無効になったPush subscription（404/410）はKVから削除します。
- KV上のJob/Checkpointは14日TTLです。

## Why not put secrets in the PWA?

公開PWAへOpenAI APIキーやVAPID private keyを埋め込むと、ブラウザから取得され第三者に利用される可能性があります。そのため秘密情報はserver-side Workerだけが保持します。
