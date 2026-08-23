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
  ├─ Chat Aへ「続けて」
  ├─ Chat Bへ「問題点も確認」
  ├─ Chat Cへ「CI成功まで」
  └─ Chat DへAutopilot Route

        ↓

Durable Chat Control Bus
        ↓

複数ChatGPTがそれぞれ進行
        ↓

PWAで待機 / エラー / 本当のあなた待ち / 完了を確認
```

さらにAutopilotでは、例えば以下のような自然文ルートを指定できます。

> 3回デバッグ。問題があればあと数回デバッグ。大丈夫なら機能Aを追加。その後3回補強、3回デバッグ、最後にUI/UX改善を3回。

途中のCI成功を最終完了と誤認せず、順序・反復・条件分岐を守り、後続工程があれば次の指示をChat Control Busへ自動投入します。

## 第一優先の設計原則

1. **複数ChatGPT開発チャットをPWAから一元操作**
2. **複数案件を同時並行で扱える**
3. **スマホで軽く、PWAを閉じても状態・指示Queueを失わない**
4. GitHub / CI / Pushで外部状態を監視
5. Supervisorが途中の「続けて」「直して再確認」を代行
6. Autopilot Routeで複数工程を自動運転

Supervisor / Guardianは製品の主役ではなく、Multi Chat Remoteをより放置可能にするための補助層です。

## 現在できること

### Multi Chat Control

- 複数Project / ChatGPT URLを登録
- PWA内の **Chat Control Center** から案件を切り替え
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

### Durable Chat Control Bus

ChatGPTへの指示は端末上だけで持たず、WorkerのKVへ保存します。

```text
PWA / Supervisor / Guardian / Autopilot
  ↓
queued
  ↓
ChatGPT Bridgeがclaim
  ↓
delivered / failed
```

- PWAを閉じてもcommandを保持
- project単位でQueueを分離
- ChatGPT URL以外への配送を拒否
- Bridgeがclaim直後に落ちても、stale claimを回収して再配送可能
- automation由来commandはdedupe keyで重複投入を抑制

### ChatGPT Apps Bridge

`chatgpt-bridge/` にChatGPT Apps SDK / MCP companionを実装しています。

```text
PWA
  ↓
Supervisor Worker Queue
  ↓
ChatGPT Bridge Widget
  ↓
window.openai.sendFollowUpMessage(...)
  ↓
そのWidgetが置かれている同じChatGPT会話
```

- ChatGPT側Widgetから同じ会話へfollow-up message
- app-only MCP toolでheartbeat / claim / result
- Worker tokenはMCP serverだけが保持し、Widgetへ渡さない
- project allowlist必須
- projectごとのBridge heartbeat
- 複数案件を独立して接続可能

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
- 自動mergeなし
- production deployなし

## 実行境界

| 層 | 役割 |
|---|---|
| ChatGPT | 実装・デバッグ・レビュー・GitHub編集・検証 |
| PWA | 複数chat操作・状態表示・route指定 |
| Chat Control Bus | 指示Queueの永続化・重複抑制・配送状態 |
| ChatGPT Bridge | Queue commandを同じChatGPT会話へfollow-up送信 |
| Supervisor | 状態整理・次手生成・completion判断・AUTO時Queue投入 |
| Guardian | branch / CI監視・retry・recovery / route next-turn Queue |
| DeepSeek / MiniMax / OpenAI API | 安価な分類・要約・次手/復旧生成のみ |

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

Bridge crash after claim
  → stale claim recovery
  → next active bridgeが再claim

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

## 軽量性のCI budget

スマホPWAであることを守るため、production build後にgzipサイズをCIで検査します。

- JavaScript: **130 KiB gzip以下**
- CSS: **20 KiB gzip以下**

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
npm run typecheck
npm test
```

ChatGPT Bridge:

```bash
cd chatgpt-bridge
npm install
npm run check
```

CIではConcept Guardを最初に実行し、通過した場合だけ次の3系統を検証します。

- app build + mobile bundle budget
- worker typecheck + regression tests
- ChatGPT bridge typecheck + Cloudflare dry-run

## セキュリティ

- LLM API keyをPWAへ保存しない
- GitHub tokenをPWAへ保存しない
- Supervisor Worker tokenをChatGPT Widgetへ渡さない
- ChatGPT cookie/session tokenを取得・保存しない
- 非公式スクレイピングや認証回避を前提にしない
- Bridge project allowlistをfail-closedにする
- 外部LLMにGitHub write/delete/merge権限を与えない
- main/default branchへWorkerからコードwriteしない
- 自動merge / production deployなし
- CI未確認を成功扱いしない

より詳しい設計判断は [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) を参照してください。
