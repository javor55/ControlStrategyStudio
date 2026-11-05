// History drawer (right side of the centre area, non-modal): branches, commits,
// details of a commit and the actions on it (compare, text diff, restore, take
// a strategy, mark as revision).
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { loadProject, type FileContent, type Files, type ProjectModel } from '@csd/core';
import { validRefName, VcsError, type BranchInfo, type Change, type CommitInfo } from '@csd/vcs';
import {
  createBranch,
  deleteBranch,
  deleteTag,
  history,
  restoreVersion,
  switchBranch,
  tagRevision,
  takeFileFrom,
} from '../state/session';
import { store, useEditor } from '../state/store';
import { confirmDialog, promptDialog } from '../ui/dialogs';
import { useMenu, type MenuEntry } from '../ui/kit';
import { ChangeList, useModelAt } from './CommitDialog';
import { startCompare, stopCompare, useCompare } from './compare';
import { absoluteTime, describeCommit, nextRevision, relativeTime, revisionLabel, shortOid } from './format';
import { closeHistory, openCommit, openTextDiff, WORKING } from './ui';
import './history.css';
import { keys } from '../ui/keys';

interface CommitDetails {
  changes: Change[];
  before: ProjectModel;
  after: ProjectModel;
}

const EMPTY_MODEL = loadProject({});
const detailsCache = new Map<string, Promise<CommitDetails>>();

/** Files and graph diff of a commit against its first parent (cached; commits never change). */
function commitDetails(c: CommitInfo): Promise<CommitDetails> {
  let p = detailsCache.get(c.oid);
  if (!p) {
    const parent = c.parents[0];
    p = (async () => {
      const after = await history.filesAt(c.oid);
      const before: Files = parent ? await history.filesAt(parent) : {};
      const changes: Change[] = parent ? await history.changesBetween(parent, c.oid) : Object.keys(after).sort().map((path) => ({ path, kind: 'added' as const }));
      return { changes, before: parent ? loadProject(before) : EMPTY_MODEL, after: loadProject(after) };
    })();
    p.catch(() => detailsCache.delete(c.oid));
    detailsCache.set(c.oid, p);
  }
  return p;
}

const toast = (text: string, kind: 'info' | 'error' = 'info') => store().toast(text, kind);
const fail = (e: unknown) => toast((e as Error).message, 'error');

/** Working-file changes that turn `from` into `to` (for carrying uncommitted edits over). */
function restoreFiles(from: Files, to: Files): Record<string, FileContent | undefined> {
  const out: Record<string, FileContent | undefined> = {};
  for (const p of Object.keys(from)) if (!(p in to)) out[p] = undefined;
  for (const [p, c] of Object.entries(to)) if (from[p] !== c) out[p] = c;
  return out;
}

/** Keeps the open file when the whole project is reloaded (branch switch). */
function keepActive(file: string | null) {
  const st = store().getState();
  if (file && file in st.files && st.activeFile !== file) store().open(file);
}

async function doSwitch(name: string) {
  const st = store().getState();
  if (name === st.vcs.branch) return;
  const active = st.activeFile;
  try {
    await switchBranch(name);
  } catch (e) {
    if (!(e instanceof VcsError)) return fail(e);
    const n = store().getState().vcs.changes.length;
    const ok = await confirmDialog({
      title: 'Uncommitted changes',
      message: `${e.message}. You have ${n} uncommitted ${n === 1 ? 'change' : 'changes'} on ⎇ ${st.vcs.branch}; switching to ⎇ ${name} replaces the working files and discards them.`,
      okLabel: 'Discard and switch',
      danger: true,
    });
    if (!ok) return;
    try {
      await switchBranch(name, { force: true });
    } catch (e2) {
      return fail(e2);
    }
  }
  keepActive(active);
  toast(`Switched to ⎇ ${name}`);
}

async function askBranchName(branches: BranchInfo[], title: string): Promise<string | null> {
  return promptDialog({
    title,
    label: 'Branch name',
    placeholder: 'e.g. moc-042-retune',
    validate: (v) => (!v ? 'Enter a name' : !validRefName(v) ? 'Not a valid branch name (no spaces or special characters)' : branches.some((b) => b.name === v) ? `“${v}” already exists` : undefined),
  });
}

async function newBranch(branches: BranchInfo[], from?: { oid: string; label: string }) {
  const st = store().getState();
  const dirty = st.vcs.changes.length > 0;
  const name = await askBranchName(branches, from ? `New branch from ${from.label}` : `New branch from ⎇ ${st.vcs.branch}`);
  if (!name) return;
  if (from && dirty) {
    const ok = await confirmDialog({
      title: 'Uncommitted changes',
      message: `The new branch starts at ${from.label}. Switching to it discards your ${st.vcs.changes.length} uncommitted changes. Commit them first to keep them.`,
      okLabel: 'Discard and create',
      danger: true,
    });
    if (!ok) return;
  }
  const working = st.files;
  const active = st.activeFile;
  try {
    await createBranch(name, { from: from?.oid, switchTo: true });
    // A branch from the current state keeps the uncommitted edits (like `git switch -c`).
    if (!from && dirty) {
      store().dispatch({ op: 'restore', files: restoreFiles(store().getState().files, working) }, { label: 'Carry over uncommitted changes' });
    }
    keepActive(active);
    toast(`Created and switched to ⎇ ${name}`);
  } catch (e) {
    fail(e);
  }
}

function TagChip({ tag, onDelete }: { tag: string; onDelete?: () => void }) {
  return (
    <span className="hx-tag" title={`Revision tag ${tag}`}>
      {revisionLabel(tag)}
      {onDelete && (
        <button type="button" className="hx-tag-x" aria-label={`Delete tag ${tag}`} title={`Delete tag ${tag}`} onClick={onDelete}>
          ×
        </button>
      )}
    </span>
  );
}

export function HistoryPanel() {
  const vcs = useEditor((s) => s.vcs);
  const model = useEditor((s) => s.model);
  const compare = useCompare();
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const menu = useMenu();
  const panelRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const refresh = useCallback(() => setBump((b) => b + 1), []);

  useEffect(() => {
    let alive = true;
    Promise.all([history.log(), history.branches(), history.tags()])
      .then(([log, br, tags]) => {
        if (!alive) return;
        setCommits(log);
        setBranches(br);
        setAllTags(tags.map((t) => t.name));
      })
      .catch((e) => {
        console.error(e);
        if (alive) setCommits([]);
      });
    return () => {
      alive = false;
    };
  }, [vcs.head, vcs.branch, vcs.revision, vcs.ready, bump]);

  // Default selection: working copy when dirty, else the newest commit.
  useEffect(() => {
    if (!commits) return;
    if (selected === WORKING && vcs.changes.length) return;
    if (selected && selected !== WORKING && commits.some((c) => c.oid === selected)) return;
    setSelected(vcs.changes.length ? WORKING : commits[0]?.oid ?? null);
  }, [commits, selected, vcs.changes.length]);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('.hx-close')?.focus();
  }, []);

  const current = commits?.find((c) => c.oid === selected);

  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('.hx-item') ?? [])];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    items[next].focus();
    items[next].click();
  };

  const branchMenu = (el: HTMLElement) => {
    const others = branches.filter((b) => !b.current);
    const items: MenuEntry[] = [
      { section: 'Switch to' },
      ...branches.map(
        (b): MenuEntry => ({
          label: `⎇ ${b.name}`,
          checked: b.current,
          radio: true,
          keepOpen: false,
          onClick: () => !b.current && void doSwitch(b.name).then(refresh),
        }),
      ),
      'separator',
      { label: `New branch from ⎇ ${vcs.branch}…`, onClick: () => void newBranch(branches).then(refresh) },
      {
        label: current ? `New branch from ${shortOid(current.oid)}…` : 'New branch from selected commit…',
        disabled: !current,
        onClick: () => current && void newBranch(branches, { oid: current.oid, label: describeCommit(current) }).then(refresh),
      },
      'separator',
      {
        label: 'Delete branch',
        disabled: !others.length,
        description: others.length ? undefined : 'No other branches',
        submenu: others.length
          ? others.map(
            (b): MenuEntry => ({
              label: `⎇ ${b.name}`,
              danger: true,
              onClick: async () => {
                if (!(await confirmDialog({ title: 'Delete branch?', message: `Branch “${b.name}” will be deleted. Commits only on this branch are lost.`, okLabel: 'Delete', danger: true }))) return;
                try {
                  await deleteBranch(b.name);
                  toast(`Deleted ⎇ ${b.name}`);
                  refresh();
                } catch (e) {
                  fail(e);
                }
              },
            }),
          )
          : undefined,
      },
    ];
    menu.openBelow(el, items);
  };

  return (
    <aside className="hx-panel" ref={panelRef} aria-label="History" onKeyDown={(e) => e.key === 'Escape' && !e.defaultPrevented && (e.target as HTMLElement).tagName !== 'SELECT' && closeHistory()}>
      <div className="hx-head">
        <h2>History</h2>
        <span className="spacer" />
        <button className="btn ghost icon hx-close" title={`Close history (${keys('Mod+Shift+H')})`} aria-label="Close history" onClick={closeHistory}>
          ×
        </button>
      </div>
      {!vcs.ready || commits === null ? (
        <div className="hx-muted hx-pad">Loading history…</div>
      ) : !commits.length ? (
        <div className="hx-empty">
          <div className="hx-empty-ico" aria-hidden="true">
            ⎇
          </div>
          <p>
            <b>No history yet.</b>
          </p>
          <p className="hx-muted">A commit stores the current state of all project files as a version you can compare with and go back to. Mark important commits as revisions (Rev A, Rev B …) for documents and exports.</p>
          <button className="btn primary" onClick={openCommit} disabled={!vcs.changes.length}>
            Make the first commit…
          </button>
        </div>
      ) : (
        <>
          <div className="hx-branchbar">
            <span className="hx-muted">Branch</span>
            <button className="btn small hx-branch-btn" aria-haspopup="menu" title="Switch, create or delete branches" onClick={(e) => branchMenu(e.currentTarget)}>
              ⎇ {vcs.branch} ▾
            </button>
          </div>
          {compare.target && (
            <div className="hx-comparing">
              Comparing working copy with <b>{compare.target.label}</b>
              <span className="spacer" />
              <button className="btn small" onClick={stopCompare}>
                Exit comparison
              </button>
            </div>
          )}
          <div className="hx-list" ref={listRef} role="list" aria-label="Commits" onKeyDown={onListKey}>
            {vcs.changes.length > 0 && (
              <div role="listitem">
                <button className={`hx-item working${selected === WORKING ? ' on' : ''}`} aria-current={selected === WORKING || undefined} onClick={() => setSelected(WORKING)}>
                  <span className="hx-dot working" aria-hidden="true" />
                  <span className="hx-item-main">
                    <span className="hx-item-sum">Working copy</span>
                    <span className="hx-item-meta">
                      {vcs.changes.length} uncommitted {vcs.changes.length === 1 ? 'change' : 'changes'}
                    </span>
                  </span>
                </button>
              </div>
            )}
            {commits.map((c) => (
              <div role="listitem" key={c.oid}>
                <button className={`hx-item${selected === c.oid ? ' on' : ''}`} aria-current={selected === c.oid || undefined} onClick={() => setSelected(c.oid)} data-oid={c.oid}>
                  <span className={`hx-dot${c.oid === vcs.head ? ' head' : ''}${c.tags.length ? ' tagged' : ''}`} aria-hidden="true" />
                  <span className="hx-item-main">
                    <span className="hx-item-sum">
                      {c.tags.map((t) => (
                        <TagChip key={t} tag={t} />
                      ))}
                      <span className="hx-item-text">{c.summary}</span>
                      {c.oid === vcs.head && <span className="hx-current">current</span>}
                    </span>
                    <span className="hx-item-meta">
                      {c.author.name} · <time title={absoluteTime(c.author.timestamp * 1000)}>{relativeTime(c.author.timestamp * 1000)}</time> · <span className="mono">{shortOid(c.oid)}</span>
                    </span>
                  </span>
                </button>
              </div>
            ))}
          </div>
          <div className="hx-details">
            {selected === WORKING ? (
              <WorkingDetails model={model} head={vcs.head} changes={vcs.changes} />
            ) : current ? (
              <CommitView key={current.oid} c={current} commits={commits} branches={branches} allTags={allTags} isHead={current.oid === vcs.head} refresh={refresh} />
            ) : null}
          </div>
        </>
      )}
      {menu.element}
    </aside>
  );
}

function WorkingDetails({ model, head, changes }: { model: ProjectModel; head?: string; changes: Change[] }) {
  const headModel = useModelAt(head);
  return (
    <div className="hx-det">
      <div className="hx-det-title">Uncommitted changes</div>
      <div className="hx-actions">
        <button className="btn primary small" onClick={openCommit} title={`Commit (${keys('Mod+Shift+C')})`}>
          Commit…
        </button>
        <button className="btn small" onClick={() => head && openTextDiff({ from: head, to: WORKING, title: 'Last commit → working copy' })}>
          Show text diff
        </button>
        <button
          className="btn small danger"
          onClick={async () => {
            if (!head) return;
            if (!(await confirmDialog({ title: 'Discard all changes?', message: `The working files are reset to the last commit. You can undo this with ${keys('Mod+Z')}.`, okLabel: 'Discard', danger: true }))) return;
            await restoreVersion(head, 'Discard changes').catch(fail);
          }}
        >
          Discard…
        </button>
      </div>
      <ChangeList changes={changes} before={headModel} after={model} onFile={(p) => head && openTextDiff({ from: head, to: WORKING, title: 'Last commit → working copy', path: p })} fileTitle="Show text diff" />
    </div>
  );
}

interface OtherRef {
  ref: string;
  oid: string;
  label: string;
  time: number;
}

function CommitView(props: { c: CommitInfo; commits: CommitInfo[]; branches: BranchInfo[]; allTags: string[]; isHead: boolean; refresh: () => void }) {
  const { c, refresh } = props;
  const [det, setDet] = useState<CommitDetails>();
  const [other, setOther] = useState<OtherRef | null>(null);
  const [otherDet, setOtherDet] = useState<{ changes: Change[]; before: ProjectModel; after: ProjectModel; from: string; to: string } | null>(null);
  const menu = useMenu();
  const label = describeCommit(c);
  const parent = c.parents[0];

  useEffect(() => {
    let alive = true;
    commitDetails(c)
      .then((d) => alive && setDet(d))
      .catch(fail);
    return () => {
      alive = false;
    };
  }, [c]);

  // Comparison of this commit with another version (older one first).
  useEffect(() => {
    if (!other) return setOtherDet(null);
    let alive = true;
    (async () => {
      const otherOlder = other.time <= c.author.timestamp;
      const from = otherOlder ? other.oid : c.oid;
      const to = otherOlder ? c.oid : other.oid;
      const [changes, bf, af] = await Promise.all([history.changesBetween(from, to), history.filesAt(from), history.filesAt(to)]);
      if (alive) setOtherDet({ changes, before: loadProject(bf), after: loadProject(af), from, to });
    })().catch(fail);
    return () => {
      alive = false;
    };
  }, [other, c]);

  const strategies = useMemo(() => (det ? [...det.after.strategies, ...det.after.sequences].sort((a, b) => a.name.localeCompare(b.name)) : []), [det]);

  const compareWithWorking = async () => {
    try {
      await startCompare(c.oid);
      // Show a changed strategy if the open file is not a strategy or sequence.
      const st = store().getState();
      const active = st.activeFile && (st.model.strategyByFile.get(st.activeFile) || st.model.sequenceByFile.get(st.activeFile));
      if (!active) {
        const first = st.model.strategies[0];
        if (first) store().open(first.file);
      }
    } catch (e) {
      fail(e);
    }
  };

  const pickOther = async (el: HTMLElement) => {
    const refs: { ref: string; label: string }[] = [];
    for (const b of props.branches) refs.push({ ref: b.name, label: `⎇ ${b.name}${b.current ? ' (current)' : ''}` });
    const tags = await history.tags().catch(() => []);
    const items: MenuEntry[] = [
      { section: 'Branches' },
      ...refs.map((r): MenuEntry => ({ label: r.label, onClick: () => void choose(r.ref) })),
      ...(tags.length ? [{ section: 'Revisions' } as MenuEntry, ...tags.map((t): MenuEntry => ({ label: revisionLabel(t.name), hint: shortOid(t.oid), onClick: () => void choose(t.name) }))] : []),
      { section: 'Commits' },
      ...props.commits
        .filter((x) => x.oid !== c.oid)
        .slice(0, 15)
        .map((x): MenuEntry => ({ label: x.summary.length > 48 ? `${x.summary.slice(0, 47)}…` : x.summary, hint: shortOid(x.oid), onClick: () => void choose(x.oid) })),
    ];
    menu.openBelow(el, items);
  };

  const choose = async (ref: string) => {
    try {
      const head = (await history.log(ref))[0];
      if (!head) return;
      if (head.oid === c.oid) return toast(`${ref} points to this commit`);
      const name = /^[0-9a-f]{40}$/.test(ref) ? describeCommit(head) : head.tags.includes(ref) ? `${revisionLabel(ref)} (${shortOid(head.oid)})` : `⎇ ${ref} (${shortOid(head.oid)})`;
      setOther({ ref, oid: head.oid, label: name, time: head.author.timestamp });
    } catch (e) {
      fail(e);
    }
  };

  const takeMenu = (el: HTMLElement) => {
    const items: MenuEntry[] = [
      { section: 'Replace in working copy (undoable)' },
      ...(strategies.length ? strategies.map((s): MenuEntry => ({ label: s.name, hint: 'steps' in s ? `sequence${s.title ? ` · ${s.title}` : ''}` : s.title, onClick: () => void take(s.file, s.name) })) : [{ label: 'No strategies or sequences in this version', disabled: true }]),
    ];
    menu.openBelow(el, items);
  };

  const take = async (file: string, name: string) => {
    try {
      await takeFileFrom(c.oid, file);
      store().open(file);
      store().toastUndo(`${name} taken from ${label}`);
    } catch (e) {
      fail(e);
    }
  };

  const restore = async () => {
    const n = store().getState().vcs.changes.length;
    const ok = await confirmDialog({
      title: 'Restore this version?',
      message: `All project files are replaced by ${label}${n ? ` (your ${n} uncommitted ${n === 1 ? 'change is' : 'changes are'} replaced too)` : ''}. History is kept; the restored state shows as uncommitted changes. Undo with ${keys('Mod+Z')}.`,
      okLabel: 'Restore',
      danger: true,
    });
    if (!ok) return;
    try {
      await restoreVersion(c.oid, `Restore ${c.tags[0] ? revisionLabel(c.tags[0]) : shortOid(c.oid)}`);
      store().toastUndo(`Restored ${label}`);
    } catch (e) {
      fail(e);
    }
  };

  const markRevision = async () => {
    const name = await promptDialog({
      title: `Mark ${shortOid(c.oid)} as revision`,
      label: 'Revision name',
      value: nextRevision(props.allTags),
      validate: (v) => (!v ? 'Enter a name' : !validRefName(v) ? 'Not a valid name (no spaces or special characters)' : props.allTags.includes(v) ? `“${v}” already exists` : undefined),
    });
    if (!name) return;
    const note = await promptDialog({ title: `Note for ${revisionLabel(name)}`, label: 'Note (optional)', value: c.summary, okLabel: 'Mark as revision' });
    if (note === null) return;
    try {
      await tagRevision(name, note || c.summary, c.oid);
      toast(`Marked as ${revisionLabel(name)}`);
      refresh();
    } catch (e) {
      fail(e);
    }
  };

  const removeTag = async (tag: string) => {
    if (!(await confirmDialog({ title: 'Delete revision tag?', message: `The tag “${tag}” is removed. The commit itself stays.`, okLabel: 'Delete tag', danger: true }))) return;
    try {
      await deleteTag(tag);
      toast(`Deleted tag ${tag}`);
      refresh();
    } catch (e) {
      fail(e);
    }
  };

  const body = c.message.split('\n').slice(1).join('\n').trim();
  return (
    <div className="hx-det">
      <div className="hx-det-title">{c.summary}</div>
      {body && <div className="hx-det-body">{body}</div>}
      <div className="hx-det-meta">
        {c.author.name}
        {c.author.email && <span className="hx-muted"> &lt;{c.author.email}&gt;</span>} · {absoluteTime(c.author.timestamp * 1000)} · <span className="mono" title={c.oid}>{shortOid(c.oid)}</span>
        {props.isHead && <span className="hx-current">current</span>}
      </div>
      {c.tags.length > 0 && (
        <div className="hx-det-tags">
          {c.tags.map((t) => (
            <TagChip key={t} tag={t} onDelete={() => void removeTag(t)} />
          ))}
        </div>
      )}
      <div className="hx-actions">
        <button className="btn small primary" onClick={compareWithWorking} title="Show what changed since this version on the canvas">
          Compare with working copy
        </button>
        <button className="btn small" aria-haspopup="menu" onClick={(e) => void pickOther(e.currentTarget)}>
          Compare with… ▾
        </button>
        <button className="btn small" onClick={() => openTextDiff({ from: parent ?? '', to: c.oid, title: parent ? `${shortOid(parent)} → ${label}` : `${label} (first commit)` })}>
          Show text diff
        </button>
        <button className="btn small" onClick={restore}>
          Restore this version…
        </button>
        <button className="btn small" aria-haspopup="menu" onClick={(e) => takeMenu(e.currentTarget)} disabled={!det}>
          Take strategy from this version ▾
        </button>
        <button className="btn small" onClick={markRevision}>
          Mark as revision…
        </button>
      </div>
      {other && (
        <div className="hx-other">
          <div className="hx-sec-h">
            {otherDet && otherDet.from === c.oid ? `${label} → ${other.label}` : `${other.label} → ${label}`}
            <span className="spacer" />
            {otherDet && (
              <button className="btn small" onClick={() => openTextDiff({ from: otherDet.from, to: otherDet.to, title: otherDet.from === c.oid ? `${label} → ${other.label}` : `${other.label} → ${label}` })}>
                Text diff
              </button>
            )}
            <button className="btn small ghost icon" aria-label="Close comparison" title="Close comparison" onClick={() => setOther(null)}>
              ×
            </button>
          </div>
          {otherDet ? (
            <ChangeList
              changes={otherDet.changes}
              before={otherDet.before}
              after={otherDet.after}
              onFile={(p) => openTextDiff({ from: otherDet.from, to: otherDet.to, title: `${shortOid(otherDet.from)} → ${shortOid(otherDet.to)}`, path: p })}
              fileTitle="Show text diff"
            />
          ) : (
            <div className="hx-muted">Loading…</div>
          )}
        </div>
      )}
      <div className="hx-sec-h">{parent ? `Changes in this commit` : 'First commit — all files added'}</div>
      {det ? (
        <ChangeList
          changes={det.changes}
          before={det.before}
          after={det.after}
          onFile={(p) => openTextDiff({ from: parent ?? '', to: c.oid, title: parent ? `${shortOid(parent)} → ${label}` : label, path: p })}
          fileTitle="Show text diff"
        />
      ) : (
        <div className="hx-muted">Loading…</div>
      )}
      {menu.element}
    </div>
  );
}
