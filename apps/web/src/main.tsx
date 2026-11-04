import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { demoProjectFiles } from '@csd/core';
import { App } from './App';
import { EditorStore, setStore } from './state/store';
import { browserStore, lastProjectId, newProjectId } from './state/persist';
import { flushSave, onFilesChanged, openSession } from './state/session';
import './styles.css';

async function boot() {
  const id = lastProjectId();
  const saved = id ? await browserStore.load(id) : undefined;
  const s = new EditorStore(saved?.id ?? newProjectId(), saved?.files ?? demoProjectFiles());
  setStore(s);
  s.onFilesChanged = onFilesChanged;
  await openSession(s.getState().projectId, s.getState().files, saved?.git, { save: !saved });
  window.addEventListener('beforeunload', flushSave);

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

boot();
