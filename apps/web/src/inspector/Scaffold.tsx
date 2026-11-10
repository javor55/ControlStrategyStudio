// Scaffold shared by every inspector panel (block, link, note, strategy, step,
// transition, sequence, folder, project, asset, block type):
//   1. sticky header: short kind label, title, severity badge, "⋯" (Rename, Delete …)
//   2. problems of the element right under the header
//   3. one "Changes since <version>" box in comparison mode
//   4. fields (Name, Type, Description, Documentation, Comment, specific, Sheet, Position)
//   5. sections with a "+ Add X" button in the header
//   6. Info last (content, file, function description as an action)
import { useEffect, useState, type ReactNode } from 'react';
import type { Diag } from '@csd/core';
import { store } from '../state/store';
import { Row, type MenuEntry } from '../ui/kit';
import { DiagBadges, MoreButton } from '../ui/parts';
import { countDiags, plural } from '../ui/text';
import { Icon } from '../project/icons';
import { stopCompare } from '../history/compare';
import { goToDiag } from '../project/ProblemsBar';

/** id of the Name field of the shown element; "Rename" in the ⋯ menu focuses it. */
export const NAME_FIELD_ID = 'insp-name';

export function focusNameField() {
  const el = document.getElementById(NAME_FIELD_ID) as HTMLInputElement | null;
  el?.focus();
  el?.select();
}

export interface HeadProps {
  /** Short kind label: "Block", "Step", "Transition", "Link", "Note", "Strategy" … */
  kind: string;
  title: ReactNode;
  sub?: ReactNode;
  diags?: readonly Diag[];
  /** Rename (first menu entry). `true` focuses the Name field. */
  onRename?: (() => void) | true;
  onDelete?: () => void;
  deleteLabel?: string;
  /** Further entries between Rename and Delete. */
  menu?: MenuEntry[];
  /** Buttons before the ⋯ menu. */
  actions?: ReactNode;
  testId?: string;
}

export function Head(props: HeadProps) {
  const rename = props.onRename === true ? focusNameField : props.onRename;
  const items = (): MenuEntry[] => {
    const out: MenuEntry[] = [];
    if (rename) out.push({ label: 'Rename', hint: 'F2', onClick: rename });
    if (props.menu?.length) out.push(...props.menu);
    if (props.onDelete) {
      if (out.length) out.push('separator');
      out.push({ label: props.deleteLabel ?? 'Delete', danger: true, onClick: props.onDelete });
    }
    return out;
  };
  const hasMenu = !!(rename || props.onDelete || props.menu?.length);
  return (
    <div className="insp-head" data-testid={props.testId}>
      <span className="insp-kind">{props.kind}</span>
      <span className="insp-title" title={typeof props.title === 'string' ? props.title : undefined}>
        {props.title}
      </span>
      {props.sub && <span className="insp-sub">{props.sub}</span>}
      <span className="spacer" />
      {props.diags && <DiagBadges diags={props.diags} />}
      {props.actions}
      {hasMenu && <MoreButton items={items} label={`${props.kind} actions`} testId="insp-more" />}
    </div>
  );
}

const SEV_LABEL = { error: 'Error', warning: 'Warning', info: 'Info' } as const;

/** Problems of the shown element (right under the header). Click one to go to it. */
const DIAGS_OPEN_KEY = 'csd.inspector.diagsOpen';
const readOpen = () => {
  try {
    return localStorage.getItem(DIAGS_OPEN_KEY) === '1';
  } catch {
    return false;
  }
};
/** Shared by every inspector panel: open / closed is remembered for all of them. */
let diagsOpen = readOpen();
const diagsListeners = new Set<() => void>();
function setDiagsOpen(v: boolean) {
  diagsOpen = v;
  try {
    localStorage.setItem(DIAGS_OPEN_KEY, v ? '1' : '0');
  } catch {
    /* ignore */
  }
  diagsListeners.forEach((f) => f());
}

/**
 * Problems of the shown element — the same messages as the problems bar at the
 * bottom, filtered to this file / element. Collapsed to one summary line by
 * default so the fields stay in view; the choice is remembered.
 */
export function DiagList({ diags }: { diags: readonly Diag[] }) {
  const [open, setOpen] = useState(diagsOpen);
  useEffect(() => {
    const f = () => setOpen(diagsOpen);
    diagsListeners.add(f);
    return () => void diagsListeners.delete(f);
  }, []);
  if (!diags.length) return null;
  const c = countDiags(diags);
  const parts = [c.errors && plural(c.errors, 'error'), c.warnings && plural(c.warnings, 'warning'), c.infos && `${c.infos} info`].filter(Boolean).join(' · ');
  const worst = c.errors ? 'error' : c.warnings ? 'warning' : 'info';
  return (
    <div className="insp-diagbox">
      <button type="button" className={`insp-diag-sum ${worst}`} aria-expanded={open} title={open ? 'Hide the messages' : 'Show the messages'} onClick={() => setDiagsOpen(!open)}>
        <span className="insp-diag-caret">{open ? '▾' : '▸'}</span>
        <span className={`badge ${worst}`}>{SEV_LABEL[worst]}</span>
        <span>{parts}</span>
      </button>
      {open && (
        <ul className="insp-diags" aria-label="Problems">
          {diags.map((x, i) => (
            <li key={i} className={x.severity}>
              <span className={`badge ${x.severity}`}>{SEV_LABEL[x.severity]}</span>
              <span className="insp-diag-msg">{x.message}</span>
              {x.line && (
                <button type="button" className="insp-line" title="Show in the text" onClick={() => goToDiag(x)}>
                  :{x.line}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The one "Changes since <version>" box of comparison mode. */
export function ChangesBox({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <section className="hx-dd" aria-label={`Changes since ${label}`} data-testid={testId}>
      <div className="hx-dd-head">
        <span className="hx-dd-title">
          Changes since <span className="mono">{label}</span>
        </span>
        <span className="spacer" />
        <button type="button" className="btn small ghost" onClick={stopCompare} title="Leave comparison mode">
          Exit comparison
        </button>
      </div>
      {children}
    </section>
  );
}

/** File path, right-aligned so the name stays visible. */
export function PathRow({ file, label = 'File' }: { file: string; label?: string }) {
  return (
    <Row label={label}>
      <span className="insp-path mono" title={file}>
        {`‎${file}‎`}
      </span>
    </Row>
  );
}

/** A Markdown description of something: "Open ↗" when it exists, "Add" otherwise. */
export function DocRow(props: { label: string; exists: boolean; onOpen: () => void; what?: string }) {
  return (
    <Row label={props.label}>
      {props.exists ? (
        <button type="button" className="insp-ep insp-action" onClick={props.onOpen} title={`Open the ${props.what ?? props.label.toLowerCase()}`}>
          Open {Icon.external}
        </button>
      ) : (
        <button type="button" className="btn small" onClick={props.onOpen} title={`Create the ${props.what ?? props.label.toLowerCase()}`}>
          Add
        </button>
      )}
    </Row>
  );
}

/** Delete an element without asking (it can be undone) and offer Undo in a toast. */
export function deleteWithUndo(run: () => boolean, text: string) {
  if (run()) store().toastUndo(text);
}

/** Position row: coordinates + Unpin, or "auto". */
export function PositionRow({ pos, onUnpin }: { pos?: readonly [number, number] | null; onUnpin: () => void }) {
  return (
    <Row label="Position">
      {pos ? (
        <span className="insp-inline">
          <span className="mono">
            {pos[0]}, {pos[1]}
          </span>
          <span className="insp-muted">pinned</span>
          <button type="button" className="btn small" onClick={onUnpin} title="Let the layout place it again">
            Unpin
          </button>
        </span>
      ) : (
        <span className="insp-muted">automatic</span>
      )}
    </Row>
  );
}
