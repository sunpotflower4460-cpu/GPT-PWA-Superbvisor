import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import EvidenceCenter from './EvidenceCenter';
import './styles.css';
import './evidence.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
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
