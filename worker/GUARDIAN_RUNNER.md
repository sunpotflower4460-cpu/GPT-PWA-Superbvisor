# Guardian Goal Runner

Guardian Goal Runnerは、GitHub Developer Agentを1回だけ動かして終わるのではなく、**実装 → CI確認 → 失敗時の修正 → 再確認**を、設定した上限内で監督するモードです。

通常のChat主体運用は変わりません。PWAのGitHub Developer Agent画面で明示的に `Guardian` を選んだ案件だけがAPI実行対象になります。

## Flow

```text
Guardian start
  ↓
Developer Agent cycle 1
  ↓
protected ai-dev-deck/* branch
  ↓
Draft PR
  ↓
GitHub Actions
  ├─ green → Guardian completed → Push
  ├─ running → wait
  └─ failed → same branch recovery cycle
                ↓
             re-check CI
```

## Stop conditions

Guardianは必ず次のいずれかで停止します。

- CIが成功した
- 最大cycle数に達した
- 最大経過時間に達した
- Developer Agentが復旧不能なエラーになった
- 人間レビューへ進める状態になった

自動mergeは行いません。

## Cost bounds

PWAから次を設定できます。

- 1 cycleあたりの最大tool round: 1〜16
- 最大cycle: 1〜4（標準3）
- 最大経過時間: 15〜360分（UI標準3時間）

この3つを掛け合わせた範囲を超えて、自律的にAPIを回し続けることはありません。

## Watchdog

OpenAI webhookを受け取った時は即時に次状態へ進みます。

加えてCloudflare WorkersのCron Triggerで、未完了Guardianを定期巡回します。これによりWebhookが一時的に取りこぼされた場合や、CI待ちで止まっている場合も後から再評価できます。

`wrangler.jsonc` 例:

```jsonc
{
  "triggers": {
    "crons": ["*/5 * * * *"]
  }
}
```

標準例は5分ごとの巡回です。

## Same-branch recovery

CI失敗時に新しいbranchを乱造しません。

最初のDeveloper Agentが作った `ai-dev-deck/*` branchを引き継ぎ、前cycleの成果を残したまま原因修正を行います。Draft PRも同じbranchを指すため、レビュー対象を一つに保てます。

## GitHub Actions policy

Guardian自身は `.github/workflows/*` をDeveloper Agentから読み書きできないようコード側で遮断しています。

そのためCI失敗を「Workflowを削除して緑にする」ような回避はできません。既存コード側を直してCIを通す前提です。

CIが存在しないrepositoryでは、一定のgrace period後に「CI未検出・人間レビュー必要」として終了します。CIがないことを成功テストと偽りません。

## Background behavior

- OpenAI Responses API background実行
- OpenAI webhookでDeveloper Agentのtool loopを継続
- Cloudflare KVへGuardian / Developer Job状態を保存
- Cron Watchdogで未完了runを再評価
- 最終完了/停止時のみWeb Push

途中cycleごとのPushは抑止し、通知が大量に飛ばないようにしています。

## Safety boundary

GuardianでもPhase 8のDeveloper Agent guardrailはそのまま維持します。

- allowlist repoのみ
- `ai-dev-deck/*` branchのみ
- main/default branch直接書込禁止
- Draft PRのみ
- auto merge禁止
- production deploy禁止
- secrets/credential/workflow path禁止
- tool/cycle/timeの3重上限

Guardianは「長く働ける」モードであって、「権限が強くなる」モードではありません。
