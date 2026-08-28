import { useEffect, useState } from 'react';

const FAB_SELECTOR = [
  '.plan-fab',
  '.developer-fab',
  '.worker-fab',
  '.chat-control-fab',
  '.smart-fab',
  '.notification-fab',
  '.handoff-fab',
  '.evidence-fab',
].join(',');

export default function MobileToolDock() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 699px)');
    const collapseOnDesktop = () => {
      if (!media.matches) setOpen(false);
    };
    media.addEventListener('change', collapseOnDesktop);
    return () => media.removeEventListener('change', collapseOnDesktop);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('tool-dock-open', open);
    return () => document.documentElement.classList.remove('tool-dock-open');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointer = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(FAB_SELECTOR)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('click', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="tool-dock">
      {open && <div className="tool-dock-scrim" onClick={() => setOpen(false)} />}
      <div className="tool-dock-panel" aria-hidden="true" />
      <button
        type="button"
        className="tool-dock-toggle"
        aria-expanded={open}
        aria-label={open ? 'ツールを閉じる' : 'ツール'}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? '閉じる' : 'ツール'}
      </button>
    </div>
  );
}
