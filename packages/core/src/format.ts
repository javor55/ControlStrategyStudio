// File format versions and migrations.
//
// Every YAML file carries `format: csd-<kind>/<version>`. When the format
// changes, add a Migration here; old projects are upgraded on load and never
// become unreadable. Files without `format` are treated as the current version.
import type { Document } from 'yaml';
import type { Diag } from './types';

export type DocKind = 'project' | 'library' | 'blocktype' | 'strategy';

export const CURRENT_FORMAT: Record<DocKind, number> = {
  project: 1,
  library: 1,
  blocktype: 1,
  strategy: 1,
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

/** Checks the `format` key and applies pending migrations to `doc`. */
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
      message: `Format ${raw} is newer than this application supports (${formatTag(kind)}). Update CSD Studio.`,
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
