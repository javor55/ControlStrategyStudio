// Keyboard hints: built from MOD (⌘ on macOS, Ctrl elsewhere), never a hard-coded "Ctrl".
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export const MOD = isMac ? '⌘' : 'Ctrl';

/** "Ctrl+Shift+H" / "⌘+Shift+H" from "Mod+Shift+H". */
export const keys = (combo: string) => combo.replace(/\bMod\b/g, MOD);
