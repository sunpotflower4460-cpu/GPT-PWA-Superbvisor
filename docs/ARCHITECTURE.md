# AI DEV DECK architecture

## 1. Product goal

AI DEV DECKの出発点は、普段ChatGPTでGitHubリポジトリをつないで行っている開発を、**スマホPWAから複数チャット同時並行で、軽く、止まりにくく操作できるようにすること**。

第一の価値は「別のAI開発環境を作ること」ではない。

**ここで使っているChatGPT開発チャットを、そのまま複数束ねて遠隔操作すること。**

通常はChatGPTアプリ/ブラウザで複数チャットを行き来する必要があるが、AI DEV DECKではPWA内から案件を切り替え、各ChatGPTへ指示を送り、待機・失敗・人間待ち・完了を一覧で把握できる状態を目指す。

優先順位は以下。

1. 複数ChatGPT開発チャットの一元操作
2. 複数案件の同時並行
3. 軽量・モバイル優先・バックグラウンドで状態を失わないこと
4. 複数端末・複数Bridgeでも二重claim/lost updateを起こしにくいこと
5. 状態監視・CI監視・通知
6. 「続けて」などの途中指示をSupervisorが代行
7. 複数工程・反復・条件分岐を持つAutopilot Route
8. 最初の指示から指定到達地点までの自動運転

Supervisor / Guardian / 外部LLM APIは主役ではなく、**Multi Chat Remoteをより放置可能にするための補助層**。

通常の送信経路は `PWA → Chat Control Bus → ChatGPT Bridge → 対象ChatGPT`。clipboard/open-chatは障害時のfallbackだけにする。

## 2. Core mental model

```text
User / multiple devices
  ↓
AI DEV DECK PWA
  ├─ Chat A command ─┐
  ├─ Chat B command ─┼─→ Supervisor Worker
  ├─ Chat C command ─┤        ↓
  └─ Chat D route   ─┘   ProjectCoordinator (SQLite Durable Object)
                              ↓ strongly consistent
                        Durable Chat Control Bus
                              ↓
                       project-specific Bridge
                              ↓
                       existing ChatGPT chats
                              ↓
                   repository / GitHub / CI evidence
                              ↑
                   Supervisor / Guardian support
```

ChatGPTは外部の別AIではない。

**GitHub接続や各種ツールを使って実装・デバッグを行う、現在のChatGPTチャットそのものが実行主体。**

Cloudflare Worker、DeepSeek、MiniMax、OpenAI API等は、ChatGPTの代わりにコードを書くためではなく、キュー、状態保持、分類、次手生成、CI監視、復旧、通知に限定する。

## 3. Layers

### Multi Chat Remote / PWA cockpit

最優先レイヤー。

- 複数Project / ChatGPT chatの一覧
- 1案件を開いて自由文指示
- 「続ける」「問題点も確認」「手動だけまで」などのQuick Command
- 案件を行き来しながら連続して指示
- 各チャットの送信待ち / 処理中 / 送信済み / 失敗状態
- Project / Goal / Definition of Done
- Progress / milestone / timeline
- Human blockers
- Resume / Handoff
- Notification UI
- Atomic Coordinatorの有効/無効診断

Main Project画面とOperating Planの通常操作もChat Control Busへ直接送る。コピーはfallback。

PWAはChatGPTチャット本文を非公式にスクレイピングしない。

### Project Coordinator / strong consistency boundary

productionの複数端末競合耐性を担うauthoritative state boundary。

実装はSQLite-backed Cloudflare Durable Object `ProjectCoordinator`。

担当:

- project単位command enqueue / dedupe
- FIFO claimの直列化
- active claim ownerの一意性
- stale claim takeover
- claim ownerとresult reporterの一致確認
- delivery failure回数 / backoff / terminal failure
- terminal failureの明示retry
- Cloud State revision compare-and-update
- Guardian runの短期execution lease取得 / renew / release

Queue/stateの強整合な判断はCoordinator内で行う。KVは既存データのmigration、履歴mirror、互換fallbackとして残す。

**KV-onlyのread → compare → writeをatomic guaranteeとは呼ばない。** `PROJECT_COORDINATOR` bindingが無効なWorkerは互換運転できるが、Setup Doctorがmulti-device safety警告を出す。

Guardian leaseは同じrunへCron/manual refreshが同時に入る通常競合を抑えるための入口ロックであり、Guardian / Developerの全state writeをtransactional storageへ移したものではない。lease期限を超える異常に長い処理まで完全fencingできるとは扱わない。

### Chat Control Bus

PWA / Supervisor / Guardian / Autopilotから各ChatGPTへ送る指示を、端末ローカルの一時操作ではなくWorker側の永続キューとして扱う。

状態:

- queued
- claimed
- delivered
- failed
- cancelled

Bridge protocol:

1. PWAまたはautomation layerがchat commandをqueue
2. ProjectCoordinatorがdedupeし永続化
3. ChatGPT側Bridgeがproject単位でclaim
4. Coordinatorが同時に1 Bridgeだけへownershipを与える
5. 対象既存chatへ配送
6. owner Bridgeがdelivered / failedをWorkerへ返却
7. PWAが状態を表示

Autopilot / recovery由来のcommandにはdedupe keyを付け、監視ループの重複配送を防ぐ。

Delivery failureはcommand IDを変えずにbackoff再試行する。既定の自動配送上限後のみterminal `failed` とし、PWA/Bridgeから同じcommandを明示再queueできる。

### ChatGPT Bridge

公式Apps SDK / MCP compatible transportを使う。

- project allowlist
- server-side Worker token
- heartbeat
- atomic claim
- same-conversation follow-up
- claim-owner result report
- stale claim recovery
- delivery backoff
- terminal failed command retry
- delivery receipt

Bridgeが完全にunmount/suspendされている間はcommandをQueueへ保持し、active復帰時に再開する。

`sendFollowUpMessage` 成功後にWorkerへのackだけ失敗した場合は、Widgetがdelivery receiptを保持し、本文をすぐ再送せずack同期を優先する。

各配送promptにはAI DEV DECK command IDを付ける。外部hostとの境界を跨ぐため完全なtransactional exactly-onceを偽装せず、同じIDをすでに実行済みなら重複実行しないようChatGPTへ明示する。

**完全に閉じた任意の既存ChatGPT会話を外部から無条件にwakeできる、とは扱わない。**

また、ChatGPT返答本文を外部PWAへ読み戻す公式transportが利用できない場合、cookie/session scrapingで擬似的に実装しない。現状はcommand statusとGitHub/CI evidenceをPWAへ集約し、response mirroringは公式手段が確認できた時だけ追加する。

### ChatGPT execution

実作業の本体。

- repository確認
- 実装
- debug
- test
- review
- GitHub変更
- CI結果を踏まえた修正

外部LLMの自己申告を完成根拠にしない。

### Supervisor

Multi Chat Remoteを補助する監督ロジック。

役割:

- 次にChatGPTへ送る指示を整理
- completion判断
- stalled判定
- error/retry判断
- human-only判断
- context handoff判断
- next action生成
- AUTO時のChat Control Bus投入

Supervisor自身はコードを実装しない。

### Guardian / Watchdog

PWAを閉じている間も外部証拠を監視する。

観測状態:

- RUNNING
- WAITING_AI
- WAITING_USER
- STALLED
- ERROR
- RATE_LIMITED
- CONTEXT_LIMIT
- COMPLETED

State rule:

- Bridge配送待ち / ChatGPT作業待ち → `WAITING_AI`
- CI監視 / recovery command配送 → `WAITING_AI`
- 本人確認 / secrets / permission / review / merge判断 → `WAITING_USER`

Recover policy:

1. 一時障害は安全な範囲で再試行
2. コード由来の失敗はChatGPT用recovery commandを生成
3. AUTO/GUARDIANではrecovery commandをChat Control Busへ自動投入
4. 同じ指示を無限・重複配送しない
5. 人間しか解決できない地点だけWAITING_USER
6. Push失敗など補助機能障害を開発完了判定と混同しない

Concurrency policy:

1. Coordinator有効時は同一Guardian runの`advance`前に`guardian-advance` leaseを取得
2. Cron sweepと手動refreshが競合した場合、lease取得者だけがadvanceする
3. 長い処理の前にleaseをrenewする
4. release失敗はlease expiryで回復可能なのでrunをterminal failureにしない
5. leaseは通常競合抑止であり、Guardian / Developer KV state全体の完全transactional fencingとは区別する

### GitHub evidence

AIの「完成しました」だけを信用せず、可能な範囲で成果物から確認する。

確認候補:

- latest commit / exact head SHA
- open PR
- CI
- open issue
- unresolved TODO
- changed files
- merge state

完成判定はChatGPTまたは外部APIの自己申告より、実際の証拠を優先する。

### Orchestration LLM

DeepSeek / MiniMax / OpenAI API等。

役割は低コストな以下の処理だけ。

- 状態分類
- 要約
- next-turn command生成
- recovery command生成
- Autopilotの次工程整理

GitHub write/delete/merge toolは渡さない。

### Work

高コストになりやすいためデフォルトでは使わない。ユーザーが明示的に選択した時だけ利用する。通常のexecutor selectorとしてAPI Workerを持たない。

## 4. Automation levels

### OFF

PWAは記録とMulti Chat一覧のみ。

### ASSIST

ユーザーがPWAから各chatを操作。Quick Command / resume / handoff候補を補助する。

### AUTO

Supervisorが途中の「続けて」「次へ」「失敗を直して再確認」等を判断し、Chat Control Busへ次commandを自動追加する。

`CHAT`だから自動継続不可、とは扱わない。実際の実装はChatGPTが行う。

### GUARDIAN

AUTOに加えてGitHub/CI監視、Retry、Recovery、Handoff、Completion Judge、Pushを有効化する。

初回handoff、recoverable CI failure、Autopilot次工程はChat Control Busへ自動投入する。

## 5. Autopilot Route

Autopilotは単純な「最後まで続ける」だけではない。

ユーザーは自然文でルートを指定できる。

例:

> 3回デバッグ。問題があればあと数回デバッグ。大丈夫なら機能Aを追加。その後3回補強、3回デバッグ、最後にUI/UX改善を3回。

重要ルール:

- 指定順序を守る
- 指定反復回数を省略しない
- 条件分岐を評価する
- 中断後は完了済み工程をやり直さず未完了地点から再開
- 各反復は同じ操作の機械的コピーではなく新しい観点で検証
- 途中のCI成功をルート全体の完了と誤認しない
- CI成功後に後続工程があればcontinuation commandを自動Queue
- recoverable failureならrecovery commandを自動Queue
- 全ルート終了 + 必要な証拠確認後のみ完了扱い

## 6. Handoff packet

長い会話を全文コピーせず、以下を引き継ぐ。

- project
- chat target
- goal
- definition of done
- Autopilot Route
- completed route steps
- current route step / iteration
- completed milestones
- current phase
- remaining tasks
- human blockers
- important decisions
- recent history
- next recommended action

## 7. Performance boundary

「軽い」はProduct Constitutionの一部として数値で監視する。

現行CI budget:

- JavaScript gzip: 130 KiB以下
- CSS gzip: 20 KiB以下

budget超過時は、上限引き上げより先にsecondary centerのlazy-load、重複UI削減、依存削減を検討する。

## 8. Security rules

自動承認しやすい操作:

- test追加
- debug
- README/docs更新
- 軽微なrefactor
- reversible bug fix
- CI再確認

原則人間確認:

- 課金
- secrets/API key
- 本人確認
- production data削除
- irreversible external action
- 大きな仕様変更
- security-sensitive permission expansion
- merge / production deploy（明示許可がない限り）

Chat transportについても、ChatGPT session cookieの窃取・非公式な認証回避・秘密情報の保存を前提にしない。

## 9. Completion rule

「ChatGPTが完了と言った」「APIがdoneと言った」だけでは完了しない。

通常案件:

Definition of Done + 実際の確認可能な証拠で判定する。

Autopilot Route案件:

1. 全route工程終了
2. route completion marker
3. 最新headに対応するCI/検証成功
4. 未処理human blockerの明示

を組み合わせる。

## 10. Current implementation status / next gaps

Implemented foundation:

1. Multi Chat Control UI
2. Durable Chat Control Bus
3. SQLite Durable Object `ProjectCoordinator`
4. atomic command enqueue / dedupe / claim / result ownership
5. atomic Cloud State revision compare-and-update
6. KV migration + history mirror / compatibility fallback
7. delivery backoff / terminal retry / persisted receipt
8. project-specific Bridge heartbeat / claim / result
9. official ChatGPT Apps Bridge companion
10. Main Project / Operating Plan direct Queue path
11. human-only WAITING_USER semantics
12. AUTO/GUARDIAN next-turn + recovery auto-queue
13. Autopilot Route continuation contract
14. Setup Doctor atomic-coordinator diagnosis
15. Concept Guard + mobile bundle budget + Worker Durable Object dry-run
16. Guardian Cron/manual advance execution lease + lease regression tests

Next high-priority gaps:

1. production Workerへ `PROJECT_COORDINATOR` binding/exportを実際にdeployし、healthで `atomicCoordinator:true` を確認
2. ChatGPT host上でのreal E2E: `PWA → Queue → Bridge → same conversation`
3. real-device PWA / Push / reconnect / multi-device E2E
4. structured Autopilot route progressをchat textとは独立して永続化
5. 実運用で必要性が確認された場合、Guardian / Developer authoritative state自体をCoordinator/D1等へ寄せて完全fencingを追加
6. 公式に可能になった場合のみChatGPT response/statusのより深いreadback

GuardianやAutopilotの高度化より、**PWA内から複数ChatGPTを自然に操作できることを常に優先する。**
