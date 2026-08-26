# GitHub Developer Agent setup

GitHub Developer Agentは、通常のChat主体運用を保ったまま、明示的に選んだ時だけGitHub上の実装をBackgroundで進めるための任意機能です。

## Security model

- Workerに設定した `GITHUB_ALLOWED_REPOS` のrepoだけ操作します。
- 書き込み先は必ず `ai-dev-deck/*` branchです。
- default branch / `main` への直接書き込みは拒否します。
- Agentが作るPRはDraftのみです。
- 自動merge、production deploy、repository権限変更、課金操作は行いません。
- `.env` や秘密鍵などの機密パスは読み書きしません。
- 1ファイル250KBまで、最大16 tool roundで停止します。

## 1. GitHub token

専用のFine-grained personal access token、または同等に権限を絞ったGitHub credentialを用意します。

推奨する最小権限:

- Repository access: **Only select repositories**
- Contents: **Read and write**
- Pull requests: **Read and write**
- Actions: **Read-only**
- Metadata: GitHubが要求するread権限

Admin、Secrets、Environments、Deployments等の権限はDeveloper Agentには不要です。

Worker Secretへ登録します。

```bash
cd worker
npx wrangler secret put GITHUB_TOKEN
```

GitHub tokenそのものをPWA、`wrangler.jsonc`、GitHub repositoryへ保存しないでください。

## 2. Repository allowlist

`wrangler.jsonc` の `vars` に、Agentへ許可するrepoをカンマ区切りで指定します。

```jsonc
{
  "vars": {
    "GITHUB_ALLOWED_REPOS": "sunpotflower4460-cpu/repo-a,sunpotflower4460-cpu/repo-b"
  }
}
```

Tokenにアクセス権があっても、このallowlistにないrepoはWorker側で拒否されます。

## 3. Worker entry

Developer Agentを有効にするWorkerのentryは `src/app.ts` です。

```jsonc
{
  "main": "src/app.ts"
}
```

`app.ts` は従来のBackground Workerを内包しているため、Smart Reply / Background jobs / Web Pushも引き続き同じWorker URLで利用できます。

## 4. Deploy

```bash
npm install
npm run typecheck
npm run deploy
```

PWAのBackground Worker設定には、従来と同じWorker URLと `SUPERVISOR_CLIENT_TOKEN` を設定します。

## 5. Use from the PWA

1. PWAの案件にGitHub URLを登録します。
2. `⌘` GitHub Developer Agentを開きます。
3. Worker側allowlistが認識されていることを確認します。
4. 作業指示を入力します。空欄なら案件Goalと「手動作業だけになるまで」の標準指示を使います。
5. tool round上限を選び、開始します。
6. Agentはfeature branchを作り、repositoryを調査して必要なテキストファイルを編集します。
7. 変更があれば最後にDraft PRを作成します。
8. CIとdiffを確認し、人間がレビューしてからmergeしてください。

## What the Agent can do

- repository treeを調べる
- UTF-8 text fileを読む
- feature branch上でfileを作成/更新/削除する
- default branchとの差分を見る
- branchに紐づくGitHub Actions状態を見る
- Draft PRを作る

## What it intentionally cannot do

- main/default branchへ直接書く
- PRをmergeする
- release/tagを公開する
- production deployする
- repository settingsや権限を変更する
- Secretを読む/変更する
- GitHub Actionsを無限ポーリングする

この境界は「AIに実装を任せる」利便性と、「勝手に本番へ出さない」安全性を両立するためのものです。

## 人間承認ゲートとの関係（governance.maintainerMode）

対象リポジトリの `project-kernel.json` が `governance.maintainerMode` を宣言している場合（GPT-templateベースのリポジトリ）、`SOLO_MAINTAINER`（PR作成者本人が `/approve-maintainer` とコメントし、GitHub上の実際のCollaborator Permissionで検証される）と `MULTI_MAINTAINER`（既定。作成者以外による `APPROVED` レビューが必要）のどちらでも、Worker（`orchestratorPolicy.ts` の `assessCi`）は Validation Contract の `checks[].category === 'HUMAN_APPROVAL_REQUIRED'` だけを見て `check-approval` を `HUMAN_REQUIRED` に分類します。モードごとの承認手段の違いを解釈するのは常にGitHub Actions側（`require-human-approval.yml`）であり、この境界線を越えてWorker/Supervisorが承認そのものを代行したり、モードの違いに応じて挙動を変えたりすることはありません。
