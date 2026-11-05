// Block libraries. Each library is a self-contained folder `library/<lib>/`
// that can be copied between projects.
import { classify, libraryFile } from './paths';
import { migrateParsed } from './format';
import { validateSchema } from './schema';
import { parseDiagram, type TypeResolution } from './diagram';
import type { BlockTypeDef, Diag, Files, LibraryDef, PortDef } from './types';
import { isObj, lineAt, parseYaml, pickExt, str } from './yamlutil';

const TYPE_REF_RE = /^(?:([A-Za-z0-9_-]+)\/)?([A-Za-z_][A-Za-z0-9_]*)(?:@(\d+\.\d+\.\d+))?$/;

export interface TypeRef {
  lib?: string;
  type: string;
  version?: string;
}

export function parseTypeRef(ref: string): TypeRef | undefined {
  const m = TYPE_REF_RE.exec(ref.trim());
  return m ? { lib: m[1], type: m[2], version: m[3] } : undefined;
}

export function formatTypeRef(r: TypeRef): string {
  return `${r.lib ? r.lib + '/' : ''}${r.type}${r.version ? '@' + r.version : ''}`;
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export function bumpVersion(v: string, part: 'major' | 'minor' | 'patch' = 'minor'): string {
  const [a, b, c] = v.split('.').map(Number);
  if (part === 'major') return `${a + 1}.0.0`;
  if (part === 'minor') return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
}

export class TypeIndex {
  readonly all: BlockTypeDef[];
  private byName = new Map<string, BlockTypeDef[]>();

  constructor(types: BlockTypeDef[]) {
    this.all = types;
    for (const t of types) {
      const list = this.byName.get(t.type) ?? [];
      list.push(t);
      this.byName.set(t.type, list);
    }
    for (const list of this.byName.values()) list.sort((x, y) => compareSemver(y.version, x.version));
  }

  /** All versions of a type name (newest first), optionally within one library. */
  versions(type: string, lib?: string): BlockTypeDef[] {
    return (this.byName.get(type) ?? []).filter((t) => !lib || t.library === lib);
  }

  /** Newest version of every type, for palettes. */
  latest(): BlockTypeDef[] {
    const out: BlockTypeDef[] = [];
    const seen = new Set<string>();
    for (const t of this.all) {
      const key = `${t.library}/${t.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(this.versions(t.type, t.library)[0]);
    }
    return out.sort((a, b) => a.category.localeCompare(b.category) || a.type.localeCompare(b.type));
  }

  resolve(ref: string): TypeResolution {
    const r = parseTypeRef(ref);
    if (!r) return { error: { code: 'bad-type-ref', message: `Invalid type "${ref}" (expected TYPE, TYPE@1.0.0 or lib/TYPE)` } };
    const all = this.versions(r.type, r.lib);
    if (!all.length) {
      return { error: { code: 'unknown-type', message: `Unknown block type "${formatTypeRef({ lib: r.lib, type: r.type })}"` } };
    }
    if (!r.lib) {
      const libs = new Set(all.map((t) => t.library));
      if (libs.size > 1) {
        return {
          error: {
            code: 'ambiguous-type',
            message: `"${r.type}" exists in libraries ${[...libs].join(', ')} — write it as lib/${r.type}`,
          },
        };
      }
    }
    if (r.version) {
      const def = all.find((t) => t.version === r.version);
      return def
        ? { def }
        : { error: { code: 'unknown-version', message: `${r.type}@${r.version} not found (available: ${all.map((t) => t.version).join(', ')})` } };
    }
    return { def: all[0] };
  }
}

function parsePorts(v: unknown): PortDef[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((p): p is Record<string, unknown> => isObj(p) && typeof p.name === 'string')
    .map((p) => ({
      name: String(p.name),
      type: str(p.type) ?? 'ANY',
      description: str(p.description),
      default: p.default,
      unit: str(p.unit),
      values: Array.isArray(p.values) ? p.values.map(String) : undefined,
      visibility: p.visibility === 'connected' ? ('connected' as const) : undefined,
      ext: pickExt(p),
    }));
}

export interface LibraryLoad {
  libraries: LibraryDef[];
  index: TypeIndex;
  diags: Diag[];
}

/** Loads all `library/<lib>/` folders and resolves composite type internals. */
export function loadLibraries(files: Files): LibraryLoad {
  const diags: Diag[] = [];
  const libs = new Map<string, LibraryDef>();
  const types: BlockTypeDef[] = [];
  const raw = new Map<BlockTypeDef, Record<string, unknown>>();

  const libOf = (folder: string): LibraryDef => {
    let l = libs.get(folder);
    if (!l) {
      l = { folder, file: libraryFile(folder), name: folder, version: '0.0.0', types: [], ext: {} };
      libs.set(folder, l);
    }
    return l;
  };

  for (const [file, content] of Object.entries(files)) {
    if (typeof content !== 'string') continue;
    const role = classify(file);
    if (role.kind !== 'library' && role.kind !== 'blocktype') continue;
    const text = parseYaml(content);
    if (text.error) {
      diags.push({ severity: 'error', code: 'yaml-syntax', message: text.error.message, file, line: text.error.line });
      continue;
    }
    const mig = migrateParsed(text, role.kind, file);
    const p = mig.parsed;
    if (role.kind === 'library') {
      diags.push(...mig.diags, ...validateSchema('library', p, file));
      const d = isObj(p.data) ? p.data : {};
      const l = libOf(role.lib);
      l.uid = str(d.uid);
      l.name = str(d.name) ?? role.lib;
      l.version = str(d.version) ?? '0.0.0';
      l.description = str(d.description);
      l.ext = pickExt(d);
      continue;
    }
    diags.push(...mig.diags, ...validateSchema('blocktype', p, file));
    const d = isObj(p.data) ? p.data : {};
    const type = str(d.type);
    const version = str(d.version);
    if (!type || !version) continue;
    const expected = `${type}@${version}.yaml`;
    if (!file.endsWith('/' + expected)) {
      diags.push({ severity: 'warning', code: 'file-name-mismatch', message: `File should be named ${expected}`, file, line: lineAt(p, ['type']) });
    }
    const def: BlockTypeDef = {
      file,
      library: role.lib,
      uid: str(d.uid),
      type,
      version,
      category: str(d.category) ?? 'Other',
      description: str(d.description) ?? '',
      color: str(d.color),
      kind: d.kind === 'composite' || isObj(d.diagram) ? 'composite' : 'basic',
      inputs: parsePorts(d.inputs),
      outputs: parsePorts(d.outputs),
      params: parsePorts(d.params),
      implementation: isObj(d.implementation)
        ? { language: str(d.implementation.language), source: str(d.implementation.source) }
        : undefined,
      ext: pickExt(d),
    };
    const dup = types.find((t) => t.library === def.library && t.type === def.type && t.version === def.version);
    if (dup) {
      diags.push({ severity: 'error', code: 'duplicate-type', message: `${type}@${version} is also defined in ${dup.file}`, file });
      continue;
    }
    const names = new Set<string>();
    for (const port of [...def.inputs, ...def.outputs, ...def.params]) {
      if (names.has(port.name)) {
        diags.push({ severity: 'error', code: 'duplicate-port', message: `${type}: "${port.name}" is defined more than once`, file });
      }
      names.add(port.name);
    }
    types.push(def);
    libOf(role.lib).types.push(def);
    raw.set(def, d);
  }

  const index = new TypeIndex(types);

  // Second pass: composite internals can reference any type in the project.
  for (const def of types) {
    const d = raw.get(def)!;
    if (def.kind !== 'composite' || !isObj(d.diagram)) continue;
    const p = migrateParsed(parseYaml(files[def.file] as string), 'blocktype', def.file).parsed;
    const res = parseDiagram(d.diagram, (ref) => index.resolve(ref), { file: def.file, parsed: p, base: ['diagram'] });
    def.diagram = res.diagram;
    diags.push(...res.diags);
  }

  // Composite recursion check.
  const visiting = new Set<BlockTypeDef>();
  const done = new Set<BlockTypeDef>();
  const visit = (t: BlockTypeDef, chain: string[]): void => {
    if (done.has(t)) return;
    if (visiting.has(t)) {
      diags.push({
        severity: 'error',
        code: 'recursive-composite',
        message: `Composite block contains itself: ${[...chain, `${t.type}@${t.version}`].join(' → ')}`,
        file: t.file,
      });
      return;
    }
    visiting.add(t);
    for (const b of t.diagram?.blocks ?? []) if (b.def?.kind === 'composite') visit(b.def, [...chain, `${t.type}@${t.version}`]);
    visiting.delete(t);
    done.add(t);
  };
  types.forEach((t) => visit(t, []));

  return { libraries: [...libs.values()].sort((a, b) => a.folder.localeCompare(b.folder)), index, diags };
}
