// File format versions and migrations.
//
// Every YAML file carries `format: csd-<kind>/<version>`. When the format
// changes, add a Migration here; old projects are upgraded on load and never
// become unreadable. Files without `format` are treated as the current version.
import type { Document } from 'yaml';
import type { Diag } from './types';
import type { ParsedYaml } from './yamlutil';

export type DocKind = 'project' | 'library' | 'blocktype' | 'strategy' | 'sequence';

export const CURRENT_FORMAT: Record<DocKind, number> = {
  project: 1,
  library: 1,
  blocktype: 1,
  strategy: 1,
  sequence: 1,
};

export function formatTag(kind: DocKind): string {
  return `csd-${kind}/${CURRENT_FORMAT[kind]}`;
}

export function parseFormat(v: unknown): { kind: string; version: number } | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^csd-([a-z]+)\/(\d+)$/.exec(v.trim());
  return m ? { kind: m[1], version: Number(m[2]) } : undefined;
}

export interface Migration {
  kind: DocKind;
  /** Upgrades a document from `from` to `from + 1`, mutating it in place. */
  from: number;
  description: string;
  migrate(doc: Document): void;
}

/** Registered migrations. Empty while all formats are at version 1. */
export const MIGRATIONS: Migration[] = [];

export interface MigrationResult {
  /** True when the document was changed and should be written back. */
  migrated: boolean;
  diags: Diag[];
}

/** Format version written in `doc` when a migration to the current version is pending. */
function pendingFrom(doc: Document, kind: DocKind): number | undefined {
  const f = parseFormat(doc.get('format'));
  return f && f.kind === kind && f.version < CURRENT_FORMAT[kind] ? f.version : undefined;
}

const migratedCache = new WeakMap<ParsedYaml, Map<string, { parsed: ParsedYaml; result: MigrationResult }>>();

/**
 * Loads a parsed file in the current format: checks `format` and, when the file
 * is older, applies the migrations to a *copy* of the (cached, read-only)
 * document and derives `data` from the migrated copy. The model always sees the
 * current format; line numbers stay those of the file as written.
 */
export function migrateParsed(p: ParsedYaml, kind: DocKind, file: string): { parsed: ParsedYaml; diags: Diag[]; migrated: boolean } {
  if (p.error) return { parsed: p, diags: [], migrated: false };
  if (pendingFrom(p.doc, kind) === undefined) return { parsed: p, diags: migrateDocument(p.doc, kind, file).diags, migrated: false };
  const key = `${kind}/${CURRENT_FORMAT[kind]}/${MIGRATIONS.length}/${file}`;
  let byKey = migratedCache.get(p);
  const hit = byKey?.get(key);
  if (hit) return { parsed: hit.parsed, diags: hit.result.diags, migrated: hit.result.migrated };
  const doc = p.doc.clone();
  const result = migrateDocument(doc, kind, file);
  const parsed: ParsedYaml = { doc, data: doc.toJS({ maxAliasCount: 100 }), lc: p.lc };
  if (!byKey) migratedCache.set(p, (byKey = new Map()));
  byKey.set(key, { parsed, result });
  return { parsed, diags: result.diags, migrated: result.migrated };
}

/** Checks the `format` key and applies pending migrations to `doc` (mutates it). */
export function migrateDocument(doc: Document, kind: DocKind, file: string): MigrationResult {
  const diags: Diag[] = [];
  const raw = doc.get('format');
  if (raw === undefined || raw === null) return { migrated: false, diags };
  const f = parseFormat(raw);
  if (!f) {
    diags.push({ severity: 'warning', code: 'bad-format', message: `Unrecognised format "${String(raw)}"`, file });
    return { migrated: false, diags };
  }
  if (f.kind !== kind) {
    diags.push({ severity: 'error', code: 'wrong-format-kind', message: `File is "${f.kind}", expected "${kind}"`, file });
    return { migrated: false, diags };
  }
  const target = CURRENT_FORMAT[kind];
  if (f.version > target) {
    diags.push({
      severity: 'error',
      code: 'format-too-new',
      message: `Format ${raw} is newer than this application supports (${formatTag(kind)}). Update Control Strategy Studio.`,
      file,
    });
    return { migrated: false, diags };
  }
  let v = f.version;
  let migrated = false;
  while (v < target) {
    const m = MIGRATIONS.find((x) => x.kind === kind && x.from === v);
    if (!m) {
      diags.push({ severity: 'error', code: 'no-migration', message: `No migration from csd-${kind}/${v}`, file });
      return { migrated, diags };
    }
    m.migrate(doc);
    v++;
    migrated = true;
  }
  if (migrated) doc.set('format', formatTag(kind));
  return { migrated, diags };
}
