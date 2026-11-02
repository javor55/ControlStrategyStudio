import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { demoProjectFiles } from '@csd/core';
import { App } from './App';
import { EditorStore, setStore } from './state/store';
import { browserStore, lastProjectId, newProjectId, rememberLast } from './state/persist';
import './styles.css';

async function boot() {
  let id = lastProjectId();
  const saved = id ? await browserStore.load(id) : undefined;
  if (!saved) id = newProjectId();
  const s = new EditorStore(id!, saved?.files ?? demoProjectFiles());
  setStore(s);
  rememberLast(id!);

  // Autosave to the browser shortly after each change.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const persist = () => {
    const st = s.getState();
    return browserStore
      .save({ id: st.projectId, name: st.model.meta.name, updated: Date.now(), files: st.files as Record<string, string | Uint8Array> })
      .then(() => s.getState().files === st.files && s.markSaved());
  };
  s.onFilesChanged = () => {
    clearTimeout(timer);
    timer = setTimeout(persist, 500);
  };
  if (!saved) persist();
  window.addEventListener('beforeunload', () => {
    clearTimeout(timer);
    if (s.getState().unsaved) persist();
  });

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

boot();
