// Commit dialog: what changed (files with graph summaries), message, author and
// optionally a revision tag on the new commit.
import { useEffect, useMemo, useRef, useState } from 'react';
import { loadProject, type ProjectModel } from '@csd/core';
import { validRefName, type Change } from '@csd/vcs';
import { commit, getAuthor, history, setAuthor, tagRevision } from '../state/session';
import { store, useEditor } from '../state/store';
import { diffCached } from './compare';
import { graphDiffsByFile, groupFiles, KIND_LABEL, KIND_LETTER, nextRevision, revisionLabel, summarizeGraph } from './format';
import { closeCommit } from './ui';
import './history.css';

/** Project model at HEAD (empty project before the first commit). */
export function useModelAt(oid: string | undefined): ProjectModel | undefined {
  const [m, setM] = useState<{ oid?: string; model: ProjectModel }>();
  useEffect(() => {
    let alive = true;
    (oid ? history.filesAt(oid) : Promise.resolve({}))
      .then((f) => alive && setM({ oid, model: loadProject(f) }))
      .catch((e) => console.error(e));
    return () => {
      alive = false;
    };
  }, [oid]);
  return m && m.oid === oid ? m.model : undefined;
}

export function ChangeBadge({ kind }: { kind: Change['kind'] }) {
  return (
    <span className={`hx-kind ${kind}`} title={KIND_LABEL[kind]} aria-label={KIND_LABEL[kind]}>
      {KIND_LETTER[kind]}
    </span>
  );
}

/** Changed files grouped (strategies & sequences / library / documents / other) with graph summaries for strategies and sequences. */
export function ChangeList(props: { changes: readonly Change[]; before?: ProjectModel; after?: ProjectModel; onFile?: (path: string) => void; fileTitle?: string }) {
  const { before, after } = props;
  const diff = useMemo(() => (before && after ? diffCached(before, after) : undefined), [before, after]);
  const byFile = useMemo(() => graphDiffsByFile(diff), [diff]);
  if (!props.changes.length) return <div className="hx-muted">No changed files.</div>;
  return (
    <div className="hx-files">
      {groupFiles(props.changes).map(([group, items]) => (
        <div key={group} className="hx-group">
          <div className="hx-group-h">
            {group} <span className="hx-count">{items.length}</span>
          </div>
          <ul>
            {items.map((c) => {
              const g = byFile.get(c.path);
              const sd = g?.diff;
              const isYaml = c.path.endsWith('.yaml');
              return (
                <li key={c.path} className="hx-file">
                  <ChangeBadge kind={c.kind} />
                  <div className="hx-file-main">
                    {props.onFile ? (
                      <button type="button" className="hx-link mono" title={props.fileTitle ?? c.path} onClick={() => props.onFile!(c.path)}>
                        {sd && isYaml ? sd.name : c.path}
                      </button>
                    ) : (
                      <span className="mono" title={c.path}>
                        {sd && isYaml ? sd.name : c.path}
                      </span>
                    )}
                    {sd && isYaml && (
                      <span className="hx-path mono" title={c.path}>
                        {`\u200e${c.path}\u200e`}
                      </span>
                    )}
                    {g && isYaml && (
                      <div className="hx-sum">
                        {g.kind === 'sequence' && <span className="hx-seq">sequence · </span>}
                        {summarizeGraph(g)}
                      </div>
                    )}
                    {sd && !isYaml && <div className="hx-sum">function description of {sd.name}</div>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function CommitDialog() {
  const vcs = useEditor((s) => s.vcs);
  const model = useEditor((s) => s.model);
  const headModel = useModelAt(vcs.head);
  const initial = useRef(getAuthor()).current;
  const firstCommit = !initial.name;
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [name, setName] = useState(initial.name);
  const [email, setEmail] = useState(initial.email ?? '');
  const [markRev, setMarkRev] = useState(false);
  const [tagName, setTagName] = useState('rev-A');
  const [tagNote, setTagNote] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    history
      .tags()
      .then((t) => {
        const names = t.map((x) => x.name);
        setTags(names);
        setTagName(nextRevision(names));
      })
      .catch(() => {});
  }, []);

  const close = () => !busy && closeCommit();
  const tagError = markRev ? (!tagName ? 'Enter a revision name' : !validRefName(tagName) ? 'Not a valid name (no spaces or special characters)' : tags.includes(tagName) ? `“${tagName}” already exists` : undefined) : undefined;
  const emailError = email && !/^[^\s@]+@[^\s@]+$/.test(email) ? 'Not an e-mail address' : undefined;
  const canCommit = vcs.changes.length > 0 && !!summary.trim() && !!name.trim() && !tagError && !emailError && !busy;

  const submit = async () => {
    if (!canCommit) {
      if (!summary.trim()) setError('Describe the change in one line');
      else if (!name.trim()) setError('Enter your name');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const author = { name: name.trim(), email: email.trim() };
      setAuthor(author);
      const message = details.trim() ? `${summary.trim()}\n\n${details.trim()}` : summary.trim();
      await commit(message, author);
      if (markRev) await tagRevision(tagName, tagNote.trim() || summary.trim());
      store().toast(markRev ? `Committed as ${revisionLabel(tagName)}` : 'Committed');
      closeCommit();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <form
        className="dialog hx-commit"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hx-commit-title"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <h3 id="hx-commit-title">
          Commit changes <span className="hx-muted">on ⎇ {vcs.branch}</span>
        </h3>
        <div className="hx-commit-body">
          <div className="hx-commit-files">
            <div className="hx-sec-h">
              {vcs.changes.length ? `${vcs.changes.length} changed ${vcs.changes.length === 1 ? 'file' : 'files'}` : 'No changes'}
              {!vcs.head && vcs.changes.length > 0 && <span className="hx-muted"> · first commit</span>}
            </div>
            <ChangeList changes={vcs.changes} before={headModel} after={model} />
          </div>
          <div className="hx-commit-form">
            <label className="hx-lbl">
              <span>Summary</span>
              <input className="input" autoFocus value={summary} maxLength={120} placeholder="e.g. FIC101: retune PID, add high-flow alarm" onChange={(e) => setSummary(e.target.value)} />
            </label>
            <label className="hx-lbl">
              <span>Details (optional)</span>
              <textarea className="textarea" rows={4} value={details} placeholder="Why the change was made, references (MOC, ticket) …" onChange={(e) => setDetails(e.target.value)} />
            </label>
            {firstCommit && <div className="hx-note">Who is committing? Your name and e-mail are stored in this browser and used for later commits.</div>}
            <div className="hx-row2">
              <label className="hx-lbl">
                <span>Author</span>
                <input className={`input${firstCommit && !name ? ' attention' : ''}`} value={name} placeholder="Name" autoComplete="name" onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="hx-lbl">
                <span>E-mail</span>
                <input className={`input${emailError ? ' invalid' : ''}`} value={email} placeholder="name@company.com" autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
              </label>
            </div>
            <label className="hx-check">
              <input type="checkbox" checked={markRev} onChange={(e) => setMarkRev(e.target.checked)} /> Mark as revision
            </label>
            {markRev && (
              <div className="hx-row2">
                <label className="hx-lbl">
                  <span>Revision name</span>
                  <input className={`input mono${tagError ? ' invalid' : ''}`} value={tagName} onChange={(e) => setTagName(e.target.value.trim())} />
                </label>
                <label className="hx-lbl">
                  <span>Note (optional)</span>
                  <input className="input" value={tagNote} placeholder="e.g. Issued for construction" onChange={(e) => setTagNote(e.target.value)} />
                </label>
              </div>
            )}
            {(tagError || emailError) && <div className="error-text">{tagError ?? emailError}</div>}
            {error && <div className="error-text">{error}</div>}
          </div>
        </div>
        <div className="actions">
          <span className="hx-muted hx-kbd-hint">Ctrl+Enter to commit</span>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!canCommit} title={vcs.changes.length ? undefined : 'There are no changes to commit'}>
            {busy ? 'Committing…' : markRev ? `Commit as ${revisionLabel(tagName)}` : 'Commit'}
          </button>
        </div>
      </form>
    </div>
  );
}
