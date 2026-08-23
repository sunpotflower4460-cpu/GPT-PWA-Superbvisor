import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import BackgroundWorkerCenter from './BackgroundWorkerCenter';
import ChatControlCenter from './ChatControlCenter';
import DataBackupCenter from './DataBackupCenter';
import DeveloperAgentCenter from './DeveloperAgentCenter';
import DeveloperAgentLauncher from './DeveloperAgentLauncher';
import EvidenceCenter from './EvidenceCenter';
import HandoffCenter from './HandoffCenter';
import NotificationCenter from './NotificationCenter';
import OperatingPlanCenter from './OperatingPlanCenter';
import ReleaseUpdateCenter from './ReleaseUpdateCenter';
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
import './release-update.css';
import './data-backup.css';
import './chat-control.css';

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
    <ChatControlCenter />
    <DeveloperAgentLauncher />
    <DeveloperAgentCenter />
    <EvidenceCenter />
    <SetupDoctorCenter />
    <DataBackupCenter />
    <ReleaseUpdateCenter />
  </React.StrictMode>,
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    let hadController = Boolean(navigator.serviceWorker.controller);
    let lastUpdateCheck = 0;

    const announceUpdate = () => {
      window.dispatchEvent(new CustomEvent('devdeck:app-update-available'));
    };

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) announceUpdate();
      hadController = true;
    });

    navigator.serviceWorker.register('./sw.js').then((registration) => {
      if (registration.waiting && hadController) announceUpdate();

      const checkForUpdate = () => {
        const now = Date.now();
        if (now - lastUpdateCheck < 5 * 60_000) return;
        lastUpdateCheck = now;
        registration.update().catch((error) => {
          console.warn('Service worker update check failed:', error);
        });
      };

      window.addEventListener('focus', checkForUpdate);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate();
      });
    }).catch((error) => {
      console.warn('Service worker registration failed:', error);
    });
  });
}
