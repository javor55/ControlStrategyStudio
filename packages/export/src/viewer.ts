// Read-only HTML export: the viewer application (one self-contained HTML file)
// with the project data embedded as JSON. No network, works from disk.
import { classify, strategyDocFile, type Files } from '@csd/core';
import type { ExportConfig } from './config';
import type { HistoryEntry } from './plan';

export const VIEWER_DATA_ID = 'css-export-data';
export const VIEWER_FORMAT = 'css-viewer/1';

export interface ViewerPayload {
  format: typeof VIEWER_FORMAT;
  generatedAt: string;
  projectName: string;
  config: ExportConfig;
  revision?: string;
  /** Commits, newest first (revision history). */
  history?: HistoryEntry[];
  uncommitted?: boolean;
  /** Text files as strings, binary assets as base64. */
  files: Record<string, string | { base64: string }>;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/**
 * Files that go into an export: project data, libraries, assets and only the
 * strategies in scope (plus their docs and the READMEs of their folders).
 */
export function filesInScope(files: Files, config: ExportConfig): Files {
  const all = Object.keys(files).filter((f) => classify(f).kind === 'strategy');
  const scope = new Set(config.strategies.length ? config.strategies : all);
  const folders = new Set<string>();
  for (const f of scope) {
    const role = classify(f);
    if (role.kind !== 'strategy') continue;
    const parts = role.folder ? role.folder.split('/') : [];
    for (let i = 0; i <= parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  const out: Record<string, string | Uint8Array> = {};
  for (const [f, c] of Object.entries(files)) {
    const role = classify(f);
    const keep =
      role.kind === 'project' ||
      role.kind === 'library' ||
      role.kind === 'blocktype' ||
      role.kind === 'asset' ||
      (role.kind === 'readme' && (role.folder === null || folders.has(role.folder))) ||
      (role.kind === 'strategy' && scope.has(f)) ||
      (role.kind === 'strategy-doc' && [...scope].some((s) => strategyDocFile(s) === f));
    if (keep) out[f] = c;
  }
  return out;
}

export function viewerPayload(
  files: Files,
  config: ExportConfig,
  meta: { projectName: string; revision?: string; generatedAt?: string; history?: HistoryEntry[]; uncommitted?: boolean },
): ViewerPayload {
  const out: ViewerPayload['files'] = {};
  for (const [f, c] of Object.entries(filesInScope(files, config))) out[f] = typeof c === 'string' ? c : { base64: toBase64(c) };
  return {
    format: VIEWER_FORMAT,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    projectName: meta.projectName,
    config,
    revision: meta.revision,
    history: config.sections.history ? meta.history : undefined,
    uncommitted: meta.uncommitted,
    files: out,
  };
}

export function payloadFiles(p: ViewerPayload): Files {
  const out: Record<string, string | Uint8Array> = {};
  for (const [f, c] of Object.entries(p.files)) out[f] = typeof c === 'string' ? c : fromBase64(c.base64);
  return out;
}

/** JSON safe to embed in a <script> element. */
export function scriptJson(value: unknown): string {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return JSON.stringify(value).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');
}

const DATA_RE = new RegExp(`(<script[^>]*id="${VIEWER_DATA_ID}"[^>]*>)([\\s\\S]*?)(</script>)`);

/** Puts the payload into the viewer template (the built viewer HTML). */
export function injectViewerData(template: string, payload: ViewerPayload, title?: string): string {
  if (!DATA_RE.test(template)) throw new Error('Viewer template has no data element');
  let html = template.replace(DATA_RE, (_m, open: string, _old: string, close: string) => open + scriptJson(payload) + close);
  if (title) html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${title.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</title>`);
  return html;
}
