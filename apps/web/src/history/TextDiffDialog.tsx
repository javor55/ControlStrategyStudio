// Text diff of the changed files between two versions (or a version and the
// working copy): unified diff per file, coloured.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Change } from '@csd/vcs';
import { history } from '../state/session';
import { store } from '../state/store';
import { ChangeBadge } from './CommitDialog';
import { unifiedHunks } from './linediff';
import { closeTextDiff, WORKING, type HistoryUi } from './ui';
import './history.css';

type Content = string | Uint8Array | undefined;

async function contentAt(ref: string, path: string): Promise<Content> {
  if (!ref) return undefined;
  if (ref === WORKING) return store().getState().files[path];
  return history.fileAt(ref, path);
}

async function changesOf(from: string, to: string): Promise<Change[]> {
  if (to === WORKING) {
    if (!from) return Object.keys(store().getState().files).sort().map((path) => ({ path, kind: 'added' as const }));
    return history.changesSince(from);
  }
  if (!from) return Object.keys(await history.filesAt(to)).sort().map((path) => ({ path, kind: 'added' as const }));
  return history.changesBetween(from, to);
}

function FileDiff({ a, b }: { a: Content; b: Content }) {
  if (a instanceof Uint8Array || b instanceof Uint8Array) return <div className="hx-muted hx-pad">Binary file ({a ? `${(a as Uint8Array).length} → ` : ''}{b ? (b as Uint8Array).length : 0} bytes).</div>;
  const hunks = unifiedHunks(a ?? '', b ?? '');
  if (!hunks.length) return <div className="hx-muted hx-pad">No textual difference.</div>;
  return (
    <table className="hx-diff" aria-label="Unified diff">
      <tbody>
        {hunks.map((h, i) => [
          <tr key={`h${i}`} className="hunk">
            <td colSpan={3}>{`@@ -${h.aStart},${h.aLen} +${h.bStart},${h.bLen} @@`}</td>
          </tr>,
          ...h.lines.map((l, j) => (
            <tr key={`${i}:${j}`} className={l.kind}>
              <td className="ln">{l.a ?? ''}</td>
              <td className="ln">{l.b ?? ''}</td>
              <td className="code">
                <span className="sign" aria-hidden="true">
                  {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                </span>
                {l.text || ' '}
              </td>
            </tr>
          )),
        ])}
      </tbody>
    </table>
  );
}

export function TextDiffDialog({ req }: { req: NonNullable<HistoryUi['textDiff']> }) {
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [path, setPath] = useState<string | undefined>(req.path);
  const [pair, setPair] = useState<{ path: string; a: Content; b: Content } | null>(null);
  const [error, setError] = useState<string>();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    changesOf(req.from, req.to)
      .then((c) => {
        setChanges(c);
        setPath((p) => (p && c.some((x) => x.path === p) ? p : c.find((x) => x.path.endsWith('.yaml'))?.path ?? c[0]?.path));
      })
      .catch((e) => setError((e as Error).message));
  }, [req.from, req.to]);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    Promise.all([contentAt(req.from, path), contentAt(req.to, path)])
      .then(([a, b]) => alive && setPair({ path, a, b }))
      .catch((e) => setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [path, req.from, req.to]);

  const stats = useMemo(() => {
    if (!pair || typeof pair.a === 'object' || typeof pair.b === 'object') return undefined;
    const lines = unifiedHunks(pair.a ?? '', pair.b ?? '', 0).flatMap((h) => h.lines);
    return { add: lines.filter((l) => l.kind === 'add').length, del: lines.filter((l) => l.kind === 'del').length };
  }, [pair]);

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeTextDiff()}>
      <div className="dialog hx-textdiff" role="dialog" aria-modal="true" aria-labelledby="hx-td-title" onKeyDown={(e) => e.key === 'Escape' && closeTextDiff()}>
        <div className="hx-td-head">
          <h3 id="hx-td-title">Text diff</h3>
          <span className="hx-muted">{req.title}</span>
          <span className="spacer" />
          <button className="btn" autoFocus onClick={closeTextDiff}>
            Close
          </button>
        </div>
        {error && <div className="error-text">{error}</div>}
        <div className="hx-td-body">
          <div className="hx-td-list" ref={listRef} role="listbox" aria-label="Changed files">
            {changes === null && <div className="hx-muted hx-pad">Loading…</div>}
            {changes?.length === 0 && <div className="hx-muted hx-pad">No changed files.</div>}
            {changes?.map((c) => (
              <button key={c.path} role="option" aria-selected={c.path === path} className={`hx-td-file${c.path === path ? ' on' : ''}`} onClick={() => setPath(c.path)} title={c.path}>
                <ChangeBadge kind={c.kind} />
                <span className="mono">{c.path}</span>
              </button>
            ))}
          </div>
          <div className="hx-td-view">
            {pair && pair.path === path ? (
              <>
                <div className="hx-td-file-h mono">
                  {path}
                  {stats && (
                    <span className="hx-stats">
                      <span className="add">+{stats.add}</span> <span className="del">−{stats.del}</span>
                    </span>
                  )}
                </div>
                <FileDiff a={pair.a} b={pair.b} />
              </>
            ) : (
              path && <div className="hx-muted hx-pad">Loading…</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
