// "?" overlay listing the canvas keyboard shortcuts and mouse gestures.
import { useEffect, useRef } from 'react';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';

export interface HelpGroup {
  title: string;
  rows: [string, string][];
}

export { MOD };

const GROUPS: HelpGroup[] = [
  {
    title: 'Mouse',
    rows: [
      ['Wheel', 'Scroll vertically'],
      ['Shift + wheel', 'Scroll horizontally'],
      [`${MOD} + wheel / pinch`, 'Zoom around the cursor'],
      ['Middle drag · Space + drag', 'Pan'],
      ['Drag on empty paper', 'Rubber-band selection'],
      ['Shift / Ctrl + click or drag', 'Add to / toggle selection'],
      ['Drag a selected block', 'Move all selected blocks'],
      ['Drag from a port to a port', 'Connect'],
      ['Drag from a port to empty paper', 'Add a matching block and connect it'],
      ['Drag the end of a link to another pin', 'Reconnect (label, category and comment are kept)'],
      ['Green / red ring while wiring', 'Valid target / types or directions do not match'],
      ['Double-click empty paper', 'Quick insert a block'],
      ['Double-click block name', 'Rename in place'],
      ['Double-click parameter / constant', 'Edit value in place'],
      ['Double-click unconnected input name', 'Set a constant'],
      ['Double-click composite block', 'Open its internals'],
      ['Click ▾ / "N parameters" on a block', 'Collapse / expand its parameters'],
      ['Right-click', 'Context menu'],
    ],
  },
  {
    title: 'Keyboard',
    rows: [
      [`${MOD}+C / ${MOD}+X / ${MOD}+V`, 'Copy / cut / paste blocks (at the mouse)'],
      [`${MOD}+D`, 'Duplicate selection'],
      [`${MOD}+A`, 'Select all blocks on the sheet'],
      ['Delete / Backspace', 'Delete selection'],
      ['Arrows · Shift+arrows', 'Nudge 10 px · 50 px'],
      [`${MOD}+Z · ${MOD}+Y`, 'Undo · redo'],
      [`${MOD}+,`, 'Settings (drawing style, editor)'],
      ['Escape', 'Clear selection / cancel drag'],
      [`/ · ${MOD}+Space`, 'Quick insert a block'],
      ['F · Shift+1', 'Fit drawing'],
      [`${MOD}+0`, 'Zoom 100 %'],
      ['+ / −', 'Zoom in / out'],
      ['?', 'This help'],
    ],
  },
];

export function ShortcutHelp({ onClose, groups = GROUPS, title = 'Canvas shortcuts' }: { onClose: () => void; groups?: HelpGroup[]; title?: string }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        close.current();
      }
    };
    // Attach after the key press that opened the overlay has finished propagating.
    const t = setTimeout(() => document.addEventListener('keydown', key));
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', key);
    };
  }, []);
  return (
    <div className="cv-help" role="dialog" aria-label={title} onPointerDown={(e) => e.stopPropagation()}>
      <div className="cv-help-head">
        <strong>{title}</strong>
        <button className="btn small icon" title="Close (Esc)" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="cv-help-body">
        {groups.map((g) => (
          <section key={g.title}>
            <h4>{g.title}</h4>
            <table>
              <tbody>
                {g.rows.map(([k, v]) => (
                  <tr key={k}>
                    <td>
                      <kbd>{k}</kbd>
                    </td>
                    <td>{v}</td>
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
