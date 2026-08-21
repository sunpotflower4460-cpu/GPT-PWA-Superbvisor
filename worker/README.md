# Background Worker

AI DEV DECKの任意実行層です。通常運転はChatGPT Chatのままにし、端末を閉じても完了させたい処理だけOpenAI Responses APIのbackground modeへ昇格します。

## 役割

- APIキーをPWA/ブラウザへ置かない
- background responseを開始
- PWAを閉じてもOpenAI側で処理を継続
- OpenAI webhookを署名検証して受信
- completed / failed / incomplete / cancelled を反映
- Cloudflare KVへJob / Checkpointを保存
- PWAからJob状態を取得

現段階ではGitHubへの書き込み権限をWorkerへ付与していません。したがって、Background Workerは推論・分析・計画・長文処理・引き継ぎ作成などを端末非依存で完了できますが、リポジトリを実際に編集したと偽らないようプロンプト側でも制約しています。

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

`ALLOWED_ORIGIN` は実際にPWAを公開するOriginへ変更してください。

例:

```text
https://sunpotflower4460-cpu.github.io
```

## 3. Secrets

以下はGitHubへコミットせず、Worker secretとして登録します。

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put OPENAI_WEBHOOK_SECRET
npx wrangler secret put SUPERVISOR_CLIENT_TOKEN
```

`SUPERVISOR_CLIENT_TOKEN` はOpenAI APIキーとは別の、このPWA専用アクセストークンです。ランダムな長い値を使ってください。

macOS例:

```bash
openssl rand -hex 32
```

## 4. Deploy

```bash
npm run typecheck
npm run deploy
```

Worker URLが発行されたら、PWAの ⚡ Background Worker → Worker接続設定 にURLと `SUPERVISOR_CLIENT_TOKEN` を入力します。

OpenAI APIキーそのものをPWAへ入力する必要はありません。

## 5. OpenAI webhook

OpenAI Platform側でWebhook endpointを作り、次を指定します。

```text
https://<your-worker>/webhooks/openai
```

Background responseで利用するイベント:

- `response.completed`
- `response.failed`
- `response.incomplete`
- `response.cancelled`

Webhook signing secretを `OPENAI_WEBHOOK_SECRET` としてWorkerへ登録します。

Workerはraw bodyと `webhook-id` / `webhook-timestamp` / `webhook-signature` を使ってStandard Webhooks形式の署名を検証し、重複WebhookもKVで除外します。

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

Body:

```json
{
  "projectId": "project-id",
  "projectName": "SNS-AI",
  "goal": "本人しかできない手動設定だけの状態まで仕上げる",
  "currentPhase": "E2E確認",
  "definitionOfDone": ["テストPASS", "重大エラーなし"],
  "prompt": "残作業を確認して次工程を進める"
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

## Cost / safety

- デフォルトモデルは `OPENAI_MODEL` で変更可能です。
- サンプル設定ではコスト優先の `gpt-5.6-luna` を指定しています。
- Workerはユーザーが明示的に開始した時だけAPI処理を開始します。
- 現段階では失敗時に無制限の自動再試行をしません。
- Retry / alternative approachを自動化する場合も、回数・予算上限を先に実装してから有効化します。
- KV上のJob/Checkpointは現在14日TTLです。

## Why not put the OpenAI key in the PWA?

公開PWAへAPIキーを埋め込むと、ブラウザから取得され第三者に利用される可能性があります。そのためOpenAI credentialは必ずserver-side Workerだけが持ちます。
