import { useEffect, useMemo, useState } from 'react';
import { checkWorkerHealth, loadWorkerConnection } from './backgroundWorker';
import { getDeveloperConfig } from './developerAgent';
import { loadProjects } from './core';
import { getPushState } from './pushNotifications';

type CheckLevel = 'PASS' | 'WARN' | 'FAIL' | 'CHECKING';
type DoctorAction = 'OPEN_NOTIFICATIONS' | 'OPEN_DEVELOPER';

interface DoctorCheck {
  id: string;
  label: string;
  level: CheckLevel;
  detail: string;
  requiredForChat?: boolean;
  action?: DoctorAction;
  actionLabel?: string;
}

export default function SetupDoctorCenter() {
  const [open, setOpen] = useState(false);
  const [checks, setChecks] = useState<DoctorCheck[]>([]);
  const [busy, setBusy] = useState(false);
  const [checkedAt, setCheckedAt] = useState('');

  useEffect(() => { void diagnose(); }, []);

  const counts = useMemo(() => ({
    fail: checks.filter((item) => item.level === 'FAIL').length,
    warn: checks.filter((item) => item.level === 'WARN').length,
  }), [checks]);
  const chatReady = checks.length > 0 && !checks.some((item) => item.requiredForChat && item.level === 'FAIL');

  async function diagnose() {
    setBusy(true);
    const next: DoctorCheck[] = [];

    next.push({
      id: 'secure',
      label: 'HTTPS / Secure Context',
      level: window.isSecureContext ? 'PASS' : 'FAIL',
      detail: window.isSecureContext ? '安全なコンテキストで動作しています。' : 'PWA・Pushに必要なHTTPS環境ではありません。',
      requiredForChat: true,
    });

    const serviceWorkerSupported = 'serviceWorker' in navigator;
    let registration: ServiceWorkerRegistration | undefined;
    if (serviceWorkerSupported) registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
    next.push({
      id: 'service-worker',
      label: 'Service Worker',
      level: registration?.active ? 'PASS' : serviceWorkerSupported ? 'WARN' : 'FAIL',
      detail: registration?.active ? 'PWAのService Workerが有効です。' : serviceWorkerSupported ? '対応していますが、まだactiveな登録を確認できません。ページ再読み込みで解消する場合があります。' : 'このブラウザーはService Workerに対応していません。',
      requiredForChat: false,
    });

    const standalone = window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    next.push({
      id: 'installed',
      label: 'PWAインストール',
      level: standalone ? 'PASS' : 'WARN',
      detail: standalone ? 'ホーム画面からPWAとして起動しています。' : 'ブラウザー表示です。スマホではホーム画面へ追加すると使いやすくなります。',
    });

    const projects = loadProjects();
    next.push({
      id: 'projects',
      label: 'プロジェクト登録',
      level: projects.length ? 'PASS' : 'WARN',
      detail: projects.length ? `${projects.length}件の案件をこの端末で管理しています。` : 'まだ案件がありません。＋から最初の案件を登録してください。',
    });

    const notificationSupported = 'Notification' in window;
    next.push({
      id: 'notification-permission',
      label: '通知権限',
      level: !notificationSupported ? 'FAIL' : Notification.permission === 'granted' ? 'PASS' : 'WARN',
      detail: !notificationSupported ? '通知APIに対応していません。' : Notification.permission === 'granted' ? '通知は許可されています。' : Notification.permission === 'denied' ? '通知が拒否されています。OS/ブラウザー設定から変更が必要です。' : '通知はまだ許可されていません。Inboxから有効化できます。',
      action: notificationSupported ? 'OPEN_NOTIFICATIONS' : undefined,
      actionLabel: notificationSupported ? '通知Inboxを開く' : undefined,
    });

    if (registration?.active) {
      try {
        const push = await withTimeout(getPushState(), 5000);
        next.push({
          id: 'push',
          label: 'Web Push購読',
          level: push.supported && push.subscribed ? 'PASS' : push.supported ? 'WARN' : 'FAIL',
          detail: push.supported && push.subscribed ? '端末を閉じていてもSupervisor Pushを受信できます。' : push.supported ? 'Push対応端末ですが購読は未登録です。Inboxから有効化できます。' : 'この環境ではWeb Pushを利用できません。',
          action: push.supported ? 'OPEN_NOTIFICATIONS' : undefined,
          actionLabel: push.supported ? 'Push設定を開く' : undefined,
        });
      } catch {
        next.push({ id: 'push', label: 'Web Push購読', level: 'WARN', detail: 'Push状態を確認できませんでした。Service Worker状態を確認してください。', action: 'OPEN_NOTIFICATIONS', actionLabel: '通知Inboxを開く' });
      }
    }

    const connection = loadWorkerConnection();
    const workerConfigured = Boolean(connection.baseUrl.trim() && connection.token.trim());
    let workerHealthy = false;
    let workerBoundaryOk = false;
    if (!workerConfigured) {
      next.push({ id: 'worker', label: 'Supervisor Worker', level: 'WARN', detail: '未設定です。Chat-only運用は可能です。外部監督を使う場合は⚡からWorker URLと接続トークンを設定してください。' });
    } else {
      try {
        const health = await withTimeout(checkWorkerHealth(connection), 8000);
        workerHealthy = Boolean(health.ok);
        workerBoundaryOk = health.executor === 'chatgpt' && health.orchestrationOnly === true;
        next.push({
          id: 'worker',
          label: 'Supervisor Worker',
          level: !health.ok ? 'FAIL' : workerBoundaryOk ? 'PASS' : 'WARN',
          detail: !health.ok
            ? 'Workerは応答しましたがhealthが正常ではありません。'
            : workerBoundaryOk
              ? 'Cloudflare Workerへ接続済み。実行主体=ChatGPT / API=オーケストレーション専用を確認しました。'
              : 'Workerには接続できますが、旧Background Executorの可能性があります。新しいWorkerへ更新してください。',
        });
      } catch (error) {
        next.push({ id: 'worker', label: 'Supervisor Worker', level: 'FAIL', detail: `接続できません: ${error instanceof Error ? error.message : 'unknown error'}` });
      }
    }

    if (workerHealthy) {
      try {
        const config = await withTimeout(getDeveloperConfig(connection), 8000);
        const providers = config.availableProviders?.length ? config.availableProviders.join(' → ') : 'deterministic fallbackのみ';
        next.push({
          id: 'orchestration-provider',
          label: 'Orchestration Provider',
          level: config.availableProviders?.length ? 'PASS' : 'WARN',
          detail: `Primary: ${config.primaryProvider || 'deepseek'} / 利用可能: ${providers} / deterministic fallback: ${config.deterministicFallback ? 'ON' : '未確認'}`,
          action: 'OPEN_DEVELOPER',
          actionLabel: 'Orchestratorを確認',
        });
        next.push({
          id: 'github-agent',
          label: 'ChatGPT Guardian / GitHub',
          level: config.configured && config.executor === 'chatgpt' && config.orchestrationOnly ? 'PASS' : config.configured ? 'WARN' : 'WARN',
          detail: config.configured
            ? `GitHub監督設定済み・許可repo ${config.repositories.length}件。Workerはコード実装せずChatGPTのbranch/CIを監視します。`
            : 'Workerは動いていますがGITHUB_TOKENまたはGITHUB_ALLOWED_REPOSが未設定です。',
          action: 'OPEN_DEVELOPER',
          actionLabel: 'Guardianを確認',
        });
      } catch (error) {
        next.push({ id: 'github-agent', label: 'ChatGPT Guardian / GitHub', level: 'WARN', detail: `Guardian設定を確認できません: ${error instanceof Error ? error.message : 'unknown error'}`, action: 'OPEN_DEVELOPER', actionLabel: 'Guardianを確認' });
      }
    } else {
      next.push({ id: 'github-agent', label: 'ChatGPT Guardian / GitHub', level: 'WARN', detail: 'Supervisor Workerが接続できるとGitHub Guardian設定を診断できます。', action: 'OPEN_DEVELOPER', actionLabel: 'Guardian画面を開く' });
    }

    if (workerHealthy && !workerBoundaryOk) {
      next.push({ id: 'executor-boundary', label: 'Executor Boundary', level: 'WARN', detail: '実作業=ChatGPT / API=監督専用という新しい境界をWorker healthから確認できません。Workerの再deployを推奨します。' });
    }

    setChecks(next);
    setCheckedAt(new Date().toISOString());
    setBusy(false);
  }

  function runAction(action?: DoctorAction) {
    if (action === 'OPEN_NOTIFICATIONS') {
      setOpen(false);
      window.dispatchEvent(new CustomEvent('devdeck:open-notifications'));
    }
    if (action === 'OPEN_DEVELOPER') {
      setOpen(false);
      window.dispatchEvent(new CustomEvent('devdeck:open-developer'));
    }
  }

  return <>
    <button className={`doctor-pill ${chatReady ? counts.fail ? 'warning' : 'ready' : 'danger'}`} onClick={() => setOpen(true)} aria-label="Setup Doctor">
      <span>{chatReady ? '✓' : '!'}</span> 診断 {counts.fail + counts.warn > 0 ? counts.fail + counts.warn : 'OK'}
    </button>
    {open && <div className="doctor-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}><section className="doctor-sheet">
      <header className="doctor-header"><div><p className="eyebrow">SETUP DOCTOR</p><h2>利用準備の診断</h2></div><button className="icon-button" onClick={() => setOpen(false)}>×</button></header>
      <div className={`doctor-summary ${chatReady ? 'ready' : 'danger'}`}><b>{chatReady ? '💬 Chat基本運転は利用可能' : '⚠ 基本環境に要修正項目あり'}</b><span>{counts.fail} fail / {counts.warn} warning</span></div>
      <div className="doctor-list">{checks.map((item) => <article key={item.id} className={`doctor-check ${item.level.toLowerCase()}`}><span className="doctor-check-icon">{item.level === 'PASS' ? '✓' : item.level === 'FAIL' ? '!' : '?'}</span><div><strong>{item.label}</strong><p>{item.detail}</p>{item.action && <button onClick={() => runAction(item.action)}>{item.actionLabel || '開く'}</button>}</div></article>)}</div>
      <div className="doctor-actions"><button onClick={diagnose} disabled={busy}>{busy ? '診断中…' : '↻ 再診断'}</button><span>{checkedAt ? `最終診断 ${new Date(checkedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}` : ''}</span></div>
      <p className="doctor-footnote">秘密値そのものは表示しません。Providerが未設定でもdeterministic fallbackでSupervisorは利用できます。警告が残っていてもChat-only運用は可能です。</p>
    </section></div>}
  </>;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error('timeout')), ms))]);
}
