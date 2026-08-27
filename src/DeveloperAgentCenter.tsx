import { useEffect, useMemo, useState } from 'react';
import { DevProject, buildActionPrompt, loadProjects, quickActions } from './core';
import { loadWorkerConnection } from './backgroundWorker';
import {
  DeveloperJob,
  getDeveloperConfig,
  getLatestDeveloperJob,
  startDeveloperJob,
} from './developerAgent';
import { GuardianRun, getLatestGuardianRun, startGuardianRun } from './guardianRunner';
import { getOperatingPlan, parseRoutePlan } from './operatingPlan';

const defaultAction = quickActions.find((action) => action.id === 'manual-only') ?? quickActions[0];
type DeveloperMode = 'single' | 'guardian';

export default function DeveloperAgentCenter() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<DevProject[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<DeveloperMode>('guardian');
  const [maxCycles, setMaxCycles] = useState(3);
  const [maxMinutes, setMaxMinutes] = useState(180);
  const [job, setJob] = useState<DeveloperJob | null>(null);
  const [guardian, setGuardian] = useState<GuardianRun | null>(null);
  const [configuredRepos, setConfiguredRepos] = useState<string[]>([]);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  const selected = useMemo(
    () => projects.find((project) => project.id === selectedId) ?? projects[0] ?? null,
    [projects, selectedId],
  );

  useEffect(() => {
    const handler = () => void openCenter();
    window.addEventListener('devdeck:open-developer', handler);
    return () => window.removeEventListener('devdeck:open-developer', handler);
  }, []);

  async function openCenter() {
    const nextProjects = loadProjects().filter((project) => Boolean(project.githubUrl));
    setProjects(nextProjects);
    setSelectedId((current) => current && nextProjects.some((project) => project.id === current) ? current : nextProjects[0]?.id ?? '');
    setOpen(true);
    setMessage('');
    try {
      const config = await getDeveloperConfig(loadWorkerConnection());
      setConfigured(config.configured);
      setConfiguredRepos(config.repositories);
    } catch (error) {
      setConfigured(false);
      setConfiguredRepos([]);
      setMessage(error instanceof Error ? error.message : 'Worker / GitHub監督設定を確認できませんでした。');
    }
  }

  function changeProject(id: string) {
    setSelectedId(id);
    setPrompt('');
    setJob(null);
    setGuardian(null);
    setMessage('');
  }

  async function start() {
    if (!selected) return;
    setBusy('start');
    setMessage('');
    try {
      const task = prompt.trim() || buildActionPrompt(selected, defaultAction);
      const connection = loadWorkerConnection();
      // Route (Goal/Route/Task separation): the same arrow-separated
      // workflow this project's saved Operating Plan already displays,
      // parsed into a declared plan and sent alongside the job/run — see
      // operatingPlan.ts's parseRoutePlan for why this is a delimiter
      // extraction, not free-text interpretation.
      const routePlan = parseRoutePlan(getOperatingPlan(selected.id).workflow);
      if (mode === 'guardian') {
        const next = await startGuardianRun(selected, task, { maxCycles, maxToolTurns: 10, maxMinutes }, connection, routePlan);
        setGuardian(next);
        setJob(null);
        setMessage('Guardianを開始しました。Worker/APIは監督だけを行い、実装・デバッグ・GitHub編集はChatGPT側で行います。');
      } else {
        const next = await startDeveloperJob(selected, task, 10, connection, routePlan);
        setJob(next);
        setGuardian(null);
        setMessage('ChatGPT作業用branchと引き継ぎ指示を準備しました。外部APIはコードを変更していません。');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'ChatGPT Orchestratorを開始できませんでした。');
    } finally {
      setBusy('');
    }
  }

  async function refresh() {
    if (!selected) return;
    setBusy('refresh');
    setMessage('');
    try {
      const connection = loadWorkerConnection();
      if (mode === 'guardian') {
        const latest = await getLatestGuardianRun(selected.id, connection);
        setGuardian(latest);
        setMessage(guardianMessage(latest));
      } else {
        const latest = await getLatestDeveloperJob(selected.id, connection);
        setJob(latest);
        setMessage(developerMessage(latest));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '状態を取得できませんでした。');
    } finally {
      setBusy('');
    }
  }

  return open ? (
    <div className="developer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
      <section className="developer-sheet">
        <header className="developer-header">
          <div><p className="eyebrow">CHATGPT EXECUTION / WORKER ORCHESTRATION</p><h2>ChatGPT Orchestrator</h2></div>
          <button className="icon-button" onClick={() => setOpen(false)}>×</button>
        </header>

        <div className="developer-guardrails">
          <b>🧠 実作業はChatGPT。</b>
          <span>Worker/APIはbranch準備・状態監視・CI再確認・失敗分類・復旧指示だけを担当します。外部LLMへGitHub write/delete/merge権限は渡しません。</span>
        </div>

        {!configured && <div className="developer-warning">⚠ Worker側のGITHUB_TOKEN / GITHUB_ALLOWED_REPOS設定が必要です。</div>}
        {configuredRepos.length > 0 && <div className="developer-allowlist"><b>監督対象repo</b>{configuredRepos.map((repo) => <code key={repo}>{repo}</code>)}</div>}

        {projects.length === 0 ? <div className="empty-state compact"><div>⌘</div><h2>GitHub登録済み案件がありません</h2><p>案件にGitHub URLを登録するとChatGPT＋Worker監督を使えます。</p></div> : selected && (
          <>
            <div className="developer-tabs">
              {projects.map((project) => <button key={project.id} className={project.id === selected.id ? 'active' : ''} onClick={() => changeProject(project.id)}>{project.name}</button>)}
            </div>

            <div className="developer-project">
              <article className="developer-project-card">
                <div><strong>{selected.name}</strong><small>{selected.githubUrl}</small></div><span>{selected.progress}%</span>
                <p>{selected.goal}</p>
              </article>

              <div className="developer-mode-switch" role="group" aria-label="監督モード">
                <button className={mode === 'single' ? 'active' : ''} onClick={() => { setMode('single'); setGuardian(null); }}>
                  <b>⌘ 単発引き継ぎ</b><small>branch準備 → ChatGPTへ渡す</small>
                </button>
                <button className={mode === 'guardian' ? 'active guardian' : 'guardian'} onClick={() => { setMode('guardian'); setJob(null); }}>
                  <b>🛡 Guardian</b><small>CI失敗後も監視・復旧</small>
                </button>
              </div>

              {mode === 'guardian' && (
                <div className="guardian-explain">
                  <b>失敗を終端にしない監督</b>
                  <span>ChatGPT作業 → CI監視 → 一時障害なら自動再実行 → コード失敗ならChatGPT用復旧指示 → 新しいcommitを再監視。人間操作が必要な時だけ安全停止します。</span>
                </div>
              )}

              <label className="developer-prompt">
                <span>ChatGPTに進めてほしい作業 <small>空欄なら標準の「手動作業だけになるまで」</small></span>
                <textarea rows={6} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例：現在の未完成箇所を確認し、実装・デバッグ・テストを進めて" />
              </label>

              {mode === 'guardian' && (
                <div className="guardian-limits">
                  <label>通常復旧サイクル目安
                    <select value={maxCycles} onChange={(event) => setMaxCycles(Number(event.target.value))}>
                      <option value={1}>1回</option>
                      <option value={2}>2回</option>
                      <option value={3}>3回（標準）</option>
                      <option value={4}>4回</option>
                    </select>
                  </label>
                  <label>最大監視時間
                    <select value={maxMinutes} onChange={(event) => setMaxMinutes(Number(event.target.value))}>
                      <option value={60}>1時間</option>
                      <option value={180}>3時間（標準）</option>
                      <option value={360}>6時間</option>
                    </select>
                  </label>
                </div>
              )}

              <div className="developer-actions">
                <button className="developer-start" disabled={!configured || busy === 'start'} onClick={start}>
                  {busy === 'start' ? '準備中…' : mode === 'guardian' ? '🛡 ChatGPT＋Guardianを開始' : '⌘ ChatGPT作業branchを準備'}
                </button>
                <button disabled={busy === 'refresh'} onClick={refresh}>{busy === 'refresh' ? '更新中…' : '状態を更新'}</button>
              </div>

              {mode === 'guardian'
                ? guardian && <GuardianCard run={guardian} project={selected} />
                : job && <DeveloperJobCard job={job} project={selected} />}
            </div>
          </>
        )}

        {message && <div className="developer-message">{message}</div>}
        <p className="developer-footnote">GuardianはCronで再確認します。Provider/API/Pushの一時失敗は監督状態を失敗終了させず再試行し、CIのコード失敗はChatGPT復旧指示へ変換します。自動merge・本番deployはしません。</p>
      </section>
    </div>
  ) : null;
}

function DeveloperJobCard({ job, project }: { job: DeveloperJob; project: DevProject }) {
  return <article className={`developer-job ${job.status}`}>
    <div className="section-heading"><span>{phaseLabel(job.phase, job.status)}</span><b>{job.orchestratorProvider || 'deterministic'} / {job.model}</b></div>
    <div className="developer-branch"><span>ChatGPT作業branch</span><code>{job.workspace.branch}</code></div>
    {job.degradedOrchestration && <div className="developer-warning">外部オーケストレーションAIは利用できませんでしたが、決定論的フォールバックで継続中です。</div>}
    {job.ciChecks && job.ciChecks.length > 0 && <CiChecks checks={job.ciChecks} />}
    {job.changedFiles && job.changedFiles.length > 0 && <details open className="developer-files"><summary>ChatGPT側の変更 {job.changedFiles.length}件</summary>{job.changedFiles.slice(0, 30).map((file) => <div key={file.filename}><code>{file.filename}</code><span>+{file.additions}/-{file.deletions}</span></div>)}</details>}
    {job.handoffPrompt && <HandoffActions prompt={job.handoffPrompt} project={project} label={job.phase === 'recovery_ready' ? 'ChatGPTで復旧する' : 'ChatGPTで作業する'} />}
    {job.pullRequest && <button className="developer-pr" onClick={() => openGitHub(job.pullRequest!.url)}>Draft PR #{job.pullRequest.number} を開く ↗</button>}
    {job.error && <div className="developer-error">⚠ {job.error}</div>}
    {job.outputText && <details className="developer-output" open={job.phase === 'recovery_ready'}><summary>Supervisorレポート</summary><pre>{job.outputText}</pre></details>}
  </article>;
}

function GuardianCard({ run, project }: { run: GuardianRun; project: DevProject }) {
  const final = run.status === 'review_ready' || run.status === 'completed' || run.status === 'failed' || run.status === 'expired';
  return <article className={`guardian-card ${run.status}`}>
    <div className="section-heading"><span>{guardianStatusLabel(run)}</span><b>{run.orchestratorProvider || 'deterministic'} / {run.model || 'none'}</b></div>
    <div className="guardian-meter"><span style={{ width: `${Math.min(100, Math.round((Math.max(1, run.cycle) / Math.max(1, run.maxCycles)) * 100))}%` }} /></div>
    {run.message && <p className="guardian-message">{run.message}</p>}
    <div className="guardian-meta"><span>監視上限 {run.maxMinutes}分</span><span>復旧 {run.recoveryCount || 0}回</span>{run.transientErrorCount ? <span>一時エラー {run.transientErrorCount}回</span> : null}</div>
    {run.degradedOrchestration && <div className="developer-warning">外部AI障害中でもフォールバック監督を継続しています。</div>}
    {run.ciChecks && run.ciChecks.length > 0 && <CiChecks checks={run.ciChecks} />}
    {run.handoffPrompt && !final && <HandoffActions prompt={run.handoffPrompt} project={project} label={run.phase === 'recovery_ready' ? 'ChatGPTで修正を続ける' : 'ChatGPTで作業を続ける'} />}
    {run.pullRequest && <button className="developer-pr" onClick={() => openGitHub(run.pullRequest!.url)}>Draft PR #{run.pullRequest.number} を開く ↗</button>}
    {run.error && <div className="developer-error">⚠ {run.error}</div>}
    {run.finalSummary && <details className="developer-output" open={run.phase === 'recovery_ready'}><summary>Supervisorレポート</summary><pre>{run.finalSummary}</pre></details>}
    {!final && <div className="guardian-live">● Worker Supervisor監督中</div>}
  </article>;
}

function CiChecks({ checks }: { checks: Array<{ name: string; status: string; conclusion: string | null; url: string; headSha: string }> }) {
  return <div className="guardian-ci"><b>現在headのGitHub Actions</b>{checks.map((check) => (
    <button key={`${check.name}-${check.headSha}`} onClick={() => openGitHub(check.url)}>
      <span>{ciIcon(check.status, check.conclusion)} {check.name}</span><small>{check.conclusion || check.status} ↗</small>
    </button>
  ))}</div>;
}

function HandoffActions({ prompt, project, label }: { prompt: string; project: DevProject; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy(openChat: boolean) {
    try { await navigator.clipboard.writeText(prompt); setCopied(true); } catch { setCopied(false); }
    if (openChat) window.open(safeChatUrl(project.chatUrl) || 'https://chatgpt.com/', '_blank', 'noopener,noreferrer');
  }
  return <div className="developer-actions">
    <button className="developer-start" onClick={() => void copy(true)}>🧠 {label}</button>
    <button onClick={() => void copy(false)}>{copied ? 'コピー済み ✓' : 'GPT指示をコピー'}</button>
  </div>;
}

function phaseLabel(phase: DeveloperJob['phase'], status: DeveloperJob['status']) {
  if (status === 'completed') return '✅ CI確認済み';
  if (status === 'failed') return '⚠ 設定エラー';
  if (phase === 'recovery_ready') return '🔁 GPT復旧待ち';
  if (phase === 'waiting_ci') return 'CI監視中';
  if (phase === 'human_required') return '👤 人間操作が必要';
  if (phase === 'waiting_chatgpt') return '🧠 GPT作業待ち';
  return '🧠 GPT引き継ぎ準備済み';
}

function guardianStatusLabel(run: GuardianRun) {
  if (run.status === 'completed') return '✅ CI確認済み';
  if (run.status === 'review_ready') return '👤 人間確認';
  if (run.status === 'expired') return '⏱ 監視時間上限';
  if (run.status === 'failed') return '⚠ 停止';
  if (run.phase === 'recovery_ready') return '🔁 GPT復旧ループ';
  if (run.status === 'waiting_ci') return 'CI監視中';
  return '🛡 監督継続中';
}

function developerMessage(job: DeveloperJob) {
  if (job.status === 'completed') return '現在headのCI成功まで確認済みです。';
  if (job.phase === 'recovery_ready') return 'CI失敗を検出し、ChatGPT用の復旧指示を準備しました。Guardianは停止していません。';
  if (job.phase === 'waiting_ci') return '現在headのCIを監視しています。';
  if (job.phase === 'human_required') return '権限や承認など、人間操作が必要です。';
  return 'ChatGPT側の作業を待ちながら監督を継続しています。';
}

function guardianMessage(run: GuardianRun) {
  if (run.status === 'completed') return 'Guardianが現在headのCI成功まで確認しました。';
  if (run.status === 'review_ready') return '人間操作が必要な地点まで進み、安全停止しました。';
  if (run.status === 'expired') return '監視時間上限です。状態は保存されているのでChatGPTで継続できます。';
  if (run.phase === 'recovery_ready') return 'CI失敗後のChatGPT復旧指示を更新しました。監視は継続中です。';
  return 'Guardianは監督を継続しています。';
}

function ciIcon(status: string, conclusion: string | null) {
  if (status !== 'completed') return '◌';
  if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') return '✓';
  return '×';
}

function safeChatUrl(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') return null;
    if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com') return url.toString();
  } catch { /* invalid URL */ }
  return null;
}

function openGitHub(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com') window.open(url.toString(), '_blank', 'noopener,noreferrer');
  } catch { /* ignore unsafe URL */ }
}
