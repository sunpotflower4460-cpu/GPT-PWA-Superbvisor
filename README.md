# GPT-PWA-Superbvisor

スマホから複数のAI開発案件を軽く並行管理するための、ChatGPT-firstなPWAコックピットです。

## 方針

- 通常運転は **ChatGPT Chat** を優先
- **Work** は必要なときだけユーザーが明示的に選択
- PWA側は、案件・Goal・完成条件・進捗・人間待ち・Quick Reply・履歴を管理
- 将来のSupervisor / Watchdog / Background Workerを前提にした状態モデルを最初から持つ
- ChatGPTの通常チャットを外部から無理にスクレイピング・自動操作しない

## v0.1 foundation

現在の `feat/pwa-foundation` では以下を実装中です。

- React + TypeScript + Vite
- インストール可能なPWA基盤
- オフライン用Service Worker
- モバイル優先ダッシュボード
- プロジェクト登録
- Goal / Definition of Done
- ChatGPT URL / GitHub URL登録
- 実行モード: CHAT / WORK / API_WORKER
- 自動化レベル: OFF / ASSIST / AUTO / GUARDIAN
- 状態モデル: RUNNING / WAITING_AI / WAITING_USER / STALLED / ERROR / RATE_LIMITED / CONTEXT_LIMIT / COMPLETED
- 工程と進捗表示
- 人間待ち表示
- Quick Replyと継続プロンプト生成
- 中断再開用プロンプト
- ローカル保存
- Activityタイムライン
- CI build check

## 次の実装順

1. GitHub連携層（PR / CI / commit / issue 状態取得）
2. Supervisor状態更新とCompletion Judge
3. 軽量LLMによるReply Predictor / Smart Reply
4. Watchdog / stall detection / retry policy
5. Checkpoint / Handoff packet
6. API Background Worker + webhook
7. Push通知
8. Workへの明示的Escalation
9. ChatGPT App / MCP連携は提供条件を見ながら追加

## 開発

```bash
npm install
npm run dev
```

ビルド確認:

```bash
npm run build
```
