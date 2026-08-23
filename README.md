# GPT-PWA-Superbvisor

スマホから複数のAI開発案件を並行管理するための **ChatGPT-first PWAコックピット** です。

> **実作業はChatGPT。Cloudflare Workerと外部LLM APIはオーケストレーション専用。**

WorkerはChatGPTが閉じている間もGitHub branch / CI / 状態を監視し、失敗時の復旧指示を準備できます。ただし外部APIがコード実装やGitHub編集を代行したことにはしません。

## まず使う

最短の初回設定は [`docs/SETUP.md`](docs/SETUP.md) を参照してください。

Chat-onlyで使うだけなら、外部LLM APIキー・Cloudflare Worker・GitHub tokenは不要です。

1. GitHub Pagesを `Source: GitHub Actions` にする
2. `Deploy PWA to GitHub Pages` workflowを実行
3. 公開URLをスマホで開き、ホーム画面へ追加
4. `＋` から案件を登録
5. ChatGPT URL / GitHub URL / Goalを入れて使い始める

Supervisor / Guardian / Pushは必要になった時だけ追加設定します。

## 設計方針

- **ChatGPT Chat = 実装・デバッグ・レビューの実行主体**
- **Cloudflare Worker = 外部監督・状態保持・CI監視**
- **DeepSeek / MiniMax / OpenAI API = 状態分類・要約・次手/復旧指示生成のみ**
- 外部LLMへGitHub write/delete/merge toolを渡さない
- Workへは勝手に切り替えない
- 通常Chatを外部PWAからスクレイピング・自動投稿しない
- GitHub状態やCIなど、AIの自己申告だけに依存しない情報を重視する
- recoverableな失敗は終端にせず、原因分類→再試行/復旧指示→再監視へ進める
- 本人しかできない操作だけ `あなた待ち` として分離する

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
- 実行者と監督レベルの表示

### Chat-first control

- Quick Reply
- Smart Reply
  - DeepSeek / MiniMax / OpenAI provider router
  - 全provider障害時rule-based fallback
- Operating Plan
  - 到達地点
  - 標準手順
  - 途中確認で止まらない
  - テスト・検証
  - 失敗時復旧
  - 自己レビュー
  - 最終報告
- Plan Execution Router
  - 💬 ChatGPT
  - ⚡ Supervisor
  - 🛡 Guardian
- Chat再開プロンプト
- Context Limit時のCheckpoint / Handoff packet

### Supervisor / recovery

- Watchdogによる停止疑い検出
- 停止・エラー・引き継ぎ推奨をSupervisor Inboxへ保存
- Inboxから再開プロンプトをコピーしてChatを開く
- WorkerからChatGPT handoff promptを生成
- Provider retry / fallback
- Push通知
- Cloud state sync

### GitHub Guardian

Guardianは外部AI開発者ではなく、**ChatGPT作業を監督するハーネス**です。

- allowlist repoへ安全な `ai-dev-deck/*` branchを準備
- ChatGPT用の作業指示を生成
- ChatGPTのcommitを検出
- 現在branch head SHAと一致するGitHub Actionsだけ監視
- pending → 待機
- cancelled / timed_out / startup_failure / stale → failed jobs再実行
- code failure → ChatGPT recovery prompt生成
- action_required → 人間操作へ安全停止
- GitHub/API一時エラー → Guardianをfailed終了せず次Cronで再試行
- CI成功 → Draft PR / review導線
- 自動mergeなし
- production deployなし

### Low-cost orchestration

Provider Routerの標準例:

```text
DeepSeek V4 Flash
  ↓
MiniMax M3
  ↓
OpenAI fallback
  ↓
Deterministic ChatGPT handoff
```

モデルはvarsで差し替え可能です。全providerが利用不能でも、監督UIと安全なChatGPT引き継ぎは維持します。

### Setup / delivery

- Setup Doctor
  - HTTPS
  - Service Worker
  - PWA起動
  - 通知権限
  - Push購読
  - Supervisor Worker接続
  - GitHub Guardian設定
- GitHub Pages自動deploy workflow
- Pagesが未設定またはSourceがGitHub Actionsでない時はdeployだけskip

## 実行 / 監督モード

| ルート | 実際の作業者 | 外部APIの役割 | 端末を閉じた時 |
|---|---|---|---|
| 💬 ChatGPT | ChatGPT | なし | ChatGPT側仕様による |
| ⚡ Supervisor | ChatGPT | 状態整理・次手生成・通知 | 指示/状態を保持できる |
| 🛡 Guardian | ChatGPT | branch/CI監視・失敗分類・復旧指示 | Worker監督は継続 |
| 🟣 Work | ChatGPT Work | Work側仕様 | Work側仕様による |

重要: Supervisor / Guardianが端末非依存で継続するのは**監督処理**です。WorkerがChatGPTの会話を勝手に送信・継続するものではありません。

## 失敗時の考え方

```text
Provider error
  → retry
  → provider fallback
  → deterministic fallback

CI transient failure
  → rerun failed jobs
  → re-check

CI code failure
  → evidenceを整理
  → ChatGPT recovery prompt
  → ChatGPTが修正
  → new headを再監視

human-required
  → safe stop + notification
```

「失敗したので終了」ではなく、**失敗を次の状態として扱う**設計です。

## 初回設定

- PWA: [`docs/SETUP.md`](docs/SETUP.md)
- Supervisor Worker: [`worker/README.md`](worker/README.md)
- Guardian: [`worker/GUARDIAN_RUNNER.md`](worker/GUARDIAN_RUNNER.md)
- アーキテクチャ: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## ローカル開発

```bash
npm install
npm run dev
```

ビルド:

```bash
npm run build
```

Worker:

```bash
cd worker
npm install
npm run check
```

## セキュリティ

- LLM APIキーをPWAへ保存しない
- GitHub tokenをPWAへ保存しない
- Worker secretsはCloudflare側で管理
- 通常ChatGPTへの外部自動投稿はしない
- 外部LLMにGitHub write/delete/merge権限を与えない
- main/default branchへWorkerからコードwriteしない
- GitHubリンクは安全なhostだけ開く
- 自動merge / production deployなし
- CI未確認を成功扱いしない
- Provider/Push/GitHub一時障害を可能な限り非終端状態として扱う
