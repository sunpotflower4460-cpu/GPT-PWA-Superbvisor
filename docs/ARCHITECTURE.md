# AI DEV DECK architecture

## 1. Product goal

スマホから複数のAI開発案件を同時に監督し、普段はChatGPT Chatを使いながら、必要時だけWorkやAPI Background Workerへ昇格する。

中心となる体験は「チャットを読むこと」ではなく、以下を数秒で把握・操作できること。

- 今どこまで進んだか
- 何が止まっているか
- 人間が必要か
- 次に何を指示すべきか
- 完成条件まであと何が残るか

## 2. Layers

### PWA cockpit

- Project / Goal / Definition of Done
- Progress / milestone / timeline
- Human blockers
- Quick Reply
- Resume / Handoff
- Notification UI

### Chat-first execution

通常は既存ChatGPT chatを主戦場にする。PWAはChatGPTチャット本文を非公式にスクレイピングしない。

通常Chatでは、Supervisorが生成した指示をユーザーが1タップでコピーしてChatGPTへ渡す。

### Supervisor

作業AIとは別の監督ロジック。

役割:

- completion判断
- stalled判定
- error/retry判断
- human-only判断
- context handoff判断
- next action生成

### Watchdog

将来バックエンドで定期的に状態を観測する。

状態:

- RUNNING
- WAITING_AI
- WAITING_USER
- STALLED
- ERROR
- RATE_LIMITED
- CONTEXT_LIMIT
- COMPLETED

Recover policy例:

1. 同じ方式の再試行は最大2回
2. 失敗が続けば別方式へ
3. 合計5回程度で解決しなければ人間へ
4. 完成条件を満たしたらCompletion Judgeへ

### GitHub evidence

AIの「完成しました」だけを信用せず、可能な範囲で成果物から確認する。

確認候補:

- latest commit
- open PR
- CI
- open issue
- unresolved TODO
- changed files
- merge state

公開リポジトリは読み取り専用のpublic GitHub APIでも扱える。private repositoryはブラウザにcredentialを置かず、将来backend/connector adapterを使う。

### API Background Worker

Chatでは端末依存や通常チャット上限を完全には制御できないため、絶対にバックグラウンド継続させたい工程だけ明示的に昇格する。

予定:

- Responses background mode
- webhook
- retry/recovery
- automatic handoff
- push notification

### Work

高コストになりやすいためデフォルトでは使わない。ユーザーが明示的に選択した時だけ利用する。

## 3. Automation levels

### OFF

PWAは記録だけ。

### ASSIST

Quick Reply / resume / handoff候補を生成。

### AUTO

Supervisorが次アクションを判断。ただし通常Chatへの自動投稿はしない。

### GUARDIAN

Supervisor + Watchdog + Retry + Recovery + Handoff + Completion Judgeを有効化する目標モード。

Chatを使う場合は、公式に自動投稿できない部分だけユーザーの1タップを残す。API Workerの場合は自動実行可能。

## 4. Handoff packet

長い会話を全文コピーせず、以下だけ引き継ぐ。

- project
- goal
- definition of done
- completed milestones
- current phase
- remaining tasks
- human blockers
- important decisions
- recent history
- next recommended action

## 5. Security rules

自動承認しやすい操作:

- test追加
- debug
- README/docs更新
-軽微なrefactor
- reversible bug fix

原則人間確認:

- 課金
- secrets/API key
- 本人確認
- production data削除
- irreversible external action
- 大きな仕様変更
- security-sensitive permission expansion

## 6. Implementation order

1. PWA foundation
2. Project state / Quick Reply
3. GitHub snapshot
4. Supervisor + Completion Judge
5. Smart Reply LLM
6. Watchdog
7. Checkpoint / Handoff
8. Backend / Background Worker
9. Push notification
10. Work escalation
11. Optional ChatGPT App / MCP integration
