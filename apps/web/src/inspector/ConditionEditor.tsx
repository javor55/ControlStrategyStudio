// Transition condition editor: a text field with autocompletion of signals
// (strategy outputs, steps, sequence inputs, other sequences, keywords) and a
// live validation message. Commits on Enter / blur (one undo step).
import { useEffect, useMemo, useRef, useState } from 'react';
import { checkCondition, conditionWordAt, matchSignals, CONDITION_KEYWORDS, type SignalOption } from '../editor/seqsignals';
import type { ProjectModel } from '@csd/core';

export function ConditionEditor(props: { value: string | undefined; options: SignalOption[]; model: ProjectModel; onCommit: (v: string) => void; testId?: string }) {
  const external = props.value ?? '';
  const [draft, setDraft] = useState(external);
  const [popup, setPopup] = useState<{ from: number; to: number; items: SignalOption[]; active: number } | null>(null);
  const editing = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editing.current) setDraft(external);
  }, [external]);

  const all = useMemo(() => [...props.options, ...CONDITION_KEYWORDS], [props.options]);
  const check = useMemo(() => checkCondition(draft, props.options, props.model), [draft, props.options, props.model]);

  const suggest = (text: string, caret: number, explicit = false) => {
    const { from, word } = conditionWordAt(text, caret);
    if (!word && !explicit) return setPopup(null);
    const items = matchSignals(all, word);
    if (!items.length || (items.length === 1 && items[0].text === word)) return setPopup(null);
    setPopup({ from, to: caret, items, active: 0 });
  };

  const accept = (o: SignalOption) => {
    if (!popup) return;
    const rest = draft.slice(popup.to);
    const tail = /^[A-Za-z0-9_:.-]*/.exec(rest)![0];
    const insert = o.text + (/^\s/.test(rest.slice(tail.length)) || o.group !== 'keyword' ? '' : ' ');
    const next = draft.slice(0, popup.from) + insert + rest.slice(tail.length);
    const caret = popup.from + insert.length;
    setDraft(next);
    setPopup(null);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(caret, caret);
    });
  };

  useEffect(() => {
    listRef.current?.querySelector('.cond-opt.active')?.scrollIntoView({ block: 'nearest' });
  }, [popup?.active]);

  const commit = () => {
    editing.current = false;
    setPopup(null);
    if (draft.trim() !== external.trim()) props.onCommit(draft.trim());
  };

  return (
    <div className="cond-ed">
      <textarea
        ref={ref}
        className={`textarea mono${check?.severity === 'error' ? ' invalid' : ''}`}
        rows={2}
        value={draft}
        spellCheck={false}
        placeholder="e.g. LIC100:LT100.PV >= 2.5 and not S10.T > 2min"
        data-testid={props.testId}
        aria-label="Condition"
        aria-autocomplete="list"
        aria-expanded={!!popup}
        onFocus={() => (editing.current = true)}
        onBlur={commit}
        onChange={(e) => {
          setDraft(e.target.value);
          suggest(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onClick={() => setPopup(null)}
        onKeyDown={(e) => {
          if (popup) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const d = e.key === 'ArrowDown' ? 1 : -1;
              setPopup({ ...popup, active: (popup.active + d + popup.items.length) % popup.items.length });
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              accept(popup.items[popup.active]);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setPopup(null);
              return;
            }
          }
          if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            const t = e.currentTarget;
            suggest(t.value, t.selectionStart ?? t.value.length, true);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            editing.current = false;
            setDraft(external);
            e.currentTarget.blur();
          }
        }}
      />
      {popup && (
        <div className="cond-pop" role="listbox" ref={listRef} data-testid="cond-completions">
          {popup.items.map((o, i) => (
            <div
              key={o.text}
              role="option"
              aria-selected={i === popup.active}
              className={`cond-opt${i === popup.active ? ' active' : ''}`}
              title={o.description}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(o);
              }}
            >
              <span className="cond-text mono">{o.text}</span>
              {o.type && <span className="pill">{o.type}</span>}
              <span className="cond-detail">{o.detail}</span>
            </div>
          ))}
        </div>
      )}
      {check && draft.trim() && !popup && (
        <div className={`cond-msg ${check.severity}`} data-testid="cond-msg">
          {check.message}
        </div>
      )}
      {!check && draft.trim() && !popup && <div className="cond-msg ok">✓ Valid condition</div>}
    </div>
  );
}
