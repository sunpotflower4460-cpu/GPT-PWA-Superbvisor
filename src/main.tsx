import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import BackgroundWorkerCenter from './BackgroundWorkerCenter';
import EvidenceCenter from './EvidenceCenter';
import HandoffCenter from './HandoffCenter';
import NotificationCenter from './NotificationCenter';
import SmartActionCenter from './SmartActionCenter';
import WatchdogRuntime from './WatchdogRuntime';
import './styles.css';
import './evidence.css';
import './smart-actions.css';
import './background-worker.css';
import './recovery.css';
import './handoff-notice.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <WatchdogRuntime />
    <NotificationCenter />
    <HandoffCenter />
    <SmartActionCenter />
    <BackgroundWorkerCenter />
    <EvidenceCenter />
  </React.StrictMode>,
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.warn('Service worker registration failed:', error);
    });
  });
}
