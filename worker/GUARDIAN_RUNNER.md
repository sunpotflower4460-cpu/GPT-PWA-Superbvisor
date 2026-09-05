# Guardian Goal Runner

Guardian Goal Runnerは、**ChatGPTが実装・デバッグを行い、Cloudflare Workerが外から監督を続ける**モードです。

外部LLM API（DeepSeek / MiniMax / OpenAI）はコードを編集しません。役割は状態分類、要約、次にChatGPTへ渡す指示、CI失敗時の復旧指示だけです。

## Flow

```text
Guardian start
  ↓
Worker: protected ai-dev-deck/* branchを準備
  ↓
DeepSeek / MiniMax / OpenAI: ChatGPT用の作業指示を整理
  ↓
ChatGPT chat: 実装・デバッグ・GitHub編集
  ↓
Worker: branch head SHAを監視
  ↓
GitHub Actions
  ├─ green → Draft PR / review ready → Push
  ├─ running → wait and keep monitoring
  ├─ transient failure → failed jobsを最大2回再実行
  ├─ code failure → ChatGPT用recovery promptを更新 → 次commit待ち
  └─ action_required → 人間操作が必要として安全停止
```

## Failure is a state, not the end

Guardianはrecoverableな失敗を原則として終端状態にしません。

- GitHub/APIの一時エラー → 状態を保持して次回Cronで再試行
- Providerの429 / 5xx / timeout → 同provider retry → 次provider → deterministic fallback
- CI cancelled / timed_out / startup_failure / stale → failed jobs再実行
- CI failure → 同じheadの失敗をfingerprintし、ChatGPT用の原因確認・修正指示を1回生成
- Push失敗 → 監督状態には影響させない
- 100件を超えるGuardian run → KV listをページングして巡回
- `waiting_chatgpt`/`handoff_ready`(ChatGPT側の作業待ち)でChatGPT Apps Bridgeが15分以上heartbeatなし → 1回だけpush通知(`bridgeStallNotifiedAt`で同じ停滞を再通知しない。再接続後の新たな停滞は改めて通知)。Guardian run経由のジョブのみ対象で、Guardian runを介さないad-hoc Quick Commandはこの対象外

## Stop / pause conditions

安全上、次は停止または人間待ちになります。

- 現在headのCI成功 + review可能状態
- GitHubが `action_required` を返した
- 課金・権限・承認など人間操作が必要
- 最大監視時間に達した
- 初期設定そのものが不正で開始できない

`maxCycles` は復旧回数の目安としてUIへ表示しますが、recoverableなCI失敗だけを理由にGuardian全体を強制終了しません。無限実行防止の最終境界は `maxMinutes` です。

## Provider routing

標準例:

```text
DeepSeek V4 Flash
  ↓ failure / rate limit
MiniMax M3
  ↓ failure / rate limit
OpenAI orchestration model
  ↓ unavailable
Deterministic ChatGPT handoff
```

Providerが全部落ちても、Workerは安全な定型ChatGPT指示を生成できるため、監督機能そのものは失われません。

## Watchdog

Cloudflare Workers Cron Triggerが未完了Guardianを定期巡回します。

```jsonc
{
  "triggers": {
    "crons": ["*/5 * * * *"]
  }
}
```

ChatGPTが閉じている間もWorkerはbranch/CI状態を監視し、復旧指示を準備できます。ただし**ChatGPTの会話をWorkerが勝手に継続することはありません**。実装の実行主体はChatGPTです。

## Same-branch recovery

CI失敗時も `ai-dev-deck/*` の同じ作業branchを使います。

Workerはコードを直しません。ChatGPTへ「現在branch / head / CI evidence / 元のGoal」を含むrecovery promptを渡し、ChatGPTが修正commitを作ったらGuardianがその新しいheadを再監視します。

## CI evidence policy

- 最新branch head SHAと一致するrunだけを見る
- CIがまだ出ていない時は成功扱いしない
- pendingは待つ
- failureは成功扱いしない
- transient failureとcode failureを分ける
- action_requiredは人間判断へ送る

外部LLMの「たぶん直った」という文章では完成判定しません。

## Safety boundary

- 実装者: ChatGPT chat
- 外部LLM: orchestration only
- allowlist repoのみ
- 作業branchは `ai-dev-deck/*`
- main/default branchへWorkerからコードwriteしない
- auto merge禁止
- production deploy禁止
- secretsをPWAへ置かない
- CI成功を推測しない
- Provider障害時はdeterministic fallback

Guardianは「外部AIが自律開発する機能」ではなく、**ChatGPTの開発作業を外から止まりにくく監督するハーネス**です。
