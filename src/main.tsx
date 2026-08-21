import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import BackgroundWorkerCenter from './BackgroundWorkerCenter';
import EvidenceCenter from './EvidenceCenter';
import SmartActionCenter from './SmartActionCenter';
import WatchdogRuntime from './WatchdogRuntime';
import './styles.css';
import './evidence.css';
import './smart-actions.css';
import './background-worker.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <WatchdogRuntime />
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
