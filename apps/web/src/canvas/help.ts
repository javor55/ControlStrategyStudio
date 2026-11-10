// One source for the canvas shortcut help ("?" overlay): shared groups, one
// group per canvas kind, and the app-wide keys (App.tsx, history, text view).
// Keys are written with MOD (Ctrl, or ⌘ on a Mac) — never a hard-coded "Ctrl".

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
/** Modifier key name for hints: "Ctrl" or "⌘". */
export const MOD = isMac ? '⌘' : 'Ctrl';
/** `MOD+X`. */
export const mod = (k: string) => `${MOD}+${k}`;

export type CanvasKind = 'fbd' | 'sfc' | 'composite';

/**
 * One help row: `keys` are keyboard shortcuts (drawn as keys, alternatives
 * separated), `gesture` is a mouse action (plain text), `text` what it does.
 */
export interface HelpRow {
  keys?: string[];
  gesture?: string;
  text: string;
}

export interface HelpGroup {
  title: string;
  rows: HelpRow[];
}

const k = (keys: string[], text: string): HelpRow => ({ keys, text });
const g = (gesture: string, text: string): HelpRow => ({ gesture, text });

export function canvasHelp(kind: CanvasKind): HelpGroup[] {
  const sfc = kind === 'sfc';
  const el = sfc ? 'steps' : 'blocks';
  const shared: HelpGroup[] = [
    {
      title: 'View',
      rows: [
        g('Wheel · Shift + wheel', 'Scroll vertically · horizontally'),
        g(`${MOD} + wheel, pinch`, 'Zoom around the pointer'),
        g('Middle drag, Space + drag', 'Pan'),
        k(['F', 'Shift+1'], 'Fit the drawing'),
        k([mod('0')], 'Zoom 100 %'),
        k(['+', '−', mod('='), mod('−')], 'Zoom in · out'),
      ],
    },
    {
      title: 'Select and edit',
      rows: [
        g(`Click · Shift / ${MOD} + click`, 'Select · add to or remove from the selection'),
        g('Drag on empty paper', `Rubber-band selection of ${el}`),
        k([mod('A')], `Select all ${el} on the sheet`),
        k(['Arrows', 'Shift+Arrows'], 'Move the selection 10 px · 50 px'),
        k(['F2'], sfc ? 'Rename the selected step in place' : 'Rename the selected block in place'),
        k(['Enter'], sfc ? 'Edit the main text: step description, transition condition, note' : 'Edit the main text: block description, note'),
        k(['Delete', 'Backspace'], 'Delete the selection (Undo in the message or ' + mod('Z') + ')'),
        k([mod('C'), mod('X'), mod('V')], `Copy · cut · paste (at the pointer)`),
        k([mod('D')], 'Duplicate the selection'),
        k([mod('Z'), mod('Y')], 'Undo · redo'),
        k(['Esc'], 'Close the open menu or popup, cancel a drag, then clear the selection'),
      ],
    },
    {
      title: 'Add',
      rows: [
        k(['/', mod('Space')], sfc ? 'Insert: search steps, branches, note, paste' : 'Insert: search block types, note, paste'),
        k([mod('F')], sfc ? 'Find a step (all sheets and sequencers) and show it' : 'Find a block (all sheets) and show it'),
        g('Double-click empty paper', 'Insert at that point (same search)'),
        g('Right-click', 'Context menu of the element or the paper'),
        g('Drag from the palette', sfc ? 'Drop onto a step (top = before, bottom = after, middle = beside) or a transition' : 'Drop a block type onto the drawing'),
      ],
    },
  ];
  const own: HelpGroup = sfc
    ? {
        title: 'Sequence (SFC)',
        rows: [
          k([mod('Enter')], 'Insert step after the selected step'),
          k([mod('Shift+Enter')], 'Insert step before the selected step'),
          g('Drag from the bottom edge of a step', 'Draw a transition (drop on empty paper: new step)'),
          g('Double-click a step', 'Edit its description (name row: rename)'),
          g('Double-click a transition', 'Insert step into transition'),
          g('Click a jump label', 'Go to the target step'),
        ],
      }
    : {
        title: kind === 'composite' ? 'Composite block (FBD)' : 'Function block diagram (FBD)',
        rows: [
          g('Drag from a pin to a pin', 'Connect'),
          g('Drag from a pin to empty paper', 'Add a matching block and connect it'),
          g('Drag the end of a link to another pin', 'Reconnect (label, category and comment are kept)'),
          g('Green / red ring while wiring', 'Valid target / types or directions do not match'),
          g('Double-click a block name', 'Rename in place'),
          g('Double-click a parameter or constant', 'Edit the value in place'),
          g('Double-click an unconnected input name', 'Set a constant'),
          g('Double-click a composite block', 'Open its internals'),
          g('Click ▾ / "N parameters" on a block', 'Show or hide its parameters'),
        ],
      };
  const global: HelpGroup = {
    title: 'Everywhere',
    rows: [
      k(['Alt+1', 'Alt+2', 'Alt+3'], 'Diagram · Split · Text view'),
      k([mod('B')], 'Show or hide the project panel'),
      k([mod('Alt+B')], 'Show or hide the properties panel'),
      k([mod('S')], 'Save as ZIP'),
      k([mod('E')], 'Export'),
      k([mod(',')], 'Settings'),
      k([mod('Shift+H')], 'Show or hide history'),
      k([mod('Shift+C')], 'Commit'),
      k(['F8', 'Shift+F8'], 'Next · previous problem in the text (Split or Text view)'),
      k(['?'], 'This help'),
    ],
  };
  return [...shared, own, global];
}
