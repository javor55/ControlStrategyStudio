// Line categories (project.yaml `signal_categories`): shared helpers and the
// short legend on the project page. The categories themselves are edited in
// Settings → Drawing style (one table for the built-in BOOL / Numeric / Other
// categories and the project's own, e.g. interlock or tracking).
import { useEffect, useMemo, useRef } from 'react';
import { BUILTIN_CATEGORIES, lineCategories, type SignalCategory } from '@csd/core';
import { PRINT_THEME } from '@csd/render';
import { useEditor } from '../state/store';
import { categoryUsage } from '../project/actions';
import { openSettings } from '../settings/open';

export const LINE_DASH: Record<string, string | undefined> = { solid: undefined, dashed: '6 3', dotted: '1.5 2.5', dashdot: '8 3 2 3' };
export const DEFAULT_LINE_WIDTH = 1.5;
const FALLBACK_COLOR = '#5b6670';

/** Default colour of a built-in category (renderer theme), else a neutral grey. */
export function builtinColor(name: string): string {
  return name === 'bool' ? PRINT_THEME.bool : name === 'numeric' ? PRINT_THEME.real : name === 'other' ? PRINT_THEME.other : FALLBACK_COLOR;
}

export const isBuiltinCategory = (name: string) => name in BUILTIN_CATEGORIES;

/** Label of a category for people: BOOL / Numeric / Other for the built-ins. */
export function categoryLabel(name: string): string {
  return name === 'bool' ? 'BOOL' : name === 'numeric' ? 'Numeric' : name === 'other' ? 'Other' : name;
}

/** Colour input that commits once, when the picker is closed (native `change`), not on every move. */
export function ColorInput({ value, onCommit, label }: { value: string; onCommit: (v: string) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.value = value;
  }, [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => commit.current(el.value);
    el.addEventListener('change', on);
    return () => el.removeEventListener('change', on);
  }, []);
  return <input ref={ref} type="color" className="v-color" defaultValue={value} aria-label={label} title={label} />;
}

export function LineSample({ name, c, w = 44 }: { name: string; c: SignalCategory; w?: number }) {
  return (
    <svg width={w} height="10" viewBox={`0 0 ${w} 10`} aria-hidden="true" className="v-cat-sample">
      <line x1="2" y1="5" x2={w - 2} y2="5" stroke={c.color ?? builtinColor(name)} strokeWidth={c.width ?? DEFAULT_LINE_WIDTH} strokeDasharray={LINE_DASH[c.style ?? 'solid']} />
    </svg>
  );
}

/** Legend of all line categories with a button to Settings → Drawing style. */
export function LineCategoriesLegend() {
  const meta = useEditor((s) => s.model.meta);
  const model = useEditor((s) => s.model);
  const cats = useMemo(() => lineCategories(meta), [meta]);
  const usage = useMemo(() => categoryUsage(), [model]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="v-sec" aria-label="Line categories">
      <h3>
        Line categories <span className="count">{Object.keys(cats).length}</span>
        <span className="spacer" />
        <button className="btn small" onClick={() => openSettings('drawing')} data-testid="edit-categories">
          Edit in Settings
        </button>
      </h3>
      <ul className="v-legend" data-testid="category-legend">
        {Object.entries(cats).map(([name, c]) => (
          <li key={name} title={c.description}>
            <LineSample name={name} c={c} />
            <span className={isBuiltinCategory(name) ? 'strong' : 'mono strong'}>{categoryLabel(name)}</span>
            {!isBuiltinCategory(name) && usage.get(name) ? <span className="muted"> · {usage.get(name)}</span> : null}
          </li>
        ))}
      </ul>
      <p className="muted">Links get BOOL, Numeric or Other automatically by their signal type; give a link a project category (e.g. interlock) in its properties.</p>
    </section>
  );
}
