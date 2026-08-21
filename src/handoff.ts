import { DevProject } from './core';
import { buildHandoffPacket } from './supervisor';

export interface HandoffCheckpoint {
  id: string;
  projectId: string;
  projectName: string;
  createdAt: string;
  reason: 'MANUAL' | 'CONTEXT_LIMIT' | 'STALL_RECOVERY';
  packet: string;
}

const STORAGE_KEY = 'gpt-pwa-supervisor.handoffs.v1';
const MAX_ITEMS = 40;

export function loadHandoffCheckpoints(): HandoffCheckpoint[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function createHandoffCheckpoint(
  project: DevProject,
  reason: HandoffCheckpoint['reason'] = 'MANUAL',
): HandoffCheckpoint {
  const checkpoint: HandoffCheckpoint = {
    id: crypto.randomUUID(),
    projectId: project.id,
    projectName: project.name,
    createdAt: new Date().toISOString(),
    reason,
    packet: buildHandoffPacket(project),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify([checkpoint, ...loadHandoffCheckpoints()].slice(0, MAX_ITEMS)));
  return checkpoint;
}

export function latestHandoffForProject(projectId: string) {
  return loadHandoffCheckpoints().find((item) => item.projectId === projectId);
}
