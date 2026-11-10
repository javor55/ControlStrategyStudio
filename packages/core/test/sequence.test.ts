import { describe, expect, it } from 'vitest';
import { applyOp, demoProjectFiles, layoutDiagram, layoutSequence, loadProject, parseExpr, exprRefs, type Files, type Op } from '../src';

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
    // FILL_T100 of the demo also starts P101: both sequences are warned.
    expect(codes(f, file)).toEqual(['multiple-writers']);
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

describe('sequence clipboard, levels and line categories', () => {
  it('copies steps with actions and inner transitions and pastes them renumbered', async () => {
    const { extractSequenceFragment } = await import('../src');
    const frag = extractSequenceFragment(demo[SEQ] as string, ['S10', 'S20', 'S25'], { positions: { S10: [100, 100] } });
    expect(frag).toContain('csd-sequence-fragment: 1');
    expect(frag).not.toContain('S0:');
    const f = run(demo, { op: 'insertSequenceFragment', file: SEQ, fragment: frag, offset: [20, 20] });
    const q = loadProject(f).sequenceByName.get('FILL_T100')!;
    expect(q.steps.map((s) => s.id)).toEqual(['S0', 'S10', 'S20', 'S25', 'S30', 'S40', 'S50', 'S60']);
    expect(q.steps.find((s) => s.id === 'S40')).toMatchObject({ pos: [120, 120], initial: false });
    expect(q.steps.find((s) => s.id === 'S40')!.actions).toHaveLength(2);
    expect(q.transitions.at(-1)).toMatchObject({ from: ['S40'], to: ['S50', 'S60'], condition: 'FIC101:FT101.PV > 5' });
    expect(() => applyOp(demo, { op: 'insertSequenceFragment', file: SEQ, fragment: 'x' })).toThrow(/clipboard/);
  });
  it('makes hierarchy levels optional', () => {
    const f = run(demo, { op: 'setLevels', levels: [] });
    expect(f['project.yaml']).toContain('levels: []');
    const p = loadProject(f);
    expect(p.meta.levels).toEqual([]);
    expect(p.root.folders[0].level).toBeUndefined();
    const g = run(demo, { op: 'setLevels', levels: ['Plant', 'Area'] });
    expect(loadProject(g).root.folders[0].folders[0].level).toBe('Area');
  });
  it('styles links by built-in category of their signal type or by their own category', async () => {
    const { lineCategories } = await import('../src');
    let f = run(demo, { op: 'setSignalCategory', name: 'bool', category: { color: '#00aa00', style: 'dashed' } });
    const meta = loadProject(f).meta;
    expect(lineCategories(meta).bool).toMatchObject({ color: '#00aa00', style: 'dashed' });
    expect(lineCategories(meta).numeric.description).toMatch(/Numeric/);
    expect(lineCategories(meta).interlock.color).toBe('#b3261e');
    f = run(f, { op: 'setLinkField', file: `${U100}/P101.yaml`, index: 0, field: 'category', value: 'numeric' });
    expect(loadProject(f).diags.filter((d) => d.code === 'unknown-category')).toEqual([]);
  });
});

import { sfcInsertOps } from '../src/sfcedit';
describe('inserting steps into an existing sequence', () => {
  const base = () => demoProjectFiles();
  const file = () => loadProject(base()).sequences[0].file;
  const run = (kind: 'after' | 'before' | 'parallel' | 'alternative', step: string, files = base()) => {
    const seq = loadProject(files).sequences[0];
    const r = sfcInsertOps(seq, kind, step, 'S99');
    if ('error' in r) throw new Error(r.error);
    const out = applyOp(files, { op: 'batch', label: kind, ops: r.ops });
    const p = loadProject(out.files);
    expect(p.diags.filter((d) => d.severity === 'error'), kind).toEqual([]);
    return p.sequences[0];
  };
  const edges = (q: ReturnType<typeof run>) => q.transitions.map((t) => `${t.from.join('+')}>${t.to.join('+')}`);

  it('inserts after a step, keeping the condition on the original transition', () => {
    const before = loadProject(base()).sequences[0];
    const t10 = before.transitions.find((t) => t.from[0] === 'S0')!;
    const q = run('after', 'S0');
    expect(edges(q)).toContain('S0>S99');
    expect(q.transitions.find((t) => t.from[0] === 'S0')!.condition).toBe(t10.condition);
    expect(edges(q)).toContain(`S99>${t10.to.join('+')}`);
  });

  it('inserts before a step, redirecting the incoming transitions', () => {
    const q = run('before', 'S10');
    expect(edges(q)).toContain('S99>S10');
    expect(edges(q).some((e) => e.endsWith('>S10') && !e.startsWith('S99'))).toBe(false);
  });

  it('adds a parallel step beside a step inside a parallel branch', () => {
    const q = run('parallel', 'S20');
    expect(edges(q).some((e) => /^S10>.*S20\+S25\+S99$/.test(e))).toBe(true);
    expect(edges(q).some((e) => /^S20\+S25\+S99>/.test(e))).toBe(true);
  });

  it('adds an alternative path beside a step', () => {
    const q = run('alternative', 'S10');
    expect(edges(q)).toContain('S0>S10');
    expect(edges(q)).toContain('S0>S99');
    expect(edges(q)).toContain('S99>S20+S25');
  });

  it('moves hand-placed steps down to make room', () => {
    let files = base();
    const seq = loadProject(files).sequences[0];
    const ops = seq.steps.map((s, i) => ({ op: 'moveStep' as const, file: file(), id: s.id, pos: [100, 100 + i * 150] as [number, number] }));
    files = applyOp(files, { op: 'batch', label: 'pin', ops }).files;
    const q = run('after', 'S10', files);
    const pos = Object.fromEntries(q.steps.map((s) => [s.id, s.pos]));
    expect(pos.S10).toEqual([100, 250]);
    expect(pos.S99).toEqual([100, 390]);
    expect(pos.S20).toEqual([100, 540]);
    expect(pos.S0).toEqual([100, 100]);
  });
});

import { sfcInsertIntoTransitionOps } from '../src/sfcedit';
describe('inserting a branch into a transition', () => {
  const go = (kind: 'step' | 'parallel' | 'alternative') => {
    const files = demoProjectFiles();
    const seq = loadProject(files).sequences[0];
    const t = seq.transitions.find((x) => x.from[0] === 'S0')!;
    const r = sfcInsertIntoTransitionOps(seq, kind, t.index, ['S1', 'S2']);
    if ('error' in r) throw new Error(r.error);
    const p = loadProject(applyOp(files, { op: 'batch', label: kind, ops: r.ops }).files);
    expect(p.diags.filter((d) => d.severity === 'error')).toEqual([]);
    return p.sequences[0].transitions.map((x) => `${x.from.join('+')}>${x.to.join('+')}`);
  };
  it('parallel', () => expect(go('parallel')).toEqual(expect.arrayContaining(['S0>S1+S2', 'S1+S2>S10'])));
  it('alternative', () => expect(go('alternative')).toEqual(expect.arrayContaining(['S0>S1', 'S0>S2', 'S1>S10', 'S2>S10'])));
  it('step', () => expect(go('step')).toEqual(expect.arrayContaining(['S0>S1', 'S1>S10'])));
});

describe('parallel branch structure', () => {
  const seqFile = 'strategies/ACME/T.seq.yaml';
  const diagsOf = (body: string) => {
    const files = { ...demoProjectFiles(), [seqFile]: `format: csd-sequence/1\nsequence: T\nsteps:\n  S0: { initial: true }\n  S10: {}\n  S20: {}\n  S21: {}\n  S22: {}\n  S23: {}\n  S30: {}\ntransitions:\n${body}` };
    return loadProject(files).diags.filter((d) => d.file === seqFile && d.severity !== 'info').map((d) => d.code);
  };
  it('accepts a fork closed by its join, also with an alternative inside a branch', () => {
    const c = (n: number) => `condition: S0.T > ${n}s`;
    expect(
      diagsOf(
        [
          `  - { from: S0, to: [S10, S20], ${c(1)} }`,
          `  - { from: S20, to: S21, ${c(2)} }`,
          `  - { from: S20, to: S22, ${c(3)} }`,
          `  - { from: S21, to: S23, ${c(4)} }`,
          `  - { from: S22, to: S23, ${c(5)} }`,
          `  - { from: [S10, S23], to: S30, ${c(6)} }`,
          `  - { from: S30, to: S0, ${c(7)} }`,
          '',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
  it('flags a branch that is never joined and a join of alternative branches', () => {
    expect(diagsOf('  - { from: S0, to: [S10, S20], condition: S0.T > 1s }\n  - { from: S20, to: S30, condition: S0.T > 2s }\n  - { from: [S10, S0], to: S21, condition: S0.T > 3s }\n')).toEqual(expect.arrayContaining(['unclosed-parallel', 'unmatched-join']));
    expect(diagsOf('  - { from: S0, to: S10, condition: S0.T > 1s }\n  - { from: S0, to: S20, condition: S0.T > 2s }\n  - { from: [S10, S20], to: S30, condition: S0.T > 3s }\n')).toContain('unmatched-join');
  });
});

describe('sequence layout with hand-placed steps', () => {
  it('moves automatically placed rows below a pinned step instead of overlapping it', () => {
    const p = loadProject(demoProjectFiles());
    const seq = p.sequences[0];
    const auto = layoutSequence(seq)[0];
    const s30 = auto.steps.find((g) => g.id === 'S30')!;
    // Pin S0 right where S30 is drawn.
    const l = layoutSequence(seq, { overrides: { S0: [s30.x, s30.y] } })[0];
    const boxes = l.steps.map((g) => ({ id: g.id, x0: g.x, x1: g.actionBox ? g.actionBox.x + g.actionBox.w : g.x + g.w, y0: g.y, y1: g.y + g.h }));
    for (const a of boxes) for (const b of boxes) if (a !== b) expect(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1, `${a.id} / ${b.id}`).toBe(false);
  });
});

describe('sequencers (several step chains with start conditions)', () => {
  const files0 = demoProjectFiles();
  const q0 = loadProject(files0).sequences[0];
  const file = q0.file;
  const codesOf = (f: Files) => loadProject(f).diags.filter((d) => d.file === file && d.severity !== 'info').map((d) => d.code);
  const step = (f: Files, ...ops: Op[]) => ops.reduce((acc, op) => applyOp(acc, op).files, f);

  it('keeps existing steps in the first sequencer when the first explicit one is added', () => {
    const f = step(files0, { op: 'addSequencer', file, id: 'HOLD', title: 'Holding', start: 'START_CMD', priority: 2 });
    expect(f[file]).toContain('sequencers:\n  - { id: MAIN }\n  - { id: HOLD, title: Holding, start: START_CMD, priority: 2 }');
    const q = loadProject(f).sequences[0];
    expect(q.sequencers.map((x) => x.id)).toEqual(['MAIN', 'HOLD']);
    expect(new Set(q.steps.map((s) => s.sequencer))).toEqual(new Set(['MAIN']));
    // HOLD has no steps yet (info); MAIN has no start condition.
    expect(codesOf(f)).toContain('missing-start-condition');
    expect(loadProject(f).diags.some((d) => d.file === file && d.code === 'no-steps' && d.severity === 'info')).toBe(true);
  });

  it('validates each sequencer as its own chain and draws one page per sequencer', () => {
    let f = step(
      files0,
      { op: 'addSequencer', file, id: 'HOLD', start: 'START_CMD', priority: 2 },
      { op: 'renameSequencer', file, from: 'MAIN', to: 'RUN' },
      { op: 'setSequencer', file, id: 'RUN', field: 'start', value: 'not START_CMD' },
      { op: 'setSequencer', file, id: 'RUN', field: 'priority', value: 1 },
      { op: 'addStep', file, id: 'H0', sequencer: 'HOLD', initial: true },
      { op: 'addStep', file, id: 'H10', sequencer: 'HOLD' },
      { op: 'addTransition', file, from: 'H0', to: 'H10', condition: 'H0.T > 5s' },
    );
    expect(codesOf(f)).toEqual([]);
    const q = loadProject(f).sequences[0];
    expect(q.steps.find((s) => s.id === 'S0')!.sequencer).toBe('RUN');
    expect(q.steps.find((s) => s.id === 'H10')!.sequencer).toBe('HOLD');
    const pages = layoutSequence(q);
    expect(pages.map((p) => p.sequencer?.id)).toEqual(['RUN', 'HOLD']);
    expect(pages[1].steps.map((g) => g.id).sort()).toEqual(['H0', 'H10']);
    // A transition across sequencers and a shared priority are reported.
    f = step(f, { op: 'addTransition', file, from: 'H10', to: 'S10', condition: 'TRUE' }, { op: 'setSequencer', file, id: 'HOLD', field: 'priority', value: 1 });
    expect(codesOf(f)).toEqual(expect.arrayContaining(['cross-sequencer-transition', 'duplicate-priority']));
    expect(() => applyOp(f, { op: 'removeSequencer', file, id: 'HOLD' })).toThrow(/still has steps/);
  });

  it('applies the ISA-88 state model: per-state sequencers and SEQ.<STATE> signals', () => {
    const f = step(files0, { op: 'setStateModel', file, model: 'isa88' });
    const q = loadProject(f).sequences[0];
    expect(q.stateModel).toBe('isa88');
    expect(q.sequencers.map((x) => [x.id, x.start, x.priority])).toEqual([
      ['RUN', 'SEQ.RUNNING', 1],
      ['HOLD', 'SEQ.HOLDING', 2],
      ['RESTART', 'SEQ.RESTARTING', 3],
      ['STOP', 'SEQ.STOPPING', 4],
      ['ABORT', 'SEQ.ABORTING', 5],
    ]);
    // Today's steps became the Running logic; the start conditions type-check.
    expect(new Set(q.steps.map((s) => s.sequencer))).toEqual(new Set(['RUN']));
    expect(codesOf(f).filter((c) => c === 'bad-condition')).toEqual([]);
    const g = step(f, { op: 'setSequencer', file, id: 'HOLD', field: 'start', value: 'SEQ.HOLDING and not SEQ.ABORTING' });
    expect(codesOf(g).filter((c) => c === 'bad-condition')).toEqual([]);
  });
});
