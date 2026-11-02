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
