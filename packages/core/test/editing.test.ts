import { describe, expect, it } from 'vitest';
import { applyOp, demoProjectFiles, extractFragment, layoutDiagram, loadProject, parseFragment, renameMap, type Files } from '../src';

const U100 = 'strategies/ACME/Brno/WaterTreatment/U100';
const FIC = `${U100}/FIC101.yaml`;
const AI2 = 'library/acme/AI_2OO3@1.0.0.yaml';
const LAG = 'library/std/LAG@1.0.0.yaml';
const demo = demoProjectFiles();
const run = (f: Files, op: Parameters<typeof applyOp>[1]) => applyOp(f, op).files;

describe('clipboard fragments', () => {
  it('renames tags by incrementing their number', () => {
    expect(renameMap(['FT101', 'FT102', 'PUMP'], ['FT101', 'PUMP', 'NEW'])).toEqual({ FT101: 'FT103', PUMP: 'PUMP_2', NEW: 'NEW' });
  });
  it('copies blocks with internal links and pastes them under new names', () => {
    const text = demo[FIC] as string;
    const frag = extractFragment(text, [], ['FT101', 'FIC101'], { positions: { FT101: [40, 40], FIC101: [300, 40] } });
    expect(frag).toContain('csd-fragment: 1');
    expect(frag).toContain('FT101.PV -> FIC101.PV');
    expect(frag).not.toContain('FV101');
    expect(frag).not.toContain('LIC100:');
    expect(parseFragment(frag)!.blocks.FIC101.params).toMatchObject({ GAIN: 0.8 });

    const f = run(demo, { op: 'insertFragment', file: FIC, fragment: frag, offset: [20, 20], sheet: 1 });
    const s = loadProject(f).strategyByName.get('FIC101')!;
    expect(s.blocks.map((b) => b.id)).toEqual(['FT101', 'FIC101', 'FV101', 'FT102', 'FIC102']);
    expect(s.blocks.find((b) => b.id === 'FIC102')).toMatchObject({ pos: [320, 60], comment: 'Tuning from loop test during FAT.' });
    expect(s.links.some((l) => l.from.block === 'FT102' && l.to.block === 'FIC102')).toBe(true);
    expect(f[FIC]).toContain('params: { GAIN: 0.8');
  });
  it('rejects text that is not a fragment', () => {
    expect(() => applyOp(demo, { op: 'insertFragment', file: FIC, fragment: 'hello' })).toThrow(/clipboard/);
  });
  it('removes several blocks and their links at once', () => {
    const f = run(demo, { op: 'removeBlocks', file: FIC, ids: ['FT101', 'FV101'] });
    const s = loadProject(f).strategyByName.get('FIC101')!;
    expect(s.blocks.map((b) => b.id)).toEqual(['FIC101']);
    expect(s.links).toHaveLength(1); // only the cascade link remains
  });
});

describe('block type editing', () => {
  it('adds, updates, moves and removes ports', () => {
    let f = run(demo, { op: 'addPort', file: LAG, list: 'inputs', port: { name: 'TRK', type: 'BOOL', description: 'Track' } });
    expect(f[LAG]).toContain('- { name: TRK, type: BOOL, description: Track }');
    f = run(f, { op: 'updatePort', file: LAG, list: 'params', name: 'T', patch: { default: '5s', unit: 's' } });
    expect(f[LAG]).toMatch(/name: T, type: TIME, unit: s, description: Time constant, default: 5s/);
    f = run(f, { op: 'movePort', file: LAG, list: 'inputs', name: 'TRK', to: 0 });
    const t = loadProject(f).types.resolve('LAG').def!;
    expect(t.inputs.map((p) => p.name)).toEqual(['TRK', 'IN']);
    expect(() => applyOp(f, { op: 'addPort', file: LAG, list: 'outputs', port: { name: 'IN', type: 'REAL' } })).toThrow(/already exists/);
    f = run(f, { op: 'removePort', file: LAG, list: 'inputs', name: 'TRK' });
    expect(loadProject(f).diags).toEqual([]);
  });
  it('renames composite interface ports including internal links and $refs', () => {
    let f = run(demo, { op: 'updatePort', file: AI2, list: 'outputs', name: 'PV', patch: { name: 'MEAS' } });
    expect(f[AI2]).toContain('MED.OUT -> out.MEAS');
    f = run(f, { op: 'updatePort', file: AI2, list: 'params', name: 'DEV_LIM', patch: { name: 'SPREAD' } });
    expect(f[AI2]).toContain('IN2: $SPREAD');
    const p = loadProject(f);
    expect(p.diagsByFile.get(AI2)).toBeUndefined();
    // the strategy using the old output name now reports it
    expect(p.diags.some((d) => d.code === 'unknown-port' && d.file?.endsWith('LIC100.yaml'))).toBe(true);
  });
  it('edits header fields and implementation', () => {
    let f = run(demo, { op: 'setTypeField', file: LAG, field: 'description', value: 'Filter' });
    f = run(f, { op: 'setImplementation', file: LAG, language: 'ST', source: 'OUT := IN;' });
    expect(f[LAG]).toContain('description: Filter');
    expect(f[LAG]).toContain('implementation:\n  language: ST\n  source: |\n    OUT := IN;');
    f = run(f, { op: 'setImplementation', file: LAG });
    expect(f[LAG]).not.toContain('implementation');
    f = run(f, { op: 'setTypeField', file: LAG, field: 'kind', value: 'composite' });
    expect(loadProject(f).types.resolve('LAG').def!.kind).toBe('composite');
  });
  it('renames a block type and its usages', () => {
    const f = run(demo, { op: 'renameBlockType', file: 'library/std/PID@1.0.0.yaml', type: 'PIDC' });
    expect(f['library/std/PIDC@1.0.0.yaml']).toContain('type: PIDC');
    expect(f['library/std/PID@1.0.0.yaml']).toBeUndefined();
    expect(f[FIC]).toContain('type: PIDC@1.0.0');
    expect(loadProject(f).diags).toEqual([]);
  });
});

describe('composite interface layout', () => {
  it('draws in/out bars wired like blocks', () => {
    const t = loadProject(demo).types.resolve('acme/AI_2OO3').def!;
    const [sheet] = layoutDiagram(t.diagram!, { composite: t });
    const out = sheet.blocks.find((b) => b.iface === 'out')!;
    expect(out.ports.map((p) => p.name)).toEqual(['PV', 'DEV_ALM']);
    expect(sheet.blocks.some((b) => b.iface === 'in')).toBe(false); // AI_2OO3 has no inputs
    expect(sheet.wires.filter((w) => w.link !== undefined)).toHaveLength(14);
    expect(sheet.connectors).toHaveLength(0);
    expect(out.x).toBeGreaterThan(Math.max(...sheet.blocks.filter((b) => !b.iface).map((b) => b.x)));
  });
});
