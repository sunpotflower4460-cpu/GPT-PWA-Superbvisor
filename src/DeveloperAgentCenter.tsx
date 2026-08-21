import { useEffect, useMemo, useState } from 'react';
import { DevProject, buildActionPrompt, loadProjects, quickActions } from './core';
import { loadWorkerConnection } from './backgroundWorker';
import {
  DeveloperJob,
  getDeveloperConfig,
  getLatestDeveloperJob,
  startDeveloperJob,
} from './developerAgent';

const defaultAction = quickActions.find((action) => action.id === 'manual-only') ?? quickActions[0];

export default function DeveloperAgentCenter() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<DevProject[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [maxToolTurns, setMaxToolTurns] = useState(10);
  const [job, setJob] = useState<DeveloperJob | null>(null);
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
    setMessage('');
  }

  async function start() {
    if (!selected) return;
    setBusy('start');
    setMessage('');
    try {
      const task = prompt.trim() || buildActionPrompt(selected, defaultAction);
      const next = await startDeveloperJob(selected, task, maxToolTurns, loadWorkerConnection());
      setJob(next);
      setMessage(next.status === 'failed' ? next.error || '開始に失敗しました。' : '安全なfeature branchを作成し、GitHub Developer Agentを開始しました。端末を閉じてもWebhookで継続します。');
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
      const latest = await getLatestDeveloperJob(selected.id, loadWorkerConnection());
      setJob(latest);
      setMessage(latest.status === 'completed' ? 'GitHub作業は完了しています。' : latest.status === 'failed' ? 'GitHub作業が停止しました。' : '最新状態を取得しました。');
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

              <label className="developer-prompt">
                <span>このGitHubで進める作業 <small>空欄なら「手動作業だけになるまで」の標準指示</small></span>
                <textarea rows={6} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例：現在の未完成箇所を確認し、実装・修正してDraft PRまで進めて" />
              </label>

              <label className="developer-limit">最大ツールラウンド
                <select value={maxToolTurns} onChange={(event) => setMaxToolTurns(Number(event.target.value))}>
                  <option value={6}>6（軽い修正）</option>
                  <option value={10}>10（標準）</option>
                  <option value={14}>14（大きめ）</option>
                  <option value={16}>16（上限）</option>
                </select>
              </label>

              <div className="developer-actions">
                <button className="developer-start" disabled={!configured || busy === 'start'} onClick={start}>{busy === 'start' ? '開始中…' : '⌘ feature branchで実装開始'}</button>
                <button disabled={busy === 'refresh'} onClick={refresh}>{busy === 'refresh' ? '更新中…' : '状態を更新'}</button>
              </div>

              {job && <DeveloperJobCard job={job} />}
            </div>}
          </>
        )}

        {message && <div className="developer-message">{message}</div>}
        <p className="developer-footnote">GitHub Actionsは非同期なので、AgentはCIを無限ポーリングしません。Draft PR作成後はGitHub Reality CheckでCIを確認できます。</p>
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
