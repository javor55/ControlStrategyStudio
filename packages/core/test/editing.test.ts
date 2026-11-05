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
    expect(loadProject(f).diags.filter((d) => d.severity !== 'info')).toEqual([]);
  });
  it('renames composite interface ports including internal links and $refs', () => {
    let f = run(demo, { op: 'updatePort', file: AI2, list: 'outputs', name: 'PV', patch: { name: 'MEAS' } });
    expect(f[AI2]).toContain('MED.OUT -> out.MEAS');
    f = run(f, { op: 'updatePort', file: AI2, list: 'params', name: 'DEV_LIM', patch: { name: 'SPREAD' } });
    expect(f[AI2]).toContain('IN2: $SPREAD');
    const p = loadProject(f);
    expect(p.diagsByFile.get(AI2)).toBeUndefined();
    // strategies using the type follow the rename
    expect(p.diags.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(f[`${U100}/LIC100.yaml`]).toContain('LT100.MEAS -> LIC100.PV');
  });
  it('propagates port renames to strategies and cross references', () => {
    let f = run(demo, { op: 'updatePort', file: 'library/std/PID@1.0.0.yaml', list: 'params', name: 'GAIN', patch: { name: 'KP' } });
    expect(f[FIC]).toContain('params: { KP: 0.8');
    f = run(f, { op: 'updatePort', file: 'library/std/PID@1.0.0.yaml', list: 'outputs', name: 'MV', patch: { name: 'OUT' } });
    expect(f[FIC]).toContain('FIC101.OUT -> FV101.IN');
    expect(f[FIC]).toContain('from: LIC100:LIC100.OUT');
    f = run(f, { op: 'updatePort', file: 'library/std/PID@1.0.0.yaml', list: 'inputs', name: 'SP_EXT', patch: { name: 'RSP' } });
    expect(f[FIC]).toContain('to: FIC101.RSP');
    expect(loadProject(f).diags.filter((d) => d.severity !== 'info')).toEqual([]);
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
    expect(loadProject(f).diags.filter((d) => d.severity !== 'info')).toEqual([]);
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

describe('display options', () => {
  it('hides unused ports, params and comments', () => {
    const s = loadProject(demo).strategyByName.get('FIC101')!;
    const [full] = layoutDiagram(s, { display: { ports: 'all' } });
    const [auto] = layoutDiagram(s);
    const [compact] = layoutDiagram(s, { display: { unusedPorts: false, params: false, comments: false } });
    const pid = (l: typeof full) => l.blocks.find((b) => b.id === 'FIC101')!;
    expect(pid(full).ports.length).toBe(13);
    // auto: pins marked `visibility: connected` (MAN_ON, TRK_ON, FF …) are hidden until used
    expect(pid(auto).ports.map((p) => p.name)).toEqual(['PV', 'SP_EXT', 'SP_EXT_ON', 'TRK_VAL', 'MV']);
    expect(pid(compact).ports.map((p) => p.name)).toEqual(['PV', 'SP_EXT', 'SP_EXT_ON', 'TRK_VAL', 'MV']);
    expect(pid(compact).params).toEqual([]);
    expect(pid(compact).comment).toEqual([]);
    expect(pid(compact).h).toBeLessThan(pid(full).h / 2);
  });
});

describe('canvas engineering features', () => {
  const P101 = `${U100}/P101.yaml`;
  it('marks previous-cycle links (z⁻¹) and lays them out as feedback', () => {
    // HEALTHY (#30) feeds P101 (#50) normally; make the motor run first → feedback
    const f = run(demo, { op: 'setOrders', file: P101, orders: { P101: 5 } });
    const s = loadProject(f).strategyByName.get('P101')!;
    const [sheet1] = layoutDiagram(s);
    const fb = sheet1.wires.find((w) => w.feedback);
    expect(fb?.feedback).toMatchObject({ sourceOrder: 40, targetOrder: 5 }); // P101_FB.OUT -> P101.FB_RUN
  });
  it('draws junction dots where one signal branches', () => {
    const t = loadProject(demo).types.resolve('acme/AI_2OO3').def!;
    const [sheet] = layoutDiagram(t.diagram!, { composite: t });
    // TT_A.PV, TT_B.PV and TT_C.PV each fan out to MED, HI and LO
    expect(sheet.junctions.length).toBeGreaterThanOrEqual(3);
  });
  it('keeps segments of different signals apart', () => {
    const t = loadProject(demo).types.resolve('acme/AI_2OO3').def!;
    const [sheet] = layoutDiagram(t.diagram!, { composite: t });
    const segs = sheet.wires.flatMap((w) =>
      w.points.slice(0, -1).map((p, i) => ({ src: w.source, p, q: w.points[i + 1] })),
    );
    for (const a of segs)
      for (const b of segs) {
        if (a.src === b.src) continue;
        const vert = (s: typeof a) => s.p[0] === s.q[0];
        if (vert(a) !== vert(b)) continue;
        const k = vert(a) ? 0 : 1;
        const o = 1 - k;
        if (a.p[k] !== b.p[k]) continue;
        const overlap = Math.min(Math.max(a.p[o], a.q[o]), Math.max(b.p[o], b.q[o])) - Math.max(Math.min(a.p[o], a.q[o]), Math.min(b.p[o], b.q[o]));
        expect(overlap, `${a.src} / ${b.src}`).toBeLessThanOrEqual(2);
      }
  });
  it('edits link label and category and defines categories', () => {
    let f = run(demo, { op: 'setSignalCategory', name: 'alarm', category: { color: '#a35a00', style: 'dashed' } });
    expect(f['project.yaml']).toContain('  alarm: { color: "#a35a00", style: dashed }');
    f = run(f, { op: 'setLinkField', file: P101, index: 3, field: 'label', value: undefined });
    f = run(f, { op: 'setLinkField', file: P101, index: 3, field: 'category', value: undefined });
    expect(f[P101]).toContain('  - HEALTHY.OUT -> P101.INTLK');
    f = run(f, { op: 'setLinkField', file: P101, index: 3, field: 'category', value: 'interlock' });
    f = run(f, { op: 'setLinkField', file: P101, index: 3, field: 'label', value: 'P101_ILK' });
    expect(f[P101]).toContain('  - from: HEALTHY.OUT\n    to: P101.INTLK\n    label: P101_ILK\n    category: interlock');
    const p = loadProject(f);
    expect(p.diags.filter((d) => d.severity !== 'info')).toEqual([]);
    const w = layoutDiagram(p.strategyByName.get('P101')!)[0].wires.find((x) => x.link === 3)!;
    expect(w.category).toBe('interlock');
    expect(w.label?.name).toBe('P101_ILK');
    f = run(f, { op: 'setSignalCategory', name: 'interlock' });
    expect(loadProject(f).diags.filter((d) => d.severity !== 'info').map((d) => d.code)).toEqual(['unknown-category']);
  });
  it('marks the demo readback tracking as previous-cycle value', () => {
    const s = loadProject(demo).strategyByName.get('FIC101')!;
    const w = layoutDiagram(s)[0].wires.find((x) => x.feedback)!;
    expect(w.feedback).toMatchObject({ sourceOrder: 30, targetOrder: 20 });
    expect(w.category).toBe('tracking');
  });
  it('renames hierarchy folders', () => {
    const r = applyOp(demo, { op: 'renameFolder', from: 'ACME/Brno/WaterTreatment', to: 'ACME/Brno/RawWater' });
    expect(Object.keys(r.files).filter((k) => k.includes('/RawWater/')).length).toBe(8);
    expect(Object.keys(r.files).some((k) => k.includes('/WaterTreatment/'))).toBe(false);
    expect(loadProject(r.files).diags.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(() => applyOp(demo, { op: 'renameFolder', from: 'ACME', to: 'ACME/X' })).toThrow(/itself/);
  });
});

describe('drawing style and block display', () => {
  it('stores the project drawing style', () => {
    let f = run(demo, { op: 'setDrawing', path: ['signals', 'bool', 'color'], value: '#00aa00' });
    f = run(f, { op: 'setDrawing', path: ['signals', 'bool', 'style'], value: 'dashed' });
    f = run(f, { op: 'setDrawing', path: ['feedback', 'mark'], value: false });
    f = run(f, { op: 'setDrawing', path: ['params'], value: 'hide' });
    expect(f['project.yaml']).toContain('drawing:\n  signals:\n    bool: { color: "#00aa00", style: dashed }');
    const m = loadProject(f).meta.drawing;
    expect(m).toMatchObject({ signals: { bool: { color: '#00aa00', style: 'dashed' } }, feedback: { mark: false, style: 'dashdot' }, params: 'hide' });
    expect(loadProject(f).diags.filter((d) => d.severity !== 'info')).toEqual([]);
    f = run(f, { op: 'setDrawing', path: ['signals', 'bool', 'color'] });
    f = run(f, { op: 'setDrawing', path: ['signals', 'bool', 'style'] });
    expect(f['project.yaml']).not.toContain('bool:');
    expect(() => applyOp(f, { op: 'setDrawing', path: ['nope'], value: 1 })).toThrow(/does not exist/);
  });
  it('collapses parameters per block with a footer to expand them', () => {
    const f = run(demo, { op: 'setBlockDisplay', file: FIC, id: 'FIC101', params: false });
    expect(f[FIC]).toContain('display: { params: false }');
    const s = loadProject(f).strategyByName.get('FIC101')!;
    const pid = layoutDiagram(s)[0].blocks.find((b) => b.id === 'FIC101')!;
    expect(pid.params).toEqual([]);
    expect(pid.paramsToggle).toEqual(expect.objectContaining({ expanded: false, count: 5 }));
    const ft = layoutDiagram(s)[0].blocks.find((b) => b.id === 'FT101')!;
    expect(ft.paramsToggle?.expanded).toBe(true);
    // project default "hide" collapses blocks without their own setting
    const hidden = layoutDiagram(s, { paramsDefault: false })[0].blocks.find((b) => b.id === 'FT101')!;
    expect(hidden.paramsToggle?.expanded).toBe(false);
    const all = layoutDiagram(s, { display: { paramsMode: 'all' } })[0].blocks.find((b) => b.id === 'FIC101')!;
    expect(all.params.length).toBe(5);
    expect(all.paramsToggle).toBeUndefined();
  });
});
