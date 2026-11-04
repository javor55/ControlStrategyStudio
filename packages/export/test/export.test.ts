import { describe, expect, it } from 'vitest';
import { demoProjectFiles, loadProject } from '@csd/core';
import { renderSheetSvg } from '@csd/render';
import {
  defaultExportConfig,
  exportRenderOptions,
  filesInScope,
  fromBase64,
  injectViewerData,
  niceTicks,
  normalizeExportConfig,
  payloadFiles,
  planExport,
  renderChartSvg,
  toBase64,
  viewerPayload,
  VIEWER_DATA_ID,
} from '../src';

const U100 = 'strategies/ACME/Brno/WaterTreatment/U100';
const files = demoProjectFiles();
const model = loadProject(files);

describe('export plan', () => {
  it('orders strategies by hierarchy and collects folders with READMEs', () => {
    const plan = planExport(model, defaultExportConfig('pdf'), { date: '2026-11-04' });
    expect(plan.strategies.map((s) => s.name)).toEqual(['FIC101', 'LIC100', 'P101']);
    expect(plan.folders.map((f) => f.path)).toEqual(['ACME', 'ACME/Brno', 'ACME/Brno/WaterTreatment', 'ACME/Brno/WaterTreatment/U100']);
    expect(plan.folders[3].readme?.markdown).toContain('Raw water intake');
    expect(plan.folders[3].level).toBe('Unit');
    expect(plan.strategies[0].hierarchy.map((h) => h.level)).toEqual(['Enterprise', 'Site', 'Area', 'Unit']);
    expect(plan.projectReadme?.markdown).toContain('# Water Treatment Brno');
    expect(plan.date).toBe('2026-11-04');
  });
  it('builds block settings (set values or all with defaults)', () => {
    const set = planExport(model, defaultExportConfig('pdf')).strategies[0];
    const pid = set.blocks.find((b) => b.id === 'FIC101')!;
    expect(set.blocks.map((b) => b.id)).toEqual(['FT101', 'FIC101', 'FV101']); // by execution order
    expect(pid.params.find((p) => p.name === 'GAIN')).toMatchObject({ value: '0.8', default: '1', set: true });
    expect(pid.params.find((p) => p.name === 'PV')).toMatchObject({ kind: 'input', linkedFrom: 'FT101.PV', set: false });
    expect(pid.params.some((p) => p.name === 'TD')).toBe(false);
    const all = planExport(model, { ...defaultExportConfig('pdf'), parameters: 'all' }).strategies[0].blocks.find((b) => b.id === 'FIC101')!;
    expect(all.params.find((p) => p.name === 'TD')).toMatchObject({ default: '0s', set: false });
  });
  it('lists links with feedback and cross references', () => {
    const plan = planExport(model, defaultExportConfig('pdf'));
    const fic = plan.strategies[0];
    expect(fic.links.find((l) => l.to === 'FIC101.TRK_VAL')).toMatchObject({ feedback: { sourceOrder: 30, targetOrder: 20 }, category: 'tracking' });
    expect(fic.links.find((l) => l.external)?.from).toBe('LIC100:LIC100.MV');
    const lic = plan.strategies[1];
    expect(lic.usedBy.map((u) => `${u.output}→${u.strategy}`).sort()).toEqual(['LAL100.QL→P101', 'LIC100.MV→FIC101']);
    expect(plan.strategies[2].links.find((l) => l.to === 'P101.INTLK')).toMatchObject({ crossSheet: true, label: 'P101_ILK' });
  });
  it('limits the scope and collects used block types incl. composite internals', () => {
    const cfg = { ...defaultExportConfig('pdf'), strategies: [`${U100}/LIC100.yaml`] };
    const plan = planExport(model, cfg);
    expect(plan.strategies.map((s) => s.name)).toEqual(['LIC100']);
    const names = plan.types.map((t) => `${t.def.library}/${t.def.type}`);
    expect(names).toContain('acme/AI_2OO3');
    expect(names).toContain('std/MID'); // inside the composite
    expect(plan.types.find((t) => t.def.type === 'AI_2OO3')!.sheets).toHaveLength(1);
  });
  it('applies display options to layouts and render options', () => {
    const cfg = defaultExportConfig('pdf');
    cfg.display = { ...cfg.display, ports: 'all', params: false, order: false, feedback: false, categories: false };
    const plan = planExport(model, cfg);
    const pid = plan.strategies[0].sheets[0].layout.blocks.find((b) => b.id === 'FIC101')!;
    expect(pid.ports).toHaveLength(13);
    expect(pid.params).toEqual([]);
    const svg = renderSheetSvg(plan.strategies[0].sheets[0].layout, exportRenderOptions(plan));
    expect(svg).not.toContain('#20');
    expect(svg).not.toContain('<tspan dy="-4"');
  });
  it('normalizes stored configs', () => {
    const c = normalizeExportConfig({ paper: 'A4', sections: { cover: false }, display: { order: false } }, 'html');
    expect(c).toMatchObject({ format: 'html', paper: 'A4', sections: { cover: false, diagrams: true }, display: { order: false, labels: true } });
  });
});

describe('charts', () => {
  it('computes nice ticks', () => {
    expect(niceTicks(0, 100)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0, 4)).toEqual([0, 1, 2, 3, 4]);
  });
  it('renders line and bar charts and reports errors', () => {
    const line = renderChartSvg('type: line\ntitle: Split\nx: { label: OUT }\nseries:\n  - { name: A, points: [[0,0],[50,100]] }\n  - { name: B, points: [[50,0],[100,100]] }');
    expect('svg' in line && line.svg).toContain('Split');
    const bar = renderChartSvg('type: bar\ncategories: [Q1, Q2]\nseries:\n  - { name: x, values: [3, 5] }');
    expect('svg' in bar && bar.svg).toContain('Q2');
    expect(renderChartSvg('series: []')).toEqual({ error: 'Chart: "series" is empty' });
  });
});

describe('viewer payload', () => {
  it('round-trips base64', () => {
    const b = new Uint8Array([0, 1, 2, 250, 255, 128, 77]);
    expect(fromBase64(toBase64(b))).toEqual(b);
    expect(toBase64(new TextEncoder().encode('Man'))).toBe('TWFu');
  });
  it('keeps only strategies in scope', () => {
    const cfg = { ...defaultExportConfig('html'), strategies: [`${U100}/FIC101.yaml`] };
    const f = filesInScope(files, cfg);
    expect(f[`${U100}/FIC101.yaml`]).toBeDefined();
    expect(f[`${U100}/FIC101.md`]).toBeDefined();
    expect(f[`${U100}/LIC100.yaml`]).toBeUndefined();
    expect(f[`${U100}/README.md`]).toBeDefined();
    expect(f['library/std/PID@1.0.0.yaml']).toBeDefined();
  });
  it('injects data safely into the template', () => {
    const p = viewerPayload({ ...files, 'assets/x.bin': new Uint8Array([1, 2, 3]), 'README.md': '</script><b>' }, defaultExportConfig('html'), { projectName: 'P' });
    const html = injectViewerData(`<title>x</title><script type="application/json" id="${VIEWER_DATA_ID}">{}</script>`, p, 'My <project>');
    expect(html).not.toContain('</script><b>');
    expect(html).toContain('<title>My &lt;project></title>');
    const json = /<script[^>]*>([\s\S]*)<\/script>/.exec(html)![1];
    const back = payloadFiles(JSON.parse(json));
    expect(back['README.md']).toBe('</script><b>');
    expect(back['assets/x.bin']).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('data export', () => {
  it('exports the project as JSON and TOML', async () => {
    const { projectData, projectDataJson, projectDataToml } = await import('../src');
    const { parse } = await import('smol-toml');
    const d = projectData(files, defaultExportConfig('json'), '2026-11-04T00:00:00Z');
    expect(Object.keys(d.strategies)).toEqual(expect.arrayContaining(['ACME/Brno/WaterTreatment/U100/FIC101']));
    expect(d.strategies['ACME/Brno/WaterTreatment/U100/FIC101'].doc).toContain('## Function');
    expect(Object.keys(d.libraries)).toEqual(expect.arrayContaining(['std', 'acme']));
    expect(JSON.parse(projectDataJson(d)).project.name).toBe('Water Treatment Brno');
    const toml = parse(projectDataToml(d)) as { strategies: Record<string, { strategy: { strategy: string } }> };
    expect(toml.strategies['ACME/Brno/WaterTreatment/U100/P101'].strategy.strategy).toBe('P101');
  });
});
