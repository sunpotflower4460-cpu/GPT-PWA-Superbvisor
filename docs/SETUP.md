# First-run Setup

AI DEV DECKをスマホPWAとして使い始めるための手順です。

このアプリは **Chat-first** です。最初からBackground WorkerやOpenAI APIを設定する必要はありません。

---

## 0. まず決める

### Chatだけで使いたい

必要なのは次だけです。

- GitHub Pages公開
- スマホでPWAを開く
- 案件登録

OpenAI APIキー / Cloudflare / GitHub tokenは不要です。

### 端末を閉じても処理を続けたい

後から次を追加します。

- Cloudflare Background Worker
- OpenAI API
- 必要ならWeb Push
- GitHub Developer Agent / Guardian

---

# 1. GitHub Pagesを有効にする

GitHubでこのリポジトリを開きます。

`Settings` → `Pages` → `Build and deployment`

`Source` を **GitHub Actions** にします。

これは最初の1回だけ必要です。

リポジトリには `.github/workflows/pages.yml` が入っており、PagesのSourceがGitHub Actionsになっている時だけPWAをbuild/deployします。

未設定、または従来のbranch配信設定の場合はdeployを安全にskipします。

---

# 2. Pagesをデプロイする

Pages設定を変更した直後は、次のどちらかを行います。

### 方法A: 次回main更新を待つ

PWA関連ファイルがmainへ入ると自動deployされます。

### 方法B: 今すぐ実行

GitHubの

`Actions` → `Deploy PWA to GitHub Pages` → `Run workflow`

から手動実行します。

成功すると通常は次の形式のURLになります。

```text
https://<GitHubユーザー名>.github.io/GPT-PWA-Superbvisor/
```

このリポジトリの場合の想定URL:

```text
https://sunpotflower4460-cpu.github.io/GPT-PWA-Superbvisor/
```

---

# 3. スマホへPWAとして追加する

## iPhone / iPad

SafariでPages URLを開きます。

1. 共有ボタン
2. `ホーム画面に追加`
3. 追加したアイコンから起動

Web Pushを使う場合も、ホーム画面へ追加したPWAから利用するのがおすすめです。

## Android

ChromeでPages URLを開き、メニューから `ホーム画面に追加` または `アプリをインストール` を選択します。

---

# 4. Setup Doctorを確認する

PWAを開くと右上付近に **診断** が表示されます。

まず確認する項目:

- HTTPS / Secure Context
- Service Worker
- PWAインストール
- プロジェクト登録

Workerを設定していなくても、Chat基本運転が利用可能なら問題ありません。

---

# 5. 最初の案件を登録する

ホームの `＋` から登録します。

入力するもの:

### 名前

例:

```text
Spotify Playlist Automation
```

### 最終目標

単なる「アプリを作る」より、AIがどこまで進めればよいかを書きます。

例:

```text
AIだけで可能な実装・テスト・レビューを完了し、本人しかできない外部設定だけが残る状態まで仕上げる
```

### ChatGPT URL

普段その案件を進めるChatGPT ChatのURLを登録します。

### GitHub URL

開発案件ならリポジトリURLを登録します。

例:

```text
https://github.com/owner/repository
```

---

# 6. Operating Planを決める

案件を開き、Operating Planで「毎回説明したくない進め方」を保存します。

おすすめ:

- 最初に現状確認: ON
- 途中確認で止まらない: ON
- テスト・検証する: ON
- 失敗時に復旧を試す: ON
- 停止前に自己レビュー: ON
- 最後に短く報告: ON

到達地点の例:

- 実装まで
- CI成功まで
- レビュー可能まで
- 本人しかできない手動だけになるまで

案件固有ルールには、たとえば次を書けます。

```text
モバイル優先。
無料または低コスト手段を優先。
既存機能を壊さない。
AIだけで安全に可能な工程は途中確認で止まらず進める。
```

---

# 7. 普段はChatで使う

Operating Planの実行先は通常 **💬 Chat** のままでOKです。

PWAはPlanを含んだ継続指示を作り、ChatGPTを開きます。

通常ChatへPWAが勝手に投稿することはありません。

Chatが止まった可能性がある時はWatchdogが検出し、Supervisor Inboxから

- 再開指示をコピー
- 元Chatを開く
- Context LimitならHandoff

へ進めます。

---

# 8. Chatが長くなったらHandoff

`CONTEXT_LIMIT` または引き継ぎ推奨になったら、Handoff Centerを使います。

Handoff packetには主に次が入ります。

- Project Goal
- 現在地点
- 完了済み工程
- 残工程
- 人間待ち
- 最近の履歴
- 継続ルール

全文会話ではなく状態を新しいChatへ持ち越す設計です。

---

# 9. Backgroundを使う場合だけWorkerを設定する

「端末を閉じても止めたくない」処理が必要になったら、Cloudflare Workerを設定します。

詳細:

[`../worker/README.md`](../worker/README.md)

必要になる主なもの:

- Cloudflare account
- OpenAI API key
- KV namespace
- `SUPERVISOR_CLIENT_TOKEN`
- OpenAI webhook

Worker URLと `SUPERVISOR_CLIENT_TOKEN` だけをPWAへ登録します。

**OpenAI APIキーそのものはPWAへ入力しません。**

---

# 10. Push通知は任意

Worker設定後、Supervisor InboxからPushを有効化できます。

必要:

- VAPID設定
- ブラウザー通知許可
- Push subscription

Pushを使わなくても、PWAを開いてInbox同期すればBackground / Guardian / Developer Agentの最新結果を復元できます。

Pushをタップすると、対象案件のSupervisor Inboxへ戻る設計です。

---

# 11. Guardianを使う場合

GitHub案件を端末非依存で

`実装 → CI → 失敗時修正 → 再確認`

まで監督したい場合に使います。

必要:

- Background Worker接続
- GitHub tokenをWorker secretへ設定
- `GITHUB_ALLOWED_REPOS`
- 案件にGitHub URLが登録済み

詳細:

- [`../worker/DEVELOPER_AGENT.md`](../worker/DEVELOPER_AGENT.md)
- [`../worker/GUARDIAN_RUNNER.md`](../worker/GUARDIAN_RUNNER.md)

Guardianは上限付きで動作し、自動mergeはしません。

---

# 12. Workについて

Workは通常ルートではありません。

このPWAから勝手にWorkへ昇格せず、必要な場合だけユーザーがChatGPT側で選択します。

普段の考え方:

```text
Chat
  ↓ 端末を閉じても続ける必要あり
Background / Guardian

Work
  = 必要と判断した時だけ明示選択
```

---

# トラブル時

## PWAが公開されない

確認:

1. `Settings > Pages`
2. `Source = GitHub Actions`
3. `Actions > Deploy PWA to GitHub Pages`
4. workflowを手動実行

## 診断でService Worker warning

一度ページを再読み込みし、ホーム画面に追加したPWAを閉じて開き直します。

## Workerがつながらない

Setup DoctorまたはBackground Worker画面でhealthを確認します。

確認:

- Worker URL
- `SUPERVISOR_CLIENT_TOKEN`
- `ALLOWED_ORIGIN`
- Worker deployment

## Pushが来ない

Supervisor Inboxで

- 通知権限
- Push購読
- テストPush

を確認します。

## Chatが止まった

Supervisor InboxのWatchdog通知から **再開してChatを開く** を使います。

## Chat上限・文脈上限

Handoff CenterからCheckpointを作り、新しいChatへ移します。

---

# セキュリティ上やらないこと

- OpenAI APIキーをPWA/localStorageへ置かない
- GitHub tokenをPWAへ置かない
- ChatGPT通常ChatをDOMスクレイピングしない
- 通常Chatへ外部から勝手に自動投稿しない
- Workへ勝手に切り替えない
- Guardianで勝手にmainへmergeしない

---

# 初回セットアップ完了の目安

Chat-first利用なら、Setup Doctorで最低限次が確認できれば開始できます。

```text
HTTPS              OK
Service Worker      OK
PWA                 installed 推奨
Project             1件以上
Worker              未設定でもOK
Push                未設定でもOK
GitHub Agent         未設定でもOK
```

Background / Guardianを使う時だけ、残りを後から設定してください。
