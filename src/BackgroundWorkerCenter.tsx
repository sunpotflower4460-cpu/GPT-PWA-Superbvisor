import { useMemo, useState } from 'react';
import { DevProject, buildActionPrompt, loadProjects, quickActions } from './core';
import {
  BackgroundJob,
  WorkerConnection,
  checkWorkerHealth,
  getBackgroundJob,
  loadBackgroundJobIds,
  loadWorkerConnection,
  saveWorkerConnection,
  startBackgroundJob,
} from './backgroundWorker';

const completionAction = quickActions.find((action) => action.id === 'manual-only') ?? quickActions[0];

export default function BackgroundWorkerCenter() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<DevProject[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [connection, setConnection] = useState<WorkerConnection>(() => loadWorkerConnection());
  const [jobs, setJobs] = useState<Record<string, BackgroundJob>>({});
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');

  const selected = useMemo(
    () => projects.find((project) => project.id === selectedId) ?? projects[0] ?? null,
    [projects, selectedId],
  );
  const selectedJob = selected ? jobs[selected.id] : undefined;

  async function openCenter() {
    const nextProjects = loadProjects();
    setProjects(nextProjects);
    setSelectedId((current) => current && nextProjects.some((project) => project.id === current) ? current : nextProjects[0]?.id ?? '');
    setConnection(loadWorkerConnection());
    setOpen(true);
    setMessage('');
  }

  function persistConnection() {
    saveWorkerConnection(connection);
    setConnection(loadWorkerConnection());
    setMessage('接続設定をこの端末に保存しました。');
  }

  async function testConnection() {
    setBusy('health');
    setMessage('');
    try {
      saveWorkerConnection(connection);
      const health = await checkWorkerHealth(connection);
      setMessage(health.ok ? 'Workerに接続できました。' : 'Worker応答を確認できませんでした。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '接続確認に失敗しました。');
    } finally {
      setBusy('');
    }
  }

  async function startSelected() {
    if (!selected) return;
    setBusy('start');
    setMessage('');
    try {
      saveWorkerConnection(connection);
      const prompt = customPrompt.trim() || buildActionPrompt(selected, completionAction);
      const job = await startBackgroundJob(selected, prompt, connection);
      setJobs((items) => ({ ...items, [selected.id]: job }));
      setMessage('Background処理を開始しました。端末を閉じてもOpenAI側で処理が継続します。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Background処理を開始できませんでした。');
    } finally {
      setBusy('');
    }
  }

  async function refreshSelected() {
    if (!selected) return;
    setBusy('refresh');
    setMessage('');
    try {
      saveWorkerConnection(connection);
      const known = jobs[selected.id]?.id || loadBackgroundJobIds()[selected.id];
      if (!known) throw new Error('この案件のBackground Jobはまだありません。');
      const job = await getBackgroundJob(known, connection);
      setJobs((items) => ({ ...items, [selected.id]: job }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '状態取得に失敗しました。');
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <button className="worker-fab" onClick={openCenter} aria-label="Background worker center">⚡</button>

      {open && (
        <div className="worker-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section className="worker-sheet">
            <header className="worker-header">
              <div>
                <p className="eyebrow">OPTIONAL TURBO</p>
                <h2>Background Worker</h2>
              </div>
              <button className="icon-button" onClick={() => setOpen(false)}>×</button>
            </header>

            <div className="worker-note">
              <b>通常はChatのままでOK。</b>
              <span>端末を閉じても止めたくない工程だけ、ここから明示的に昇格します。API利用料が発生します。</span>
            </div>

            <details className="worker-settings">
              <summary>Worker接続設定</summary>
              <label>
                Worker URL
                <input
                  value={connection.baseUrl}
                  onChange={(event) => setConnection((current) => ({ ...current, baseUrl: event.target.value }))}
                  placeholder="https://gpt-pwa-supervisor-worker.example.workers.dev"
                />
              </label>
              <label>
                個人接続トークン
                <input
                  type="password"
                  value={connection.token}
                  onChange={(event) => setConnection((current) => ({ ...current, token: event.target.value }))}
                  placeholder="Workerに設定したSUPERVISOR_CLIENT_TOKEN"
                />
              </label>
              <div className="worker-setting-actions">
                <button onClick={persistConnection}>保存</button>
                <button onClick={testConnection} disabled={busy === 'health'}>{busy === 'health' ? '確認中…' : '接続確認'}</button>
              </div>
            </details>

            {projects.length === 0 ? (
              <div className="empty-state compact">
                <div>⚡</div><h2>案件がありません</h2><p>先にプロジェクトを登録してください。</p>
              </div>
            ) : (
              <>
                <div className="worker-project-tabs">
                  {projects.map((project) => (
                    <button
                      key={project.id}
                      className={project.id === selected?.id ? 'active' : ''}
                      onClick={() => {
                        setSelectedId(project.id);
                        setCustomPrompt('');
                        setMessage('');
                      }}
                    >{project.name}</button>
                  ))}
                </div>

                {selected && (
                  <div className="worker-project">
                    <article className="worker-project-card">
                      <div className="section-heading">
                        <div><strong>{selected.name}</strong><small>{selected.currentPhase}</small></div>
                        <span>{selected.progress}%</span>
                      </div>
                      <p>{selected.goal}</p>
                    </article>

                    <label className="worker-prompt">
                      <span>このWorkerへ任せる指示 <small>空欄なら「手動作業だけになるまで」の標準指示</small></span>
                      <textarea
                        rows={5}
                        value={customPrompt}
                        onChange={(event) => setCustomPrompt(event.target.value)}
                        placeholder="例：現在の設計をレビューし、次の実装順と修正案を完成条件まで整理して"
                      />
                    </label>

                    <div className="worker-actions">
                      <button className="worker-start" disabled={busy === 'start'} onClick={startSelected}>
                        {busy === 'start' ? '開始中…' : '⚡ Backgroundへ任せる'}
                      </button>
                      <button disabled={busy === 'refresh'} onClick={refreshSelected}>
                        {busy === 'refresh' ? '更新中…' : '状態を更新'}
                      </button>
                    </div>

                    {selectedJob && <JobCard job={selectedJob} />}
                  </div>
                )}
              </>
            )}

            {message && <div className="worker-message">{message}</div>}

            <p className="worker-footnote">
              現段階のBackground Workerは、長い推論・調査結果・引き継ぎ/計画などを端末非依存で完了させる実行層です。GitHubを書き換える能力はまだ自動付与していません。次段階で安全なGitHub実行ツールを接続します。
            </p>
          </section>
        </div>
      )}
    </>
  );
}

function JobCard({ job }: { job: BackgroundJob }) {
  const final = ['completed', 'failed', 'incomplete', 'cancelled'].includes(job.status);
  return (
    <article className={`worker-job ${final ? 'final' : 'running'}`}>
      <div className="section-heading">
        <span>Job {job.id.slice(0, 12)}…</span>
        <b>{job.status}</b>
      </div>
      <div className="worker-job-meta">
        <span>{job.model}</span>
        <span>更新 {new Date(job.updatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      {job.checkpoint && (
        <div className="worker-checkpoint">
          <b>Checkpoint</b>
          <p>{job.checkpoint.summary}</p>
        </div>
      )}
      {job.error && <div className="worker-error">⚠ {job.error}</div>}
      {job.outputText && (
        <details className="worker-output">
          <summary>完了レポートを見る</summary>
          <pre>{job.outputText}</pre>
        </details>
      )}
    </article>
  );
}
