import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import BackgroundWorkerCenter from './BackgroundWorkerCenter';
import DeveloperAgentCenter from './DeveloperAgentCenter';
import DeveloperAgentLauncher from './DeveloperAgentLauncher';
import EvidenceCenter from './EvidenceCenter';
import HandoffCenter from './HandoffCenter';
import NotificationCenter from './NotificationCenter';
import OperatingPlanCenter from './OperatingPlanCenter';
import RuntimeProjectSync from './RuntimeProjectSync';
import SetupDoctorCenter from './SetupDoctorCenter';
import SmartActionCenter from './SmartActionCenter';
import WatchdogRuntime from './WatchdogRuntime';
import './styles.css';
import './evidence.css';
import './smart-actions.css';
import './background-worker.css';
import './recovery.css';
import './handoff-notice.css';
import './watchdog-inbox.css';
import './developer-agent.css';
import './operating-plan.css';
import './dashboard-plan.css';
import './execution-router.css';
import './setup-doctor.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <RuntimeProjectSync />
    <WatchdogRuntime />
    <NotificationCenter />
    <HandoffCenter />
    <SmartActionCenter />
    <BackgroundWorkerCenter />
    <OperatingPlanCenter />
    <DeveloperAgentLauncher />
    <DeveloperAgentCenter />
    <EvidenceCenter />
    <SetupDoctorCenter />
  </React.StrictMode>,
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.warn('Service worker registration failed:', error);
    });
  });
}
