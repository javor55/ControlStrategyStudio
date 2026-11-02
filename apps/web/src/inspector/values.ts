// Value parsing / formatting helpers of the property panel.
import { formatTypeRef, parseTypeRef, type BlockTypeDef, type PortDef, type TypeIndex } from '@csd/core';

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * Turns the text typed into a parameter field into a YAML value:
 * empty → undefined (remove), true/false → boolean, numeric → number,
 * anything else → string (`$NAME` references stay strings).
 * STRING parameters always stay strings.
 */
export function parseParamText(text: string, def?: PortDef): unknown {
  const t = text.trim();
  if (!t) return undefined;
  if (t.startsWith('$')) return t;
  if (def?.type === 'STRING') return t;
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
  if (NUMBER_RE.test(t)) return Number(t);
  return t;
}

/** Text shown in an editable field for a stored value. */
export function valueText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return valueText(a) === valueText(b);
}

/** Reference to write for a type: bare `TYPE`, or `lib/TYPE` when the name exists in several libraries. */
export function typeRefFor(types: TypeIndex, def: Pick<BlockTypeDef, 'type' | 'library'>, version?: string): string {
  const libs = new Set(types.versions(def.type).map((t) => t.library));
  return formatTypeRef({ lib: libs.size > 1 ? def.library : undefined, type: def.type, version });
}

/** Library of a reference, using the resolved definition when the ref is unqualified. */
export function refParts(ref: string, def?: BlockTypeDef): { lib?: string; type: string; version?: string } {
  const r = parseTypeRef(ref);
  return { lib: r?.lib ?? def?.library, type: r?.type ?? def?.type ?? ref, version: r?.version };
}
