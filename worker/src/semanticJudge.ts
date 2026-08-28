import { DeveloperJob } from './developerAgent';
import { SemanticJudge, SemanticJudgeResult } from './completionJudge';
import { OrchestrationEnv, requestOrchestrationText } from './orchestrationModel';

// The first real implementation of the extension point completionJudge.ts
// deliberately left unfilled (see pendingSemanticJudge there). Reuses the
// exact same orchestration-only LLM substrate smartReplies.ts already
// uses in production (same provider fallback chain, same "never fabricate
// a confident answer when the provider is unavailable" discipline) rather
// than inventing a new one — this is an advisory judge, never the coding
// agent, same boundary every orchestration-model call in this Worker
// already enforces.
//
// Honesty about what evidence this can actually see: the Worker never
// fetches full diff/patch content anywhere (see executionFabric.ts's own
// note that it has no filesystem/exec access) — job.changedFiles is only
// ever a per-file stat summary (filename/status/+lines/-lines), the same
// summary already rendered into recovery/handoff prompts elsewhere in
// developerAgent.ts. So this judge is a scope-drift / self-report
// plausibility check against goal + definitionOfDone + that file-level
// shape + ChatGPT's own outputText, NOT a real code review — the prompt
// below says so explicitly and instructs PENDING over a confident PASS
// whenever the available evidence can't actually support one.
const MAX_FILES_IN_PROMPT = 40;

export function createSemanticJudge(env: OrchestrationEnv): SemanticJudge {
  return {
    async evaluate(job, deterministic) {
      // No point spending a provider call reviewing a job the
      // Deterministic Judge already knows is not a completion candidate
      // (CI red, route incomplete, approval outstanding) — nothing here
      // could turn that into a pass, and the certificate never promotes
      // past REJECTED/COMPLETION_CANDIDATE on deterministic.pass alone
      // regardless of what this returns.
      if (!deterministic.pass) {
        return { verdict: 'PENDING', notes: ['Deterministic Judge未通過のため、Semantic Judgeは実行していません。'] };
      }

      const result = await requestOrchestrationText(env, {
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(job),
        maxTokens: 900,
        requireJson: true,
      });

      if (!result) {
        return {
          verdict: 'PENDING',
          notes: ['Semantic Judge providerを利用できないため、判定は保留です。人間の確認が必要です。'],
        };
      }

      return parseVerdict(result.text);
    },
  };
}

const SYSTEM_PROMPT = `あなたはAI DEV DECKのオーケストレーション専用「完了判定レビューAI」です。実装・コード編集・GitHub操作は一切行いません。実作業の実行主体はユーザーのChatGPTチャットです。

あなたに渡されるのは目標・完了の定義・変更されたファイルの一覧(ファイル名と増減行数のみ、実際のdiff本文は渡されません)・ChatGPT自身の自己申告テキストだけです。実際のコード内容は読めません。

役割は「CIが緑になった」という事実だけでは検出できない、次のような問題がないかを自己申告と変化の形から推測することです:
- 変更されたファイルの範囲が目標や完了の定義と明らかに無関係(スコープドリフト)
- 自己申告の内容がファイル変更の規模・範囲と整合していない
- 完了の定義に列挙された項目のうち、自己申告からは満たされたと判断できないものがある

証拠が不十分な場合は絶対にPASSを断定しないでください。実際のコードを読んでいない以上、「アーキテクチャが健全」であることを断定的に保証することはできません — 明らかな矛盾や範囲外の変更が見当たらない、というだけの消極的な確認にとどめてください。判断できない・情報が不足している場合は必ずPENDINGを返してください。FAILは、自己申告とファイル変更の間に実際に矛盾がある、または完了の定義の一部が明らかに未達と読み取れる場合のみ使ってください。

JSONのみを返してください。形式: {"verdict":"PASS"|"FAIL"|"PENDING","notes":["理由や懸念事項を短く"]}`;

function buildUserPrompt(job: DeveloperJob): string {
  const files = (job.changedFiles ?? [])
    .slice(0, MAX_FILES_IN_PROMPT)
    .map((file) => `- \`${file.filename}\` (${file.status}, +${file.additions}/-${file.deletions})`)
    .join('\n') || '- (ファイル変更情報なし)';
  const extraFilesNote = (job.changedFiles?.length ?? 0) > MAX_FILES_IN_PROMPT
    ? `\n(他 ${job.changedFiles!.length - MAX_FILES_IN_PROMPT} ファイル、省略)`
    : '';
  const definitionOfDone = job.definitionOfDone.length
    ? job.definitionOfDone.map((item) => `- ${item}`).join('\n')
    : '- (未指定)';
  const kernelNote = job.kernelManifest
    ? 'このリポジトリはproject-kernel.jsonを持つ管理対象プロジェクトです。'
    : '';

  return `GOAL: ${job.goal}\n\n完了の定義:\n${definitionOfDone}\n\n変更されたファイル:\n${files}${extraFilesNote}\n\nChatGPT自身の自己申告(最終出力):\n${(job.outputText || job.handoffPrompt || '').trim().slice(0, 4000) || '(自己申告なし)'}\n\n${kernelNote}`.trim();
}

function parseVerdict(text: string): SemanticJudgeResult {
  const candidate = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    return { verdict: 'PENDING', notes: ['Semantic Judgeの応答をJSONとして解釈できませんでした。'] };
  }

  const allowed: SemanticJudgeResult['verdict'][] = ['PASS', 'FAIL', 'PENDING'];
  const verdict = typeof parsed.verdict === 'string' && allowed.includes(parsed.verdict as SemanticJudgeResult['verdict'])
    ? parsed.verdict as SemanticJudgeResult['verdict']
    : 'PENDING';
  const notes = Array.isArray(parsed.notes)
    ? parsed.notes.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 500)).slice(0, 10)
    : [];

  return { verdict, notes: notes.length ? notes : ['(理由なし)'] };
}
