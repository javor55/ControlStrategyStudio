// Opens the Settings dialog from anywhere (project view, inspector …). The top
// bar owns the dialog and listens for this event.
export type SettingsTab = 'project' | 'drawing' | 'editor';

const EVENT = 'csd:open-settings';

export function openSettings(tab?: SettingsTab) {
  window.dispatchEvent(new CustomEvent<SettingsTab | undefined>(EVENT, { detail: tab }));
}

export function onOpenSettings(fn: (tab?: SettingsTab) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<SettingsTab | undefined>).detail);
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}
