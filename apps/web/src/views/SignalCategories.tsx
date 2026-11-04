// Signal categories editor (project.yaml `signal_categories`): line colour,
// dash style, width and description of link categories such as interlock or
// tracking. Every edit is one `setSignalCategory` op.
import { useEffect, useMemo, useRef } from 'react';
import type { SignalCategory } from '@csd/core';
import { store, useEditor } from '../state/store';
import { Field } from '../ui/kit';
import { confirmDialog } from '../ui/dialogs';
import { askCategoryName, categoryUsage, defaultCategoryColor } from '../project/actions';

const STYLES = ['solid', 'dashed', 'dotted', 'dashdot'] as const;
const FALLBACK_COLOR = '#5b6670';
const DASH: Record<string, string | undefined> = { solid: undefined, dashed: '6 3', dotted: '1.5 2.5', dashdot: '8 3 2 3' };

function setCategory(name: string, category: SignalCategory | undefined, label: string) {
  return store().dispatch({ op: 'setSignalCategory', name, category: category && { ...category } }, { label });
}

/** Colour input that commits once, when the picker is closed (native `change`), not on every move. */
function ColorInput({ value, onCommit, label }: { value: string; onCommit: (v: string) => void; label: string }) {
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

function Sample({ c }: { c: SignalCategory }) {
  return (
    <svg width="44" height="10" aria-hidden="true" className="v-cat-sample">
      <line x1="2" y1="5" x2="42" y2="5" stroke={c.color ?? FALLBACK_COLOR} strokeWidth={c.width ?? 1.5} strokeDasharray={DASH[c.style ?? 'solid']} />
    </svg>
  );
}

export function SignalCategoriesSection() {
  const cats = useEditor((s) => s.model.meta.signalCategories);
  const model = useEditor((s) => s.model);
  const usage = useMemo(() => categoryUsage(), [model]); // eslint-disable-line react-hooks/exhaustive-deps
  const names = Object.keys(cats);
  const undefinedUsed = [...usage.keys()].filter((n) => !(n in cats)).sort();

  const add = async () => {
    const name = await askCategoryName();
    if (!name) return;
    setCategory(name, { color: defaultCategoryColor(), style: 'solid' }, `Add signal category ${name}`);
  };

  const update = (name: string, patch: Partial<SignalCategory>, label: string) => setCategory(name, { ...cats[name], ...patch }, label);

  const remove = async (name: string) => {
    const n = usage.get(name) ?? 0;
    if (n) {
      const ok = await confirmDialog({
        title: `Delete category ${name}?`,
        message: `${n} link${n === 1 ? '' : 's'} use${n === 1 ? 's' : ''} it and will be drawn in the default style (they keep "category: ${name}"). You can undo this.`,
        okLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
    }
    setCategory(name, undefined, `Delete signal category ${name}`);
  };

  return (
    <section className="v-sec" aria-label="Signal categories">
      <h3>
        Signal categories <span className="count">{names.length}</span>
        <span className="spacer" />
        <button className="btn small" onClick={add}>
          + Add category
        </button>
      </h3>
      {names.length ? (
        <table className="v-table v-cats">
          <thead>
            <tr>
              <th className="c-name">Name</th>
              <th className="c-color">Colour</th>
              <th className="c-style">Style</th>
              <th className="c-width">Width</th>
              <th>Description</th>
              <th className="c-used" title="Line sample and number of links using this category">Links</th>
              <th className="c-act" />
            </tr>
          </thead>
          <tbody>
            {names.map((name) => {
              const c = cats[name];
              const n = usage.get(name) ?? 0;
              return (
                <tr key={name} data-testid={`cat-${name}`}>
                  <td className="mono strong" title={name}>
                    {name}
                  </td>
                  <td>
                    <ColorInput value={c.color ?? FALLBACK_COLOR} label={`Colour of ${name}`} onCommit={(v) => update(name, { color: v }, `Colour of ${name}`)} />
                  </td>
                  <td>
                    <select className="select" aria-label={`Line style of ${name}`} value={c.style ?? 'solid'} onChange={(e) => update(name, { style: e.target.value as SignalCategory['style'] }, `Line style of ${name}`)}>
                      {STYLES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="v-cat-w">
                    <Field
                      value={c.width}
                      placeholder="1.5"
                      title="Line width (px)"
                      onCommit={(v) => {
                        const t = v.trim();
                        const w = t === '' ? undefined : Number(t);
                        if (w !== undefined && (!Number.isFinite(w) || w <= 0 || w > 10)) return store().toast('Width must be a number between 0 and 10', 'error');
                        update(name, { width: w }, `Line width of ${name}`);
                      }}
                    />
                  </td>
                  <td>
                    <Field value={c.description} placeholder="—" title="Description" onCommit={(v) => update(name, { description: v.trim() || undefined }, `Description of ${name}`)} />
                  </td>
                  <td className="mono" title={`${n} link${n === 1 ? '' : 's'}`}>
                    <Sample c={c} />
                    <span className="v-cat-n">{n}</span>
                  </td>
                  <td>
                    <button className="btn small ghost icon danger" title={`Delete ${name}`} aria-label={`Delete ${name}`} onClick={() => remove(name)}>
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="muted">No categories yet. Categories give links a common line style, e.g. interlocks in red, tracking signals dotted.</p>
      )}
      {undefinedUsed.length > 0 && (
        <p className="muted v-cat-undef">
          Used but not defined:{' '}
          {undefinedUsed.map((n) => (
            <button key={n} className="linkish mono" title={`Define ${n}`} onClick={() => setCategory(n, { color: defaultCategoryColor(), style: 'solid' }, `Add signal category ${n}`)}>
              {n} ({usage.get(n)})
            </button>
          ))}
        </p>
      )}
    </section>
  );
}
