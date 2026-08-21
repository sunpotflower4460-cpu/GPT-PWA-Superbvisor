import { useEffect, useState } from 'react';
import { loadProjects } from './core';
import { getLatestBackgroundJob, loadWorkerConnection } from './backgroundWorker';
import {
  SupervisorNotification,
  addNotification,
  clearReadNotifications,
  loadNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  showSystemNotification,
} from './notifications';

export default function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SupervisorNotification[]>(() => loadNotifications());
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');
  const unread = items.filter((item) => !item.readAt).length;

  useEffect(() => {
    const reload = () => setItems(loadNotifications());
    window.addEventListener('devdeck:notifications-changed', reload);
    return () => window.removeEventListener('devdeck:notifications-changed', reload);
  }, []);

  async function openCenter() {
    setOpen(true);
    setItems(loadNotifications());
    await syncStatus();
  }

  async function syncStatus() {
    setSyncing(true);
    setMessage('');
    const projects = loadProjects();
    const connection = loadWorkerConnection();
    let added = 0;

    for (const project of projects) {
      const localInputs: Array<Omit<SupervisorNotification, 'id' | 'createdAt'>> = [];
      if (project.status === 'CONTEXT_LIMIT') {
        localInputs.push({ dedupeKey: `project:${project.id}:handoff:${project.lastActivityAt}`, projectId: project.id, projectName: project.name, kind: 'handoff', title: `${project.name}: 引き継ぎ推奨`, detail: '会話が長くなっています。Checkpointを作成して新しいChatへ移る準備ができます。' });
      }
      if (project.humanBlockers.length) {
        localInputs.push({ dedupeKey: `project:${project.id}:human:${project.humanBlockers.join('|')}`, projectId: project.id, projectName: project.name, kind: 'human', title: `${project.name}: あなたが必要`, detail: project.humanBlockers.join(' / ') });
      }
      if (project.status === 'ERROR' || project.status === 'STALLED') {
        localInputs.push({ dedupeKey: `project:${project.id}:attention:${project.status}:${project.lastActivityAt}`, projectId: project.id, projectName: project.name, kind: 'error', title: `${project.name}: ${project.status === 'ERROR' ? 'エラー' : '停止疑い'}`, detail: `${project.currentPhase} でSupervisorの確認が必要です。` });
      }
      for (const input of localInputs) {
        const created = addNotification(input);
        if (created) { added += 1; showSystemNotification(created); }
      }

      if (!connection.baseUrl || !connection.token) continue;
      try {
        const job = await getLatestBackgroundJob(project.id, connection);
        if (job.status === 'completed') {
          const created = addNotification({
            dedupeKey: `job:${job.id}:completed`, projectId: project.id, projectName: project.name, kind: 'complete',
            title: `${project.name}: Background完了`, detail: job.report?.summary || job.checkpoint?.summary || 'Background処理が完了しました。',
          });
          if (created) { added += 1; showSystemNotification(created); }
        }
        if (job.status === 'failed' || job.status === 'incomplete' || job.status === 'cancelled') {
          const created = addNotification({
            dedupeKey: `job:${job.id}:${job.status}`, projectId: project.id, projectName: project.name, kind: 'error',
            title: `${project.name}: Background ${job.status}`, detail: job.error || job.checkpoint?.summary || 'Background処理を確認してください。',
          });
          if (created) { added += 1; showSystemNotification(created); }
        }
        if (job.report?.humanRequired.length) {
          const created = addNotification({
            dedupeKey: `job:${job.id}:human`, projectId: project.id, projectName: project.name, kind: 'human',
            title: `${project.name}: あなたが必要`, detail: job.report.humanRequired.join(' / '),
          });
          if (created) { added += 1; showSystemNotification(created); }
        }
      } catch {
        // No job or temporarily unavailable Worker must not break the inbox sync.
      }
    }

    setItems(loadNotifications());
    setMessage(added ? `${added}件の新しい状態を取り込みました。` : '新しい通知はありません。');
    setSyncing(false);
  }

  function read(item: SupervisorNotification) {
    markNotificationRead(item.id);
    setItems(loadNotifications());
  }

  function readAll() {
    markAllNotificationsRead();
    setItems(loadNotifications());
  }

  function clearRead() {
    clearReadNotifications();
    setItems(loadNotifications());
  }

  return (
    <>
      <button className="notification-fab" onClick={openCenter} aria-label="Notification inbox">🔔{unread > 0 && <span>{unread > 99 ? '99+' : unread}</span>}</button>
      {open && (
        <div className="notice-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section className="notice-sheet">
            <header className="notice-header">
              <div><p className="eyebrow">SUPERVISOR INBOX</p><h2>通知</h2></div>
              <button className="icon-button" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="notice-actions">
              <button onClick={syncStatus} disabled={syncing}>{syncing ? '同期中…' : '↻ 状態を同期'}</button>
              <button onClick={readAll}>すべて既読</button>
              <button onClick={clearRead}>既読を消す</button>
            </div>
            {message && <div className="notice-message">{message}</div>}
            <div className="notice-list">
              {items.length === 0 ? <div className="empty-state compact"><div>🌿</div><h2>通知はありません</h2><p>完了・停止・本人待ちなど重要なものだけここに残します。</p></div> : items.map((item) => (
                <button key={item.id} className={`notice-item ${item.kind} ${item.readAt ? 'read' : ''}`} onClick={() => read(item)}>
                  <span className="notice-icon">{icon(item.kind)}</span>
                  <div><strong>{item.title}</strong><p>{item.detail}</p><time>{new Date(item.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div>
                  {!item.readAt && <i />}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function icon(kind: SupervisorNotification['kind']) {
  if (kind === 'complete') return '✓';
  if (kind === 'human') return '👤';
  if (kind === 'error') return '!';
  if (kind === 'handoff') return '↗';
  return '•';
}
