// Small building blocks shared by panels, views and the tree (on top of ui/kit):
// error / warning badges with a tooltip, the "+ Add X" section button, empty
// states and the "⋯" more-actions button.
import type { ReactNode } from 'react';
import type { Diag } from '@csd/core';
import { useMenu, type MenuEntry } from './kit';
import { Icon } from '../project/icons';
import { badgeTitle, countDiags } from './text';

/** Error and warning counts as two badges (info is not a problem and is not shown). */
export function DiagBadges({ diags, title }: { diags: readonly Diag[]; title?: string }) {
  const c = countDiags(diags);
  if (!c.errors && !c.warnings) return null;
  return (
    <span className="diag-badges" title={title ?? badgeTitle(c)} aria-label={badgeTitle(c)}>
      {c.errors > 0 && <span className="badge error">{c.errors}</span>}
      {c.warnings > 0 && <span className="badge warning">{c.warnings}</span>}
    </span>
  );
}

/** "+ Add X" ghost button in a section header (one style everywhere). */
export function AddButton(props: { label: string; onClick: (el: HTMLElement) => void; title?: string; testId?: string; disabled?: boolean }) {
  return (
    <button type="button" className="btn small ghost add-btn" title={props.title} data-testid={props.testId} disabled={props.disabled} onClick={(e) => props.onClick(e.currentTarget)}>
      {Icon.plus}
      {props.label}
    </button>
  );
}

/** Empty state: one sentence and an optional action. */
export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span>{children}</span>
      {action}
    </div>
  );
}

/** "⋯" button that opens a menu below itself. */
export function MoreButton({ items, label = 'More actions', testId }: { items: () => MenuEntry[]; label?: string; testId?: string }) {
  const menu = useMenu();
  return (
    <>
      <button type="button" className="btn small ghost icon" title={label} aria-label={label} aria-haspopup="menu" data-testid={testId} onClick={(e) => menu.openBelow(e.currentTarget, items())}>
        {Icon.more}
      </button>
      {menu.element}
    </>
  );
}
