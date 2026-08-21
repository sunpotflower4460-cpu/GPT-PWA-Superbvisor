import { useEffect, useState } from 'react';

export default function ReleaseUpdateCenter() {
  const [available, setAvailable] = useState(false);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    const show = () => {
      setAvailable(true);
      setExpanded(true);
    };
    window.addEventListener('devdeck:app-update-available', show);
    return () => window.removeEventListener('devdeck:app-update-available', show);
  }, []);

  if (!available) return null;

  if (!expanded) {
    return (
      <button className="release-update-pill" onClick={() => setExpanded(true)} aria-label="アプリ更新あり">
        ↻ 更新あり
      </button>
    );
  }

  return (
    <aside className="release-update-banner" role="status" aria-live="polite">
      <div>
        <b>新しいPWA版があります</b>
        <span>現在の操作はそのまま。再読み込みすると最新UIへ切り替わります。</span>
      </div>
      <div className="release-update-actions">
        <button className="release-update-primary" onClick={() => window.location.reload()}>更新を反映</button>
        <button onClick={() => setExpanded(false)}>あとで</button>
      </div>
    </aside>
  );
}
