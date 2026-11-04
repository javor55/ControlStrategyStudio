import { describe, expect, it } from 'vitest';
import { applyOp, demoProjectFiles, layoutDiagram, loadProject, parseExpr, exprRefs, type Files, type Op } from '../src';

const U100 = 'strategies/ACME/Brno/WaterTreatment/U100';
const SEQ = `${U100}/FILL_T100.seq.yaml`;
const demo = demoProjectFiles();
const run = (f: Files, ...ops: Op[]) => ops.reduce((x, op) => applyOp(x, op).files, f);
const diagsOf = (f: Files, file = SEQ) => loadProject(f).diagsByFile.get(file) ?? [];
const codes = (f: Files, file = SEQ) => diagsOf(f, file).filter((d) => d.severity !== 'info').map((d) => d.code);

describe('condition expressions', () => {
  it('parses logic, comparisons, arithmetic, durations and references', () => {
    const e = parseExpr('START_CMD and not LIC100:LAL100.QH or (S20.T > 10min && FIC101:FT101.PV >= 2 * 1.5)');
    expect(exprRefs(e).map((r) => r.text)).toEqual(['START_CMD', 'LIC100:LAL100.QH', 'S20.T', 'FIC101:FT101.PV']);
    expect(() => parseExpr('a and')).toThrow(/incomplete/);
    expect(() => parseExpr('(a or b')).toThrow(/\)/);
  });
});

describe('demo sequence', () => {
  it('loads with steps, parallel branch and cross references', () => {
    const p = loadProject(demo);
    const q = p.sequenceByName.get('FILL_T100')!;
    expect(q.steps.map((s) => s.id)).toEqual(['S0', 'S10', 'S20', 'S25', 'S30']);
    expect(q.transitions[1]).toMatchObject({ from: ['S10'], to: ['S20', 'S25'] });
    expect(codes(demo)).toEqual([]);
    expect(diagsOf(demo).map((d) => d.code)).toEqual(['action-not-linked', 'action-not-linked']);
    expect(p.sequenceRefs('FIC101').map((r) => `${r.kind}:${r.block}.${r.port}`)).toEqual(['writes:FIC101.MAN_ON', 'writes:FIC101.MAN_VAL', 'reads:FT101.PV']);
    expect(p.root.folders[0].folders[0].folders[0].folders[0].sequences).toEqual([SEQ]);
    expect(q.docFile).toBe(`${U100}/FILL_T100.md`);
  });
});

describe('sequence validation', () => {
  const edit = (from: string, to: string) => ({ ...demo, [SEQ]: (demo[SEQ] as string).replace(from, to) });
  it('checks conditions: syntax, unknown signals, types, words', () => {
    expect(codes(edit('P101:P101.RUNNING', 'P101:P101.NOPE'))).toEqual(['bad-condition']);
    expect(codes(edit('FIC101:FT101.PV > 5', 'FIC101:FT101.PV'))).toEqual(['bad-condition']); // REAL, not BOOL
    expect(codes(edit('P101:P101.RUNNING', 'P101:P101.RUNNING >'))).toEqual(['bad-condition']);
    const words = edit('P101:P101.RUNNING', 'Pump is running');
    expect(codes(words)).toEqual([]);
    expect(diagsOf(words).some((d) => d.code === 'condition-not-linked')).toBe(true);
    expect(codes(edit('S0.T', 'S0.T'))).toEqual([]);
  });
  it('checks action targets', () => {
    expect(codes(edit('P101:P101.START', 'P101:P101.CMD'))).toEqual(['wrong-direction']);
    expect(codes(edit('P101:P101.START', 'P101.START'))).toEqual(['bad-action-target']);
    expect(codes(edit('FIC101:FIC101.MAN_ON, value: true', 'FIC101:FIC101.PV')).sort()).toEqual(['action-target-linked', 'missing-value']);
  });
  it('checks structure', () => {
    expect(codes(edit('    initial: true\n', ''))).toEqual(['no-initial-step']);
    expect(codes(edit('  - { from: S30, to: S0, condition: P101:P101.RUNNING }\n', '  - { from: S30, to: S99, condition: TRUE }\n'))).toEqual(['unknown-step']);
    expect(codes(edit('  - { from: [S20, S25], to: S30, condition: LIC100:LT100.PV >= 2.5, comment: Operating level }\n', ''))).toEqual(
      expect.arrayContaining(['unreachable-step', 'unclosed-parallel']),
    );
  });
  it('lets strategies read sequence signals', () => {
    const P101 = `${U100}/P101.yaml`;
    let f = run(demo, { op: 'connect', file: P101, from: 'FILL_T100:S30.X', to: 'P101.PERM' });
    expect(codes(f, P101)).toEqual([]);
    expect(loadProject(f).usedBy('FILL_T100').map((r) => r.strategy.name)).toEqual(['P101']);
    f = run(demo, { op: 'connect', file: P101, from: 'FILL_T100:S99.X', to: 'P101.PERM' });
    expect(codes(f, P101)).toEqual(['unknown-port']);
    f = run(demo, { op: 'connect', file: P101, from: 'FILL_T100:SEQ.RUNNING', to: 'P101.PERM' });
    expect(codes(f, P101)).toEqual([]);
  });
});

describe('sequence operations', () => {
  it('creates sequences and edits steps, actions and transitions', () => {
    const file = 'strategies/ACME/CIP.seq.yaml';
    let f = run(demo, { op: 'createSequence', folder: 'ACME', name: 'CIP', title: 'Cleaning' });
    expect(() => applyOp(f, { op: 'createSequence', folder: 'ACME', name: 'P101' })).toThrow(/already used/);
    f = run(
      f,
      { op: 'addStep', file, id: 'S10', description: 'Rinse' },
      { op: 'addTransition', file, from: 'S0', to: 'S10', condition: 'START' },
      { op: 'addSeqInput', file, name: 'START', type: 'BOOL' },
      { op: 'addAction', file, step: 'S10', action: { q: 'S', set: 'P101:P101.START' } },
      { op: 'addAction', file, step: 'S10', action: { q: 'N', text: 'Open rinse valve' } },
      { op: 'setStepTime', file, id: 'S10', max: '5min' },
      { op: 'addTransition', file, from: 'S10', to: 'S0', condition: 'S10.T > 2min' },
    );
    expect(f[file]).toContain('S10:\n    description: Rinse\n    time: { max: 5min }\n    actions:\n      - { q: S, set: P101:P101.START }\n      - { q: N, text: Open rinse valve }');
    expect(f[file]).toContain('  - { from: S0, to: S10, condition: START }');
    expect(codes(f, file)).toEqual([]);
    f = run(f, { op: 'insertStep', file, transition: 0, id: 'S5', description: 'Check' });
    const q = loadProject(f).sequenceByName.get('CIP')!;
    expect(q.transitions.map((t) => `${t.from}>${t.to}`)).toEqual(['S0>S5', 'S5>S10', 'S10>S0']);
    f = run(f, { op: 'setStepField', file, id: 'S10', field: 'initial', value: true });
    expect(loadProject(f).sequenceByName.get('CIP')!.steps.filter((s) => s.initial).map((s) => s.id)).toEqual(['S10']);
    f = run(f, { op: 'removeStep', file, id: 'S5' });
    expect(loadProject(f).sequenceByName.get('CIP')!.transitions.map((t) => `${t.from}>${t.to}`)).toEqual(['S10>S0']);
  });
  it('renames steps in transitions, conditions and strategies that read them', () => {
    const P101 = `${U100}/P101.yaml`;
    let f = run(demo, { op: 'connect', file: P101, from: 'FILL_T100:S30.X', to: 'P101.PERM' }, { op: 'setTransition', file: SEQ, index: 3, condition: 'P101:P101.RUNNING and S30.T > 2s' });
    f = run(f, { op: 'renameStep', file: SEQ, from: 'S30', to: 'S40' });
    expect(f[SEQ]).toContain('  S40:');
    expect(f[SEQ]).toContain('{ from: S40, to: S0, condition: P101:P101.RUNNING and S40.T > 2s }');
    expect(f[SEQ]).toContain('to: S40');
    expect(f[P101]).toContain('FILL_T100:S40.X -> P101.PERM');
    expect(codes(f)).toEqual([]);
  });
  it('follows renamed strategies, blocks and ports', () => {
    let f = run(demo, { op: 'renameBlock', file: `${U100}/FIC101.yaml`, from: 'FT101', to: 'FT102' });
    expect(f[SEQ]).toContain('condition: FIC101:FT102.PV > 5');
    f = run(f, { op: 'renameStrategy', file: `${U100}/P101.yaml`, name: 'P201' });
    expect(f[SEQ]).toContain('set: P201:P101.START');
    expect(f[SEQ]).toContain('condition: P201:P101.RUNNING');
    f = run(f, { op: 'updatePort', file: 'library/std/MOTOR@1.0.0.yaml', list: 'outputs', name: 'RUNNING', patch: { name: 'RUN' } });
    expect(f[SEQ]).toContain('condition: P201:P101.RUN');
    f = run(f, { op: 'renameStrategy', file: SEQ, name: 'FILL1' });
    expect(f[`${U100}/FILL1.seq.yaml`]).toContain('sequence: FILL1');
    expect(f[`${U100}/FILL1.md`]).toBeDefined();
    expect(loadProject(f).diags.filter((d) => d.severity !== 'info')).toEqual([]);
  });
  it('keeps strategies laid out the same', () => {
    expect(layoutDiagram(loadProject(demo).strategyByName.get('FIC101')!)[0].blocks).toHaveLength(3);
  });
});

describe('SFC layout', () => {
  it('lays out steps top-down with parallel bars and a jump back to the initial step', async () => {
    const { layoutSequence } = await import('../src');
    const q = loadProject(demo).sequenceByName.get('FILL_T100')!;
    const [l] = layoutSequence(q);
    const y = (id: string) => l.steps.find((s) => s.id === id)!.y;
    expect(y('S0')).toBeLessThan(y('S10'));
    expect(y('S10')).toBeLessThan(y('S20'));
    expect(y('S20')).toBe(y('S25')); // parallel branches side by side
    expect(y('S20')).toBeLessThan(y('S30'));
    expect(l.bars.filter((b) => b.double)).toHaveLength(2); // fork + join
    const back = l.transitions.find((t) => t.transition.from[0] === 'S30')!;
    expect(back.jumps.map((j) => j.step)).toEqual(['S0']);
    expect(l.steps.find((s) => s.id === 'S0')!.jumpsIn).toEqual(['S30']);
    expect(l.steps.find((s) => s.id === 'S10')!.actions.map((a) => a.lines[0])).toEqual(['FIC101:FIC101.MAN_ON := TRUE', 'FIC101:FIC101.MAN_VAL := 30']);
  });
  it('respects manual positions and renders SVG', async () => {
    const { layoutSequence } = await import('../src');
    const f = run(demo, { op: 'moveStep', file: SEQ, id: 'S25', pos: [900, 400] });
    const [l] = layoutSequence(loadProject(f).sequenceByName.get('FILL_T100')!);
    expect(l.steps.find((s) => s.id === 'S25')).toMatchObject({ x: 900, y: 400, pinned: true });
    const { renderSequenceSvg } = await import('@csd/render');
    const svg = renderSequenceSvg(l, { interactive: true, selection: { kind: 'block', id: 'S10' } });
    expect(svg).toContain('data-step="S10"');
    expect(svg).toContain('data-transition="0"');
    expect(svg).toContain('LIC100:LT100.PV &gt;= 2.5');
  });
});

describe('sequence diff and strategy tags', () => {
  it('diffs steps, actions and transitions', async () => {
    const { diffProjects } = await import('../src');
    const f = run(
      demo,
      { op: 'addStep', file: SEQ, id: 'S40', description: 'Done' },
      { op: 'setTransition', file: SEQ, index: 3, to: 'S40' },
      { op: 'updateAction', file: SEQ, step: 'S10', index: 1, patch: { value: 35 } },
      { op: 'removeStep', file: SEQ, id: 'S25' },
    );
    const d = diffProjects(loadProject(demo), loadProject(f)).sequences[0];
    expect(d.name).toBe('FILL_T100');
    expect(d.steps.map((s) => `${s.id}:${s.kind}`).sort()).toEqual(['S10:changed', 'S25:removed', 'S40:added']);
    expect(d.steps.find((s) => s.id === 'S10')!.changes).toEqual([{ field: 'actions[2]', before: 'N FIC101:FIC101.MAN_VAL := 30', after: 'N FIC101:FIC101.MAN_VAL := 35' }]);
    expect(d.transitions.map((t) => `${t.key}:${t.kind}`).sort()).toEqual(['S10 → S20+S25:removed', 'S10 → S20:added', 'S20+S25 → S30:removed', 'S20 → S30:added', 'S30 → S0:removed', 'S30 → S40:added'].sort());
  });
  it('draws tags on strategy inputs written by sequences', () => {
    const p = loadProject(demo);
    const s = p.strategyByName.get('P101')!;
    const [sheet] = layoutDiagram(s, { writtenBy: (b, port) => p.sequenceRefs('P101', b).filter((r) => r.kind === 'writes' && r.port === port).map((r) => r.sequence) });
    expect(sheet.connectors.find((c) => c.kind === 'written-by')).toMatchObject({ label: '← FILL_T100' });
  });
});
