import { describe, expect, it } from 'vitest';
import { applyOp, demoProjectFiles, diffProjects, loadProject, type Files, type Op } from '../src';

const U100 = 'strategies/ACME/Brno/WaterTreatment/U100';
const FIC = `${U100}/FIC101.yaml`;
const demo = demoProjectFiles();
const after = (...ops: Op[]): Files => ops.reduce((f, op) => applyOp(f, op).files, demo as Files);

describe('graph diff', () => {
  it('reports nothing for identical projects', () => {
    const d = diffProjects(loadProject(demo), loadProject(demo));
    expect(d.strategies).toEqual([]);
    expect(d.summary).toEqual({ strategies: 0, continuous: 0, sequences: 0, blocks: 0, links: 0, steps: 0, transitions: 0, types: 0, other: 0 });
  });
  it('finds added, removed and changed blocks, rewired links and parameters', () => {
    const f = after(
      { op: 'addBlock', file: FIC, id: 'FAH101', type: 'LIM_ALM' },
      { op: 'connect', file: FIC, from: 'FT101.PV', to: 'FAH101.IN' },
      { op: 'setParam', file: FIC, id: 'FIC101', name: 'GAIN', value: 1.1 },
      { op: 'setParam', file: FIC, id: 'FIC101', name: 'TD', value: '2s' },
      { op: 'setBlockField', file: FIC, id: 'FV101', field: 'order', value: 15 },
      { op: 'connect', file: FIC, from: 'FT101.PV', to: 'FIC101.TRK_VAL', replace: true },
      { op: 'removeBlock', file: `${U100}/P101.yaml`, id: 'P101_CMD' },
    );
    const d = diffProjects(loadProject(demo), loadProject(f));
    const fic = d.strategies.find((s) => s.name === 'FIC101')!;
    expect(fic.kind).toBe('changed');
    expect(fic.blocks.find((b) => b.id === 'FAH101')).toMatchObject({ kind: 'added' });
    expect(fic.blocks.find((b) => b.id === 'FIC101')!.changes).toEqual([
      { field: 'params.GAIN', before: '0.8', after: '1.1' },
      { field: 'params.TD', before: undefined, after: '2s' },
    ]);
    expect(fic.blocks.find((b) => b.id === 'FV101')!.changes).toEqual([{ field: 'order', before: '30', after: '15' }]);
    expect(fic.links.find((l) => l.key === 'FAH101.IN')).toMatchObject({ kind: 'added' });
    expect(fic.links.find((l) => l.key === 'FIC101.TRK_VAL')!.changes).toContainEqual({ field: 'from', before: 'FV101.OUT_RB', after: 'FT101.PV' });
    const p101 = d.strategies.find((s) => s.name === 'P101')!;
    expect(p101.blocks).toEqual([{ id: 'P101_CMD', kind: 'removed', changes: [] }]);
    expect(p101.links.find((l) => l.key === 'P101_CMD.IN')).toMatchObject({ kind: 'removed' });
  });
  it('tracks renamed strategies by uid and reports added / removed ones', () => {
    const f = after({ op: 'renameStrategy', file: FIC, name: 'FIC201' }, { op: 'createStrategy', folder: 'ACME', name: 'NEW1' });
    const d = diffProjects(loadProject(demo), loadProject(f));
    const ren = d.strategies.find((s) => s.name === 'FIC201')!;
    expect(ren.kind).toBe('changed');
    expect(ren.header).toContainEqual({ field: 'name', before: 'FIC101', after: 'FIC201' });
    expect(d.strategies.find((s) => s.name === 'NEW1')!.kind).toBe('added');
  });
  it('lists library and other file changes; position-only moves are flagged', () => {
    const f = after(
      { op: 'newTypeVersion', file: 'library/std/PID@1.0.0.yaml' },
      { op: 'moveBlock', file: FIC, id: 'FT101', pos: [100, 100] },
      { op: 'setText', file: 'README.md', text: '# Changed\n' },
    );
    const d = diffProjects(loadProject(demo), loadProject(f));
    expect(d.types).toEqual([{ path: 'library/std/PID@1.1.0.yaml', kind: 'added' }]);
    expect(d.other).toEqual([{ path: 'README.md', kind: 'changed' }]);
    expect(d.strategies.find((s) => s.name === 'FIC101')!.blocks).toEqual([{ id: 'FT101', kind: 'changed', changes: [], moved: true }]);
    expect(d.summary.blocks).toBe(0);
  });
});

describe('diff details', () => {
  const base = demoProjectFiles();
  const fic = Object.keys(base).find((f) => f.endsWith('/FIC101.yaml'))!;
  const seqFile = Object.keys(base).find((f) => f.endsWith('.seq.yaml'))!;
  const both = (edit: (f: Record<string, string>) => void) => {
    const after = { ...base } as Record<string, string>;
    edit(after);
    return diffProjects(loadProject(base), loadProject(after));
  };
  it('sees x- keys and display options of blocks', () => {
    const d = both((f) => (f[fic] = f[fic].replace('  FT101:\n', '  FT101:\n    x-tia: { db: 12 }\n    display: { params: false }\n')));
    const ch = d.strategies[0].blocks.find((b) => b.id === 'FT101')!.changes.map((c) => c.field);
    expect(ch).toEqual(expect.arrayContaining(['display', 'x-tia']));
  });
  it('counts sequence steps and transitions separately, with notes and the description', () => {
    const md = seqFile.replace(/\.seq\.yaml$/, '.md');
    const d = both((f) => {
      f[seqFile] = f[seqFile].replace(/description: Idle/, 'description: Waiting');
      f[md] = '## Function\n\nNew text\n';
    });
    expect(d.summary.sequences).toBe(1);
    expect(d.summary.continuous).toBe(0);
    expect(d.summary.steps).toBe(1);
    expect(d.sequences[0].docChanged).toBe(true);
  });
});
