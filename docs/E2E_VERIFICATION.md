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

- 1・2はCloudflareアカウントでのWorker/Bridge deployが前提です。GitHub tokenは
  Guardian(GitHub連携)専用の別設定で、Coordinator/Chat Control Bridgeのどちらにも不要です。
- 3のうち**3-1(PWAインストール)だけ**はWorker未設定でも確認できます。3-2(Push)・3-3(再接続)は
  Worker設定が前提、3-4(複数端末)はさらに§1でAtomic Coordinatorが有効であることが前提です。

Chatだけで使っている場合は3-1のみ先に確認できますが、3-2以降・1・2はWorkerを設定してから
着手してください。

---

## 0. 事前チェック

作業前に、PWAの **診断(Setup Doctor)** を一度開いて現在地点を確認します。

- HTTPS / Secure Context: PASS であること(HTTPでない/localhostでない環境ではPush/PWAインストールが機能しない)
- Service Worker: PASS であること(WARNの場合はページ再読み込みで解消するか確認)

Service Workerの状態が影響するのは3-1(PWAインストール)と3-2(Push)だけです。
Setup Doctor自身もService Workerを `requiredForChat: false` としており、
Coordinator(§1)やChat Control Bridge(§2)は通常のWorker宛てfetchのみで動作し、
PWA自身のService Workerを経由しません。Service WorkerがFAIL/WARNのままでも
§1・§2は問題なく進められます。3-1・3-2に着手する前にだけ解消してください。

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
3. PWA側で対象案件に **実在するChatGPT会話のURL** を登録しておく。
   Chat Control / Bridge配送はGitHub URLを必要としない
   (`enqueueChatCommand` はprojectId・chatUrl・promptのみ検証し、Bridgeのclaimも
   project ID単位でスコープされる)。GitHub連携が必要なのはGuardian固有の機能のみで、
   この章の検証には無関係。

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

以下の「別の端末・別ブラウザから指示をキューする」は、**その同じproject IDへ向けて
直接APIを叩けば十分**です。案件登録はlocalStorageに保存され新規作成のたびに新しい
IDが割り当てられるため、2台目の端末でPWAを開いて同じ名前の案件を作り直しても別IDに
なり、この案件のBridgeには届きません(3-4で詳しく扱う制約と同じ)。UIでの再登録や
Cloud Syncは不要で、1台目で確認済みのproject IDとChat URLを使って直接キューします。

```bash
curl -X POST https://<your-worker>.workers.dev/api/chat-commands \
  -H "Authorization: Bearer <SUPERVISOR_CLIENT_TOKEN>" -H "Content-Type: application/json" \
  -d '{"projectId":"<project-id>","chatUrl":"<chat-url>","prompt":"resilience test"}'
```

- **Widget休止からの復帰**: ChatGPTアプリ/タブをバックグラウンドにし、**その状態のまま**
  別の端末・別ブラウザからその案件へ指示を1件キューする。数分放置してから前面に戻し、
  休止中にキューされていたその指示が復帰後に配送されることを確認する。
  (先にキューしてからバックグラウンドにすると、休止する前にBridgeが即座に配送してしまう
  可能性があり、「休止中にqueueされていた指示の復帰後配送」を検証したことにならない。)
- **PWAを閉じた状態での配送**: 検証対象の端末でPWAを完全に閉じたことを確認したうえで、
  **別の端末・別ブラウザから**その案件へ指示をキューする。
  (同じ端末で「キューしてから閉じる」順序だと、閉じる前に接続中のBridgeが即座にclaim・配送してしまう
  可能性があり、「閉じた状態での配送」の検証にならない。)
  閉じた端末のPWAが起動していなくても指示が配送されることを確認する。
- **再送の重複がないこと(通常配送)**: 配送成功後、同じ指示が2重に会話へ投稿されていないことを確認する。
- **delivery receipt再同期(host送信成功・Worker ack失敗)**: 上の3つとは別の、より狭いシナリオ。
  ChatGPTへ指示が実際に投稿された直後(会話に文字が表示された直後)、Bridgeが結果をWorkerへ
  報告し終える前を狙って、ChatGPTを実行している端末を一瞬オフラインにする(機内モードON→数秒後OFF)。
  Bridgeが再びオンラインになった時、**同じ指示がもう一度ChatGPTへ重複投稿されず**、
  Worker側のcommand状態が正しく `delivered` 系へ収束することを確認する。
  タイミングがシビアなため、1回で再現しなくても構わない(再現できた場合のみ合格として記録し、
  再現できなかった場合は「未検証」と明記する)。

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

また `/api/push/test`(`sendSupervisorPush`)はKVから購読を最大100件しか取得せず
(`worker/src/push.ts`: `SUPERVISOR_STATE.list({ prefix: PREFIX, limit: 100 })`、
cursorによる続き取得なし)、登録済み端末が100件を超える環境では取得順で後ろに
なった端末に届かないことがある。届かない場合は購読自体が壊れているとは限らず、
この上限によるものである可能性を先に切り分けること(検証用デプロイでは登録端末数を
少数に保つのが望ましい)。

合格条件: **診断** の `通知権限` と `Web Push購読` が両方PASSになり、
PWAを閉じた状態でテストPushが実機の通知センターに届く。

### 3-3. 再接続(reconnect)確認

1. 検証対象の端末を機内モードなどで一時的にオフラインにする。
2. オフラインのまま、**別の端末・別クライアント**から、その端末が確認できる既知の変化を
   1つ意図的に起こす(例: Chat Controlで指示を1件キューする、GuardianのあるCI失敗を
   再確認させる、など)。「たまたま何か進んでいたら確認する」のではなく、確認対象を
   先に決めておく。
3. オンラインに戻し、PWAを開き直す。
4. **診断**を再実行し、Supervisor Workerが再度PASSになることを確認する。
5. 手順2で起こした**その特定の変化**が、この端末にも正しく反映されていることを確認する
   (古い状態のまま止まっていないこと)。

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

3. **Cloud State revision競合の確認**: 手動保存ボタン(「この端末 → Cloudへ保存」)の
   競合エラーはUI上ほぼ即座に消えてしまい(保存失敗直後に呼ばれる状態確認処理が
   エラー表示を上書きするため)、この確認には使えない。代わりに**両端末でAuto Sync
   (自動同期)をON**にすること。

   マージ処理(`mergeNewestBackup`、`src/DataBackupCenter.tsx`)は案件を**project ID単位で
   丸ごと**マージし、同じIDの案件が両端末にある場合は `lastActivityAt` が新しい方の
   レコードを丸ごと採用する(フィールド単位のマージではない)。そのため**同じ案件の
   別々のフィールドを両端末で変えても、両方は残らない**(新しい方の端末の変更だけが残るのが
   正しい挙動になり、「両方残るべき」という期待値が成立しない)。データを失わずにマージ
   できることを確認するには、**別々の案件(別のproject ID)**を使う必要がある。

   両端末が一度同じrevisionまで自動同期された状態から、Auto Syncが次に同期する前に、
   端末Aは共有中の案件(1台目と同じproject ID)の**工程(automation level)ボタンを
   別の値に変更する**(案件名は作成時にしか設定できず、既存案件を開いた画面には
   rename機能がないため、実際にUIから編集できるこのフィールドを使う)。端末Bは
   **それとは別の新しい案件をローカルで作成する**(端末Bだけのローカル案件でよく、
   project IDが共有案件と違う限り新規作成で構わない)。
   片方の自動同期が先に成功し、もう片方が「Cloud Sync: 競合を検出」という通知
   (Supervisor Inboxに残る。自動上書きしない)を受け取ることを確認する。
   タイミングが揃わず両方成功してしまった場合は、変更する間隔を詰めて再試行する。
   両方が無条件に成功して片方の変更が黙って消えてしまう場合は不合格。

   競合を確認したら、負けた側の端末で通知の案内どおり「設定 → データバックアップ →
   Cloudから安全にマージ」を実行する。この操作(`mergeCloudIntoDevice`、
   `src/DataBackupCenter.tsx`)は**マージ結果をこの端末のローカルにしか書き込まない**
   (Cloudへの反映は次回のAuto Sync送信を待つ)ため、負けた側の端末だけを見て
   「共有案件のautomation level変更と端末Bの別案件、両方が消えずに残っている」ことを
   確認しただけでは不十分——Cloud本体や勝った側の端末に伝播したかどうかは別問題であり、
   その後方の伝播経路が壊れていてもこの時点では気づけない。したがって:
   - 負けた側の端末で上記マージ後の内容を確認したら、その端末のAuto Syncが次に
     Cloudへ送信するまで待つ(または手動で「この端末 → Cloudへ保存」を実行する)。
   - 勝った側の端末でも次のAuto Syncが実行されるのを待つ(または手動でCloudから取得する)。
   - **勝った側の端末でも**、共有案件のautomation level変更と端末Bの別案件の両方が
     消えずに反映されていることを確認する。
   ここまで確認して初めて、両端末とCloud本体が矛盾なく収束したと言える。競合通知が
   出た時点や負けた側の端末だけで確認を止めると、マージ処理自体やその後の伝播が
   壊れていて片方の変更を黙って消していても見逃す。
4. 一方の端末からChat Controlで指示をキューする。
5. もう一方の端末で、その指示が実際にキューされたことを確認する。
   overviewは接続状態・件数・最新timestampなどの集約metadataしか持たないため、
   overview上の状態だけでは「その指示」を確認したことにならない。対象案件を開き、
   コマンド一覧(または `GET /api/projects/<project-id>/chat-commands`)で、
   実際に送った指示の本文・IDと一致する項目があることまで確認する。
   さらに、2章で接続したBridgeがこの指示を実際に配送し終えるまで待ち、配送完了後に
   **両端末**でその同じcommand IDのstatusを再確認する。片方の端末だけ`delivered`系に
   進み、もう片方が古い`queued`のまま止まっている場合(片方のPWAのpolling/refreshが
   壊れている可能性)は不合格。「キュー時点で両方から見えた」だけでなく、
   「配送完了後も両端末が同じ終端状態に収束する」ことまで確認する。
6. **enqueue dedupeの確認**: PWAのUIは送信のたびに端末ローカルの乱数dedupe keyを生成するため、
   2台から「同じ指示」を送ってもdedupe keyは別々になり検証にならない。同じdedupe keyを直接APIで
   2回送って確認する。

   dedupe indexはcommand本体と同じ保持期間(14日)残り続けるため、固定文字列のキーだと
   このrunbookを同じprojectで再実行したときに**前回実行時のcommandがそのまま返るだけ**になり、
   今回のenqueueを何も検証したことにならない。実行のたびにユニークなキーを生成すること。

   ```bash
   DEDUPE_KEY="e2e-dedupe-test-$(date +%s%N)"
   curl -X POST https://<your-worker>.workers.dev/api/chat-commands \
     -H "Authorization: Bearer <SUPERVISOR_CLIENT_TOKEN>" \
     -H "Content-Type: application/json" \
     -d "{\"projectId\":\"<project-id>\",\"chatUrl\":\"<chat-url>\",\"prompt\":\"dedupe test\",\"dedupeKey\":\"$DEDUPE_KEY\"}"
   ```

   これを2回、間を空けて順番に実行しても「通常の再送」しか確認できない(KV fallbackや
   read-then-writeレースのある実装でも同じ結果になり得る)。Coordinatorが宣言している
   **atomicな同時enqueue集約**まで確認するには、別のユニークキーで、シェルの `&` で
   同じリクエストをほぼ同時に2回発火させる。

   ```bash
   DEDUPE_KEY2="e2e-dedupe-test-$(date +%s%N)-b"
   curl -s -X POST https://<your-worker>.workers.dev/api/chat-commands \
     -H "Authorization: Bearer <SUPERVISOR_CLIENT_TOKEN>" -H "Content-Type: application/json" \
     -d "{\"projectId\":\"<project-id>\",\"chatUrl\":\"<chat-url>\",\"prompt\":\"dedupe test\",\"dedupeKey\":\"$DEDUPE_KEY2\"}" &
   curl -s -X POST https://<your-worker>.workers.dev/api/chat-commands \
     -H "Authorization: Bearer <SUPERVISOR_CLIENT_TOKEN>" -H "Content-Type: application/json" \
     -d "{\"projectId\":\"<project-id>\",\"chatUrl\":\"<chat-url>\",\"prompt\":\"dedupe test\",\"dedupeKey\":\"$DEDUPE_KEY2\"}" &
   wait
   ```

   両方のレスポンスが**同じcommand ID**を指していることを確認する(順番に送った1回目の
   確認と合わせて、通常の再送・同時実行の両方を見たことになる)。

7. **claim競合の確認**: この確認はCoordinatorが本当に単一ownerしか許可しないことを
   確定的に検証するためのもので、実際に稼働中のBridge widgetは不要かつ**邪魔になる**。
   `chatgpt-bridge/src/bridgeApp.ts` の `tick()` は接続中ずっと一定間隔で
   `POST /api/chat-commands/claim` をpollingし続けるため、2章で接続したBridgeが
   同じprojectへ接続されたままだと、これから発火するcurlの2リクエストより先に
   そのBridgeが自分のpollingでcommandをclaimしてしまい、結果が不確定になる。

   先に、このprojectへ現在接続されている実際のBridge(2章で接続したChatGPTタブなど)を
   **実際に閉じて**pollingを止める。`bridgeApp.ts`は`setInterval`のpollingを
   `beforeunload`(タブ/ページを実際に閉じる・離れる)でしか止めておらず、
   タブをバックグラウンドにする(裏に回す・他のタブに切り替える)だけではpollingは
   止まらない。バックグラウンドで十分と考えて進めると、そのBridgeが2つのcurl
   リクエストより先にcommandをclaimしてしまい、この確認が不確定になる。

   claimは**project内で最も古いqueued/claimed可能なcommand**を返す(特定のcommand IDを
   指定できない)ため、手順4〜6で作ったcommandがまだ`queued`のまま残っていると
   (直前まで接続していたBridgeがcooldown中で拾いきれていない場合など)、これから発火する
   2つのclaimリクエストがそれぞれ**別々の**古いcommandを受け取ってしまい、「片方だけが
   受け取り、もう片方は空」という結果にならず、正しい実装でもこの確認が不合格に見えてしまう。
   `GET /api/projects/<project-id>/chat-commands` で未解決(`queued`/`claimed`)のcommandが
   残っていないことを確認してから次に進むこと。残っている場合は配送か
   `POST /api/chat-commands/<id>/cancel`(`queued`のみ取消可)で解消する。

   未解決commandがないことを確認したら、この節のためだけの新しいcommandを1件キューする。

   ```bash
   curl -s -X POST https://<your-worker>.workers.dev/api/chat-commands \
     -H "Authorization: Bearer <SUPERVISOR_CLIENT_TOKEN>" -H "Content-Type: application/json" \
     -d '{"projectId":"<project-id>","chatUrl":"<chat-url>","prompt":"claim race test"}'
   ```

   レスポンスの `command.id` を控えておく(以降 `<race-command-id>`)。このcommandに対して、
   2つの異なる `bridgeId` で `POST /api/chat-commands/claim` を直接、シェルの `&` で
   ほぼ同時に発火させる。

   ```bash
   curl -s -X POST https://<your-worker>.workers.dev/api/chat-commands/claim \
     -H "Authorization: Bearer <SUPERVISOR_CLIENT_TOKEN>" -H "Content-Type: application/json" \
     -d '{"bridgeId":"e2e-bridge-a","projectId":"<project-id>"}' &
   curl -s -X POST https://<your-worker>.workers.dev/api/chat-commands/claim \
     -H "Authorization: Bearer <SUPERVISOR_CLIENT_TOKEN>" -H "Content-Type: application/json" \
     -d '{"bridgeId":"e2e-bridge-b","projectId":"<project-id>"}' &
   wait
   ```

   片方だけが**手順で控えた`<race-command-id>`と同じ** `command.id` を受け取り、もう片方は
   空(claimするcommandなし)を返すことを確認する。ここで`command.id`が
   `<race-command-id>`と一致するかまで見るのは、事前確認をすり抜けた別のcommandを
   誤って「片方だけが受け取った」と判定しないため。両方が同じcommandを受け取ってしまう
   場合は不合格。

   確認できたら**必ず**、勝った側の `bridgeId` を使って、この`<race-command-id>`を
   終端状態にしておく。claimしたまま結果報告しないと2分後にstale claimとして
   再claim可能に戻り、後で実際のBridgeを再接続した際にこのテスト用プロンプトが
   本物のChatGPT会話へ誤配送されてしまう。

   ```bash
   curl -s -X POST https://<your-worker>.workers.dev/api/chat-commands/<race-command-id>/result \
     -H "Authorization: Bearer <SUPERVISOR_CLIENT_TOKEN>" -H "Content-Type: application/json" \
     -d '{"projectId":"<project-id>","bridgeId":"<勝った側のbridgeId>","status":"cancelled","detail":"e2e claim race test cleanup"}'
   ```

   これを実行してから、実際のBridgeを再接続すること。
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

セクション2(ChatGPT host実機E2E、real ChatGPT developer/private app E2E・
reconnect/suspended-widget UX validation・delivery receipt recoveryに対応)と
セクション3全体、つまり3-1〜3-4すべて(実機PWAインストールに加え、Push・reconnect・
複数端末の各シナリオも実機で確認済みであること。real iPhone/Android PWA E2Eに対応)の
両方を合格させた場合は、
あわせて `chatgpt-bridge/README.md` の「Production hardening still needed」から
実際に確認できた項目だけを削除・更新してください。**public distribution時のOAuthは
この手順書の対象外**であり、未確認のまま残しておくこと。一部の項目だけ確認できた場合は、
その項目だけを削除し、残りは「Production hardening still needed」に残しておいてください。
両方の文書を更新しないと、「ARCHITECTURE.mdでは実装済み、chatgpt-bridge/READMEではまだ必要」
という矛盾した記録が残ります。

一部だけ確認できた場合は、gapの文言に確認済み範囲(例: 「Bridge初回接続とテキスト配送は確認済み、
複数端末の同時競合シナリオは未検証」)を追記しておくと、次に着手する時に迷いません。

問題が見つかった場合は、再現手順・実際の挙動・期待した挙動をこの文書の末尾に追記するか、
新しいIssueとして記録してください。**推測で「直った」と扱わず、この手順書を再実行して
確認できた事実だけを合格として記録する**のが、このプロジェクトの完成判定の考え方
(`docs/ARCHITECTURE.md` §9 Completion rule)と一貫します。
