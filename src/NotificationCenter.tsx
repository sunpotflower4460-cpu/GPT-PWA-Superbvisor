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
import {
  PushState,
  disablePushNotifications,
  enablePushNotifications,
  getPushState,
  sendTestPush,
} from './pushNotifications';

const initialPushState: PushState = { supported: false, permission: 'unsupported', subscribed: false };

export default function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SupervisorNotification[]>(() => loadNotifications());
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [pushState, setPushState] = useState<PushState>(initialPushState);
  const [pushBusy, setPushBusy] = useState('');
  const [pushMessage, setPushMessage] = useState('');
  const unread = items.filter((item) => !item.readAt).length;

  useEffect(() => {
    const reload = () => setItems(loadNotifications());
    window.addEventListener('devdeck:notifications-changed', reload);
    return () => window.removeEventListener('devdeck:notifications-changed', reload);
  }, []);

  async function openCenter() {
    setOpen(true);
    setItems(loadNotifications());
    setActionMessage('');
    await Promise.all([syncStatus(), refreshPushState()]);
  }

  async function refreshPushState() {
    try {
      setPushState(await getPushState());
    } catch {
      setPushState(initialPushState);
    }
  }

  async function enablePush() {
    setPushBusy('enable');
    setPushMessage('');
    try {
      await enablePushNotifications(loadWorkerConnection());
      await refreshPushState();
      setPushMessage('Push通知を有効にしました。PWAを閉じていてもBackground完了を受け取れます。');
    } catch (error) {
      setPushMessage(error instanceof Error ? error.message : 'Push通知を有効にできませんでした。');
    } finally {
      setPushBusy('');
    }
  }

  async function disablePush() {
    setPushBusy('disable');
    setPushMessage('');
    try {
      await disablePushNotifications(loadWorkerConnection());
      await refreshPushState();
      setPushMessage('Push通知を解除しました。');
    } catch (error) {
      setPushMessage(error instanceof Error ? error.message : 'Push通知を解除できませんでした。');
    } finally {
      setPushBusy('');
    }
  }

  async function testPush() {
    setPushBusy('test');
    setPushMessage('');
    try {
      const result = await sendTestPush(loadWorkerConnection());
      setPushMessage(result.disabled
        ? 'Worker側のVAPID設定がまだありません。'
        : `テスト送信: ${result.sent}端末へ送信 / ${result.failed}件失敗`);
    } catch (error) {
      setPushMessage(error instanceof Error ? error.message : 'テストPushに失敗しました。');
    } finally {
      setPushBusy('');
    }
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
        localInputs.push({
          dedupeKey: `project:${project.id}:handoff:${project.lastActivityAt}`,
          projectId: project.id,
          projectName: project.name,
          kind: 'handoff',
          title: `${project.name}: 引き継ぎ推奨`,
          detail: '会話が長くなっています。Checkpointを作成して新しいChatへ移る準備ができます。',
          action: 'OPEN_HANDOFF',
          actionLabel: '引き継ぎを開く',
        });
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

  async function runItemAction(item: SupervisorNotification) {
    setActionMessage('');
    if (!item.action) return;

    if (item.action === 'OPEN_HANDOFF') {
      markNotificationRead(item.id);
      setItems(loadNotifications());
      setOpen(false);
      window.dispatchEvent(new CustomEvent('devdeck:open-handoff', { detail: { projectId: item.projectId } }));
      return;
    }

    if (item.action === 'RECOVER_CHAT') {
      if (!item.actionPrompt) {
        setActionMessage('再開指示が保存されていません。Smart Supervisorから再生成してください。');
        return;
      }
      const project = loadProjects().find((candidate) => candidate.id === item.projectId);
      const target = project?.chatUrl || 'https://chatgpt.com/';
      const nextWindow = window.open(target, '_blank', 'noopener,noreferrer');
      try {
        await navigator.clipboard.writeText(item.actionPrompt);
        markNotificationRead(item.id);
        setItems(loadNotifications());
        setActionMessage(nextWindow
          ? '再開指示をコピーしてChatを開きました。貼り付けて送信してください。'
          : '再開指示をコピーしました。ポップアップがブロックされたためChatは手動で開いてください。');
      } catch (error) {
        setActionMessage(error instanceof Error ? error.message : '再開指示をコピーできませんでした。');
      }
    }
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

            <div className="push-card">
              <div>
                <b>📲 Background Push</b>
                <small>{!pushState.supported ? 'この環境では未対応' : pushState.subscribed ? '有効・PWAを閉じても受信' : `未登録・権限 ${pushState.permission}`}</small>
              </div>
              <div className="push-actions">
                {!pushState.subscribed
                  ? <button onClick={enablePush} disabled={pushBusy === 'enable' || !pushState.supported}>{pushBusy === 'enable' ? '設定中…' : 'Pushを有効化'}</button>
                  : <>
                      <button onClick={testPush} disabled={pushBusy === 'test'}>{pushBusy === 'test' ? '送信中…' : 'テスト'}</button>
                      <button onClick={disablePush} disabled={pushBusy === 'disable'}>{pushBusy === 'disable' ? '解除中…' : '解除'}</button>
                    </>}
              </div>
            </div>
            {pushMessage && <div className="notice-message">{pushMessage}</div>}

            <div className="notice-actions">
              <button onClick={syncStatus} disabled={syncing}>{syncing ? '同期中…' : '↻ 状態を同期'}</button>
              <button onClick={readAll}>すべて既読</button>
              <button onClick={clearRead}>既読を消す</button>
            </div>
            {message && <div className="notice-message">{message}</div>}
            {actionMessage && <div className="notice-message notice-action-message">{actionMessage}</div>}
            <div className="notice-list">
              {items.length === 0 ? <div className="empty-state compact"><div>🌿</div><h2>通知はありません</h2><p>完了・停止・本人待ちなど重要なものだけここに残します。</p></div> : items.map((item) => (
                <article key={item.id} className={`notice-item ${item.kind} ${item.readAt ? 'read' : ''}`}>
                  <button className="notice-item-main" onClick={() => read(item)}>
                    <span className="notice-icon">{icon(item.kind)}</span>
                    <div><strong>{item.title}</strong><p>{item.detail}</p><time>{new Date(item.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div>
                    {!item.readAt && <i />}
                  </button>
                  {item.action && (
                    <button className={`notice-item-action ${item.action.toLowerCase()}`} onClick={() => runItemAction(item)}>
                      {item.actionLabel || '開く'}
                    </button>
                  )}
                </article>
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
