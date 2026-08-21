export type SupervisorNotificationKind = 'complete' | 'human' | 'error' | 'handoff' | 'info';
export type SupervisorNotificationAction = 'RECOVER_CHAT' | 'OPEN_HANDOFF' | 'OPEN_URL';

export interface SupervisorNotification {
  id: string;
  dedupeKey: string;
  projectId?: string;
  projectName?: string;
  kind: SupervisorNotificationKind;
  title: string;
  detail: string;
  createdAt: string;
  readAt?: string;
  action?: SupervisorNotificationAction;
  actionLabel?: string;
  actionPrompt?: string;
  actionUrl?: string;
}

const STORAGE_KEY = 'gpt-pwa-supervisor.notifications.v1';
const MAX_ITEMS = 100;

export function loadNotifications(): SupervisorNotification[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveNotifications(items: SupervisorNotification[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
  window.dispatchEvent(new CustomEvent('devdeck:notifications-changed'));
}

export function addNotification(input: Omit<SupervisorNotification, 'id' | 'createdAt'>): SupervisorNotification | null {
  const items = loadNotifications();
  if (items.some((item) => item.dedupeKey === input.dedupeKey)) return null;
  const notification: SupervisorNotification = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  saveNotifications([notification, ...items]);
  return notification;
}

export function markNotificationRead(id: string) {
  const now = new Date().toISOString();
  saveNotifications(loadNotifications().map((item) => item.id === id ? { ...item, readAt: item.readAt ?? now } : item));
}

export function markAllNotificationsRead() {
  const now = new Date().toISOString();
  saveNotifications(loadNotifications().map((item) => ({ ...item, readAt: item.readAt ?? now })));
}

export function clearReadNotifications() {
  saveNotifications(loadNotifications().filter((item) => !item.readAt));
}

export function unreadNotificationCount() {
  return loadNotifications().filter((item) => !item.readAt).length;
}

export function showSystemNotification(item: SupervisorNotification) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(item.title, { body: item.detail, tag: item.dedupeKey });
  } catch {
    // In-app inbox remains the source of truth when system notifications are unavailable.
  }
}
