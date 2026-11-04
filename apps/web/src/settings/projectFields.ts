// Edits of plain project.yaml fields (name, description, author, title block).
// Core has no dedicated op for these yet, so the change is made on the YAML
// document (comments and order kept) and dispatched as one `setText` op.
import { PROJECT_FILE, stringifyDoc } from '@csd/core';
import { isMap, parseDocument } from 'yaml';
import { store } from '../state/store';

export function setProjectField(path: string[], value: string | undefined, label: string): boolean {
  const s = store();
  const text = s.getState().files[PROJECT_FILE];
  const doc = parseDocument(typeof text === 'string' ? text : '');
  if (doc.errors.length) {
    s.toast('project.yaml has syntax errors — fix them in the text view first', 'error');
    return false;
  }
  const v = value?.trim();
  if (v) doc.setIn(path, v);
  else if (path.length > 1) {
    // Keep the parent map (e.g. `title_block`) with an empty value, as new projects have it.
    const parent = doc.getIn(path.slice(0, -1));
    if (isMap(parent)) doc.setIn(path, '');
  } else doc.deleteIn(path);
  const next = stringifyDoc(doc);
  if (next === text) return false;
  return s.dispatch({ op: 'setText', file: PROJECT_FILE, text: next }, { label });
}
