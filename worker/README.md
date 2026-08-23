# Supervisor Worker

AI DEV DECKの**外部オーケストレーション / durable control層**です。

## 最重要ルール

**実際に作業するのはChatGPTチャットです。**

Cloudflare Workerと外部LLM APIは、次だけを担当します。

- Chat Control Bus
- compact all-chat overview
- multi-device command coordination
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
PWA / Supervisor / Guardian
 ↓
Cloudflare Worker
 ├─ Multi Chat Overview
 │    └─ compact batch summaries only
 │
 ├─ ProjectCoordinator (SQLite Durable Object)
 │    ├─ atomic enqueue / dedupe
 │    ├─ one active Bridge claim owner
 │    ├─ read-only command overview summary
 │    ├─ delivery retry / stale claim recovery
 │    ├─ Cloud State revision compare-and-update
 │    └─ Guardian advance execution lease
 │
 ├─ KV
 │    └─ migration / history mirror / compatibility fallback
 │
 ├─ Provider Router
 │    DeepSeek → MiniMax → OpenAI → deterministic fallback
 │
 └─ GitHub Guardian
      protected branch準備
        ↓
      ChatGPTが実装
        ↓
      exact head SHAのCI監視
```

## Atomic coordinator

productionで複数端末・複数Bridgeを安全に扱うため、`PROJECT_COORDINATOR` はSQLite-backed Durable Objectとして設定します。

Coordinatorが担当する強整合境界:

- 同じdedupe keyの同時enqueueを1 commandへ集約
- 1 commandへ同時に複数Bridgeがclaimしない
- stale/non-owner Bridgeからのresult overwriteを409で拒否
- transient delivery failureを同じcommand IDでbackoff再試行
- retry/requeue時に古いBridge ownershipを解放
- terminal failureを明示retryで同じcommand IDのまま再queue
- Cloud Stateのrevision conflictをatomicに判定
- 同一Guardian runのCron/manual advance入口を短期execution leaseで1本に絞る
- high-frequency UI overviewへcommand本文を返さずread-only summaryを提供

Guardian leaseは通常の二重advanceを抑止するための入口ロックです。Guardian / Developerの全KV state writeをtransactional storageへ移したわけではなく、lease期限を超える異常に長い処理まで完全fencingできるとは扱いません。

`PROJECT_COORDINATOR` がない場合は既存KV fallbackで基本動作しますが、**atomic multi-device guaranteeはありません**。`GET /health` の `atomicCoordinator` とPWAのSetup Doctorで確認できます。

## Multi Chat overview

PWAのChat Controlは、選択中だけでなく管理中の全ChatGPTのremote activityを同じ画面で表示します。

PWAは次をbatch取得します。

```http
POST /api/chat-control/overview
Authorization: Bearer <SUPERVISOR_CLIENT_TOKEN>
Content-Type: application/json

{
  "projectIds": ["project-a", "project-b"]
}
```

1 requestあたり最大30 projectです。PWA側は30件を超える時に複数batchへ分割します。

返却するのはcompact metadataだけです。

- Bridge connected/offline
- DELIVERING
- RETRY_SCHEDULED
- QUEUED
- WAITING_BRIDGE
- NEEDS_ATTENTION
- DELIVERED
- CONNECTED_IDLE
- pending / failed count
- latest status/timestamp
- active command ID
- next retry time

Coordinator有効時、overviewは `/commands/overview` のread-only summaryを使います。**full prompt / command本文を取得せず、overview readだけを理由にKV history mirrorを書き直しません。**

KV fallback時は最大100件からsummary化し、上限に達した場合は`approximate`として扱います。

## Failure resilience

- Provider 408 / 409 / 425 / 429 / 5xx → 同providerを最大3 attempt
- Provider失敗 → 次providerへfallback
- 全provider失敗 → deterministic ChatGPT handoff
- Bridge send failure → 同じcommand IDでbackoff再queue、上限後のみterminal failed
- retry/requeue → 古いBridge ownershipを解除して次claimへ渡す
- ChatGPT send成功 / Worker ack失敗 → Bridge delivery receiptを再同期し、本文の即再送を避ける
- stale Bridge claim → 2分後に回収可能
- Guardian Cron/manual refresh競合 → Coordinator有効時は同一runのadvance leaseを1実行だけ取得
- CI `cancelled` / `timed_out` / `startup_failure` / `stale` → failed jobsを最大2回再実行
- CI `failure` → 同じ失敗をfingerprintしてChatGPT修正指示へ変換
- GitHub/API一時エラー → Guardianをfailed終了せず次Cronで再試行
- Push失敗 → 監督状態を壊さない
- CI未検出 → successと推測しない

## 1. Install

```bash
cd worker
npm install
npm run check
```

`npm run check` は次をまとめて検証します。

- TypeScript typecheck
- regression tests
- SQLite Durable Objectを含むWrangler dry-run

## 2. Cloudflare Worker設定

```bash
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler kv namespace create SUPERVISOR_STATE
```

返されたKV namespace IDを `wrangler.jsonc` の `SUPERVISOR_STATE` に設定します。

`wrangler.example.jsonc` には以下のDurable Object設定が含まれています。

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "PROJECT_COORDINATOR",
        "class_name": "ProjectCoordinator"
      }
    ]
  },
  "exports": {
    "ProjectCoordinator": {
      "type": "durable-object",
      "storage": "sqlite"
    }
  }
}
```

このbinding/exportを削除した状態でproduction deployしないでください。互換KV fallbackへ落ち、複数端末競合耐性が弱くなります。

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

deploy後、必ずhealthを確認します。

```http
GET /health
```

期待値:

```json
{
  "ok": true,
  "executor": "chatgpt",
  "orchestrationOnly": true,
  "chatCommandBus": true,
  "atomicCoordinator": true
}
```

`atomicCoordinator: false` の場合はproduction multi-device安全性が未設定です。

Worker URLと `SUPERVISOR_CLIENT_TOKEN` をPWAのSupervisor Worker設定へ入力し、Setup DoctorでもAtomic Multi-device CoordinatorがPASSになることを確認します。

## API

### Health / executor boundary

```http
GET /health
```

PWAはここからChatGPT executor境界とAtomic Coordinator bindingを確認します。

### Multi Chat overview

```http
POST /api/chat-control/overview
```

全案件のprimary rail用compact stateをbatch取得します。1 request最大30 projectです。

### Chat Control Bus

```http
POST /api/chat-commands
POST /api/chat-commands/claim
POST /api/chat-commands/<id>/result
POST /api/chat-commands/<id>/retry
GET  /api/projects/<project-id>/chat-commands
```

Coordinator有効時はproject単位でauthoritative stateを持ちます。KVはmirror/fallbackです。

### Cloud State

```http
GET    /api/state-sync
POST   /api/state-sync
DELETE /api/state-sync
```

Coordinator有効時はrevision compare-and-updateがstrongly consistentです。

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

GitHub allowlist、ChatGPT executor boundary、Atomic Coordinator、利用可能provider、deterministic fallback有無を確認できます。

### Guardian

```http
POST /api/guardian-runs
GET /api/guardian-runs/<id>
GET /api/guardian-projects/<project-id>/latest
```

Coordinator有効時、同じGuardian runのCron sweepと手動refreshは `guardian-advance` leaseで同時advanceを抑制します。

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

状態の扱いを3段階に分けます。

**Strongly consistent / authoritative:**
- Chat command ownership / dedupe / delivery retry
- compact command overview summary
- Cloud State revision compare-and-update
- SQLite Durable Object `ProjectCoordinator`

**Strongly coordinated execution entry:**
- Guardian runのCron/manual `advance` はCoordinator leaseで同時実行を抑制
- leaseは期限付きで、Worker crash後は自動takeover可能

**Durable snapshot / mirror:**
- KV migration source
- command history mirror
- Guardian / Developer / handoff / Push等の既存監督snapshot

したがって、通常のGuardian二重advanceは抑制済みですが、Guardian / Developer state全体が完全transactional/fencedになったとは扱いません。実運用上必要性が確認された場合は、authoritative state自体をCoordinator/D1等へ移すのが次の強化段階です。

## Cost / safety

- all-chat overviewはsummary-only + batch transport
- overview pollでfull prompt/historyを繰り返し読まない
- overview pollでKV mirror writeを増幅しない
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
