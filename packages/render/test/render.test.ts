import { describe, expect, it } from 'vitest';
import { demoProjectFiles, layoutDiagram, loadProject } from '@csd/core';
import { renderSheetSvg } from '../src';

describe('renderSheetSvg', () => {
  const p = loadProject(demoProjectFiles());
  const fic = p.strategyByName.get('FIC101')!;
  const [sheet] = layoutDiagram(fic, { defaultScan: fic.scan });

  it('renders blocks, constants, connectors and notes', () => {
    const svg = renderSheetSvg(sheet);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    for (const s of ['FT101', 'PID@1.0.0', 'LIC100:LIC100.MV', 'Cascade SP', 'TRUE', 'GAIN = 0.8', 'Valve fails closed']) expect(svg).toContain(s);
    expect(svg).not.toContain('data-block');
  });
  it('adds hit areas only in interactive mode', () => {
    const svg = renderSheetSvg(sheet, { interactive: true, selection: { kind: 'block', id: 'FIC101' } });
    expect(svg).toContain('data-block="FIC101"');
    expect(svg).toContain('data-port="PV" data-dir="in" data-owner="FIC101"');
    expect(svg).toMatch(/data-link="\d"/);
  });
  it('escapes text', () => {
    const s = { ...fic, notes: [{ index: 0, text: 'a < b & "c"', sheet: 1 }] };
    const svg = renderSheetSvg(layoutDiagram(s)[0]);
    expect(svg).toContain('a &lt; b &amp; &quot;c&quot;');
  });
});

describe('visual diff', () => {
  it('highlights added and changed items and ghosts removed ones', async () => {
    const { applyOp, diffProjects } = await import('@csd/core');
    const FIC = 'strategies/ACME/Brno/WaterTreatment/U100/FIC101.yaml';
    const before = demoProjectFiles();
    let f = applyOp(before, { op: 'removeBlock', file: FIC, id: 'FV101' }).files;
    f = applyOp(f, { op: 'addBlock', file: FIC, id: 'FAH101', type: 'LIM_ALM' }).files;
    f = applyOp(f, { op: 'setParam', file: FIC, id: 'FIC101', name: 'GAIN', value: 2 }).files;
    const pa = loadProject(before);
    const pb = loadProject(f);
    const sd = diffProjects(pa, pb).strategies.find((s) => s.name === 'FIC101')!;
    const { renderDiffFor } = await import('../src');
    const after = layoutDiagram(pb.strategyByName.get('FIC101')!)[0];
    const old = layoutDiagram(pa.strategyByName.get('FIC101')!)[0];
    const d = renderDiffFor(sd, after, old);
    expect(d.blocks).toEqual({ FAH101: 'added', FIC101: 'changed' });
    expect(d.ghosts!.blocks.map((b) => b.id)).toEqual(['FV101']);
    expect(d.ghosts!.wires.length).toBeGreaterThanOrEqual(2);
    const svg = renderSheetSvg(after, { diff: d });
    expect(svg).toContain('removed');
    expect(svg).toContain('#2f7d4a');
  });
});
