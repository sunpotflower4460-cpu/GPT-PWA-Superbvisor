# AI DEV DECK Product Constitution

この文書は、AI DEV DECKが将来の機能追加・リファクタ・AIによる自動修正の中で**別の製品へ変質しないための最上位ルール**です。

機械可読な対応物はリポジトリ直下の [`product-concept.json`](../product-concept.json) です。文章とmanifestが矛盾する場合は、変更を止めて意図を確認してください。

## 1. North Star

AI DEV DECKの第一目的は、

> **普段使っている複数のChatGPT開発チャットを、スマホPWAからまとめて同時並行・軽量・バックグラウンド耐性ありで操作すること。**

です。

この製品は「新しいAIコーディング環境をもう1つ作る」ためのものではありません。

**現在使っているChatGPT開発チャットそのものを実行主体として残し、それらをPWAから束ねるControl Planeを作ること**が核です。

理想の操作は `PWA → 対象ChatGPT` であり、`PWA → コピー → ChatGPTを開く → 貼る` は通常経路ではなく手動fallbackです。

## 2. Role Constitution

### ChatGPT = executor

ChatGPT開発チャットが担当するもの:

- repository理解
- 実装
- デバッグ
- テスト
- レビュー
- GitHub編集
- CI失敗を受けた修正

### PWA = multi-chat control plane

PWAが担当するもの:

- 複数ChatGPT案件の一覧・切替
- 自由文 / Quick Command / Autopilot Route投入
- queued / claimed / delivered / failed の表示
- WAITING_AI / WAITING_USER / エラー / 完了の区別
- 進捗・証拠・通知の集約
- モバイルから少ない操作で複数案件を回すこと

### Worker = durable supervisor

Workerが担当するもの:

- command queue
- state persistence
- GitHub / CI evidence observation
- retry / recovery routing
- Autopilot next-turn routing
- notifications
- provider fallback
- branch / Draft PRなどの安全なオーケストレーション

Workerは別のコーディングAIではありません。

### External LLM = orchestration-only

DeepSeek / MiniMax / OpenAI API等が担当できるもの:

- 状態分類
- 要約
- next command生成
- recovery command生成
- Autopilot工程整理

外部LLMをrepositoryの主たるコード実行者にしません。

## 3. Immutable product invariants

以下は通常の機能開発で変更してはいけない不変条件です。

### C1 — Multi Chat Remote first

Supervisor、Guardian、Autopilot、Provider Routerはすべて**Multi Chat Remoteを便利にする補助層**です。

補助層の高度化により、複数ChatGPTをPWAから操作する本流が複雑化・後回しになってはいけません。

### C2 — Existing ChatGPT remains the executor

「より自動化しやすいから」という理由だけで、Workerや安価な外部APIを主実装者へ置き換えません。

通常のExecutor selectorに `API_WORKER` を復活させません。Workは明示利用時だけの別経路で、通常のMulti Chat Remoteの実行者はChatGPTです。

### C3 — Failure is a state

recoverable failureは終了理由ではありません。

原因分類 → retry / recovery → Chat Control Bus → ChatGPT → 新しい証拠確認へ進みます。

### C4 — Evidence over self-report

AIが「完了しました」と言っただけでは完成にしません。

可能な限りcurrent head、CI、成果物、DoDとの対応を確認します。

### C5 — Human-only is explicit

本人確認、課金、secrets、大きな仕様決定、最終merge承認など**人間しかできないものだけ**を `WAITING_USER / あなた待ち` に分離します。

ChatGPTへの通常handoff、Bridge配送待ち、ChatGPT応答待ち、CI失敗からの復旧指示生成は `WAITING_USER` にしてはいけません。

### C6 — Official/safe transport boundary

ChatGPT連携のために以下へ依存しません。

- session cookie窃取
- 非公式認証回避
- hidden endpointへの無断投稿
- ChatGPT画面スクレイピングを主要transportにすること
- PWA / Widgetへのsecret埋め込み

Transportは公式Apps SDK / MCP等へ差し替え可能な境界として保ちます。

### C7 — No implicit merge/deploy

明示的な将来方針変更がない限り、automatic merge / production deployは行いません。

### C8 — Mobile and low friction

機能が増えても、主操作は「スマホから数秒で案件の状態を把握し、次の指示を送る」ことを優先します。

軽さは感覚だけで判断せず、production bundleのgzip budgetをCIで監視します。budgetを超えた場合は、安易に上限を上げる前にsecondary UIのlazy-loadや構造整理を優先します。

### C9 — Evidence and orchestration must not become the product itself

CI画面、Provider Router、Supervisor設定、ログ閲覧が主役になってはいけません。それらはChatGPT案件を回すための裏方です。

### C10 — Control Bus first, clipboard fallback second

通常のQuick Command / Operating Plan / recovery / Autopilot next-turnはChat Control Busへ送ります。

コピーしてChatGPTを別画面で開く導線は、Bridge未接続・障害時などの手動fallbackとしてのみ残します。

### C11 — AUTO means ChatGPT can continue

`CHAT` は「自動化できないモード」ではありません。

AUTO / GUARDIANでは、SupervisorやGuardianが生成した復旧指示・次工程指示をChat Control Busへ投入し、ChatGPT executorを継続させます。人間しかできない境界へ到達した時だけ止めます。

### C12 — Platform limitations must be represented honestly

PWAを閉じてもQueue・state・GitHub/CI監視を保持することと、完全に閉じたChatGPT会話を外部から強制的に起動できることは別です。

公式にサポートされた機能がないものを「できる」と見せません。特にChatGPTの返答本文を外部PWAへ読み戻す経路が公式に利用できない場合、cookie/session scrapingで擬似実装せず、status/evidenceと利用可能な公式transportを使います。

## 4. Anti-goals

次の方向へ進み始めた場合はconcept driftとして扱います。

- Claude Code / Cursor等の代替IDEを作る
- 外部API autonomous coding agentを製品の中心にする
- チャット履歴ビューアを主機能にする
- 普通のタスク管理アプリへ寄せる
- LLM provider比較・routingを製品価値の中心にする
- ChatGPTを単なる下請けtransportとして扱う
- 「自動化率」を上げるために安全境界や人間確認を消す
- UIが設定画面・監視画面中心になり、Multi Chat操作が奥へ追いやられる
- 通常の指示送信をclipboard-firstへ戻す
- routineなChatGPT待ち/復旧を `あなた待ち` と表示する
- 非公式手段でChatGPT response mirroringを装う

## 5. Feature decision gate

新しい機能・大きなリファクタは、実装前またはPR時に以下を確認します。

1. **North Starへ直接効くか？** 複数ChatGPTの操作が速く・軽く・止まりにくくなるか。
2. **ChatGPT executorを保つか？** 別AI実行基盤へ主役を移していないか。
3. **ユーザー操作を減らすか？** 設定項目や画面遷移だけを増やしていないか。
4. **バックグラウンド耐性を上げるか？** PWAを閉じてもstate/evidence/queueを失いにくいか。
5. **failure recoveryを改善するか？** 失敗時に安全に再開しやすくなるか。
6. **evidenceを強くするか？** AI自己申告への依存を減らすか。
7. **既存の安全境界を壊さないか？** secrets / merge / deploy / unofficial transportを緩めていないか。
8. **モバイルで意味があるか？** desktop IDE的な複雑さを持ち込んでいないか。
9. **人間待ちを増やしていないか？** ChatGPT/Bridgeが処理できる工程を誤って本人操作へ戻していないか。
10. **通常操作がPWA内で完結する方向か？** clipboard/open-chatを主要経路へ戻していないか。

直接価値が弱い機能は、少なくとも「どのNorth Star機能を支えるのか」を説明できない限り優先しません。

## 6. Protected architecture zones

以下を変更する時は「普通の修正」ではなく**concept-impacting change**として扱います。

- `product-concept.json`
- `docs/PRODUCT_CONSTITUTION.md`
- `docs/ARCHITECTURE.md`
- `scripts/concept-guard.mjs`
- `scripts/check-bundle-size.mjs`
- ChatGPT executor境界
- Worker orchestration-only境界
- Chat Control Bus
- ChatGPT Bridge transport
- WAITING_USER / WAITING_AI状態境界
- Autopilot / recoveryの自動Queue境界
- completion/evidenceルール
- merge / deploy安全境界

これらを変えるPRは、PR本文のConcept Alignment欄に変更理由を必ず記載します。

## 7. Amendment rule

このConstitution自体は変更可能ですが、通常機能の都合で暗黙に変えてはいけません。

変更する場合は:

1. 「なぜNorth Star自体を変える必要があるか」を明記する
2. `product-concept.json` と同時更新する
3. `docs/ARCHITECTURE.md` との整合を取る
4. concept guardを弱める場合は、その理由を明示する
5. 自動mergeせず、人間が意図を確認する

## 8. Short test

迷った時は、次の1問へ戻ります。

> **この変更は「複数の普段使いChatGPT開発チャットを、PWAから自然にまとめて動かす」という体験を強くしているか？**

答えがNoなら、AI DEV DECKの中心機能として本当に必要か再検討します。
