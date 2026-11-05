// Top-bar version control status (branch · revision · changes), the Commit
// button, the history drawer / dialogs host and their keyboard shortcuts.
import { useEffect, useRef } from 'react';
import { store, useEditor } from '../state/store';
import { CommitDialog } from './CommitDialog';
import { HistoryPanel } from './HistoryPanel';
import { TextDiffDialog } from './TextDiffDialog';
import { revisionLabel, shortOid } from './format';
import { plural } from '../ui/text';
import { openCommit, toggleHistory, useHistoryUi } from './ui';
import './history.css';
import { keys } from '../ui/keys';

/** Opens the commit dialog, or says why not. */
export function requestCommit() {
  const vcs = store().getState().vcs;
  if (!vcs.ready) return;
  if (!vcs.changes.length) return store().toast('No changes to commit');
  openCommit();
}

export function VcsStatus() {
  const vcs = useEditor((s) => s.vcs);
  const { panel } = useHistoryUi();
  const n = vcs.changes.length;
  const rev = vcs.revision ? revisionLabel(vcs.revision) : vcs.head ? shortOid(vcs.head) : 'no commits';
  return (
    <span className="hx-status">
      <button
        className={`btn ghost hx-status-btn${panel ? ' on' : ''}`}
        aria-pressed={panel}
        aria-label={`History: branch ${vcs.branch}, ${rev}, ${n ? `${n} uncommitted changes` : 'no changes'}`}
        title={`Show history, branches and revisions (${keys('Mod+Shift+H')})`}
        onClick={toggleHistory}
        disabled={!vcs.ready}
        data-testid="vcs-status"
      >
        <span className="hx-branch">⎇ {vcs.branch}</span>
        <span className="hx-sep">·</span>
        <span className={vcs.revision ? 'hx-rev' : 'hx-muted'}>{rev}</span>
        <span className={`hx-changes${n ? ' dirty' : ''}`}>{n ? `${n} ${n === 1 ? 'change' : 'changes'}` : 'No changes'}</span>
      </button>
      <button className="btn" title={n ? `Commit ${plural(n, 'change')} (${keys('Mod+Shift+C')})` : `No changes to commit (${keys('Mod+Shift+C')})`} disabled={!vcs.ready || !n} onClick={openCommit}>
        Commit…
      </button>
    </span>
  );
}

/** Drawer and dialogs of the history UI; mount once inside the centre area. */
export function HistoryDrawer() {
  const { panel } = useHistoryUi();
  const first = useRef(true);
  // The workspace gets narrower / wider: fit the drawing again.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    store().requestFit();
  }, [panel]);
  return panel ? <HistoryPanel /> : null;
}

export function HistoryDialogs() {
  const { commit, textDiff } = useHistoryUi();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || !e.shiftKey || e.altKey) return;
      if (e.code === 'KeyC') {
        e.preventDefault();
        e.stopPropagation();
        requestCommit();
      } else if (e.code === 'KeyH') {
        e.preventDefault();
        e.stopPropagation();
        toggleHistory();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <>
      {commit && <CommitDialog />}
      {textDiff && <TextDiffDialog req={textDiff} />}
    </>
  );
}
