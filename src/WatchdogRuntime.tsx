import { useEffect } from 'react';
import { loadProjects } from './core';
import {
  inspectProject,
  loadWatchdogStates,
  recordNotification,
  saveWatchdogStates,
  shouldNotify,
} from './watchdog';

const INTERVAL_MS = 60_000;

export default function WatchdogRuntime() {
  useEffect(() => {
    function inspect() {
      const projects = loadProjects().filter((project) => project.automationLevel !== 'OFF');
      const states = loadWatchdogStates();
      const nextStates = { ...states };

      for (const project of projects) {
        const previous = states[project.id];
        const finding = inspectProject(project, previous);
        let nextState = finding.nextState;

        if (
          finding.needsAttention &&
          shouldNotify(finding, previous) &&
          'Notification' in window &&
          Notification.permission === 'granted'
        ) {
          new Notification(`AI DEV DECK · ${project.name}`, {
            body: `${finding.title} — ${finding.detail}`,
            icon: './icon.svg',
            tag: `watchdog-${project.id}`,
          });
          nextState = recordNotification(nextState, finding);
        }

        nextStates[project.id] = nextState;
      }

      saveWatchdogStates(nextStates);
      window.dispatchEvent(new CustomEvent('devdeck:watchdog-scan'));
    }

    inspect();
    const timer = window.setInterval(inspect, INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  return null;
}
