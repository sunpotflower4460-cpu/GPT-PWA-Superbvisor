import { useEffect } from 'react';
import { loadProjects } from './core';
import { addNotification } from './notifications';
import {
  WatchdogFinding,
  inspectProject,
  loadWatchdogStates,
  notificationKey,
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

        if (finding.needsAttention) {
          const action = finding.recommendedAction === 'HANDOFF'
            ? 'OPEN_HANDOFF' as const
            : finding.prompt
              ? 'RECOVER_CHAT' as const
              : undefined;
          addNotification({
            dedupeKey: `watchdog:${project.id}:${project.lastActivityAt}:${notificationKey(finding)}`,
            projectId: project.id,
            projectName: project.name,
            kind: notificationKind(finding),
            title: `${project.name}: ${finding.title}`,
            detail: finding.detail,
            action,
            actionLabel: action === 'OPEN_HANDOFF' ? '引き継ぎを開く' : action === 'RECOVER_CHAT' ? '再開してChatを開く' : undefined,
            actionPrompt: action === 'RECOVER_CHAT' ? finding.prompt : undefined,
          });
        }

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

function notificationKind(finding: WatchdogFinding) {
  if (finding.recommendedAction === 'HUMAN') return 'human' as const;
  if (finding.recommendedAction === 'HANDOFF') return 'handoff' as const;
  if (finding.severity === 'INFO') return 'info' as const;
  return 'error' as const;
}
