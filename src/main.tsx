import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import EvidenceCenter from './EvidenceCenter';
import SmartActionCenter from './SmartActionCenter';
import './styles.css';
import './evidence.css';
import './smart-actions.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <SmartActionCenter />
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
