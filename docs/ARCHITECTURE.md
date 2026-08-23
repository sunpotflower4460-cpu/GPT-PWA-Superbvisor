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
4. 状態監視・CI監視・通知
5. 「続けて」などの途中指示をSupervisorが代行
6. 複数工程・反復・条件分岐を持つAutopilot Route
7. 最初の指示から指定到達地点までの自動運転

Supervisor / Guardian / 外部LLM APIは主役ではなく、**Multi Chat Remoteをより放置可能にするための補助層**。

## 2. Core mental model

```text
User
  ↓ 1回の操作
AI DEV DECK PWA
  ├─ Chat A ─→ ChatGPT
  ├─ Chat B ─→ ChatGPT
  ├─ Chat C ─→ ChatGPT
  └─ Chat D ─→ ChatGPT
        ↑
        └─ Supervisor / Guardianが必要な時だけ次手を補助
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

PWAはChatGPTチャット本文を非公式にスクレイピングしない。

### Chat Control Bus

PWAから各ChatGPTへ送る指示を、端末ローカルの一時操作ではなくWorker側の永続キューとして扱う。

状態:

- queued
- claimed
- delivered
- failed
- cancelled

Bridge protocol:

1. PWAがchat commandをqueue
2. ChatGPT側Bridgeがclaim
3. 対象既存chatへ配送
4. delivered / failedをWorkerへ返却
5. PWAが状態を表示

現時点では外部PWAから任意の既存ChatGPT会話へ直接メッセージを注入する公式の一般公開経路は前提にしない。

そのため、Transport層は差し替え可能にし、PWA・状態管理・Autopilotは特定の非公式ブラウザ自動化へ依存させない。

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

Recover policy:

1. 一時障害は安全な範囲で再試行
2. コード由来の失敗はChatGPT用recovery commandを生成
3. 同じ失敗を無限再試行しない
4. 人間しか解決できない地点だけWAITING_USER
5. Push失敗など補助機能障害を開発完了判定と混同しない

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

高コストになりやすいためデフォルトでは使わない。ユーザーが明示的に選択した時だけ利用する。

## 4. Automation levels

### OFF

PWAは記録とMulti Chat一覧のみ。

### ASSIST

ユーザーがPWAから各chatを操作。Quick Command / resume / handoff候補を補助する。

### AUTO

Supervisorが途中の「続けて」「次へ」「失敗を直して再確認」等を判断してChat Control Busへ次commandを追加する。

実際の実装はChatGPTが行う。

### GUARDIAN

AUTOに加えてGitHub/CI監視、Retry、Recovery、Handoff、Completion Judge、Pushを有効化する。

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

## 7. Security rules

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

## 8. Completion rule

「ChatGPTが完了と言った」「APIがdoneと言った」だけでは完了しない。

通常案件:

Definition of Done + 実際の確認可能な証拠で判定する。

Autopilot Route案件:

1. 全route工程終了
2. route completion marker
3. 最新headに対応するCI/検証成功
4. 未処理human blockerの明示

を組み合わせる。

## 9. Implementation order from here

1. Multi Chat Control UI
2. Durable Chat Control Bus
3. Bridge adapter contract (`claim → deliver → result`)
4. 複数chatの状態同期 / unread / waiting表示
5. バックグラウンドQueue + Push
6. ChatGPT側の公式に利用可能なBridge実装
7. AUTO next-turn loop
8. Autopilot Route state machineの構造化
9. Evidence Matrix / Definition of Done判定
10. Durable lock / idempotency / multi-device coordination
11. Real-device PWA E2E

GuardianやAutopilotの高度化より、**PWA内から複数ChatGPTを自然に操作できることを常に優先する。**
