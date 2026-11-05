// Wording helpers shared by all panels: plurals and problem summaries, so
// "1 note", "2 notes" and "✓ no errors or warnings · 3 info" read the same everywhere.
import type { Diag } from '@csd/core';

const IRREGULAR: Record<string, string> = {
  strategy: 'strategies',
  library: 'libraries',
  info: 'info',
  change: 'changes',
  branch: 'branches',
};

/** "1 note", "3 notes", "0 strategies". `many` overrides the plural form. */
export function plural(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : (many ?? IRREGULAR[one] ?? `${one}s`)}`;
}

/** Plural form of a noun without the count. */
export function nounFor(n: number, one: string, many?: string): string {
  return n === 1 ? one : (many ?? IRREGULAR[one] ?? `${one}s`);
}

export interface DiagCounts {
  errors: number;
  warnings: number;
  infos: number;
}

export function countDiags(diags: readonly Diag[]): DiagCounts {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const d of diags) {
    if (d.severity === 'error') errors++;
    else if (d.severity === 'warning') warnings++;
    else infos++;
  }
  return { errors, warnings, infos };
}

/** Problems are errors and warnings; info is listed but never counted as a problem. */
export function problemCount(c: DiagCounts): number {
  return c.errors + c.warnings;
}

/**
 * One line: "2 errors · 1 warning · 3 info", or "✓ no errors or warnings · 3 info",
 * or "✓ no errors or warnings".
 */
export function problemSummary(c: DiagCounts, opts: { check?: boolean } = {}): string {
  const parts: string[] = [];
  if (c.errors) parts.push(plural(c.errors, 'error'));
  if (c.warnings) parts.push(plural(c.warnings, 'warning'));
  if (!parts.length) parts.push(`${opts.check === false ? '' : '✓ '}no errors or warnings`);
  if (c.infos) parts.push(`${c.infos} info`);
  return parts.join(' · ');
}

/** Tooltip of an error / warning badge pair. */
export function badgeTitle(c: DiagCounts): string {
  return [c.errors && plural(c.errors, 'error'), c.warnings && plural(c.warnings, 'warning'), c.infos && `${c.infos} info`].filter(Boolean).join(', ');
}
