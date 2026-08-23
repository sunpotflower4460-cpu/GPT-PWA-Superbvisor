# GPT-PWA-Superbvisor

普段ChatGPTでGitHubリポジトリをつないで行っている開発を、**スマホPWAから複数チャット同時並行で、軽く、止まりにくく操作する**ための Multi Chat Remote / 開発コックピットです。

> **主役は複数の既存ChatGPT開発チャット。PWAはそれらを束ね、Workerは状態・Queue・CI・復旧を支える。**
>
> **実作業はChatGPT。Workerと外部LLM APIはオーケストレーション専用。**

実装・デバッグ・GitHub編集の実行者は、ここで普段使っているChatGPTチャットです。DeepSeek / MiniMax / OpenAI API等の外部LLMは、状態整理・次手生成・復旧補助だけに使います。

通常の指示経路は **PWA → Chat Control Bus → ChatGPT Bridge → 対象ChatGPT** です。コピーしてChatGPTを開く操作は通常フローではなく、Bridge障害時などの手動fallbackです。

## Product Constitution — ここを最優先で守る

このリポジトリでは、将来の機能追加やAIによる自動修正で製品コンセプトがずれないよう、以下を最上位ルールとして固定しています。

- 人間向け: [`docs/PRODUCT_CONSTITUTION.md`](docs/PRODUCT_CONSTITUTION.md)
- 機械可読manifest: [`product-concept.json`](product-concept.json)
- AI coding agent向け: [`AGENTS.md`](AGENTS.md)
- 自動検査: [`scripts/concept-guard.mjs`](scripts/concept-guard.mjs)
- 軽量性budget: [`scripts/check-bundle-size.mjs`](scripts/check-bundle-size.mjs)

重要な原則は、**Multi Chat Remoteが第一価値であり、Supervisor / Guardian / Autopilot / Provider Routerは補助層であること**です。

```bash
npm run concept:guard
```

Concept Guardに失敗した場合は、CIを通すためだけにガードを弱めず、まず実装がProduct Constitutionからずれていないか確認します。

## 目指す体験

通常:

```text
Chat Aを開く → 指示 → 待つ
Chat Bへ移動 → 指示 → 待つ
Chat Cへ移動 → 指示 → 待つ
```

AI DEV DECK:

```text
PWA
  ├─ Chat A  ● 配送中
  ├─ Chat B  ↻ 再試行待ち
  ├─ Chat C  ○ Bridge待ち
  └─ Chat D  ! 要確認

  ├─ Chat Aへ「続けて」
  ├─ Chat Bへ「問題点も確認」
  ├─ Chat Cへ「CI成功まで」
  └─ Chat DへAutopilot Route

        ↓

ProjectCoordinator
(SQLite Durable Object)
        ↓
Durable Chat Control Bus
        ↓

複数ChatGPTがそれぞれ進行
        ↓

PWAで全案件の待機 / エラー / 本当のあなた待ち / 完了を確認
```

さらにAutopilotでは、例えば以下のような自然文ルートを指定できます。

> 3回デバッグ。問題があればあと数回デバッグ。大丈夫なら機能Aを追加。その後3回補強、3回デバッグ、最後にUI/UX改善を3回。

途中のCI成功を最終完了と誤認せず、順序・反復・条件分岐を守り、後続工程があれば次の指示をChat Control Busへ自動投入します。

## 第一優先の設計原則

1. **複数ChatGPT開発チャットをPWAから一元操作**
2. **複数案件を同時並行で扱い、全案件のremote状態を同じ画面で把握**
3. **スマホで軽く、PWAを閉じても状態・指示Queueを失わない**
4. **複数端末・複数Bridgeでもcommand ownership/state revisionを安全に調停する**
5. GitHub / CI / Pushで外部状態を監視
6. Supervisorが途中の「続けて」「直して再確認」を代行
7. Autopilot Routeで複数工程を自動運転

Supervisor / Guardianは製品の主役ではなく、Multi Chat Remoteをより放置可能にするための補助層です。

## 現在できること

### Multi Chat Control

- 複数Project / ChatGPT URLを登録
- PWA内の **Chat Control Center** から案件を切り替え
- **選択中でない案件も含め、全ChatGPTのremote activityを一覧表示**
  - 配送中
  - 再試行待ち
  - 送信待ち
  - Bridge待ち
  - 要確認
  - 最近送信済み
  - 接続中 / offline
- 全体の接続数 / 進行・待機数 / 要確認数を表示
- 自由文指示を案件ごとに投入
- Main Project画面のQuick Commandも直接Queueへ送信
- Operating Planも直接Queueへ送信
- Quick Command
  - そのまま続ける
  - 問題点も確認
  - 手動だけまで
  - Autopilot Route
- 案件一覧から▶で複数chatへ続行指示を連続投入
- projectごとの送信Queue / 履歴を表示
- `queued / claimed / delivered / failed / cancelled` を表示
- failed commandを同じcommand IDのまま明示再試行

#### 軽量なall-chat overview

一覧表示のために全command本文を何度も取り直しません。

- PWAは8秒ごとにcompact overviewを取得
- Worker endpointは1 batch最大30案件
- 30件超はPWAが自動で複数batchへ分割し、残りを切り捨てない
- Coordinatorの `/commands/overview` はstatus/count/timestamp等のsummaryだけを返す
- overview pollはcommand本文を取得しない
- overview readを理由にKV history mirror writeを発生させない
- 選択中chatの詳細Queue/heartbeatは別の6秒pollで保持

### Durable Chat Control Bus

ChatGPTへの指示は端末上だけで持たず、Worker側へ永続化します。

productionのauthoritativeな競合判断はSQLite-backed Durable Object `ProjectCoordinator` が担当し、KVは既存データmigration・履歴mirror・互換fallbackとして残します。

```text
PWA / Supervisor / Guardian / Autopilot
  ↓
ProjectCoordinator
  ↓
queued
  ↓
1つのBridgeだけがclaim
  ↓
delivered / retrying / failed
```

- PWAを閉じてもcommandを保持
- project単位でQueueを分離
- ChatGPT URL以外への配送を拒否
- 同じdedupe keyの同時enqueueをatomicに1 commandへ集約
- 1 commandのactive claim ownerは1 Bridgeだけ
- stale claimを回収して再配送可能
- stale/non-owner Bridgeからのresult overwriteを拒否
- transient delivery failureは同じcommand IDでbackoff再試行
- retry/requeue時は以前のBridge ownershipを解放
- 自動試行上限後のみterminal `failed`
- automation由来commandはdedupe keyで重複投入を抑制

`PROJECT_COORDINATOR` が未設定の古いWorkerではKV fallbackで基本操作はできますが、**atomic multi-device guaranteeは有効ではありません**。Setup Doctorがこの状態を警告します。

### Atomic Cloud State

複数端末からのCloud State同期も、Coordinator有効時は同じrevisionに対するcompare-and-updateをDurable Object内で直列化します。

- 2台が同じbaseRevisionから同時saveした場合、片方だけ成功
- もう片方は409 revision conflict
- lost updateを「後勝ち」で隠さない
- 既存KV stateは初回にCoordinatorへmigration

### ChatGPT Apps Bridge

`chatgpt-bridge/` にChatGPT Apps SDK / MCP companionを実装しています。

```text
PWA
  ↓
Supervisor Worker / ProjectCoordinator
  ↓
ChatGPT Bridge Widget
  ↓
window.openai.sendFollowUpMessage(...)
  ↓
そのWidgetが置かれている同じChatGPT会話
```

- ChatGPT側Widgetから同じ会話へfollow-up message
- app-only MCP toolでheartbeat / claim / result / retry
- Worker tokenはMCP serverだけが保持し、Widgetへ渡さない
- project allowlist必須
- projectごとのBridge heartbeat
- 複数案件を独立して接続可能
- 各配送へ `AI DEV DECK COMMAND ID` を付与
- ChatGPT送信成功後にWorker ackだけ失敗した場合はdelivery receiptを保存し、本文再送よりack再同期を優先
- send失敗時はWorker側backoffへ戻し、自動試行上限後だけ明示retryを要求

完全なtransactional exactly-onceをChatGPT hostとの境界越しに偽装はしません。command IDとdelivery receiptで重複実行の可能性を最小化します。

詳細: [`chatgpt-bridge/README.md`](chatgpt-bridge/README.md)

**現在の重要な制約:** Worker QueueはPWAを閉じても残りますが、ChatGPT側Widgetが完全にunmount/suspendされている間は会話へ注入できません。Bridgeが再びactiveになればQueueから再開します。完全に閉じた任意の既存ChatGPT会話へサーバー側から無条件にメッセージを注入できる、と過大評価はしません。

また、ChatGPTの返答本文を外部PWAへ読み戻す公式transportが利用できない段階では、cookie/session scrapingで擬似的なresponse mirrorを作りません。現在はQueue状態とGitHub/CI evidenceをPWAへ集約します。

### Project cockpit

- モバイル優先PWA
- Goal / Definition of Done
- ChatGPT URL / GitHub URL
- RUNNING / WAITING_AI / WAITING_USER / STALLED / ERROR / RATE_LIMITED / CONTEXT_LIMIT / COMPLETED
- 工程・進捗・Activity
- `あなた待ち` 専用表示
- Operating Plan
- Setup DoctorでAtomic Coordinator状態を診断

`WAITING_USER / あなた待ち` は、本人確認・権限・secrets・レビュー/merge判断など本当に人間しかできない時だけ使用します。Bridge配送、ChatGPT作業、CI復旧は `WAITING_AI` 側です。

### Autopilot Route

- 自然文の順序・反復・条件分岐を実行契約化
- 「3回」「問題があれば」「その後」などをrouteとして扱う
- 完了済み工程を中断後にやり直さない
- 未完了地点から復旧
- route途中のCI成功では止めない
- 後続工程はChat Control Busへ自動Queue
- recoverable CI failureの復旧指示も自動Queue
- 全route終了 + `[AUTOPILOT_ROUTE_COMPLETE]` + 最新head CI成功で最終完了判定

### Supervisor / recovery

- Smart Reply
- DeepSeek / MiniMax / OpenAI provider router
- deterministic fallback
- Watchdog
- Supervisor Inbox
- Context Handoff
- Push
- Cloud state sync
- AUTO時のnext/recovery command自動Queue

### GitHub Guardian

Guardianは外部AI開発者ではなく、**ChatGPT作業を監督するハーネス**です。

- allowlist repoに安全な `ai-dev-deck/*` branch
- ChatGPT用作業指示をChat Control Busへ投入
- ChatGPT commit検出
- exact current head SHAのCIだけを証拠に採用
- pending → 待機
- transient CI → failed jobs再実行
- code failure → ChatGPT recovery prompt → 自動Queue
- Autopilot route途中のCI成功 → next-turn prompt → 自動Queue
- action_required → あなた待ち
- 一時GitHub/API障害 → 非終端で再監視
- CI成功 → Draft PR導線
- Cron/manual refresh競合 → Coordinatorの`guardian-advance` leaseで通常の二重advanceを抑止
- 自動mergeなし
- production deployなし

Guardian leaseは通常の二重advanceを抑える入口ロックであり、Guardian / Developer KV state全体を完全transactional/fencedにしたとは扱いません。

## 実行境界

| 層 | 役割 |
|---|---|
| ChatGPT | 実装・デバッグ・レビュー・GitHub編集・検証 |
| PWA | 複数chat操作・**全chat live overview**・状態表示・route指定 |
| ProjectCoordinator | command ownership/dedupe/retry・read-only overview summary・Cloud State revision・Guardian leaseの強整合調停 |
| Chat Control Bus | 指示Queueの永続化・配送状態 |
| ChatGPT Bridge | Queue commandを同じChatGPT会話へfollow-up送信・delivery receipt同期 |
| Supervisor | 状態整理・次手生成・completion判断・AUTO時Queue投入 |
| Guardian | branch / CI監視・retry・recovery / route next-turn Queue |
| DeepSeek / MiniMax / OpenAI API | 安価な分類・要約・次手/復旧生成のみ |
| KV | migration / history mirror / compatibility fallback |

外部LLMへGitHub write/delete/merge toolは渡しません。通常のexecutorに `API_WORKER` はありません。Workは明示選択時だけの別経路です。

## Low-cost orchestration

```text
DeepSeek V4 Flash
  ↓
MiniMax M3
  ↓
OpenAI fallback
  ↓
Deterministic ChatGPT handoff
```

全providerが利用不能でも、Queue・監督状態・安全なhandoffは残します。

## 失敗時の考え方

```text
Provider error
  → retry / fallback

Bridge send failure
  → same command IDでbackoff
  → old bridge ownership release
  → automatic retry
  → 上限後だけterminal failed

ChatGPT send success / Worker ack failure
  → delivery receipt保持
  → 本文を再送せずack再同期

Bridge crash after claim
  → stale claim recovery
  → next active bridgeが再claim

Guardian Cron + manual refresh
  → guardian-advance lease
  → one active advance

CI transient failure
  → rerun failed jobs
  → re-check

CI code failure
  → evidence整理
  → ChatGPT recovery command
  → Chat Control Busへ自動Queue
  → ChatGPT修正
  → new head再監視

human-required
  → safe stop + notification
```

**失敗は終了ではなく状態**として扱います。

## 軽量性のCI / runtime budget

スマホPWAであることを守るため、production build後にgzipサイズをCIで検査します。

- JavaScript: **130 KiB gzip以下**
- CSS: **20 KiB gzip以下**

さらにall-chat overviewはruntimeでも軽量性を守ります。

- compact batch summary
- full command promptをoverviewに含めない
- overview readでKV mirror writeを増幅しない
- 30件超は複数batchへ分割

budgetを超えた場合は、先にsecondary centerのlazy-loadや依存整理を検討し、安易に上限だけを上げません。

## 初回設定

- Product Constitution: [`docs/PRODUCT_CONSTITUTION.md`](docs/PRODUCT_CONSTITUTION.md)
- PWA: [`docs/SETUP.md`](docs/SETUP.md)
- Supervisor Worker: [`worker/README.md`](worker/README.md)
- ChatGPT Bridge: [`chatgpt-bridge/README.md`](chatgpt-bridge/README.md)
- Guardian: [`worker/GUARDIAN_RUNNER.md`](worker/GUARDIAN_RUNNER.md)
- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## ローカル開発

Product direction check:

```bash
npm run concept:guard
```

PWA:

```bash
npm install
npm run dev
npm run build
npm run bundle:budget
```

Worker:

```bash
cd worker
npm install
npm run check
```

`npm run check` はtypecheck、regression tests、SQLite Durable Objectを含むWrangler dry-runを実行します。

ChatGPT Bridge:

```bash
cd chatgpt-bridge
npm install
npm run check
```

CIではConcept Guardを最初に実行し、通過した場合だけ次の3系統を検証します。

- app build + mobile bundle budget
- worker typecheck + regression tests + SQLite Durable Object dry-run
- ChatGPT bridge typecheck + Cloudflare dry-run

## セキュリティ

- LLM API keyをPWAへ保存しない
- GitHub tokenをPWAへ保存しない
- Supervisor Worker tokenをChatGPT Widgetへ渡さない
- ChatGPT cookie/session tokenを取得・保存しない
- 非公式スクレイピングや認証回避を前提にしない
- Bridge project allowlistをfail-closedにする
- stale/non-owner Bridgeからのresult overwriteを拒否する
- 外部LLMにGitHub write/delete/merge権限を与えない
- main/default branchへWorkerからコードwriteしない
- 自動merge / production deployなし
- CI未確認を成功扱いしない

より詳しい設計判断は [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) を参照してください。
