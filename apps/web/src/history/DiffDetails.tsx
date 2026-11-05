// Inspector box in comparison mode for continuous strategies: field changes of
// the selected block or link (before → after), or an overview of all changes of
// the open strategy, including removed items that no longer exist on the canvas.
// Sequences use the same box (SequenceInspector) and the same Fields table.
import { formatEndpoint, type FieldChange, type Selection, type StrategyDiff } from '@csd/core';
import { store, useEditor } from '../state/store';
import { strategyDiffOf, useCompare } from './compare';
import { summarizeStrategy } from './format';
import { ChangesBox } from '../inspector/Scaffold';
import './history.css';

const fieldLabel = (f: string) => (f.startsWith('params.') ? f.slice(7) : f);

/** before → after table of field changes. */
export function Fields({ changes }: { changes: readonly FieldChange[] }) {
  if (!changes.length) return null;
  return (
    <table className="hx-fields">
      <tbody>
        {changes.map((c) => (
          <tr key={c.field}>
            <th className="mono" title={c.field}>
              {fieldLabel(c.field)}
            </th>
            <td>
              <span className="hx-before mono">{c.before ?? '—'}</span>
              <span className="hx-arrow" aria-label="changed to">
                →
              </span>
              <span className="hx-after mono">{c.after ?? '—'}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** "added" / "changed" / "removed" chip in the diff colour. */
export function Kind({ kind }: { kind: 'added' | 'changed' | 'removed' }) {
  return <span className={`hx-dk ${kind}`}>{kind}</span>;
}

function Overview({ sd, label }: { sd: StrategyDiff; label: string }) {
  const select = (id: string) => store().select({ kind: 'block', id });
  const blocks = sd.blocks.filter((b) => b.kind !== 'changed' || b.changes.length);
  const moved = sd.blocks.filter((b) => b.kind === 'changed' && !b.changes.length && b.moved);
  const removedBlocks = blocks.filter((b) => b.kind === 'removed');
  const removedLinks = sd.links.filter((l) => l.kind === 'removed');
  return (
    <>
      <div className="hx-dd-sum">{summarizeStrategy(sd)}</div>
      {sd.header.length > 0 && (
        <>
          <div className="hx-dd-h">Strategy</div>
          <Fields changes={sd.header} />
        </>
      )}
      {blocks.filter((b) => b.kind !== 'removed').length > 0 && (
        <>
          <div className="hx-dd-h">Blocks</div>
          <ul className="hx-dd-list">
            {blocks
              .filter((b) => b.kind !== 'removed')
              .map((b) => (
                <li key={b.id}>
                  <Kind kind={b.kind} />
                  <button className="hx-link mono" onClick={() => select(b.id)} title="Select on the canvas">
                    {b.id}
                  </button>
                  {b.changes.length > 0 && <span className="hx-muted">{b.changes.map((c) => fieldLabel(c.field)).join(', ')}</span>}
                </li>
              ))}
          </ul>
        </>
      )}
      {sd.links.filter((l) => l.kind !== 'removed').length > 0 && (
        <>
          <div className="hx-dd-h">Links</div>
          <ul className="hx-dd-list">
            {sd.links
              .filter((l) => l.kind !== 'removed')
              .map((l) => {
                const from = l.changes.find((c) => c.field === 'from');
                return (
                  <li key={l.key}>
                    <Kind kind={l.kind} />
                    <button className="hx-link mono" onClick={() => l.after && store().select({ kind: 'link', index: l.after.index })} title="Select on the canvas">
                      → {l.key}
                    </button>
                    {from ? (
                      <span className="hx-muted">
                        rewired: <span className="hx-before mono">{from.before}</span> → <span className="hx-after mono">{from.after}</span>
                      </span>
                    ) : l.changes.length ? (
                      <span className="hx-muted">{l.changes.map((c) => c.field).join(', ')}</span>
                    ) : null}
                  </li>
                );
              })}
          </ul>
        </>
      )}
      {(removedBlocks.length > 0 || removedLinks.length > 0) && (
        <>
          <div className="hx-dd-h">Removed since {label}</div>
          <ul className="hx-dd-list">
            {removedBlocks.map((b) => (
              <li key={`b:${b.id}`}>
                <Kind kind="removed" />
                <span className="mono hx-strike">{b.id}</span>
                <span className="hx-muted">block</span>
              </li>
            ))}
            {removedLinks.map((l) => (
              <li key={`l:${l.key}`}>
                <Kind kind="removed" />
                <span className="mono hx-strike">
                  {l.before ? formatEndpoint(l.before.from) : '?'} → {l.key}
                </span>
                <span className="hx-muted">link</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {(sd.notes.added || sd.notes.removed || sd.notes.changed) > 0 && (
        <div className="hx-muted hx-dd-p">
          Notes: +{sd.notes.added} −{sd.notes.removed}
        </div>
      )}
      {sd.docChanged && <div className="hx-muted hx-dd-p">The function description changed.</div>}
      {moved.length > 0 && <div className="hx-muted hx-dd-p">Moved only: {moved.map((b) => b.id).join(', ')}</div>}
    </>
  );
}

/** Changes box of a continuous strategy for the current selection (nothing outside comparison mode). */
export function StrategyChanges({ file, selection }: { file: string; selection: Selection | null }) {
  const { target, diff } = useCompare();
  if (!target || !diff) return null;
  const sd = strategyDiffOf(diff, file);
  const all = (
    <button type="button" className="btn small" onClick={() => store().select(null)}>
      All changes in this strategy
    </button>
  );
  let body;
  if (!sd) body = <div className="hx-muted hx-dd-p">No changes in this strategy.</div>;
  else if (sd.kind === 'added') body = <div className="hx-dd-p">New: it did not exist in {target.label}.</div>;
  else if (selection?.kind === 'block') {
    const b = sd.blocks.find((x) => x.id === selection.id);
    body = (
      <>
        <div className="hx-dd-p">
          {!b ? 'Unchanged.' : b.kind === 'added' ? <Kind kind="added" /> : b.changes.length ? <Kind kind="changed" /> : 'Only moved.'}
        </div>
        {b && <Fields changes={b.changes} />}
        {all}
      </>
    );
  } else if (selection?.kind === 'link') {
    const l = sd.links.find((x) => x.after?.index === selection.index);
    body = (
      <>
        <div className="hx-dd-p">{!l ? 'Unchanged.' : <Kind kind={l.kind === 'added' ? 'added' : 'changed'} />}</div>
        {l && <Fields changes={l.changes} />}
        {all}
      </>
    );
  } else if (selection) return null;
  else body = <Overview sd={sd} label={target.label} />;
  return (
    <ChangesBox label={target.label} testId="compare-details">
      {body}
    </ChangesBox>
  );
}

/** Coloured dot in the project tree for a strategy that differs (comparison mode) or has uncommitted changes. */
export function ChangeDot({ file }: { file: string }) {
  const { target, diff } = useCompare();
  const doc = file.replace(/\.yaml$/, '.md');
  const uncommitted = useEditor((s) => s.vcs.changes.find((c) => c.path === file) ?? s.vcs.changes.find((c) => c.path === doc));
  if (target) {
    const sd = strategyDiffOf(diff, file);
    if (!sd) return null;
    const kind = sd.kind === 'added' ? 'added' : 'changed';
    return <span className={`hx-tree-dot ${kind}`} title={`${kind === 'added' ? 'New' : 'Changed'} since ${target.label}: ${summarizeStrategy(sd)}`} aria-label={`${kind} since ${target.label}`} />;
  }
  if (!uncommitted) return null;
  const kind = uncommitted.kind === 'added' ? 'added' : 'changed';
  const what = uncommitted.kind === 'added' ? 'new, not committed yet' : uncommitted.kind === 'deleted' ? 'deleted, not committed yet' : 'changed since the last commit';
  return <span className={`hx-tree-dot hollow ${kind}`} title={`Uncommitted: ${what}`} aria-label={`uncommitted: ${what}`} />;
}
