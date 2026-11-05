// "?" overlay listing the canvas shortcuts and mouse gestures. The content comes
// from one source (help.ts) for every canvas kind.
import { Fragment, useEffect, useRef } from 'react';
import { canvasHelp, type CanvasKind } from './help';
import { CIcon } from './icons';

export { MOD } from './help';

const TITLES: Record<CanvasKind, string> = { fbd: 'Shortcuts — continuous strategy', sfc: 'Shortcuts — sequence strategy', composite: 'Shortcuts — composite block' };

export function ShortcutHelp({ kind, onClose }: { kind: CanvasKind; onClose: () => void }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || (e.key === '?' && !(e.target as HTMLElement).closest?.('input, textarea, .cm-editor'))) {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      }
    };
    // Attach after the key press that opened the overlay has finished propagating.
    const t = setTimeout(() => document.addEventListener('keydown', key, true));
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', key, true);
    };
  }, []);
  const title = TITLES[kind];
  return (
    <div className="cv-help" role="dialog" aria-label={title} onPointerDown={(e) => e.stopPropagation()}>
      <div className="cv-help-head">
        <strong>{title}</strong>
        <button className="btn small ghost icon" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          {CIcon.close}
        </button>
      </div>
      <div className="cv-help-body">
        {canvasHelp(kind).map((g) => (
          <section key={g.title}>
            <h4>{g.title}</h4>
            <table>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={(r.keys ?? []).join() + (r.gesture ?? '') + r.text}>
                    <td>
                      {r.keys
                        ? r.keys.map((key, i) => (
                            <Fragment key={key}>
                              {i > 0 && <span className="cv-help-or"> </span>}
                              <kbd>{key}</kbd>
                            </Fragment>
                          ))
                        : <span className="cv-help-gesture">{r.gesture}</span>}
                    </td>
                    <td>{r.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  );
}
