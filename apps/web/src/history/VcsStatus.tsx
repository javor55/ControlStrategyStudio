// Top-bar version control status (branch · revision · changes), the Commit
// button, the history drawer / dialogs host and their keyboard shortcuts.
import { useEffect, useRef } from 'react';
import { store, useEditor } from '../state/store';
import { CommitDialog } from './CommitDialog';
import { doSwitch, HistoryPanel, newBranch } from './HistoryPanel';
import { TextDiffDialog } from './TextDiffDialog';
import { nextRevision, revisionLabel, shortOid } from './format';
import { plural } from '../ui/text';
import { openCommit, openTextDiff, toggleHistory, useHistoryUi, WORKING } from './ui';
import { startCompare, stopCompare, useCompare } from './compare';
import { history, tagRevision } from '../state/session';
import { validRefName } from '@csd/vcs';
import { promptDialog } from '../ui/dialogs';
import { useMenu, type MenuEntry } from '../ui/kit';
import { Icon } from '../project/icons';
import './history.css';
import { keys } from '../ui/keys';

/** Opens the commit dialog, or says why not. */
export function requestCommit() {
  const vcs = store().getState().vcs;
  if (!vcs.ready) return;
  if (!vcs.changes.length) return store().toast('No changes to commit');
  openCommit();
}

/** Marks the current commit as a revision (Rev A, Rev B …). */
async function markHeadRevision() {
  const vcs = store().getState().vcs;
  if (!vcs.head) return;
  const tags = (await history.tags()).map((t) => t.name);
  const head = (await history.log())[0];
  const name = await promptDialog({
    title: 'Mark the current commit as a revision',
    label: 'Revision name',
    value: nextRevision(tags),
    validate: (v) => (!v ? 'Enter a name' : !validRefName(v) ? 'Not a valid name (no spaces or special characters)' : tags.includes(v) ? `“${v}” already exists` : undefined),
  });
  if (!name) return;
  const note = await promptDialog({ title: `Note for ${revisionLabel(name)}`, label: 'Note (optional)', value: head?.summary ?? '', okLabel: 'Mark as revision' });
  if (note === null) return;
  try {
    await tagRevision(name, note || head?.summary || name, vcs.head);
    store().toast(`Marked as ${revisionLabel(name)}`);
  } catch (e) {
    store().toast((e as Error).message, 'error');
  }
}

export function VcsStatus() {
  const vcs = useEditor((s) => s.vcs);
  const { panel } = useHistoryUi();
  const compare = useCompare();
  const menu = useMenu();
  const n = vcs.changes.length;
  const rev = vcs.revision ? revisionLabel(vcs.revision) : vcs.head ? shortOid(vcs.head) : 'no commits';

  const open = async (el: HTMLElement) => {
    const [branches, log] = await Promise.all([history.branches().catch(() => []), history.log().catch(() => [])]);
    const compareItems: MenuEntry[] = log.slice(0, 15).map(
      (c): MenuEntry => ({
        label: c.tags.length ? `${revisionLabel(c.tags[0])} · ${c.summary}` : c.summary || shortOid(c.oid),
        hint: shortOid(c.oid),
        title: `${c.summary}\n${new Date(c.author.timestamp * 1000).toLocaleString()}`,
        onClick: () => void startCompare(c.oid).catch((e) => store().toast((e as Error).message, 'error')),
      }),
    );
    const items: MenuEntry[] = [
      { section: `Version · ⎇ ${vcs.branch}` },
      { label: 'History', hint: keys('Mod+Shift+H'), checked: panel, keepOpen: false, onClick: toggleHistory },
      {
        label: 'Compare with',
        description: 'Show on the canvas what changed since a version',
        disabled: !log.length,
        submenu: compareItems.length ? compareItems : [{ label: 'No commits yet', disabled: true }],
      },
      ...(compare.target ? [{ label: `Stop comparing with ${compare.target.label}`, onClick: stopCompare } as MenuEntry] : []),
      {
        label: 'Show changes',
        description: 'Text diff of the uncommitted changes',
        disabled: !vcs.head || !n,
        onClick: () => vcs.head && openTextDiff({ from: vcs.head, to: WORKING, title: 'Uncommitted changes' }),
      },
      'separator',
      {
        label: 'Switch branch',
        disabled: !branches.length,
        submenu: branches.map((b): MenuEntry => ({ label: `⎇ ${b.name}`, checked: b.current, radio: true, keepOpen: false, onClick: () => void doSwitch(b.name) })),
      },
      { label: 'New branch…', disabled: !vcs.head, onClick: () => void newBranch(branches) },
      { label: 'Mark revision…', description: 'Name the last commit Rev A, Rev B … for documents and exports', disabled: !vcs.head, onClick: () => void markHeadRevision() },
    ];
    menu.openBelow(el, items);
  };

  return (
    <span className="hx-status">
      <button
        className={`btn hx-status-btn${panel ? ' on' : ''}`}
        aria-haspopup="menu"
        aria-label={`Version: branch ${vcs.branch}, ${rev}, ${n ? `${n} uncommitted changes` : 'no changes'}`}
        title="Version: history, compare, branches and revisions"
        onClick={(e) => void open(e.currentTarget)}
        disabled={!vcs.ready}
        data-testid="vcs-status"
      >
        <span className="hx-branch">⎇ {vcs.branch}</span>
        <span className="hx-sep">·</span>
        <span className={vcs.revision ? 'hx-rev' : 'hx-muted'}>{rev}</span>
        <span className={`hx-changes${n ? ' dirty' : ''}`}>{n ? `${n} ${n === 1 ? 'change' : 'changes'}` : 'No changes'}</span>
        {Icon.caret}
      </button>
      <button className="btn hx-commit-btn" title={n ? `Commit ${plural(n, 'change')} (${keys('Mod+Shift+C')})` : `No changes to commit (${keys('Mod+Shift+C')})`} disabled={!vcs.ready || !n} onClick={openCommit}>
        Commit…
      </button>
      {menu.element}
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
