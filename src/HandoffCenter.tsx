import { useEffect, useMemo, useState } from 'react';
import { DevProject, loadProjects } from './core';
import { createHandoffCheckpoint, loadHandoffCheckpoints } from './handoff';
import { addNotification } from './notifications';

export default function HandoffCenter() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<DevProject[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [packet, setPacket] = useState('');
  const [copied, setCopied] = useState(false);
  const [historyCount, setHistoryCount] = useState(0);

  const selected = useMemo(
    () => projects.find((project) => project.id === selectedId) ?? projects[0] ?? null,
    [projects, selectedId],
  );
  const selectedChatUrl = safeChatUrl(selected?.chatUrl);

  useEffect(() => {
    const handler = (event: Event) => {
      const projectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      openCenter(projectId);
    };
    window.addEventListener('devdeck:open-handoff', handler);
    return () => window.removeEventListener('devdeck:open-handoff', handler);
  }, []);

  function openCenter(preferredProjectId?: string) {
    const next = loadProjects().sort((a, b) => Number(b.status === 'CONTEXT_LIMIT') - Number(a.status === 'CONTEXT_LIMIT'));
    const nextId = preferredProjectId && next.some((project) => project.id === preferredProjectId)
      ? preferredProjectId
      : selectedId && next.some((project) => project.id === selectedId)
        ? selectedId
        : next[0]?.id ?? '';
    setProjects(next);
    setSelectedId(nextId);
    setPacket('');
    setCopied(false);
    setHistoryCount(loadHandoffCheckpoints().length);
    setOpen(true);
  }

  function makeCheckpoint(project: DevProject) {
    const checkpoint = createHandoffCheckpoint(project, project.status === 'CONTEXT_LIMIT' ? 'CONTEXT_LIMIT' : 'MANUAL');
    setPacket(checkpoint.packet);
    setHistoryCount(loadHandoffCheckpoints().length);
    addNotification({
      dedupeKey: `handoff:${checkpoint.id}`,
      projectId: project.id,
      projectName: project.name,
      kind: 'handoff',
      title: `${project.name}: Checkpoint保存`,
      detail: '新しいChatへ引き継げる状態を保存しました。',
    });
  }

  async function copyPacket() {
    if (!packet) return;
    await navigator.clipboard.writeText(packet);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function copyAndOpen() {
    if (!selected) return;
    if (!packet) {
      const checkpoint = createHandoffCheckpoint(selected, selected.status === 'CONTEXT_LIMIT' ? 'CONTEXT_LIMIT' : 'MANUAL');
      setPacket(checkpoint.packet);
      await navigator.clipboard.writeText(checkpoint.packet);
    } else {
      await navigator.clipboard.writeText(packet);
    }
    setCopied(true);
    window.open('https://chatgpt.com/', '_blank', 'noopener,noreferrer');
  }

  return (
    <>
      <button className="handoff-fab" onClick={() => openCenter()} aria-label="Chat handoff center">↗</button>
      {open && (
        <div className="handoff-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section className="handoff-sheet">
            <header className="handoff-header">
              <div><p className="eyebrow">CHAT HANDOFF</p><h2>引き継ぎ</h2></div>
              <button className="icon-button" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="handoff-note">
              <b>Chatが長くなったら、全文ではなく状態だけ持ち越す。</b>
              <span>通常Chatを外部PWAから自動作成・自動投稿はしません。Checkpoint生成→コピー→新規Chatを開くところまで最短化します。</span>
            </div>

            {projects.length === 0 ? <div className="empty-state compact"><div>↗</div><h2>案件がありません</h2></div> : (
              <>
                <div className="handoff-tabs">
                  {projects.map((project) => <button key={project.id} className={project.id === selected?.id ? 'active' : ''} onClick={() => { setSelectedId(project.id); setPacket(''); }}>
                    {project.status === 'CONTEXT_LIMIT' && <span>⚠ </span>}{project.name}
                  </button>)}
                </div>
                {selected && (
                  <div className="handoff-project">
                    <article>
                      <strong>{selected.name}</strong><span>{selected.progress}%</span>
                      <p>{selected.currentPhase}</p>
                    </article>
                    <button className="handoff-create" onClick={() => makeCheckpoint(selected)}>Checkpoint / 引き継ぎ文を作る</button>
                    {packet && <textarea readOnly value={packet} rows={12} />}
                    <div className="handoff-actions">
                      <button disabled={!packet} onClick={copyPacket}>{copied ? '✓ コピー済み' : 'コピー'}</button>
                      <button className="handoff-primary" onClick={copyAndOpen}>コピーして新しいChatを開く ↗</button>
                      {selectedChatUrl && <button onClick={() => window.open(selectedChatUrl, '_blank', 'noopener,noreferrer')}>元Chatを開く</button>}
                    </div>
                  </div>
                )}
              </>
            )}
            <p className="handoff-footnote">保存済みCheckpoint: {historyCount}件（最新40件を端末保存）</p>
          </section>
        </div>
      )}
    </>
  );
}

function safeChatUrl(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || (host !== 'chatgpt.com' && !host.endsWith('.chatgpt.com') && host !== 'chat.openai.com')) return null;
    return url.toString();
  } catch {
    return null;
  }
}
