// Signal data types, value checks and durations.
import type { PortDef } from './types';

export const SIGNAL_TYPES = ['BOOL', 'INT', 'DINT', 'REAL', 'TIME', 'STRING', 'ANY', 'ANY_NUM'] as const;
const NUMERIC = new Set(['INT', 'DINT', 'REAL', 'ANY_NUM']);

export function isNumericType(t: string): boolean {
  return NUMERIC.has(t);
}

export type Compat = 'ok' | 'mismatch';

/** Can a signal of type `src` drive an input of type `dst`? */
export function compatible(src: string, dst: string): Compat {
  if (src === dst || src === 'ANY' || dst === 'ANY') return 'ok';
  if (dst === 'ANY_NUM' && isNumericType(src)) return 'ok';
  if (src === 'ANY_NUM' && isNumericType(dst)) return 'ok';
  if ((src === 'INT' || src === 'DINT') && (dst === 'REAL' || dst === 'DINT')) return 'ok';
  return 'mismatch';
}

export type WireKind = 'bool' | 'real' | 'other';

export function wireKind(type: string | undefined): WireKind {
  if (type === 'BOOL') return 'bool';
  if (type && isNumericType(type)) return 'real';
  return 'other';
}

const DURATION = /^(?:T#)?(\d+(?:\.\d+)?)(ms|s|min|m|h)$/i;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, min: 60000, m: 60000, h: 3600000 };

/** Parses `500ms`, `1s`, `2min`, `1h`, `T#5s` to milliseconds. */
export function parseDuration(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const m = DURATION.exec(v.trim());
  return m ? Number(m[1]) * UNIT_MS[m[2].toLowerCase()] : undefined;
}

/** Returns an error message when `value` does not fit the port/param definition. */
export function checkValue(def: PortDef, value: unknown): string | undefined {
  if (typeof value === 'string' && value.startsWith('$')) return undefined; // composite param reference
  switch (def.type) {
    case 'BOOL':
      return typeof value === 'boolean' ? undefined : 'expected true or false';
    case 'INT':
    case 'DINT':
      return Number.isInteger(value) ? undefined : 'expected an integer';
    case 'REAL':
    case 'ANY_NUM':
      return typeof value === 'number' ? undefined : 'expected a number';
    case 'TIME':
      return parseDuration(value) !== undefined ? undefined : 'expected a duration such as 500ms, 5s, 2min';
    case 'ENUM':
      return def.values?.includes(String(value)) ? undefined : `expected one of ${(def.values ?? []).join(', ')}`;
    case 'STRING':
      return value === null || typeof value === 'object' ? 'expected text' : undefined;
    default:
      return undefined;
  }
}

/** Formats a value the way it should appear on a diagram. */
export function formatValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
