# AI DEV DECK architecture

## 1. Product goal

AI DEV DECKの出発点は、普段ChatGPTでGitHubリポジトリをつないで行っている開発を、**スマホPWAから複数チャット同時並行で、軽く、止まりにくく操作できるようにすること**。

第一の価値は「別のAI開発環境を作ること」ではない。

**ここで使っているChatGPT開発チャットを、そのまま複数束ねて遠隔操作すること。**

通常はChatGPTアプリ/ブラウザで複数チャットを行き来する必要があるが、AI DEV DECKではPWA内から案件を切り替え、各ChatGPTへ指示を送り、待機・失敗・人間待ち・完了を一覧で把握できる状態を目指す。

優先順位は以下。

1. 複数ChatGPT開発チャットの一元操作
2. 複数案件の同時並行と**全案件remote activityの一画面把握**
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
  ├─ all-chat activity overview ← compact batch summaries
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
- **案件を開かなくても各ChatGPTのremote activityを一覧表示**
  - 配送中
  - 再試行待ち
  - 送信待ち
  - Bridge待ち
  - 要確認
  - 最近送信済み
  - 接続中 / offline
- 全体の接続数 / 進行・待機数 / 要確認数
- 1案件を開いて自由文指示
- 「続ける」「問題点も確認」「手動だけまで」などのQuick Command
- 案件を行き来しながら連続して指示
- Project / Goal / Definition of Done
- Progress / milestone / timeline
- Human blockers
- Resume / Handoff
- Notification UI
- Atomic Coordinatorの有効/無効診断

Main Project画面とOperating Planの通常操作もChat Control Busへ直接送る。コピーはfallback。

PWAはChatGPTチャット本文を非公式にスクレイピングしない。

#### Lightweight all-chat overview

Primary Chat Controlは選択中のchatだけをpollしない。ChatGPT URLを持つ管理案件をまとめて `/api/chat-control/overview` へ送り、Worker側でcompact summaryへ変換する。

- PWA poll: 8秒
- Worker 1 request: 最大30 project
- 30件を超える場合: PWAが30件ずつbatch分割し、残りを黙って切り捨てない
- selected chatの詳細command/heartbeat pollは別途6秒
- overviewはfull prompt / command本文を返さない
- Coordinatorは `/commands/overview` でstatus/count/timestampだけを返す
- overview readを理由にKV history mirrorを書き直さない
- KV fallback時だけ最大100件のmetadata sourceからsummary化し、上限到達時は`approximate`を返す

これにより、複数案件を1件ずつ開かずに把握できることと、モバイルで軽いことを両立する。

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
- retry/requeue時の旧Bridge ownership解放
- manual fallback前のqueued/failed command cancel
- **read-only command overview summary**
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

Delivery failureはcommand IDを変えずにbackoff再試行する。既定の自動配送上限後のみterminal `failed` とし、PWA/Bridgeから同じcommandを明示再queueできる。requeue時には以前の`bridgeId` ownershipを外し、次のclaimで新しいownerを設定する。

#### Manual fallback handoff

自動Queueに残っているcommandをそのままClipboardへコピーして別ChatGPTタブから送ると、Bridge復帰後に同じ本文が再配送される可能性がある。したがってmanual fallbackは「別経路追加」ではなく、**automatic delivery ownershipからmanual deliveryへ安全に切り替える状態遷移**として扱う。

PWAの順序:

1. ChatGPT用のblank tabをユーザー操作中に確保
2. command promptをClipboardへコピー
3. `POST /api/chat-commands/<id>/cancel` でqueued/failed commandをcancel
4. cancel成功後だけ確保済みtabをChatGPT URLへ遷移

Failure rule:

- popup block → cancelしない
- Clipboard failure → cancelしない
- Bridgeが先にclaim済み → Coordinatorがcancelを409拒否し、PWAは手動送信しない
- cancel成功 → commandはterminal `cancelled` となり、Bridgeは後からclaimできない
- cancel失敗 → reserved blank tabを閉じる

Coordinator有効時、`/commands/cancel` と `/commands/claim` は同じproject Durable Object内で直列化される。cancelが先ならBridgeはclaimできず、claimが先ならmanual fallbackが停止する。KV fallbackでは同等の状態ルールは持つが、productionのatomic race guaranteeとは扱わない。

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

Multi Chat overviewはbundleだけでなくruntime costも抑える。

- compact summary only
- batch API
- full prompt/historyをoverviewに載せない
- read-triggered KV mirrorを避ける
- selected chat詳細pollとall-chat overview pollを分離する

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
- production deploy（許可なし）
- merge（オプトインかつCompletion Judgeが CERTIFIED と判定した場合のみ自動。CI/governanceに関わる変更(.github/workflows/、project-kernel.json、CODEOWNERS等)を含む差分は、opt-inの有無に関わらず常に対象外）

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
2. **全ChatGPT案件のlive remote activity rail + compact batch overview**
3. Durable Chat Control Bus
4. SQLite Durable Object `ProjectCoordinator`
5. atomic command enqueue / dedupe / claim / result ownership
6. read-only Coordinator command summary / no mirror-write overview polling
7. atomic Cloud State revision compare-and-update
8. KV migration + history mirror / compatibility fallback
9. delivery backoff / terminal retry / persisted receipt
10. retry/requeue時のstale Bridge ownership解放
11. **duplicate-safe manual fallback cancel / claim race handling**
12. project-specific Bridge heartbeat / claim / result
13. official ChatGPT Apps Bridge companion
14. Main Project / Operating Plan direct Queue path
15. human-only WAITING_USER semantics
16. AUTO/GUARDIAN next-turn + recovery auto-queue
17. Autopilot Route continuation contract
18. Setup Doctor atomic-coordinator diagnosis
19. Concept Guard + mobile bundle budget + Worker Durable Object dry-run
20. Guardian Cron/manual advance execution lease + lease regression tests
21. structured Autopilot Route progress (checkpoints + self-reported step marker) persisted chat-text-independently, surfaced in the Handoff packet
22. Completion Judgeが実際に取得したopen issue件数を完成判定へ反映(従来は表示のみで判定には未使用だった`testsPassing`/`unresolvedTodos`の未使用フィールドは削除)
23. Goal/Route/Task分離 + phase単位のCI evidence routing + context pressure + trace
24. Multi Chat / Specialist Chat: 宣言的なphase単位chatUrlバインディング(`routePlan.ts`)、Worker側dispatch routing/claim-time scoping/per-chat bridge可視化、Operating Plan UIでの割り当て編集
25. GPT-template連携: 実project-kernel.jsonに対するlive drift検知(週次スケジュール、PR CIはブロックしない)、新規プロジェクト作成時のGPT-template導線
26. Semantic Judge(`semanticJudge.ts`)の実装: LLMによる完了判定レビュー、KERNEL_AWAREプロジェクトのHANDOFF.md自己監査文書を証拠として評価(prompt injection対策のnonce区切り込み)、`refreshDeveloperJob`/`guardianRunner.ts`の実際の完了フローへの配線(Developer/Guardian両方のpush通知に反映、`GET .../completion`は再計算せず永続化済みcertificateを優先)
27. `scripts/local-ci.mjs`: GitHub Actionsが利用できない状況向けのローカルフォールバックCI(ci.ymlと同じジョブ構成)
28. Auto-merge(`autoMergePolicy.ts`): プロジェクトごとのopt-in(`autoMerge`)かつCompletion Judge `CERTIFIED`時のみ、Draft PRをready化しsquash mergeを試行(`markPullRequestReadyForReview`/`mergePullRequest`)。CI/governanceに関わるパス(`.github/workflows/`、`project-kernel.json`、`CODEOWNERS`、secrets等)を含む差分は非configurableにブロック。失敗は常にsoft-fail(既存のDraft/Open PRへフォールバック、Developer/Guardian両方のpush通知に反映)
29. ChatGPT Apps Bridge信頼性向上: (a) チャットコマンドが配送試行を使い果たし恒久的に`failed`となった場合、`chatCommandQueue.ts`が一度だけpush通知(以前は人間がChat Control Centerを開いて`failed`行に気づくまで無音でした)。(b) `guardianRunner.ts`のsweepが`waiting_chatgpt`/`handoff_ready`中のBridge heartbeat断絶を能動的に検知し、15分以上続いた場合に一度だけpush通知(`bridgeStallNotifiedAt`でデバウンス、再接続後の新たな断絶は再通知)。(c) Chat Control FABに未確認件数バッジを追加(シート未オープン時も低頻度background pollで鮮度を保つ)

Next high-priority gaps:

1. production Workerへ `PROJECT_COORDINATOR` binding/exportを実際にdeployし、healthで `atomicCoordinator:true` を確認
2. ChatGPT host上でのreal E2E: `PWA → Queue → Bridge → same conversation`
3. real-device PWA / Push / reconnect / multi-device E2E
4. 実運用で必要性が確認された場合、Guardian / Developer authoritative state自体をCoordinator/D1等へ寄せて完全fencingを追加
5. 公式に可能になった場合のみChatGPT response/statusのより深いreadback

1〜3はコードでは閉じられず実機・手動検証が必要な項目です。手順は
[`E2E_VERIFICATION.md`](./E2E_VERIFICATION.md) を参照してください。

GuardianやAutopilotの高度化より、**PWA内から複数ChatGPTを自然に操作できることを常に優先する。**
