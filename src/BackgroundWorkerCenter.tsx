import { useMemo, useState } from 'react';
import { DevProject, buildActionPrompt, loadProjects, quickActions } from './core';
import {
  BackgroundJob,
  WorkerConnection,
  checkWorkerHealth,
  getLatestBackgroundJob,
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

  function openCenter() {
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
      setMessage(health.ok && health.orchestrationOnly && health.executor === 'chatgpt'
        ? 'Supervisor Workerに接続できました。実行主体=ChatGPT / API=監督専用を確認しました。'
        : health.ok
          ? 'Workerには接続できましたが、旧Background Executorの可能性があります。新しいWorkerへ更新してください。'
          : 'Worker応答を確認できませんでした。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '接続確認に失敗しました。');
    } finally {
      setBusy('');
    }
  }

  async function prepareSelected() {
    if (!selected) return;
    setBusy('start');
    setMessage('');
    try {
      saveWorkerConnection(connection);
      const prompt = customPrompt.trim() || buildActionPrompt(selected, completionAction);
      const job = await startBackgroundJob(selected, prompt, connection);
      setJobs((items) => ({ ...items, [selected.id]: job }));
      setMessage('SupervisorがChatGPTへ渡す次手を準備しました。APIは実作業を行っていません。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Supervisor指示を準備できませんでした。');
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
      const job = await getLatestBackgroundJob(selected.id, connection);
      setJobs((items) => ({ ...items, [selected.id]: job }));
      setMessage(job.kind === 'orchestration_handoff'
        ? '最新のChatGPT引き継ぎ指示を取得しました。'
        : '旧Background Jobを取得しました。新規作業はSupervisor方式で作成してください。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '状態取得に失敗しました。');
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <button className="worker-fab" onClick={openCenter} aria-label="Supervisor worker center">⚡</button>

      {open && (
        <div className="worker-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section className="worker-sheet">
            <header className="worker-header">
              <div>
                <p className="eyebrow">LOW-COST ORCHESTRATION</p>
                <h2>Supervisor Worker</h2>
              </div>
              <button className="icon-button" onClick={() => setOpen(false)}>×</button>
            </header>

            <div className="worker-note">
              <b>実際に作業するのはChatGPT。</b>
              <span>Cloudflare WorkerとDeepSeek / MiniMax / OpenAI APIは、状態整理・次手生成・CI監視・失敗復旧の司令塔です。APIだけで実装完了とは判定しません。</span>
            </div>

            <details className="worker-settings">
              <summary>Supervisor Worker接続設定</summary>
              <label>
                Worker URL
                <input value={connection.baseUrl} onChange={(event) => setConnection((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://...workers.dev" />
              </label>
              <label>
                個人接続トークン
                <input type="password" value={connection.token} onChange={(event) => setConnection((current) => ({ ...current, token: event.target.value }))} placeholder="SUPERVISOR_CLIENT_TOKEN" />
              </label>
              <div className="worker-setting-actions">
                <button onClick={persistConnection}>保存</button>
                <button onClick={testConnection} disabled={busy === 'health'}>{busy === 'health' ? '確認中…' : '接続・役割確認'}</button>
              </div>
            </details>

            {projects.length === 0 ? (
              <div className="empty-state compact"><div>⚡</div><h2>案件がありません</h2><p>先にプロジェクトを登録してください。</p></div>
            ) : (
              <>
                <div className="worker-project-tabs">
                  {projects.map((project) => (
                    <button key={project.id} className={project.id === selected?.id ? 'active' : ''} onClick={() => {
                      setSelectedId(project.id);
                      setCustomPrompt('');
                      setMessage('');
                    }}>{project.name}</button>
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
                      <span>Supervisorへ整理してほしい内容 <small>空欄なら標準の「手動作業だけになるまで」</small></span>
                      <textarea rows={5} value={customPrompt} onChange={(event) => setCustomPrompt(event.target.value)} placeholder="例：現在地点と残作業を整理し、このChatGPTが次に実行する最適な指示を作って" />
                    </label>

                    <div className="worker-actions">
                      <button className="worker-start" disabled={busy === 'start'} onClick={prepareSelected}>{busy === 'start' ? '整理中…' : '⚡ GPT実行指示を準備'}</button>
                      <button disabled={busy === 'refresh'} onClick={refreshSelected}>{busy === 'refresh' ? '更新中…' : '最新指示を取得'}</button>
                    </div>

                    {selectedJob && <JobCard job={selectedJob} project={selected} />}
                  </div>
                )}
              </>
            )}

            {message && <div className="worker-message">{message}</div>}
            <p className="worker-footnote">Providerが429/5xx/timeoutでも別provider・決定論的fallbackへ退避します。API障害だけで監督全体を停止しない設計です。</p>
          </section>
        </div>
      )}
    </>
  );
}

function JobCard({ job, project }: { job: BackgroundJob; project: DevProject }) {
  if (job.kind !== 'orchestration_handoff') {
    return <article className="worker-job final">
      <div className="section-heading"><span>Legacy Job</span><b>{job.status}</b></div>
      <div className="worker-message">旧Background Executorの保存Jobです。新規の自動実行には使用しません。</div>
      {job.outputText && <details className="worker-output"><summary>旧レポートを見る</summary><pre>{job.outputText}</pre></details>}
    </article>;
  }

  return (
    <article className="worker-job final">
      <div className="section-heading"><span>Orchestration {job.id.slice(0, 8)}</span><b>GPT HANDOFF READY</b></div>
      <div className="worker-job-meta">
        <span>{job.orchestratorProvider || 'deterministic'} / {job.model}</span>
        <span>更新 {new Date(job.updatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      {job.degradedOrchestration && <div className="worker-message">外部モデルが使えなくても決定論的fallbackで指示生成を継続しました。</div>}
      {job.checkpoint && <div className="worker-checkpoint"><b>Supervisor</b><p>{job.checkpoint.summary}</p></div>}
      {job.report && (
        <div className="completion-report">
          <div className="report-title"><b>🧭 オーケストレーション完了</b><span>{job.report.reachedStage}</span></div>
          <p>{job.report.summary}</p>
          {job.report.remaining.length > 0 && <ReportList title="次にChatGPTが行うこと" items={job.report.remaining} />}
          {job.report.humanRequired.length > 0 && <ReportList title="👤 人間判断が必要" items={job.report.humanRequired} />}
        </div>
      )}
      {job.handoffPrompt && <HandoffActions prompt={job.handoffPrompt} project={project} />}
      {job.outputText && <details className="worker-output"><summary>Supervisor要約</summary><pre>{job.outputText}</pre></details>}
    </article>
  );
}

function HandoffActions({ prompt, project }: { prompt: string; project: DevProject }) {
  const [copied, setCopied] = useState(false);
  async function copy(openChat: boolean) {
    try { await navigator.clipboard.writeText(prompt); setCopied(true); } catch { setCopied(false); }
    if (openChat) window.open(safeChatUrl(project.chatUrl) || 'https://chatgpt.com/', '_blank', 'noopener,noreferrer');
  }
  return <div className="worker-actions">
    <button className="worker-start" onClick={() => void copy(true)}>🧠 ChatGPTで実行</button>
    <button onClick={() => void copy(false)}>{copied ? 'コピー済み ✓' : '指示をコピー'}</button>
  </div>;
}

function ReportList({ title, items }: { title: string; items: string[] }) {
  return <div className="report-list"><b>{title}</b><ol>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ol></div>;
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
