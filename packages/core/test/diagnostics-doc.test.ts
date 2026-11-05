import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every diagnostic code the core can report must be listed in docs/diagnostics.md.
const SRC = join(__dirname, '../src');
const DOC = readFileSync(join(__dirname, '../../../docs/diagnostics.md'), 'utf8');
const CODE = "'([a-z]+(?:-[a-z]+)*)'";
const CONTEXTS = [
  new RegExp(`code:\\s*${CODE}`, 'g'),
  new RegExp(`push\\('(?:error|warning|info)',\\s*${CODE}`, 'g'),
  new RegExp(`(?:report|bad)\\(\\s*${CODE}`, 'g'),
  new RegExp(`\\?\\s*${CODE}\\s*:\\s*${CODE}`, 'g'),
];

function sourceCodes(): Set<string> {
  const out = new Set<string>();
  for (const f of readdirSync(SRC).filter((x) => x.endsWith('.ts'))) {
    const text = readFileSync(join(SRC, f), 'utf8')
      .split('\n')
      .filter((l) => /code|push\(|report\(|bad\(/.test(l))
      .join('\n');
    for (const rx of CONTEXTS) for (const m of text.matchAll(rx)) for (const c of m.slice(1)) if (c) out.add(c);
  }
  for (const c of ['error', 'warning', 'info', 'type']) out.delete(c);
  return out;
}

describe('docs/diagnostics.md', () => {
  it('lists every diagnostic code', () => {
    expect(sourceCodes().size).toBeGreaterThan(55);
    const documented = new Set([...DOC.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]));
    const missing = [...sourceCodes()].filter((c) => !documented.has(c) && !/^(invalid|not-found|exists|syntax|not-empty|wrong-file|reserved|invalid-name)$/.test(c));
    expect(missing).toEqual([]);
  });
});
