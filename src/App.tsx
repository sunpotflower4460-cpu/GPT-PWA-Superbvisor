import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  AutomationLevel,
  DevProject,
  ProjectStatus,
  buildActionPrompt,
  createProject,
  isLikelyStalled,
  loadProjects,
  quickActions,
  saveProjects,
  statusLabel,
} from './core';
import { OperatingPlan, getOperatingPlan, targetLabels } from './operatingPlan';
import { enqueueProjectChatCommand } from './chatControl';

type Tab = 'projects' | 'human' | 'activity' | 'settings';

// A pure link into GitHub's own "create repository from template" flow
// — never an API-driven repo-creation call from this Worker. Keeps the
// "new project" scaffolding suggestion entirely declarative and
// reversible: the user creates the repo themselves on GitHub's own
// site, then pastes its URL back in here, same as any other GitHub URL
// they'd type in manually. Uses the documented `/generate` path suffix
// (github.com/{owner}/{repo}/generate), not the `/new?template_owner=`
// query-string form — the query-string form was unverified against
// GitHub's own docs when this was written, so `/generate` was chosen
// as the guaranteed-stable, documented mechanism instead.
const GPT_TEMPLATE_URL = 'https://github.com/sunpotflower4460-cpu/GPT-template/generate';

const statusTone: Record<ProjectStatus, string> = {
  RUNNING: 'running',
  WAITING_AI: 'neutral',
  WAITING_USER: 'human',
  STALLED: 'warning',
  ERROR: 'danger',
  RATE_LIMITED: 'warning',
  CONTEXT_LIMIT: 'warning',
  COMPLETED: 'success',
};

function formatRelative(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.round(hours / 24)}日前`;
}

function planTargetLabel(plan: OperatingPlan) {
  return plan.target === 'CUSTOM' ? plan.customTarget.trim() || targetLabels.CUSTOM : targetLabels[plan.target];
}

function executionRouteLabel(project: DevProject) {
  return project.executionMode === 'WORK' ? '🟣 Work（明示利用）' : '💬 ChatGPT';
}

function safeChatUrl(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') return null;
    if (host !== 'chatgpt.com' && !host.endsWith('.chatgpt.com') && host !== 'chat.openai.com') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function safeGitHubUrl(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export default function App() {
  const [projects, setProjects] = useState<DevProject[]>(() => loadProjects());
  const [tab, setTab] = useState<Tab>('projects');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [actionFeedback, setActionFeedback] = useState('');
  const [sendingAction, setSendingAction] = useState('');

  useEffect(() => saveProjects(projects), [projects]);
  useEffect(() => {
    const reload = () => setProjects(loadProjects());
    window.addEventListener('devdeck:projects-changed', reload);
    window.addEventListener('devdeck:operating-plan-changed', reload);
    return () => {
      window.removeEventListener('devdeck:projects-changed', reload);
      window.removeEventListener('devdeck:operating-plan-changed', reload);
    };
  }, []);

  const selected = projects.find((project) => project.id === selectedId) ?? null;
  const selectedPlan = selected ? getOperatingPlan(selected.id) : null;
  const selectedChatUrl = safeChatUrl(selected?.chatUrl);
  const selectedGitHubUrl = safeGitHubUrl(selected?.githubUrl);
  const runningCount = projects.filter((project) => ['RUNNING', 'WAITING_AI'].includes(project.status)).length;
  const humanCount = projects.filter((project) => project.status === 'WAITING_USER' || project.humanBlockers.length > 0).length;
  const completedCount = projects.filter((project) => project.status === 'COMPLETED').length;
  const alertCount = projects.filter((project) => ['STALLED', 'ERROR', 'RATE_LIMITED', 'CONTEXT_LIMIT'].includes(project.status) || isLikelyStalled(project)).length;

  const activity = useMemo(
    () =>
      projects
        .flatMap((project) => project.timeline.map((event) => ({ ...event, projectName: project.name })))
        .sort((a, b) => +new Date(b.at) - +new Date(a.at)),
    [projects],
  );

  function patchProject(id: string, patch: Partial<DevProject>) {
    setProjects((items) =>
      items.map((item) =>
        item.id === id
          ? { ...item, ...patch, lastActivityAt: patch.lastActivityAt ?? new Date().toISOString() }
          : item,
      ),
    );
  }

  async function sendAction(project: DevProject, actionId: string) {
    const action = quickActions.find((item) => item.id === actionId);
    if (!action) return;
    if (!project.chatUrl) {
      setActionFeedback('ChatGPT URLを登録してください。');
      return;
    }
    setSendingAction(action.id);
    setActionFeedback('');
    try {
      await enqueueProjectChatCommand(project, buildActionPrompt(project, action));
      patchProject(project.id, {
        status: 'WAITING_AI',
        currentPhase: `Chat Control Bus · ${action.label} 配送待ち`,
        humanBlockers: [],
      });
      setActionFeedback(`${action.label} を対象ChatGPTの送信キューへ追加しました。`);
    } catch (error) {
      setActionFeedback(error instanceof Error ? error.message : 'ChatGPT指示を送信キューへ追加できませんでした。');
    } finally {
      setSendingAction('');
      window.setTimeout(() => setActionFeedback(''), 3500);
    }
  }

  function openChatControl(projectId: string) {
    window.dispatchEvent(new CustomEvent('devdeck:open-chat-control', { detail: { projectId } }));
  }

  function renderProjectCard(project: DevProject) {
    const stalled = isLikelyStalled(project);
    const visibleStatus: ProjectStatus = stalled ? 'STALLED' : project.status;
    const plan = getOperatingPlan(project.id);

    return (
      <button className="project-card" key={project.id} onClick={() => setSelectedId(project.id)}>
        <div className="project-card-top">
          <div>
            <span className={`status-dot ${statusTone[visibleStatus]}`} />
            <strong>{project.name}</strong>
          </div>
          <span className={`status-pill ${statusTone[visibleStatus]}`}>{statusLabel(visibleStatus)}</span>
        </div>
        <div className="progress-row">
          <div className="progress-track"><span style={{ width: `${project.progress}%` }} /></div>
          <b>{project.progress}%</b>
        </div>
        <p className="phase">{project.currentPhase}</p>
        <div className="plan-chip">☷ {planTargetLabel(plan)}</div>
        <div className="card-meta">
          <span>{executionRouteLabel(project)}</span>
          <span>{project.automationLevel}</span>
          <span>{formatRelative(project.lastActivityAt)}</span>
        </div>
        {project.humanBlockers.length > 0 && (
          <div className="human-callout">👤 あなたが必要：{project.humanBlockers[0]}</div>
        )}
      </button>
    );
  }

  if (selected) {
    return (
      <main className="app-shell">
        <header className="topbar detail-topbar">
          <button className="icon-button" onClick={() => setSelectedId(null)}>←</button>
          <div>
            <p className="eyebrow">PROJECT</p>
            <h1>{selected.name}</h1>
          </div>
          <span className={`status-pill ${statusTone[isLikelyStalled(selected) ? 'STALLED' : selected.status]}`}>
            {statusLabel(isLikelyStalled(selected) ? 'STALLED' : selected.status)}
          </span>
        </header>

        <section className="detail-stack">
          <article className="panel hero-panel">
            <div className="section-heading"><span>目標</span><b>{selected.progress}%</b></div>
            <h2>{selected.goal}</h2>
            <div className="progress-track large"><span style={{ width: `${selected.progress}%` }} /></div>
            <p className="muted">現在：{selected.currentPhase} ・ {executionRouteLabel(selected)} ・ 最終活動 {formatRelative(selected.lastActivityAt)}</p>
          </article>

          {selectedPlan && (
            <article className="panel dashboard-plan-panel">
              <div className="section-heading"><span>☷ Operating Plan</span><b>{planTargetLabel(selectedPlan)}</b></div>
              <p>{selectedPlan.workflow}</p>
              <div className="dashboard-plan-meta">
                {selectedPlan.continueWithoutConfirmation && <span>連続実行</span>}
                {selectedPlan.validateAndTest && <span>検証あり</span>}
                {selectedPlan.recoverFromFailure && <span>失敗時復旧</span>}
                {selectedPlan.selfReview && <span>自己レビュー</span>}
              </div>
              <button className="secondary-action" onClick={() => window.dispatchEvent(new CustomEvent('devdeck:open-operating-plan', { detail: { projectId: selected.id } }))}>Planを開く / 実行</button>
            </article>
          )}

          <article className="panel">
            <div className="section-heading"><span>工程</span><span>{selected.automationLevel}</span></div>
            <div className="milestones">
              {selected.milestones.map((milestone) => (
                <div className={`milestone ${milestone.state.toLowerCase()}`} key={milestone.id}>
                  <span>{milestone.state === 'DONE' ? '✓' : milestone.state === 'ACTIVE' ? '●' : milestone.state === 'BLOCKED' ? '!' : '○'}</span>
                  <span>{milestone.title}</span>
                </div>
              ))}
            </div>
          </article>

          {selected.humanBlockers.length > 0 && (
            <article className="panel human-panel">
              <div className="section-heading"><span>👤 あなた待ち</span><b>{selected.humanBlockers.length}件</b></div>
              {selected.humanBlockers.map((item) => <p key={item}>• {item}</p>)}
            </article>
          )}

          <article className="panel">
            <div className="section-heading"><span>このChatGPTへ指示</span><span>Multi Chat Remote</span></div>
            <div className="quick-actions">
              {quickActions.map((action, index) => (
                <button
                  key={action.id}
                  className={index === 0 ? 'primary-action' : 'secondary-action'}
                  disabled={Boolean(sendingAction) || !selectedChatUrl}
                  onClick={() => void sendAction(selected, action.id)}
                >
                  {sendingAction === action.id ? '送信キューへ追加中…' : action.label}
                </button>
              ))}
            </div>
            {actionFeedback && <p className="muted">{actionFeedback}</p>}
            <div className="launch-row">
              <button className="launch-button" onClick={() => openChatControl(selected.id)}>Chat Controlを開く</button>
              {selectedChatUrl ? (
                <button className="ghost-button" onClick={() => window.open(selectedChatUrl, '_blank', 'noopener,noreferrer')}>ChatGPTを直接開く ↗</button>
              ) : <span className="muted">{selected.chatUrl ? 'Chat URLを確認してください' : 'Chat URL未登録'}</span>}
              {selectedGitHubUrl ? (
                <button className="ghost-button" onClick={() => window.open(selectedGitHubUrl, '_blank', 'noopener,noreferrer')}>GitHub ↗</button>
              ) : selected.githubUrl ? <span className="muted">GitHub URLを確認してください</span> : null}
            </div>
          </article>

          <article className="panel">
            <div className="section-heading"><span>自動化レベル</span><span>実行者はChatGPT固定</span></div>
            {selected.executionMode === 'WORK' && (
              <div className="human-callout">
                Workを明示利用中です。通常のMulti Chat Remoteへ戻す場合は
                <button className="ghost-button" onClick={() => patchProject(selected.id, { executionMode: 'CHAT' })}>ChatGPT実行へ戻す</button>
              </div>
            )}
            <div className="segmented automation">
              {(['OFF', 'ASSIST', 'AUTO', 'GUARDIAN'] as AutomationLevel[]).map((level) => (
                <button className={selected.automationLevel === level ? 'active' : ''} key={level} onClick={() => patchProject(selected.id, { automationLevel: level })}>{level}</button>
              ))}
            </div>
            <p className="muted">AUTO / GUARDIANでは、復旧やAutopilot Routeの次工程をChat Control Busへ自動投入します。本人操作が必要な時だけ「あなた待ち」になります。</p>
          </article>

          <article className="panel">
            <div className="section-heading"><span>最近の履歴</span><span>{selected.timeline.length}件</span></div>
            <div className="timeline">
              {selected.timeline.slice().reverse().slice(0, 8).map((event) => (
                <div className="timeline-row" key={event.id}>
                  <time>{new Date(event.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</time>
                  <span>{event.message}</span>
                </div>
              ))}
            </div>
          </article>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AI DEVELOPMENT COCKPIT</p>
          <h1>AI DEV DECK</h1>
        </div>
        <button className="add-button" onClick={() => setShowCreate(true)}>＋</button>
      </header>

      {tab === 'projects' && (
        <>
          <section className="summary-grid">
            <div><b>{runningCount}</b><span>稼働中</span></div>
            <div><b>{humanCount}</b><span>あなた待ち</span></div>
            <div><b>{alertCount}</b><span>要確認</span></div>
            <div><b>{completedCount}</b><span>完了</span></div>
          </section>
          <section className="content-section">
            <div className="section-heading"><h2>プロジェクト</h2><span>{projects.length}件</span></div>
            <div className="project-list">
              {projects.length ? projects.map(renderProjectCard) : (
                <div className="empty-state">
                  <div>🛰️</div>
                  <h2>最初の案件を登録</h2>
                  <p>ChatGPTの開発チャットとGitHubを、スマホから見渡せる状態にします。</p>
                  <button className="primary-action" onClick={() => setShowCreate(true)}>プロジェクトを追加</button>
                </div>
              )}
            </div>
          </section>
        </>
      )}

      {tab === 'human' && (
        <section className="content-section">
          <div className="section-heading"><h2>👤 あなた待ち</h2><span>{humanCount}件</span></div>
          <div className="project-list">
            {projects.filter((p) => p.status === 'WAITING_USER' || p.humanBlockers.length).map(renderProjectCard)}
            {humanCount === 0 && <div className="empty-state"><div>🌿</div><h2>今は操作不要</h2><p>人間にしかできない作業は登録されていません。</p></div>}
          </div>
        </section>
      )}

      {tab === 'activity' && (
        <section className="content-section">
          <div className="section-heading"><h2>Activity</h2><span>{activity.length}件</span></div>
          <div className="panel timeline">
            {activity.length ? activity.slice(0, 30).map((event) => (
              <div className="timeline-row activity-row" key={`${event.projectName}-${event.id}`}>
                <time>{new Date(event.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
                <span><b>{event.projectName}</b><br />{event.message}</span>
              </div>
            )) : <p className="muted">まだ履歴がありません。</p>}
          </div>
        </section>
      )}

      {tab === 'settings' && <Settings />}

      {showCreate && (
        <CreateProjectModal
          onClose={() => setShowCreate(false)}
          onCreate={(project) => {
            setProjects((items) => [project, ...items]);
            setShowCreate(false);
            setSelectedId(project.id);
          }}
        />
      )}

      <nav className="bottom-nav">
        <button className={tab === 'projects' ? 'active' : ''} onClick={() => setTab('projects')}><span>⌂</span>案件</button>
        <button className={tab === 'human' ? 'active' : ''} onClick={() => setTab('human')}><span>👤</span>自分待ち</button>
        <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}><span>⚡</span>履歴</button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}><span>⚙</span>設定</button>
      </nav>
    </main>
  );
}

function CreateProjectModal({ onClose, onCreate }: { onClose: () => void; onCreate: (project: DevProject) => void }) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [chatUrl, setChatUrl] = useState('');
  const [githubUrl, setGithubUrl] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !goal.trim()) return;
    onCreate(createProject({ name: name.trim(), goal: goal.trim(), chatUrl: chatUrl.trim() || undefined, githubUrl: githubUrl.trim() || undefined }));
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <div className="section-heading"><h2>プロジェクト追加</h2><button type="button" className="icon-button" onClick={onClose}>×</button></div>
        <label>名前<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例：SNS-AI" /></label>
        <label>最終目標<textarea value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="例：本人しかできない外部設定だけの状態まで仕上げる" rows={4} /></label>
        <label>ChatGPT URL<input value={chatUrl} onChange={(e) => setChatUrl(e.target.value)} placeholder="https://chatgpt.com/c/..." /></label>
        <label>GitHub URL<input value={githubUrl} onChange={(e) => setGithubUrl(e.target.value)} placeholder="https://github.com/owner/repo" /></label>
        {!githubUrl.trim() && (
          <p className="field-hint">
            新しいリポジトリが必要な場合は、
            <a href={GPT_TEMPLATE_URL} target="_blank" rel="noopener noreferrer">GPT-template</a>
            から作成すると、CI・レビュー承認などのガードレールが最初から入った状態で始められます。作成後、そのリポジトリのURLを上に貼り付けてください(必須ではありません)。
          </p>
        )}
        <button className="primary-action" type="submit">登録する</button>
      </form>
    </div>
  );
}

function Settings() {
  const [notificationState, setNotificationState] = useState<NotificationPermission | 'unsupported'>(() =>
    'Notification' in window ? Notification.permission : 'unsupported',
  );

  async function requestNotifications() {
    if (!('Notification' in window)) {
      setNotificationState('unsupported');
      return;
    }
    const result = await Notification.requestPermission();
    setNotificationState(result);
  }

  return (
    <section className="content-section">
      <div className="section-heading"><h2>設定</h2><span>v0.16</span></div>
      <article className="panel settings-list">
        <div><b>基本実行者</b><span>ChatGPT固定</span></div>
        <div><b>Multi Chat</b><span>Control Bus + Bridge</span></div>
        <div><b>Work</b><span>明示利用時のみ</span></div>
        <div><b>AUTO</b><span>次手を自動Queue</span></div>
        <div><b>Guardian</b><span>CI監視 + 自動復旧Queue</span></div>
        <div><b>Operating Plan</b><span>案件ごとに保存</span></div>
        <div><b>状態同期</b><span>起動 / 復帰 / 2分ごと</span></div>
        <div><b>データ保存</b><span>案件はこの端末 + Worker状態</span></div>
      </article>
      <article className="panel">
        <div className="section-heading"><span>通知</span><span>{notificationState}</span></div>
        <p className="muted">通知InboxからWeb Pushを有効化すると、Guardianの完了や本当に本人操作が必要な停止をPWAを閉じていても受け取れます。</p>
        <button className="secondary-action" onClick={requestNotifications} disabled={notificationState === 'unsupported'}>通知権限を確認</button>
      </article>
    </section>
  );
}
