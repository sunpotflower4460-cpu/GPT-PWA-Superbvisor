# 実機・手動E2E検証 手順書

`docs/ARCHITECTURE.md` §10「Next high-priority gaps」のうち、コードでは閉じられず
実際の人手による検証が必要な3項目を対象にした手順書です。

```text
1. production Workerへ PROJECT_COORDINATOR binding/exportを実際にdeployし、
   healthで atomicCoordinator:true を確認
2. ChatGPT host上でのreal E2E: PWA → Queue → Bridge → same conversation
3. real-device PWA / Push / reconnect / multi-device E2E
```

`docs/SETUP.md`(初回セットアップ)・`worker/README.md`(Worker deploy)・
`chatgpt-bridge/README.md`(Bridge deploy)の**手順そのもの**はこの文書では繰り返さず、
「何を確認すれば閉じたと言えるか」だけをここにまとめます。設定コマンド自体は各READMEを参照してください。

セクション間の依存関係:

- 1・2はCloudflareアカウント・GitHub token等の環境構築が前提です。
- 3のうち**3-1(PWAインストール)だけ**はWorker未設定でも確認できます。3-2(Push)・3-3(再接続)は
  Worker設定が前提、3-4(複数端末)はさらに§1でAtomic Coordinatorが有効であることが前提です。

Chatだけで使っている場合は3-1のみ先に確認できますが、3-2以降・1・2はWorkerを設定してから
着手してください。

---

## 0. 事前チェック

作業前に、PWAの **診断(Setup Doctor)** を一度開いて現在地点を確認します。

- HTTPS / Secure Context: PASS であること(HTTPでない/localhostでない環境ではPush/PWAインストールが機能しない)
- Service Worker: PASS であること(WARNの場合はページ再読み込みで解消するか確認)

ここがFAILのままだと以降のPush/Bridge検証が正しく行えないため、先に解消してください。

---

## 1. Production Coordinator 検証(ARCHITECTURE.md gap #1)

### 目的

`PROJECT_COORDINATOR`(SQLite Durable Object)が本番Workerで実際に有効化されているかを確認する。
未設定のままだとKV compatibility fallbackで動作し、複数端末・複数Bridgeの同時実行時に
atomicな重複防止が効きません。

### 手順

1. `worker/README.md` の「2. Cloudflare Worker設定」に従い、`wrangler.jsonc` に
   `durable_objects.bindings` と `exports.ProjectCoordinator`(`storage: "sqlite"`)が
   **削除されずに残っている**状態でdeployする。
2. `worker/README.md` の「6. Deploy」に従い `npm run deploy` を実行する。
3. deploy後、ブラウザまたはcurlで直接確認する。

   ```http
   GET https://<your-worker>.workers.dev/health
   ```

   期待するレスポンス:

   ```json
   {
     "ok": true,
     "executor": "chatgpt",
     "orchestrationOnly": true,
     "chatCommandBus": true,
     "atomicCoordinator": true
   }
   ```

4. PWA側でもWorker URL / `SUPERVISOR_CLIENT_TOKEN` を登録した上で、**診断(Setup Doctor)** を開く。

### 合格条件

- `診断` の **Supervisor Worker** が PASS
- `診断` の **Atomic Multi-device Coordinator** が PASS
  (detail: 「SQLite Durable Objectが有効です。同一案件のQueue claim/dedupeとCloud State
  revisionを強整合で調停します。」)

`atomicCoordinator: false` のままの場合は、`wrangler.jsonc` の binding/export記述が
deployに反映されていない可能性が高いです。`npx wrangler deployments list` 等で
最新deployの内容を確認してください。

---

## 2. ChatGPT host 実機E2E(ARCHITECTURE.md gap #2)

### 目的

`PWA → Supervisor Worker → ProjectCoordinator → ChatGPT Apps Bridge →
window.openai.sendFollowUpMessage → 同じChatGPT会話` という実配送経路を、
実際のChatGPTアカウント上で確認する。

### 事前準備

1. `chatgpt-bridge/README.md` に従い、Bridge用のCloudflare Worker(または
   ローカルExpress + HTTPS tunnel)をdeployし、`/mcp` エンドポイントを用意する。
2. ChatGPTのDeveloper Mode / private appから、その `/mcp` エンドポイントを接続する。
3. PWA側で対象案件に **実在するChatGPT会話のURL** と **GitHub URL** を登録しておく。

### 手順(初回接続)

1. PWAの **Chat Control** を開き、対象案件を選択する。
2. **Bridgeを接続 ↗** ボタンを押す。
   - 接続指示がクリップボードへコピーされ、登録済みChatGPT URLが新しいタブで開く。
3. 開いたChatGPTへ、コピーされた指示を**一度だけ**貼り付けて送信する。
   (内部的に `connect_ai_dev_deck_bridge` toolが呼ばれる。)
4. PWAのChat Controlへ戻り、ヘッダーの表示が
   `● このChatGPTに接続中` に変わることを確認する。

### 手順(配送確認)

1. Chat Controlの「送信キュー」または案件のクイックコマンドから、任意の短い指示を1件送る。
2. 数秒〜数十秒待ち、**接続した実際のChatGPT会話に**その指示が実際に投稿されることを目視確認する。
3. コマンド一覧のstatusが `queued → delivered` (または同等の完了状態)に変わることを確認する。

### 手順(耐障害シナリオ — 最低限)

以下は `chatgpt-bridge/README.md` の "Background resilience" に書かれている設計を、
実機で裏取りする作業です。すべて1回ずつで構いません。

- **Widget休止からの復帰**: ChatGPTアプリ/タブをバックグラウンドにして数分放置し、
  前面に戻す。復帰後にqueueされていた指示が配送されることを確認する。
- **PWAを閉じた状態での配送**: 検証対象の端末でPWAを完全に閉じたことを確認したうえで、
  **別の端末・別ブラウザから**その案件へ指示をキューする。
  (同じ端末で「キューしてから閉じる」順序だと、閉じる前に接続中のBridgeが即座にclaim・配送してしまう
  可能性があり、「閉じた状態での配送」の検証にならない。)
  閉じた端末のPWAが起動していなくても指示が配送されることを確認する。
- **再送の重複がないこと**: 配送成功後、同じ指示が2重に会話へ投稿されていないことを確認する。

### 合格条件

- 初回接続でヘッダーが `● このChatGPTに接続中` になる
- キューした指示が実際のChatGPT会話へ実配送される
- 上記の耐障害シナリオで、指示が失われる/二重配送されるケースが無い

問題があった場合は、`chatgpt-bridge/README.md` の "Current platform limitation" を
再確認し(ChatGPT側Widgetが完全にunmountされている間は原理的に配送できない、という
既知の制約に該当していないか)、該当しない不具合であればここに記録して対応方針を検討してください。

---

## 3. 実機PWA / Push / 再接続 / 複数端末 E2E(ARCHITECTURE.md gap #3)

### 3-1. 実機PWAインストール

1. `docs/SETUP.md` の「3. スマホへPWAとして追加する」に従い、iPhoneまたはAndroidの
   実機でホーム画面へ追加する。
2. ホーム画面のアイコンから起動し、**診断** で以下を確認する。
   - PWAインストール: PASS(standalone表示になっていること)
   - HTTPS / Secure Context: PASS

### 3-2. Web Push実機確認

1. Worker側にVAPID設定済みであることを確認する(`worker/README.md` 「5. Web Push / VAPID」)。
2. 検証対象の端末で、PWAの通知Inboxから通知を有効化する(内部的に `enablePushNotifications` を呼ぶ)。
   ブラウザの通知許可ダイアログで **許可** を選択する。
3. **診断** で `Web Push購読` がPASSになったら、検証対象の端末でPWAを完全に閉じる
   (アプリ切り替えからも消す)。
4. **閉じた端末以外から**テストPushを送る。`sendTestPush`(`/api/push/test`)はWorkerに
   登録されている全端末へ配信するため、閉じた端末自身でボタンを押すと「閉じる前に送信済み」に
   なってしまい検証にならない。次のどちらかを使う。
   - 別の端末・別ブラウザでもPWAを開いており通知購読済みなら、そちらの通知Inboxから
     **テストPush送信** を実行する。
   - または直接APIを叩く。

     ```bash
     curl -X POST https://<your-worker>.workers.dev/api/push/test \
       -H "Authorization: Bearer <SUPERVISOR_CLIENT_TOKEN>"
     ```

5. 閉じておいた端末の実機通知センターにテスト通知が届くことを確認する。

テストPush(`/api/push/test`)は `projectId` を持たないため、タップすると常に汎用の
Supervisor Inbox(`?supervisor=inbox`)へ遷移する。案件別の遷移まで確認したい場合は、
このテストPushではなくGuardian/Watchdogが実際に発行する案件紐付きの通知
(例: `WAITING_USER`到達時のPush)を使うこと。

合格条件: **診断** の `通知権限` と `Web Push購読` が両方PASSになり、
PWAを閉じた状態でテストPushが実機の通知センターに届く。

### 3-3. 再接続(reconnect)確認

1. 機内モードなどで実機を一時的にオフラインにする。
2. オンラインに戻し、PWAを開き直す。
3. **診断**を再実行し、Supervisor Workerが再度PASSになることを確認する。
4. Guardian/Developer案件がある場合、オフライン中に進んだ状態(CI結果・復旧指示など)が
   正しく反映されていることを確認する(古い状態のまま止まっていないこと)。

### 3-4. 複数端末(multi-device)確認

**前提**: §1でAtomic Coordinatorが有効になっていること(KV fallbackのままではatomicな
重複防止が保証されません)。

1. 1台目の端末で案件を登録し、**データバックアップ画面の ☁ Cloud Sync** でこの端末のデータを
   Cloudへ保存する。
2. 2台目の端末(または同一端末の別ブラウザプロファイル)で同じ `SUPERVISOR_CLIENT_TOKEN` を設定し、
   Cloud Syncで**1台目と同じデータ(同じproject ID)を取り込む**。

   案件登録は端末ローカルのlocalStorageに保存され、新規作成のたびに新しいIDが割り当てられる。
   2台目で「同じ名前の案件」を作り直すと別IDになり、Coordinator側は project ID でスコープされる
   別々のcoordinatorを検証することになってしまうため、Cloud Syncで**同一IDのまま**共有すること。

3. 一方の端末からChat Controlで指示をキューする。
4. もう一方の端末でも、その指示・状態が(overview経由で)確認できることを確認する。
5. **enqueue dedupeの確認**: PWAのUIは送信のたびに端末ローカルの乱数dedupe keyを生成するため、
   2台から「同じ指示」を送ってもdedupe keyは別々になり検証にならない。同じdedupe keyを直接APIで
   2回送って確認する。

   ```bash
   curl -X POST https://<your-worker>.workers.dev/api/chat-commands \
     -H "Authorization: Bearer <SUPERVISOR_CLIENT_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"projectId":"<project-id>","chatUrl":"<chat-url>","prompt":"dedupe test","dedupeKey":"e2e-dedupe-test-1"}'
   ```

   同じ `dedupeKey` でもう一度実行し、新しいcommandが作られず**同じcommand IDが返る**ことを確認する。

6. **claim競合の確認**: 2台のBridge(2章で接続したChatGPT会話を2つ用意するか、Bridgeを2箇所へ
   deployする)を同じprojectへ接続した状態で、上記5でキューした1件のcommandに対し、
   片方のBridgeだけがclaimし、もう片方が同じcommandを二重配送しないことを確認する。
   (2台の端末から**別々の**指示をほぼ同時に送る方法は、それぞれ独立したcommandになるため
   claim競合の検証にはならない。)

### 合格条件(3全体)

- 実機ホーム画面インストール後もHTTPS/Service Worker/PWA判定がPASS
- PWAを閉じた状態でも実機通知センターへテストPushが届く
- オフライン→オンライン復帰後、Worker再接続と状態同期が正常に行われる
- 複数端末から同じ案件を扱っても、二重配送や状態の食い違いが起きない

---

## 検証結果の記録

上記1〜3すべてで合格条件を満たしたら、`docs/ARCHITECTURE.md` §10の
「Next high-priority gaps」から該当項目を削除し、「Implemented foundation」へ
一行追記してください(このセッションでPhase A〜Eを閉じてきた際と同じやり方です)。

一部だけ確認できた場合は、gapの文言に確認済み範囲(例: 「Bridge初回接続とテキスト配送は確認済み、
複数端末の同時競合シナリオは未検証」)を追記しておくと、次に着手する時に迷いません。

問題が見つかった場合は、再現手順・実際の挙動・期待した挙動をこの文書の末尾に追記するか、
新しいIssueとして記録してください。**推測で「直った」と扱わず、この手順書を再実行して
確認できた事実だけを合格として記録する**のが、このプロジェクトの完成判定の考え方
(`docs/ARCHITECTURE.md` §9 Completion rule)と一貫します。
