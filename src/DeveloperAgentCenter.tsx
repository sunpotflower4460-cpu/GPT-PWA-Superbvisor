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

const defaultAction = quickActions.find((action) => action.id === 'manual-only') ?? quickActions[0];
type DeveloperMode = 'single' | 'guardian';

export default function DeveloperAgentCenter() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<DevProject[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<DeveloperMode>('single');
  const [maxToolTurns, setMaxToolTurns] = useState(10);
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
      setMessage(error instanceof Error ? error.message : 'GitHub Developer Agent設定を確認できませんでした。');
    }
  }

  function changeProject(id: string) {
    setSelectedId(id);
    setPrompt('');
    setJob(null);
    setGuardian(null);
    setMessage('');
  }

  function changeMode(next: DeveloperMode) {
    setMode(next);
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
      if (mode === 'guardian') {
        const next = await startGuardianRun(selected, task, { maxCycles, maxToolTurns, maxMinutes }, connection);
        setGuardian(next);
        setJob(null);
        setMessage('Guardianを開始しました。実装→CI確認→必要なら同じbranchで修正を、設定した上限まで自動で進めます。端末を閉じてもCron/Webhookが監督します。');
      } else {
        const next = await startDeveloperJob(selected, task, maxToolTurns, connection);
        setJob(next);
        setGuardian(null);
        setMessage(next.status === 'failed' ? next.error || '開始に失敗しました。' : '安全なfeature branchを作成し、GitHub Developer Agentを開始しました。端末を閉じてもWebhookで継続します。');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Developer Agentを開始できませんでした。');
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
        setMessage(latest.status === 'completed' ? 'GitHub作業は完了しています。' : latest.status === 'failed' ? 'GitHub作業が停止しました。' : '最新状態を取得しました。');
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
          <div><p className="eyebrow">GUARDED GITHUB EXECUTION</p><h2>GitHub Developer Agent</h2></div>
          <button className="icon-button" onClick={() => setOpen(false)}>×</button>
        </header>

        <div className="developer-guardrails">
          <b>🔒 mainへは書かない。</b>
          <span>許可したrepoだけ → `ai-dev-deck/*` branchで編集 → 最後はDraft PR。自動マージ・本番deploy・秘密情報操作はしません。</span>
        </div>

        {!configured && <div className="developer-warning">⚠ Worker側のGITHUB_TOKEN / GITHUB_ALLOWED_REPOS設定がまだありません。</div>}
        {configuredRepos.length > 0 && <div className="developer-allowlist"><b>許可repo</b>{configuredRepos.map((repo) => <code key={repo}>{repo}</code>)}</div>}

        {projects.length === 0 ? <div className="empty-state compact"><div>⌘</div><h2>GitHub登録済み案件がありません</h2><p>案件にGitHub URLを登録するとここから実装を任せられます。</p></div> : (
          <>
            <div className="developer-tabs">
              {projects.map((project) => <button key={project.id} className={project.id === selected?.id ? 'active' : ''} onClick={() => changeProject(project.id)}>{project.name}</button>)}
            </div>

            {selected && <div className="developer-project">
              <article className="developer-project-card">
                <div><strong>{selected.name}</strong><small>{selected.githubUrl}</small></div><span>{selected.progress}%</span>
                <p>{selected.goal}</p>
              </article>

              <div className="developer-mode-switch" role="group" aria-label="GitHub実行モード">
                <button className={mode === 'single' ? 'active' : ''} onClick={() => changeMode('single')}>
                  <b>⌘ 単発</b><small>1回の実装 → Draft PR</small>
                </button>
                <button className={mode === 'guardian' ? 'active guardian' : 'guardian'} onClick={() => changeMode('guardian')}>
                  <b>🛡 Guardian</b><small>CI失敗なら自動修正</small>
                </button>
              </div>

              {mode === 'guardian' && (
                <div className="guardian-explain">
                  <b>指定地点へ近づくまで監督</b>
                  <span>実装 → GitHub Actions確認 → 失敗なら同じfeature branchで原因修正 → 再確認。上限に達するかCIが通るまで進めます。</span>
                </div>
              )}

              <label className="developer-prompt">
                <span>このGitHubで進める作業 <small>空欄なら「手動作業だけになるまで」の標準指示</small></span>
                <textarea rows={6} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例：現在の未完成箇所を確認し、実装・修正してDraft PRまで進めて" />
              </label>

              <label className="developer-limit">1サイクルの最大ツールラウンド
                <select value={maxToolTurns} onChange={(event) => setMaxToolTurns(Number(event.target.value))}>
                  <option value={6}>6（軽い修正）</option>
                  <option value={10}>10（標準）</option>
                  <option value={14}>14（大きめ）</option>
                  <option value={16}>16（上限）</option>
                </select>
              </label>

              {mode === 'guardian' && (
                <div className="guardian-limits">
                  <label>最大サイクル
                    <select value={maxCycles} onChange={(event) => setMaxCycles(Number(event.target.value))}>
                      <option value={1}>1回</option>
                      <option value={2}>2回</option>
                      <option value={3}>3回（標準）</option>
                      <option value={4}>4回（上限）</option>
                    </select>
                  </label>
                  <label>最大経過時間
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
                  {busy === 'start' ? '開始中…' : mode === 'guardian' ? '🛡 Guardianで進める' : '⌘ feature branchで実装開始'}
                </button>
                <button disabled={busy === 'refresh'} onClick={refresh}>{busy === 'refresh' ? '更新中…' : '状態を更新'}</button>
              </div>

              {mode === 'guardian' ? guardian && <GuardianCard run={guardian} /> : job && <DeveloperJobCard job={job} />}
            </div>}
          </>
        )}

        {message && <div className="developer-message">{message}</div>}
        <p className="developer-footnote">
          {mode === 'guardian'
            ? 'GuardianはWebhookに加えて5分ごとのWatchdogで再確認します。上限到達・エラー・CI成功、またはCI未検出のレビュー待ちで停止し、自動mergeはしません。'
            : 'GitHub Actionsは非同期なので、単発AgentはCIを無限ポーリングしません。Draft PR作成後はGitHub Reality CheckでCIを確認できます。'}
        </p>
      </section>
    </div>
  ) : null;
}

function DeveloperJobCard({ job }: { job: DeveloperJob }) {
  return <article className={`developer-job ${job.status}`}>
    <div className="section-heading"><span>{job.status.toUpperCase()}</span><b>{job.toolTurns}/{job.maxToolTurns} tool rounds</b></div>
    <div className="developer-branch"><span>branch</span><code>{job.workspace.branch}</code></div>
    {job.changedFiles && job.changedFiles.length > 0 && <details open className="developer-files"><summary>変更ファイル {job.changedFiles.length}件</summary>{job.changedFiles.slice(0, 30).map((file) => <div key={file.filename}><code>{file.filename}</code><span>+{file.additions}/-{file.deletions}</span></div>)}</details>}
    {job.pullRequest && <button className="developer-pr" onClick={() => window.open(job.pullRequest!.url, '_blank', 'noopener,noreferrer')}>Draft PR #{job.pullRequest.number} を開く ↗</button>}
    {job.error && <div className="developer-error">⚠ {job.error}</div>}
    {job.outputText && <details className="developer-output"><summary>Agentレポート</summary><pre>{job.outputText}</pre></details>}
  </article>;
}

function GuardianCard({ run }: { run: GuardianRun }) {
  const final = run.status === 'review_ready' || run.status === 'completed' || run.status === 'failed' || run.status === 'expired';
  return <article className={`guardian-card ${run.status}`}>
    <div className="section-heading">
      <span>{guardianStatusLabel(run.status)}</span>
      <b>cycle {run.cycle}/{run.maxCycles}</b>
    </div>
    <div className="guardian-meter"><span style={{ width: `${Math.round((run.cycle / run.maxCycles) * 100)}%` }} /></div>
    {run.message && <p className="guardian-message">{run.message}</p>}
    <div className="guardian-meta"><span>最大 {run.maxMinutes}分</span><span>1 cycle {run.maxToolTurns} rounds</span></div>
    {run.ciChecks && run.ciChecks.length > 0 && (
      <div className="guardian-ci">
        <b>GitHub Actions</b>
        {run.ciChecks.map((check) => (
          <button key={`${check.name}-${check.headSha}`} onClick={() => window.open(check.url, '_blank', 'noopener,noreferrer')}>
            <span>{ciIcon(check.status, check.conclusion)} {check.name}</span><small>{check.conclusion || check.status} ↗</small>
          </button>
        ))}
      </div>
    )}
    {run.pullRequest && <button className="developer-pr" onClick={() => window.open(run.pullRequest!.url, '_blank', 'noopener,noreferrer')}>Draft PR #{run.pullRequest.number} を開く ↗</button>}
    {run.error && <div className="developer-error">⚠ {run.error}</div>}
    {run.finalSummary && <details className="developer-output"><summary>最新Agentレポート</summary><pre>{run.finalSummary}</pre></details>}
    {!final && <div className="guardian-live">● Supervisor監督中</div>}
  </article>;
}

function guardianStatusLabel(status: GuardianRun['status']) {
  if (status === 'waiting_ci') return 'CI待ち';
  if (status === 'review_ready') return '👤 レビュー待ち';
  if (status === 'completed') return '✅ CI確認済み';
  if (status === 'failed') return '⚠ 停止';
  if (status === 'expired') return '⏱ 時間上限';
  return '🛡 稼働中';
}

function guardianMessage(run: GuardianRun) {
  if (run.status === 'completed') return 'GuardianがCI成功まで確認しました。Draft PRをレビューできます。';
  if (run.status === 'review_ready') return 'コード作業は終わりましたがCIを確認できませんでした。完成扱いにはせず、人間レビュー待ちです。';
  if (run.status === 'failed') return 'Guardianが設定したサイクル上限またはエラーで停止しました。';
  if (run.status === 'expired') return 'Guardianが最大経過時間に到達して停止しました。';
  if (run.status === 'waiting_ci') return 'GitHub Actionsの完了を待っています。';
  return 'Guardianは現在も作業を監督しています。';
}

function ciIcon(status: string, conclusion: string | null) {
  if (status !== 'completed') return '◌';
  if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') return '✓';
  return '×';
}
