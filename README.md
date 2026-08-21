# GPT-PWA-Superbvisor

スマホから複数のAI開発案件を並行管理するための **ChatGPT-first PWAコックピット** です。

> 基本はChat。必要な時だけBackground / Guardianへ昇格し、停止・エラー・引き継ぎ・完了をSupervisorが見える状態にします。

## まず使う

最短の初回設定は [`docs/SETUP.md`](docs/SETUP.md) を参照してください。

Chat-onlyで使うだけなら、OpenAI APIキー・Cloudflare Worker・GitHub tokenは不要です。

1. GitHub Pagesを `Source: GitHub Actions` にする
2. `Deploy PWA to GitHub Pages` workflowを実行
3. 公開URLをスマホで開き、ホーム画面へ追加
4. `＋` から案件を登録
5. ChatGPT URL / GitHub URL / Goalを入れて使い始める

Background / Guardian / Pushは必要になった時だけ追加設定します。

## 設計方針

- 通常運転は **ChatGPT Chat** を最優先
- **Work** へは勝手に切り替えず、ユーザーが明示的に選ぶ
- 通常Chatを外部PWAからスクレイピング・自動投稿しない
- PWAは案件状態・Operating Plan・復旧・通知・引き継ぎを管理する
- API実行は明示操作時だけ開始し、上限を持たせる
- GitHub状態やCIなど、AIの自己申告だけに依存しない情報を重視する
- 本人しかできない操作に到達したら `あなた待ち` として分離する

## 現在できること

### Project cockpit

- モバイル優先PWA
- 案件ごとのGoal / Definition of Done
- ChatGPT URL / GitHub URL登録
- 状態モデル
  - RUNNING
  - WAITING_AI
  - WAITING_USER
  - STALLED
  - ERROR
  - RATE_LIMITED
  - CONTEXT_LIMIT
  - COMPLETED
- 工程・進捗・Activityタイムライン
- `あなた待ち` 専用表示
- 現在の実行ルート表示

### Chat-first control

- Quick Reply
- Smart Reply（端末内ルール / 任意LLM）
- Operating Plan
  - 到達地点
  - 標準手順
  - 途中確認で止まらない
  - テスト・検証
  - 失敗時復旧
  - 自己レビュー
  - 最終報告
- Plan Execution Router
  - 💬 Chat
  - ⚡ Background
  - 🛡 Guardian
- Chat再開プロンプト
- Context Limit時のCheckpoint / Handoff packet

### Supervisor / recovery

- Watchdogによる停止疑い検出
- 停止・エラー・引き継ぎ推奨をSupervisor Inboxへ保存
- Inboxから再開プロンプトをコピーしてChatを開く
- Inboxから対象案件のHandoff Centerを開く
- Background / Guardian / Developer Agent結果の再同期
- Draft PRへの安全な導線

### Background / GitHub automation

任意のCloudflare Workerを設定すると利用できます。

- OpenAI Responses API background mode
- failed / incomplete時の上限付きAuto Recovery
- Webhook受信・状態保存
- Web Push
- GitHub Developer Agent
- Guardian Runner
  - 実装
  - CI確認
  - 失敗時の同一branch修正
  - 上限付きcycle監督
- 自動mergeはしない

### Setup / delivery

- Setup Doctor
  - HTTPS
  - Service Worker
  - PWA起動
  - 通知権限
  - Push購読
  - Worker接続
  - GitHub Agent設定
- GitHub Pages自動deploy workflow
- Pagesが未設定またはSourceがGitHub Actionsでない時は、赤エラーにせずdeployだけskip

## 実行モード

| ルート | 用途 | 追加API費用 | 端末を閉じても継続 |
|---|---|---:|---:|
| 💬 Chat | 通常の開発作業 | なし | 保証なし |
| ⚡ Background | 長い分析・非GitHub処理 | あり | 対応 |
| 🛡 Guardian | GitHub実装→CI→復旧監督 | あり | 対応 |
| 🟣 Work | 必要時にChatGPT側で明示選択 | プラン依存 | Work側仕様による |

## 初回設定

- PWAだけ使う: [`docs/SETUP.md`](docs/SETUP.md)
- Background Worker: [`worker/README.md`](worker/README.md)
- GitHub Developer Agent: [`worker/DEVELOPER_AGENT.md`](worker/DEVELOPER_AGENT.md)
- Guardian Runner: [`worker/GUARDIAN_RUNNER.md`](worker/GUARDIAN_RUNNER.md)
- アーキテクチャ: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## ローカル開発

```bash
npm install
npm run dev
```

ビルド確認:

```bash
npm run build
```

Worker:

```bash
cd worker
npm install
npm run typecheck
```

## セキュリティ

- OpenAI APIキーをPWAへ保存しない
- GitHub tokenをPWAへ保存しない
- Worker secretsはCloudflare側で管理
- 通常ChatGPTへの外部自動投稿はしない
- GitHub PRリンクは許可された `https://github.com` のみ開く
- Background / Guardianはユーザーの明示操作で開始
- 自動復旧には回数・時間上限を持たせる
