# Supervisor Worker

AI DEV DECKの**外部オーケストレーション層**です。

## 最重要ルール

**実際に作業するのはChatGPTチャットです。**

Cloudflare Workerと外部LLM APIは、次だけを担当します。

- 状態整理
- ChatGPTへ渡す次手の生成
- GitHub作業branchの準備
- branch head / CI監視
- CI失敗分類
- 一時障害の再試行
- ChatGPT用recovery prompt生成
- 状態保存
- Push通知
- Cloud sync

外部LLMへGitHub write/delete/merge toolは渡しません。旧OpenAI Responses background executor / webhook経路は廃止されています。

## Architecture

```text
PWA
 ↓
Cloudflare Worker
 ├─ Provider Router
 │    DeepSeek → MiniMax → OpenAI → deterministic fallback
 │
 ├─ Generic Supervisor
 │    state → ChatGPT handoff prompt
 │
 └─ GitHub Guardian
      protected branch準備
        ↓
      ChatGPTが実装
        ↓
      exact head SHAのCI監視
        ├─ green → Draft PR / review
        ├─ transient → CI rerun
        ├─ code failure → ChatGPT recovery prompt
        └─ human required → safe stop
```

## Failure resilience

- Provider 408 / 409 / 425 / 429 / 5xx → 同providerを最大3 attempt
- Provider失敗 → 次providerへfallback
- 全provider失敗 → deterministic ChatGPT handoff
- CI `cancelled` / `timed_out` / `startup_failure` / `stale` → failed jobsを最大2回再実行
- CI `failure` → 同じ失敗をfingerprintしてChatGPT修正指示へ変換
- GitHub/API一時エラー → Guardianをfailed終了せず次Cronで再試行
- Push失敗 → 監督状態を壊さない
- Guardian一覧 → KV paginationで全件巡回
- CI未検出 → successと推測しない

## 1. Install

```bash
cd worker
npm install
npm run check
```

## 2. Cloudflare Worker設定

```bash
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler kv namespace create SUPERVISOR_STATE
```

返されたKV namespace IDを `wrangler.jsonc` の `SUPERVISOR_STATE` に設定します。

`ALLOWED_ORIGIN` はPWAの公開Originへ変更します。

## 3. Required secrets

PWA専用のWorker接続token:

```bash
npx wrangler secret put SUPERVISOR_CLIENT_TOKEN
```

GitHub Guardianを使う場合:

```bash
npx wrangler secret put GITHUB_TOKEN
```

`GITHUB_ALLOWED_REPOS` は `wrangler.jsonc` のvarsでallowlistを設定します。

## 4. Orchestration providers

最低1providerあると高品質な次手生成ができます。全部未設定でもdeterministic fallbackでSupervisor/Guardianは動作します。

推奨の低コスト構成:

```bash
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put MINIMAX_API_KEY
```

OpenAIをfallbackにも使う場合だけ:

```bash
npx wrangler secret put OPENAI_API_KEY
```

標準vars:

```jsonc
{
  "ORCHESTRATOR_PROVIDER": "deepseek",
  "ORCHESTRATOR_FALLBACKS": "minimax,openai",
  "DEEPSEEK_ORCHESTRATOR_MODEL": "deepseek-v4-flash",
  "MINIMAX_ORCHESTRATOR_MODEL": "MiniMax-M3",
  "OPENAI_ORCHESTRATOR_MODEL": "gpt-5.4-nano",
  "MINIMAX_BASE_URL": "https://api.minimax.io/v1",
  "ORCHESTRATOR_TIMEOUT_MS": "15000"
}
```

モデル名やendpointはprovider側の変更時にvarsだけで差し替えられるよう、コードから分離しています。

## 5. Web Push / VAPID

```bash
npx @pushforge/builder vapid
npx wrangler secret put VAPID_PRIVATE_JWK
```

`wrangler.jsonc`:

```jsonc
{
  "VAPID_PUBLIC_KEY": "<public key>",
  "VAPID_SUBJECT": "mailto:you@example.com"
}
```

Pushはbest-effortです。通知配信失敗によってGuardianを失敗終了させません。

## 6. Deploy

```bash
npm run check
npm run deploy
```

Worker URLと `SUPERVISOR_CLIENT_TOKEN` をPWAのSupervisor Worker設定へ入力します。

## API

### Health / executor boundary

```http
GET /health
```

返り値には次が含まれます。

```json
{
  "ok": true,
  "executor": "chatgpt",
  "orchestrationOnly": true
}
```

PWAはこれを使って旧Background Executorへ接続していないか確認できます。

### Generic orchestration handoff

```http
POST /api/jobs
Authorization: Bearer <SUPERVISOR_CLIENT_TOKEN>
```

このAPIはプロジェクト作業を実行しません。状態を整理し、`handoffPrompt` を返します。

### GitHub / provider config

```http
GET /api/github-agent/config
```

GitHub allowlist、ChatGPT executor boundary、利用可能provider、deterministic fallback有無を確認できます。

### Guardian

```http
POST /api/guardian-runs
GET /api/guardian-runs/<id>
GET /api/guardian-projects/<project-id>/latest
```

Guardianの詳細は `GUARDIAN_RUNNER.md` を参照してください。

### Smart Reply

```http
POST /api/smart-replies
```

Smart Replyも同じProvider Routerを使います。全provider障害時はrule-based候補へfallbackします。

### Push

```http
GET /api/push/public-key
POST /api/push/subscriptions
DELETE /api/push/subscriptions
POST /api/push/test
```

## OpenAI webhookについて

旧バージョンの `/webhooks/openai` は、OpenAI Responses background executor用でした。

現在は外部APIに実作業を委譲しないため廃止済みで、endpointは `410 deprecated_background_executor` を返します。`OPENAI_WEBHOOK_SECRET` は不要です。

## State and consistency

Guardian / handoff / Push subscription / Cloud sync stateはKVへ保存します。

KVは監督スナップショット用途には適していますが、厳密なmulti-device atomic transactionではありません。Cloud syncの完全なCASが必要になった場合はDurable Objectsまたはtransactional storageへ移行する前提です。

## Cost / safety

- 低コストproviderをprimaryにできる
- 高価なmodelを毎回使わない
- provider failureで別providerへfallback
- APIは実装を行わないため、モデル変更でGitHub書込挙動が変わらない
- GitHubはallowlist repoのみ
- Workerはmain/default branchへコードwriteしない
- Draft PRのみ
- auto mergeなし
- production deployなし
- secretsはWorker側のみ

このWorkerの目的は「別AIに開発を丸投げする」ことではなく、**ChatGPTの実作業を、安いAPIと堅い状態機械で外から支えること**です。
