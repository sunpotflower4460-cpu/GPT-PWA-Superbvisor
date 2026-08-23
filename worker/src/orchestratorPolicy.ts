export interface CiCheckLike {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  headSha: string;
}

export type CiAssessmentState =
  | 'NO_RUN'
  | 'PENDING'
  | 'SUCCESS'
  | 'TRANSIENT_FAILURE'
  | 'CODE_FAILURE'
  | 'HUMAN_REQUIRED';

export interface CiAssessment {
  state: CiAssessmentState;
  failed: CiCheckLike[];
  transient: CiCheckLike[];
  humanRequired: CiCheckLike[];
}

const SUCCESS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const TRANSIENT_CONCLUSIONS = new Set(['cancelled', 'timed_out', 'startup_failure', 'stale']);
const HUMAN_CONCLUSIONS = new Set(['action_required']);

export function assessCi(checks: CiCheckLike[]): CiAssessment {
  if (!checks.length) return { state: 'NO_RUN', failed: [], transient: [], humanRequired: [] };
  if (checks.some((check) => check.status !== 'completed')) {
    return { state: 'PENDING', failed: [], transient: [], humanRequired: [] };
  }

  const failed = checks.filter((check) => !SUCCESS_CONCLUSIONS.has((check.conclusion || '').toLowerCase()));
  if (!failed.length) return { state: 'SUCCESS', failed: [], transient: [], humanRequired: [] };

  const humanRequired = failed.filter((check) => HUMAN_CONCLUSIONS.has((check.conclusion || '').toLowerCase()));
  if (humanRequired.length) return { state: 'HUMAN_REQUIRED', failed, transient: [], humanRequired };

  const transient = failed.filter((check) => TRANSIENT_CONCLUSIONS.has((check.conclusion || '').toLowerCase()));
  if (transient.length === failed.length) return { state: 'TRANSIENT_FAILURE', failed, transient, humanRequired: [] };

  return { state: 'CODE_FAILURE', failed, transient, humanRequired: [] };
}

export function failureFingerprint(headSha: string, checks: CiCheckLike[]) {
  const signature = checks
    .map((check) => `${check.id}:${check.name}:${check.status}:${check.conclusion || ''}`)
    .sort()
    .join('|');
  return `${headSha}:${signature}`;
}

export function isRetryableProviderStatus(status: number) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function definitionOfDone(items?: string[]) {
  return items?.length
    ? items.map((item) => `- ${item}`).join('\n')
    : '- Goalを満たすこと\n- 可能な検証を行うこと\n- 未確認事項と人間操作を明示すること';
}

export function buildGenericChatGptHandoff(input: {
  projectName?: string;
  goal: string;
  currentPhase?: string;
  task: string;
  definitionOfDone?: string[];
}) {
  return `重要: この依頼の実行主体は、このChatGPTチャットです。Cloudflare WorkerやDeepSeek/MiniMax/OpenAI APIは監督・整理・次手生成だけを担当し、実作業を完了したふりをしてはいけません。\n\nPROJECT:\n${input.projectName || '未指定'}\n\nGOAL:\n${input.goal}\n\nCURRENT PHASE:\n${input.currentPhase || '未指定'}\n\nTASK:\n${input.task}\n\nDefinition of Done:\n${definitionOfDone(input.definitionOfDone)}\n\nこのChatGPTで利用可能なツール・接続先・現在の会話文脈を使って、実際にできる作業はここで進めてください。調査だけで終えず、安全に実行可能な実装・デバッグ・レビュー・検証は可能な範囲で実行してください。失敗した場合は同じ手順を漫然と繰り返さず、原因を確認して別手段または修正を試し、証拠を再確認してください。課金、秘密情報、本人確認、不可逆操作、本番公開など人間判断が必要なものだけ止めて明示してください。外部APIの要約だけを根拠に完成扱いせず、実際の結果・CI・取得できた証拠を優先してください。`;
}

export function buildChatGptHandoff(input: {
  repository: string;
  branch: string;
  defaultBranch: string;
  goal: string;
  task: string;
  definitionOfDone?: string[];
}) {
  return `この作業の実装担当は、このChatGPTチャットです。外部APIは実装を行いません。\n\nRepository: ${input.repository}\n作業branch: ${input.branch}\nDefault branch: ${input.defaultBranch}\n\nGOAL:\n${input.goal}\n\nTASK:\n${input.task}\n\nDefinition of Done:\n${definitionOfDone(input.definitionOfDone)}\n\nGitHubを確認して必要な実装・デバッグ・テストをこのChatGPTから実際に行ってください。必ず指定branch上で作業し、main/default branchへ直接書き込まないでください。作業後はdiffとCIを確認し、失敗していたら原因を特定して修正→再確認まで進めてください。課金・秘密情報・本人確認・本番deploy・mergeなど人間判断が必要な操作は勝手に行わず、必要事項だけ明示してください。`;
}

export function buildRecoveryPrompt(input: {
  repository: string;
  branch: string;
  goal: string;
  originalTask: string;
  headSha: string;
  checks: CiCheckLike[];
  previousSummary?: string;
}) {
  const ci = input.checks.length
    ? input.checks.map((check) => `- ${check.name}: ${check.conclusion || check.status} (${check.url})`).join('\n')
    : '- CI runを確認できません';

  return `この作業の実装修正担当は、このChatGPTチャットです。Supervisorは外部APIで監視だけを行っています。\n\nRepository: ${input.repository}\n作業branch: ${input.branch}\n現在head: ${input.headSha}\n\nGOAL:\n${input.goal}\n\n元のTASK:\n${input.originalTask}\n\nCI/監視結果:\n${ci}\n\n直前の監督要約:\n${input.previousSummary || 'なし'}\n\n同じ失敗を繰り返さないでください。まず現在のbranch・diff・CI失敗箇所を実際に確認し、原因を切り分け、必要なコード修正またはテスト修正をこのChatGPTから行い、再度CIまで確認してください。CI自体の一時障害ならコードを無意味に変更せず再実行/再確認を優先してください。mainへの直接write・自動merge・本番deployはしないでください。`;
}
