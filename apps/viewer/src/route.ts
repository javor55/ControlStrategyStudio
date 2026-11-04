// View state kept in location.hash so a view can be bookmarked and shared:
//   #s=FIC101&sheet=1&b=FIC101     strategy sheet with a selected block
//   #s=P101&sheet=2&l=4            … with a selected link (signal)
//   #s=FIC101&tab=blocks           strategy tab (doc | blocks | links)
//   #q=FILL_T100&sheet=1&s=S10     sequence sheet with a selected step
//   #q=FILL_T100&sheet=1&tr=2      … with a selected transition (index)
//   #q=FILL_T100&tab=steps         sequence tab (doc | steps | transitions)
//   #f=ACME/Brno                   hierarchy folder
//   #lib  /  #t=acme/AI_2OO3@1.0.0&b=MED   library index / block type
//   #project (or empty)            project page
import { useEffect, useState } from 'react';

export type Sel = { kind: 'block'; id: string } | { kind: 'link'; index: number } | null;
export type Tab = 'doc' | 'sheet' | 'blocks' | 'links';
export type SeqSel = { kind: 'step'; id: string } | { kind: 'transition'; index: number } | null;
export type SeqTab = 'doc' | 'sheet' | 'steps' | 'transitions';

export type Route =
  | { page: 'project' }
  | { page: 'folder'; path: string }
  | { page: 'library' }
  | { page: 'type'; key: string; sheet?: number; sel: Sel }
  | { page: 'strategy'; name: string; tab?: Tab; sheet?: number; sel: Sel }
  | { page: 'sequence'; name: string; tab?: SeqTab; sheet?: number; sel: SeqSel };

export function parseHash(hash: string): Route {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const sel = (): Sel => {
    const b = q.get('b');
    if (b) return { kind: 'block', id: b };
    const l = q.get('l');
    if (l !== null && /^\d+$/.test(l)) return { kind: 'link', index: Number(l) };
    return null;
  };
  const sheet = q.get('sheet');
  const sheetN = sheet && /^\d+$/.test(sheet) ? Number(sheet) : undefined;
  const seq = q.get('q');
  if (seq) {
    const tab = q.get('tab');
    const step = q.get('s');
    const tr = q.get('tr');
    const ssel: SeqSel = step ? { kind: 'step', id: step } : tr !== null && /^\d+$/.test(tr) ? { kind: 'transition', index: Number(tr) } : null;
    return { page: 'sequence', name: seq, tab: tab === 'doc' || tab === 'steps' || tab === 'transitions' ? tab : sheetN !== undefined || ssel ? 'sheet' : undefined, sheet: sheetN, sel: ssel };
  }
  const s = q.get('s');
  if (s) {
    const tab = q.get('tab');
    return { page: 'strategy', name: s, tab: tab === 'doc' || tab === 'blocks' || tab === 'links' ? tab : sheetN !== undefined ? 'sheet' : undefined, sheet: sheetN, sel: sel() };
  }
  const t = q.get('t');
  if (t) return { page: 'type', key: t, sheet: sheetN, sel: sel() };
  if (q.has('lib')) return { page: 'library' };
  const f = q.get('f');
  if (f !== null) return { page: 'folder', path: f };
  return { page: 'project' };
}

export function routeHash(r: Route): string {
  const q: string[] = [];
  const add = (k: string, v?: string | number) => q.push(v === undefined ? k : `${k}=${encodeURIComponent(String(v)).replace(/%2F/g, '/').replace(/%40/g, '@')}`);
  const addSel = (sel: Sel) => {
    if (sel?.kind === 'block') add('b', sel.id);
    if (sel?.kind === 'link') add('l', sel.index);
  };
  switch (r.page) {
    case 'project':
      add('project');
      break;
    case 'folder':
      add('f', r.path);
      break;
    case 'library':
      add('lib');
      break;
    case 'type':
      add('t', r.key);
      if (r.sheet !== undefined && r.sheet !== 1) add('sheet', r.sheet);
      addSel(r.sel);
      break;
    case 'strategy':
      add('s', r.name);
      if (r.tab && r.tab !== 'sheet') add('tab', r.tab);
      else if (r.sheet !== undefined) add('sheet', r.sheet);
      addSel(r.sel);
      break;
    case 'sequence':
      add('q', r.name);
      if (r.tab && r.tab !== 'sheet') add('tab', r.tab);
      else if (r.sheet !== undefined) add('sheet', r.sheet);
      if (r.sel?.kind === 'step') add('s', r.sel.id);
      if (r.sel?.kind === 'transition') add('tr', r.sel.index);
      break;
  }
  return '#' + q.join('&');
}

/** Navigates: a new history entry, or `replace` for selection changes. */
export function go(r: Route, opts: { replace?: boolean } = {}) {
  const h = routeHash(r);
  if (h === location.hash) return;
  if (opts.replace) location.replace(h);
  else location.hash = h;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
