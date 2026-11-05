// Operations: format migrations, comment / x- key preservation, guards and
// the smaller op contracts (uid, no-op renames, error codes …).
import { afterEach, describe, expect, it } from 'vitest';
import { isMap, type Document } from 'yaml';
import {
  applyOp,
  CURRENT_FORMAT,
  demoProjectFiles,
  extractSequenceFragment,
  inverseOf,
  loadProject,
  MIGRATIONS,
  OpError,
  suggestStepId,
  type Files,
  type Op,
} from '../src';

const U100 = 'strategies/ACME/Brno/WaterTreatment/U100';
const SEQ = `${U100}/FILL_T100.seq.yaml`;
const P101 = `${U100}/P101.yaml`;
const FIC = `${U100}/FIC101.yaml`;
const demo = demoProjectFiles();
const run = (f: Files, op: Op) => applyOp(f, op).files;
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof OpError ? e.code : `not an OpError: ${(e as Error).message}`;
  }
  return undefined;
};

describe('format migrations', () => {
  const saved = CURRENT_FORMAT.strategy;
  afterEach(() => {
    CURRENT_FORMAT.strategy = saved;
    MIGRATIONS.length = 0;
  });

  it('reach the model, keep the cached document unchanged and upgrade files on edit', () => {
    // Test format csd-strategy/2: `title` was called `caption` in version 1.
    CURRENT_FORMAT.strategy = 2;
    MIGRATIONS.push({
      kind: 'strategy',
      from: 1,
      description: 'caption → title',
      migrate(doc: Document) {
        const root = doc.contents;
        if (isMap(root) && root.has('caption')) {
          root.set('title', root.get('caption'));
          root.delete('caption');
        }
      },
    });
    const file = 'strategies/OLD.yaml';
    const text = 'format: csd-strategy/1\nstrategy: OLD\ncaption: From version 1 # kept\nblocks:\n  A: { type: AI }\n';
    const files = { ...demo, [file]: text };
    const p = loadProject(files);
    const s = p.strategyByName.get('OLD')!;
    expect(s.title).toBe('From version 1');
    expect(p.diagsByFile.get(file) ?? []).toEqual([]);
    // Loading twice gives the same result (the cached parse is not mutated).
    expect(loadProject(files).strategyByName.get('OLD')!.title).toBe('From version 1');
    // An edit writes the file in the current format.
    const f = run(files, { op: 'setBlockField', file, id: 'A', field: 'description', value: 'x' });
    expect(f[file]).toContain('format: csd-strategy/2');
    expect(f[file]).toContain('title: From version 1');
    expect(f[file]).not.toContain('caption');
  });
});

describe('comments survive set ops and renames', () => {
  const f: Files = {
    ...demo,
    [P101]: (demo[P101] as string).replace('scan: 500ms', 'scan: 500ms # fast scan').replace('    description: Feed pump P101\n', '    description: Feed pump P101 # from P&ID\n'),
    [SEQ]: (demo[SEQ] as string).replace('  S20:\n', '  # wait for level\n  S20:\n').replace('    time: { max: 2h }', '    time: { max: 2h } # long fill'),
  };
  const comments = (text: string) => text.split('\n').filter((l) => l.includes('#')).map((l) => l.slice(l.indexOf('#')));

  it('keeps comments on replaced values', () => {
    expect(run(f, { op: 'setStrategyField', file: P101, field: 'scan', value: '1s' })[P101]).toContain('scan: 1s # fast scan');
    expect(run(f, { op: 'setBlockField', file: P101, id: 'P101', field: 'description', value: 'Pump' })[P101]).toContain('description: Pump # from P&ID');
    expect(run(f, { op: 'setStepTime', file: SEQ, id: 'S20', max: '3h' })[SEQ]).toContain('time: { max: 3h } # long fill');
  });
  it('keeps comments when blocks, steps, ports and strategies are renamed', () => {
    const s = run(f, { op: 'renameStep', file: SEQ, from: 'S20', to: 'S21' })[SEQ] as string;
    expect(s).toContain('  # wait for level\n  S21:');
    expect(comments(s)).toEqual(comments(f[SEQ] as string));
    const b = run(f, { op: 'renameBlock', file: P101, from: 'P101', to: 'P102' })[P101] as string;
    expect(comments(b)).toEqual(comments(f[P101] as string));
    const r = applyOp(f, { op: 'renameStrategy', file: P101, name: 'P201' });
    expect(comments(r.files[`${U100}/P201.yaml`] as string)).toEqual(comments(f[P101] as string));
    const LAG = 'library/std/LAG@1.0.0.yaml';
    const lag = (demo[LAG] as string).replace(/(\n {2}- \{ name: T,[^\n]*)/, '$1 # time constant');
    const p = run({ ...demo, [LAG]: lag }, { op: 'updatePort', file: LAG, list: 'params', name: 'T', patch: { name: 'TAU' } })[LAG] as string;
    expect(p).toMatch(/name: TAU,[^\n]*# time constant/);
  });
});

describe('x- keys survive paste', () => {
  it('keeps extension keys on steps, actions, transitions and notes', () => {
    const text = (demo[SEQ] as string)
      .replace('  S10:\n', '  S10:\n    x-plc: { dbx: 12 }\n')
      .replace('{ q: N, set: FIC101:FIC101.MAN_ON, value: true }', '{ q: N, set: FIC101:FIC101.MAN_ON, value: true, x-tag: A1 }')
      .replace('{ from: S0, to: S10, condition: START_CMD and not LIC100:LAL100.QH }', '{ from: S0, to: S10, condition: START_CMD and not LIC100:LAL100.QH, x-sil: 2 }')
      .concat('notes:\n  - { text: Copy me, x-color: red }\n');
    const frag = extractSequenceFragment(text, ['S0', 'S10'], { notes: [0] });
    const out = run({ ...demo, [SEQ]: text }, { op: 'insertSequenceFragment', file: SEQ, fragment: frag, offset: [10, 10] })[SEQ] as string;
    const q = loadProject({ ...demo, [SEQ]: out }).sequenceByFile.get(SEQ)!;
    const pasted = q.steps.find((s) => s.id === 'S50')!; // copy of S10
    expect(pasted.ext).toEqual({ 'x-plc': { dbx: 12 } });
    expect(pasted.actions[0].ext).toEqual({ 'x-tag': 'A1' });
    const t = q.transitions[q.transitions.length - 1];
    expect(t.ext).toEqual({ 'x-sil': 2 });
    expect(t.condition).toContain('START_CMD');
    expect(q.notes.map((n) => n.text)).toEqual(['Copy me', 'Copy me']);
  });
});

describe('op contracts', () => {
  it('inserts a step on the sheet of its source step, optionally pinned', () => {
    let f = run(demo, { op: 'addSheet', file: SEQ, title: 'Two' });
    f = run(f, { op: 'moveToSheet', file: SEQ, ids: ['S10'], sheet: 2 });
    f = run(f, { op: 'insertStep', file: SEQ, transition: 1, id: 'S15', pos: [100, 200] });
    const s = loadProject(f).sequenceByFile.get(SEQ)!.steps.find((x) => x.id === 'S15')!;
    expect(s).toMatchObject({ sheet: 2, pos: [100, 200] });
  });
  it('checks the kind of file an op addresses', () => {
    expect(codeOf(() => applyOp(demo, { op: 'addBlock', file: SEQ, id: 'A', type: 'AI' }))).toBe('wrong-file');
    expect(codeOf(() => applyOp(demo, { op: 'setStrategyField', file: 'project.yaml', field: 'title', value: 'x' }))).toBe('wrong-file');
    expect(codeOf(() => applyOp(demo, { op: 'addStep', file: P101, id: 'S1' }))).toBe('wrong-file');
    expect(codeOf(() => applyOp(demo, { op: 'addBlock', file: 'strategies/NOPE.yaml', id: 'A', type: 'AI' }))).toBe('not-found');
    // notes and sheets work for sequences too
    expect(run(demo, { op: 'addNote', file: SEQ, text: 'Hello' })[SEQ]).toContain('text: Hello');
  });
  it('throws OpError with code syntax on files with YAML errors', () => {
    const f = { ...demo, [P101]: 'strategy: P101\nblocks: [\n' };
    expect(codeOf(() => applyOp(f, { op: 'addBlock', file: P101, id: 'A', type: 'AI' }))).toBe('syntax');
  });
  it('checks folder names in every op taking a folder', () => {
    expect(codeOf(() => applyOp(demo, { op: 'createStrategy', folder: '../evil', name: 'X' }))).toBe('invalid-name');
    expect(codeOf(() => applyOp(demo, { op: 'createSequence', folder: 'a/./b', name: 'X' }))).toBe('invalid-name');
    expect(codeOf(() => applyOp(demo, { op: 'moveStrategy', file: P101, folder: 'a/../../b' }))).toBe('invalid-name');
    expect(codeOf(() => applyOp(demo, { op: 'createFolder', folder: 'a//b' }))).toBe('invalid-name');
    expect(codeOf(() => applyOp(demo, { op: 'renameFolder', from: 'ACME', to: 'x:y' }))).toBe('invalid-name');
    expect(Object.keys(run(demo, { op: 'createStrategy', folder: '', name: 'ROOT' }))).toContain('strategies/ROOT.yaml');
  });
  it('reserves README for strategies and SEQ for steps', () => {
    expect(codeOf(() => applyOp(demo, { op: 'createStrategy', folder: 'ACME', name: 'README' }))).toBe('reserved');
    expect(codeOf(() => applyOp(demo, { op: 'renameStrategy', file: SEQ, name: 'README' }))).toBe('reserved');
    expect(codeOf(() => applyOp(demo, { op: 'addStep', file: SEQ, id: 'SEQ' }))).toBe('reserved');
    expect(codeOf(() => applyOp(demo, { op: 'renameStep', file: SEQ, from: 'S10', to: 'SEQ' }))).toBe('reserved');
  });
  it('takes an optional uid on create and duplicate', () => {
    const uid = '00000000-0000-4000-8000-000000000001';
    expect(run(demo, { op: 'createStrategy', folder: '', name: 'A', uid })['strategies/A.yaml']).toContain(uid);
    expect(run(demo, { op: 'createSequence', folder: '', name: 'Q', uid })['strategies/Q.seq.yaml']).toContain(uid);
    expect(run(demo, { op: 'duplicateStrategy', file: P101, name: 'P102', uid })[`${U100}/P102.yaml`]).toContain(uid);
    expect(run(demo, { op: 'createLibrary', folder: 'lib2', uid })['library/lib2/library.yaml']).toContain(uid);
  });
  it('setStepTime keeps the bound that is not given', () => {
    let f = run(demo, { op: 'setStepTime', file: SEQ, id: 'S10', min: '10s' });
    expect(loadProject(f).sequenceByFile.get(SEQ)!.steps.find((s) => s.id === 'S10')!.time).toEqual({ min: '10s', max: '2min' });
    f = run(f, { op: 'setStepTime', file: SEQ, id: 'S10', max: undefined });
    expect(loadProject(f).sequenceByFile.get(SEQ)!.steps.find((s) => s.id === 'S10')!.time).toEqual({ min: '10s', max: undefined });
    f = run(f, { op: 'setStepTime', file: SEQ, id: 'S10', min: '', max: null });
    expect(loadProject(f).sequenceByFile.get(SEQ)!.steps.find((s) => s.id === 'S10')!.time).toBeUndefined();
  });
  it('duplicating a sequence points its self-references to the copy', () => {
    const text = (demo[SEQ] as string).replace('condition: P101:P101.RUNNING', 'condition: P101:P101.RUNNING and FILL_T100:S20.X');
    const f = run({ ...demo, [SEQ]: text }, { op: 'duplicateStrategy', file: SEQ, name: 'FILL_T200' });
    expect(f[`${U100}/FILL_T200.seq.yaml`]).toContain('FILL_T200:S20.X');
    expect(f[SEQ]).toContain('FILL_T100:S20.X');
  });
  it('updates sequence inputs and renames them in conditions', () => {
    const f = run(demo, { op: 'updateSeqInput', file: SEQ, name: 'START_CMD', patch: { name: 'GO', description: 'Go!' } });
    const q = loadProject(f).sequenceByFile.get(SEQ)!;
    expect(q.inputs[0]).toMatchObject({ name: 'GO', type: 'BOOL', description: 'Go!' });
    expect(q.transitions[0].condition).toBe('GO and not LIC100:LAL100.QH');
    expect(loadProject(f).diags.filter((d) => d.severity === 'error')).toEqual([]);
    // removing it leaves the condition as written; validation reports it
    const g = run(f, { op: 'removeSeqInput', file: SEQ, name: 'GO' });
    expect(loadProject(g).diags.filter((d) => d.file === SEQ && d.severity === 'error').map((d) => d.code)).toEqual(['bad-condition']);
  });
  it('treats renames to the same name as no-ops and throws on unknown ids', () => {
    for (const op of [
      { op: 'renameBlock', file: P101, from: 'P101', to: 'P101' },
      { op: 'renameStep', file: SEQ, from: 'S10', to: 'S10' },
      { op: 'renameStrategy', file: P101, name: 'P101' },
      { op: 'renameStrategy', file: SEQ, name: 'FILL_T100' },
    ] as Op[]) {
      expect(applyOp(demo, op).changed).toEqual([]);
    }
    expect(codeOf(() => applyOp(demo, { op: 'removeBlocks', file: FIC, ids: ['FT101', 'NOPE'] }))).toBe('not-found');
    expect(codeOf(() => applyOp(demo, { op: 'renameBlock', file: FIC, from: 'FT101', to: 'FIC101' }))).toBe('exists');
  });
  it('moves blocks and steps to another sheet keeping their positions', () => {
    let f = run(demo, { op: 'addSheet', file: FIC });
    f = run(f, { op: 'moveBlock', file: FIC, id: 'FT101', pos: [40, 60] });
    f = run(f, { op: 'moveToSheet', file: FIC, ids: ['FT101'], sheet: 2 });
    expect(loadProject(f).strategyByFile.get(FIC)!.blocks.find((b) => b.id === 'FT101')).toMatchObject({ sheet: 2, pos: [40, 60] });
    let g = run(demo, { op: 'addSheet', file: SEQ });
    g = run(g, { op: 'moveStep', file: SEQ, id: 'S30', pos: [100, 400] });
    g = run(g, { op: 'moveToSheet', file: SEQ, ids: ['S30'], sheet: 2 });
    expect(loadProject(g).sequenceByFile.get(SEQ)!.steps.find((s) => s.id === 'S30')).toMatchObject({ sheet: 2, pos: [100, 400] });
    expect(codeOf(() => applyOp(g, { op: 'moveToSheet', file: SEQ, ids: ['S30'], sheet: 9 }))).toBe('not-found');
    g = run(g, { op: 'moveToSheet', file: SEQ, ids: ['S30'], sheet: 1 });
    expect(g[SEQ]).not.toMatch(/S30:[^]*sheet:/);
  });
  it('pins and unpins steps, optionally per sheet', () => {
    let f = run(demo, { op: 'pinAll', file: SEQ, positions: { S0: [10, 10], S10: [10, 100] } });
    expect(loadProject(f).sequenceByFile.get(SEQ)!.steps.filter((s) => s.pos).map((s) => s.id)).toEqual(['S0', 'S10']);
    f = run(f, { op: 'addSheet', file: SEQ });
    f = run(f, { op: 'moveToSheet', file: SEQ, ids: ['S10'], sheet: 2 });
    f = run(f, { op: 'unpinAll', file: SEQ, sheet: 2 });
    expect(loadProject(f).sequenceByFile.get(SEQ)!.steps.filter((s) => s.pos).map((s) => s.id)).toEqual(['S0']);
    f = run(f, { op: 'unpinAll', file: SEQ });
    expect(loadProject(f).sequenceByFile.get(SEQ)!.steps.filter((s) => s.pos)).toEqual([]);
  });
  it('never calls a sequence a strategy in messages', () => {
    const f = { ...demo, [SEQ]: (demo[SEQ] as string).replace('scan: 1s\n', 'scan: 1s\nsheets:\n  - { id: 1 }\n') };
    expect(() => applyOp(f, { op: 'removeSheet', file: SEQ, id: 1 })).toThrow(/sequence needs at least one/);
    expect(() => applyOp(demo, { op: 'insertSequenceFragment', file: SEQ, fragment: 'nothing' })).toThrow(/sequence/);
  });
  it('suggests step names', () => {
    expect(suggestStepId(['S0', 'S10', 'S20'])).toBe('S30');
    expect(suggestStepId(['S0', 'S10', 'S20'], 'S10', 'S20')).toBe('S15');
    expect(suggestStepId(['S0', 'S1'], 'S0', 'S1')).toBe('S10');
    expect(suggestStepId({ steps: [{ id: 'Idle' }] })).toBe('S0');
  });
  it('undoes every new op exactly', () => {
    const ops: Op[] = [
      { op: 'moveToSheet', file: SEQ, ids: ['S10'], sheet: 1 },
      { op: 'updateSeqInput', file: SEQ, name: 'START_CMD', patch: { name: 'GO' } },
      { op: 'pinAll', file: SEQ, positions: { S0: [1, 2] } },
      { op: 'duplicateStrategy', file: SEQ, name: 'COPY' },
    ];
    for (const op of ops) {
      const r = applyOp(demo, op);
      expect(applyOp(r.files, inverseOf(r)).files).toEqual(demo);
    }
  });
});
