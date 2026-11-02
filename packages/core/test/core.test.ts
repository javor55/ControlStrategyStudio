import { describe, expect, it } from 'vitest';
import {
  applyOp,
  autoOrder,
  demoProjectFiles,
  inverseOf,
  layoutDiagram,
  loadProject,
  OpError,
  suggestBlockId,
  type Diag,
  type Files,
  type Op,
} from '../src';

const U100 = 'strategies/ACME/Brno/WaterTreatment/U100';
const FIC = `${U100}/FIC101.yaml`;
const LIC = `${U100}/LIC100.yaml`;
const P101 = `${U100}/P101.yaml`;

const demo = demoProjectFiles();
const codes = (diags: Diag[]) => diags.map((d) => d.code);
const run = (files: Files, op: Op) => applyOp(files, op).files;
const withStrategy = (body: string, extra: Files = {}): Files => ({ ...demo, [`strategies/T/TEST.yaml`]: `strategy: TEST\n${body}`, ...extra });
const diagsOf = (files: Files, file = 'strategies/T/TEST.yaml') => loadProject(files).diagsByFile.get(file) ?? [];

describe('demo project', () => {
  const p = loadProject(demo);
  it('loads without diagnostics', () => {
    expect(p.diags).toEqual([]);
    expect(p.strategies.map((s) => s.name)).toEqual(['FIC101', 'LIC100', 'P101']);
    expect(p.meta.name).toBe('Water Treatment Brno');
  });
  it('builds the hierarchy with level names', () => {
    const acme = p.root.folders[0];
    expect(acme.level).toBe('Enterprise');
    const u100 = acme.folders[0].folders[0].folders[0];
    expect(u100.name).toBe('U100');
    expect(u100.level).toBe('Unit');
    expect(u100.readme).toBe(`${U100}/README.md`);
    expect(u100.strategies).toHaveLength(3);
  });
  it('resolves libraries, composite blocks and docs', () => {
    expect(p.libraries.map((l) => l.folder)).toEqual(['acme', 'std']);
    const lt = p.strategyByName.get('LIC100')!.blocks.find((b) => b.id === 'LT100')!;
    expect(lt.def?.kind).toBe('composite');
    expect(lt.def?.diagram?.blocks).toHaveLength(8);
    expect(p.strategyByName.get('FIC101')!.docFile).toBe(`${U100}/FIC101.md`);
  });
  it('finds cross references', () => {
    expect(p.usedBy('LIC100').map((r) => r.strategy.name).sort()).toEqual(['FIC101', 'P101']);
    expect(p.usedBy('LIC100', 'LIC100')).toHaveLength(1);
  });
});

describe('validation', () => {
  it('reports YAML syntax errors with a line', () => {
    const d = diagsOf(withStrategy('blocks:\n  A: [unclosed\n'));
    expect(d[0].code).toBe('yaml-syntax');
    expect(d[0].line).toBeGreaterThan(0);
  });
  it('reports unknown types, ports and directions', () => {
    const d = diagsOf(
      withStrategy(`blocks:
  A: { type: AI }
  B: { type: PIDX }
  C: { type: PID }
links:
  - A.OUT -> C.PV
  - C.PV -> A.SIM_PV
  - A.PV -> C.MV
`),
    );
    expect(codes(d)).toEqual(expect.arrayContaining(['unknown-type', 'unknown-port', 'wrong-direction']));
  });
  it('reports multiple drivers, type mismatch and linked constants', () => {
    const d = diagsOf(
      withStrategy(`blocks:
  A: { type: AI }
  B: { type: AI }
  C: { type: PID, params: { PV: 3, MAN_ON: 1 } }
links:
  - A.PV -> C.PV
  - B.PV -> C.PV
  - A.PV -> C.MAN_ON
`),
    );
    expect(codes(d)).toEqual(expect.arrayContaining(['multiple-drivers', 'type-mismatch', 'linked-and-constant']));
  });
  it('checks parameter values and names', () => {
    const d = diagsOf(withStrategy(`blocks:\n  C: { type: PID, params: { DIRECTION: UP, TI: 12, FOO: 1 } }\n`));
    expect(codes(d).filter((c) => c === 'bad-value')).toHaveLength(2);
    expect(codes(d)).toContain('unknown-param');
  });
  it('checks cross-strategy references', () => {
    const d = diagsOf(
      withStrategy(`blocks:\n  C: { type: PID }\nlinks:\n  - NOPE:X.MV -> C.SP_EXT\n  - LIC100:LIC100.NOPE -> C.PV\n  - C.MV -> LIC100:LIC100.PV\n`),
    );
    expect(codes(d)).toEqual(expect.arrayContaining(['unknown-strategy', 'unknown-port', 'ext-target']));
  });
  it('warns about order problems and unknown keys, with line numbers', () => {
    const d = diagsOf(withStrategy(`blocks:\n  A: { type: AI, order: 10 }\n  B: { type: AI, order: 10 }\n  C: { type: AI }\ncolour: red\n`));
    expect(codes(d)).toEqual(expect.arrayContaining(['duplicate-order', 'missing-order', 'unknown-key']));
    expect(d.find((x) => x.code === 'unknown-key')!.line).toBe(6);
  });
  it('accepts x- extension data', () => {
    const files = withStrategy(`x-pcs7: { chart: TEST }\nblocks:\n  A: { type: AI, x-tag: 4711 }\n`);
    expect(diagsOf(files)).toEqual([]);
    const s = loadProject(files).strategyByName.get('TEST')!;
    expect(s.ext).toEqual({ 'x-pcs7': { chart: 'TEST' } });
    expect(s.blocks[0].ext).toEqual({ 'x-tag': 4711 });
  });
  it('rejects formats newer than supported', () => {
    expect(codes(diagsOf(withStrategy('format: csd-strategy/99\n').valueOf() as Files))).toContain('format-too-new');
  });
});

describe('library', () => {
  it('resolves versions and reports ambiguity', () => {
    const files: Files = {
      ...demo,
      'library/acme/PID@1.0.0.yaml': 'type: PID\nversion: 1.0.0\ninputs: []\noutputs: []\n',
    };
    const p = loadProject(files);
    expect(p.types.resolve('PID').error?.code).toBe('ambiguous-type');
    expect(p.types.resolve('std/PID').def?.library).toBe('std');
    expect(p.types.resolve('PID@2.0.0').error?.code).toBe('ambiguous-type');
    expect(p.types.resolve('std/PID@2.0.0').error?.code).toBe('unknown-version');
  });
  it('picks the newest version unless pinned', () => {
    const r = applyOp(demo, { op: 'newTypeVersion', file: 'library/std/PID@1.0.0.yaml' });
    const p = loadProject(r.files);
    expect(p.types.resolve('PID').def?.version).toBe('1.1.0');
    expect(p.types.resolve('PID@1.0.0').def?.version).toBe('1.0.0');
  });
  it('detects recursive composite blocks', () => {
    const files: Files = {
      ...demo,
      'library/acme/LOOP@1.0.0.yaml': 'type: LOOP\nversion: 1.0.0\nkind: composite\noutputs: []\ndiagram:\n  blocks:\n    X: { type: acme/LOOP }\n',
    };
    expect(codes(loadProject(files).diags)).toContain('recursive-composite');
  });
});

describe('operations', () => {
  it('adds blocks in canonical key order and keeps comments', () => {
    const files = { ...demo, [FIC]: (demo[FIC] as string).replace('blocks:', '# my note\nblocks:') };
    const out = run(files, { op: 'addBlock', file: FIC, id: 'LAH101', type: 'LIM_ALM', pos: [400.4, 300] });
    const text = out[FIC] as string;
    expect(text).toContain('# my note');
    expect(text).toContain('  LAH101:\n    type: LIM_ALM\n    pos: [ 400, 300 ]');
    expect(codes(loadProject(out).diags)).toEqual(['missing-order']);
    const out2 = run(out, { op: 'setBlockField', file: FIC, id: 'LAH101', field: 'order', value: 40 });
    expect(out2[FIC]).toContain('    type: LIM_ALM\n    order: 40\n    pos: [ 400, 300 ]');
  });
  it('connects, comments and disconnects links', () => {
    let f = run(demo, { op: 'addBlock', file: FIC, id: 'FAH', type: 'LIM_ALM' });
    f = run(f, { op: 'connect', file: FIC, from: 'FT101.PV', to: 'FAH.IN' });
    expect(f[FIC]).toContain('  - FT101.PV -> FAH.IN');
    const s = () => loadProject(f).strategyByName.get('FIC101')!;
    const idx = s().links.find((l) => l.to.block === 'FAH')!.index;
    f = run(f, { op: 'setLinkComment', file: FIC, index: idx, comment: 'alarm' });
    expect(f[FIC]).toContain('  - from: FT101.PV\n    to: FAH.IN\n    comment: alarm');
    f = run(f, { op: 'setLinkComment', file: FIC, index: idx, comment: undefined });
    expect(f[FIC]).toContain('  - FT101.PV -> FAH.IN');
    f = run(f, { op: 'disconnect', file: FIC, index: idx });
    expect(f[FIC]).not.toContain('FAH.IN');
  });
  it('replaces the driver of an input when asked', () => {
    let f = run(demo, { op: 'addBlock', file: FIC, id: 'AI2', type: 'AI' });
    expect(() => applyOp(f, { op: 'connect', file: FIC, from: 'X', to: 'Y' })).toThrow(OpError);
    f = run(f, { op: 'connect', file: FIC, from: 'AI2.PV', to: 'FIC101.PV', replace: true });
    const links = loadProject(f).strategyByName.get('FIC101')!.links.filter((l) => l.to.port === 'PV' && l.to.block === 'FIC101');
    expect(links).toHaveLength(1);
    expect(links[0].from.block).toBe('AI2');
  });
  it('renames blocks everywhere they are referenced', () => {
    const f = run(demo, { op: 'renameBlock', file: LIC, from: 'LAL100', to: 'LA100' });
    expect(f[LIC]).toContain('  LA100:');
    expect(f[P101]).toContain('LIC100:LA100.QL -> DRY_RUN.IN2');
    expect(loadProject(f).diags).toEqual([]);
  });
  it('renames strategies, their docs and references', () => {
    const r = applyOp(demo, { op: 'renameStrategy', file: LIC, name: 'LIC200' });
    expect(r.files[`${U100}/LIC200.yaml`]).toContain('strategy: LIC200');
    expect(r.files[LIC]).toBeUndefined();
    expect(r.files[FIC]).toContain('from: LIC200:LIC100.MV');
    expect(loadProject(r.files).diags).toEqual([]);
    const r2 = applyOp(demo, { op: 'renameStrategy', file: FIC, name: 'FIC102' });
    expect(r2.files[`${U100}/FIC102.md`]).toBeDefined();
    expect(() => applyOp(demo, { op: 'renameStrategy', file: FIC, name: 'P101' })).toThrow(/already used/);
  });
  it('removes blocks together with their links', () => {
    const f = run(demo, { op: 'removeBlock', file: FIC, id: 'FIC101' });
    expect(f[FIC]).not.toMatch(/FIC101\.(PV|MV|SP_EXT)/);
    expect(loadProject(f).diags).toEqual([]);
  });
  it('sets and clears params, positions and fields', () => {
    let f = run(demo, { op: 'setParam', file: FIC, id: 'FV101', name: 'OUT_HI', value: 80 });
    expect(f[FIC]).toContain('params: { CHANNEL: FV101, OUT_HI: 80 }');
    f = run(f, { op: 'setParam', file: FIC, id: 'FV101', name: 'CHANNEL' });
    f = run(f, { op: 'setParam', file: FIC, id: 'FV101', name: 'OUT_HI' });
    expect(f[FIC]).not.toMatch(/FV101:[\s\S]*params:[\s\S]*links:/);
    f = run(f, { op: 'moveBlock', file: FIC, id: 'FV101', pos: [10, 20] });
    expect(f[FIC]).toContain('pos: [ 10, 20 ]');
    f = run(f, { op: 'moveBlock', file: FIC, id: 'FV101', pos: null });
    expect(f[FIC]).not.toContain('pos:');
  });
  it('undoes any op exactly', () => {
    const ops: Op[] = [
      { op: 'renameStrategy', file: LIC, name: 'LIC9' },
      { op: 'addSheet', file: FIC, title: 'Alarms' },
      { op: 'createStrategy', folder: 'ACME/Plzen', name: 'TIC1', title: 'Temp' },
      { op: 'createFolder', folder: 'ACME/Plzen' },
    ];
    for (const op of ops) {
      const r = applyOp(demo, op);
      expect(r.changed.length).toBeGreaterThan(0);
      expect(applyOp(r.files, inverseOf(r)).files).toEqual(demo);
    }
  });
  it('manages sheets', () => {
    let f = run(demo, { op: 'addSheet', file: FIC, title: 'Alarms' });
    expect(f[FIC]).toContain('sheets:\n  - { id: 1, title: Sheet 1 }\n  - { id: 2, title: Alarms }');
    f = run(f, { op: 'setBlockField', file: FIC, id: 'FV101', field: 'sheet', value: 2 });
    expect(() => applyOp(f, { op: 'removeSheet', file: FIC, id: 2 })).toThrow(/not empty/);
    const p = loadProject(f);
    expect(p.diags).toEqual([]);
    const sheets = layoutDiagram(p.strategyByName.get('FIC101')!);
    expect(sheets[0].connectors.some((c) => c.kind === 'sheet-out' && c.label === '→ 2 / FV101.IN')).toBe(true);
    expect(sheets[1].connectors.some((c) => c.kind === 'sheet-in')).toBe(true);
  });
  it('creates libraries, block types and new versions', () => {
    let f = run(demo, { op: 'createLibrary', folder: 'plant', name: 'Plant blocks' });
    f = run(f, { op: 'createBlockType', lib: 'plant', type: 'DOSING', category: 'Devices' });
    f = run(f, { op: 'newTypeVersion', file: 'library/plant/DOSING@1.0.0.yaml', part: 'major' });
    const p = loadProject(f);
    expect(p.diags).toEqual([]);
    expect(p.types.versions('DOSING').map((t) => t.version)).toEqual(['2.0.0', '1.0.0']);
  });
  it('suggests unique block ids', () => {
    expect(suggestBlockId('PID@1.0.0', ['PID1'])).toBe('PID2');
    expect(suggestBlockId('acme/AI_2OO3', [])).toBe('AI2OO31');
  });
});

describe('layout', () => {
  const p = loadProject(demo);
  it('does not overlap auto-placed blocks', () => {
    for (const s of p.strategies) {
      for (const l of layoutDiagram(s)) {
        for (const a of l.blocks)
          for (const b of l.blocks) {
            if (a === b) continue;
            const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
            expect(overlap, `${s.name}: ${a.id} / ${b.id}`).toBe(false);
          }
      }
    }
  });
  it('respects manual positions and overrides', () => {
    const f = run(demo, { op: 'moveBlock', file: FIC, id: 'FV101', pos: [900, 500] });
    const l = layoutDiagram(loadProject(f).strategyByName.get('FIC101')!)[0];
    expect(l.blocks.find((b) => b.id === 'FV101')).toMatchObject({ x: 900, y: 500, pinned: true });
    const l2 = layoutDiagram(loadProject(f).strategyByName.get('FIC101')!, { overrides: { FV101: [10, 10] } })[0];
    expect(l2.blocks.find((b) => b.id === 'FV101')).toMatchObject({ x: 10, y: 10 });
  });
  it('computes execution order from signal flow', () => {
    const order = autoOrder(p.strategyByName.get('P101')!);
    expect(order.get('LSL100')!).toBeLessThan(order.get('DRY_RUN')!);
    expect(order.get('HEALTHY')!).toBeLessThan(order.get('P101')!);
    expect(order.get('P101')!).toBeLessThan(order.get('P101_CMD')!);
  });
});
