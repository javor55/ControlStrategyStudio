// Data export: the whole project (in scope) as ONE structured JSON or TOML
// document — for other tools that do not want to read the YAML folder.
import { classify, parseYaml, type Files } from '@csd/core';
import { stringify as tomlStringify } from 'smol-toml';
import type { ExportConfig } from './config';
import { filesInScope } from './viewer';

export const DATA_FORMAT = 'css-data/1';

export interface ProjectData {
  format: typeof DATA_FORMAT;
  exportedAt: string;
  project: unknown;
  readme?: string;
  /** Hierarchy folder descriptions by folder path. */
  folders: Record<string, { readme: string }>;
  libraries: Record<string, { library?: unknown; types: Record<string, unknown> }>;
  /** Strategies by file path (relative to `strategies/`). */
  strategies: Record<string, { strategy: unknown; doc?: string }>;
  assets: string[];
}

export function projectData(files: Files, config: ExportConfig, exportedAt = new Date().toISOString()): ProjectData {
  const out: ProjectData = { format: DATA_FORMAT, exportedAt, project: {}, folders: {}, libraries: {}, strategies: {}, assets: [] };
  const parsed = (c: string) => parseYaml(c).data ?? null;
  for (const [f, c] of Object.entries(filesInScope(files, config))) {
    const role = classify(f);
    if (typeof c !== 'string') {
      if (role.kind === 'asset') out.assets.push(f);
      continue;
    }
    switch (role.kind) {
      case 'project':
        out.project = parsed(c);
        break;
      case 'readme':
        if (role.folder === null) out.readme = c;
        else out.folders[role.folder] = { readme: c };
        break;
      case 'library':
        (out.libraries[role.lib] ??= { types: {} }).library = parsed(c);
        break;
      case 'blocktype':
        (out.libraries[role.lib] ??= { types: {} }).types[f.slice(`library/${role.lib}/`.length).replace(/\.yaml$/, '')] = parsed(c);
        break;
      case 'strategy': {
        const key = f.slice('strategies/'.length).replace(/\.yaml$/, '');
        out.strategies[key] = { ...out.strategies[key], strategy: parsed(c) };
        break;
      }
      case 'strategy-doc': {
        const key = f.slice('strategies/'.length).replace(/\.md$/, '');
        out.strategies[key] = { ...(out.strategies[key] ?? { strategy: null }), doc: c };
        break;
      }
      case 'asset':
        out.assets.push(f);
        break;
    }
  }
  out.assets.sort();
  return out;
}

/** TOML has no null: drop nulls / undefined recursively (empty values just disappear). */
function withoutNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined).map(withoutNulls);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== null && x !== undefined) o[k] = withoutNulls(x);
    return o;
  }
  return v;
}

export function projectDataJson(data: ProjectData): string {
  return JSON.stringify(data, null, 2) + '\n';
}

export function projectDataToml(data: ProjectData): string {
  return tomlStringify(withoutNulls(data) as Record<string, unknown>) + '\n';
}
