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
  projectData,
  projectDataToml,
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

describe('sequences', () => {
  const SEQ = `${U100}/FILL_T100.seq.yaml`;
  it('plans sequences in hierarchy order together with strategies', () => {
    const plan = planExport(model, defaultExportConfig('pdf'));
    expect(plan.items.map((i) => `${i.kind}:${i.name}`)).toEqual(['strategy:FIC101', 'sequence:FILL_T100', 'strategy:LIC100', 'strategy:P101']);
    expect(plan.strategies.map((s) => s.name)).toEqual(['FIC101', 'LIC100', 'P101']);
    expect(plan.sequences.map((s) => s.name)).toEqual(['FILL_T100']);
    const u100 = plan.folders.find((f) => f.path.endsWith('U100'))!;
    expect(u100.sequences).toEqual([SEQ]);
    expect(u100.items).toEqual([`${U100}/FIC101.yaml`, SEQ, `${U100}/LIC100.yaml`, `${U100}/P101.yaml`]);
    const q = plan.sequences[0];
    expect(q.hierarchy.map((h) => h.name)).toEqual(['ACME', 'Brno', 'WaterTreatment', 'U100']);
    expect(q.doc?.markdown).toContain('First filling of tank T100');
    expect(q.sheets).toHaveLength(1);
    expect(q.sheets[0].layout.steps.map((g) => g.id).sort()).toEqual(['S0', 'S10', 'S20', 'S25', 'S30']);
    expect(q.inputs.map((i) => i.name)).toEqual(['START_CMD']);
  });
  it('builds step, action and transition rows', () => {
    const q = planExport(model, defaultExportConfig('pdf')).sequences[0];
    expect(q.steps[0]).toMatchObject({ step: 'S0', initial: true, description: 'Idle', actions: [] });
    const s10 = q.steps.find((s) => s.step === 'S10')!;
    expect(s10.monitoring).toBe('max 2min');
    expect(s10.actions[1]).toMatchObject({ q: 'N', target: 'FIC101:FIC101.MAN_VAL', value: '30', linked: true, summary: 'N FIC101:FIC101.MAN_VAL := 30' });
    expect(q.steps.find((s) => s.step === 'S20')!.actions[0]).toMatchObject({ linked: false, text: 'Inlet flow controller in cascade with LIC100' });
    expect(q.transitions[1]).toMatchObject({ label: 'S10 → S20 + S25', comment: 'Flow established', conditionKind: 'linked', sheet: 1 });
    expect(q.transitions[0].refs.map((r) => [r.text, r.at, r.scope])).toEqual([
      ['START_CMD', 0, undefined],
      ['LIC100:LAL100.QH', 18, 'LIC100'],
    ]);
    const words = loadProject({ ...files, [SEQ]: (files[SEQ] as string).replace('condition: P101:P101.RUNNING', 'condition: Pump is running') });
    expect(planExport(words, defaultExportConfig('pdf')).sequences[0].transitions[3]).toMatchObject({ conditionKind: 'words', refs: [] });
  });
  it('cross-references sequences and strategies', () => {
    const plan = planExport(model, defaultExportConfig('pdf'));
    const q = plan.sequences[0];
    expect(q.refs.filter((r) => r.kind === 'writes').map((r) => `${r.where} ${r.strategy}:${r.block}.${r.port}`)).toEqual([
      'S10 FIC101:FIC101.MAN_ON',
      'S10 FIC101:FIC101.MAN_VAL',
      'S30 P101:P101.START',
    ]);
    expect(q.refs.filter((r) => r.kind === 'reads').map((r) => `${r.where} ${r.strategy}`)).toEqual(['S0 → S10 LIC100', 'S10 → S20 + S25 FIC101', 'S20 + S25 → S30 LIC100', 'S30 → S0 P101']);
    const p101 = plan.strategies.find((s) => s.name === 'P101')!;
    expect(p101.sequenceRefs.map((r) => `${r.kind} ${r.block}.${r.port} ${r.where}`)).toEqual(['writes P101.START S30', 'reads P101.RUNNING S30 → S0']);
    const conns = p101.sheets.flatMap((s) => s.layout.connectors).filter((c) => c.kind === 'written-by' || c.kind === 'used-by');
    expect(conns.map((c) => `${c.kind} ${c.label} ${c.target?.strategy}`).sort()).toEqual(['used-by → FILL_T100 FILL_T100', 'written-by ← FILL_T100 FILL_T100']);
    // A strategy reading a step of the sequence.
    const P101 = `${U100}/P101.yaml`;
    const m2 = loadProject({ ...files, [P101]: (files[P101] as string).replace('  - P101.CMD -> P101_CMD.IN', '  - P101.CMD -> P101_CMD.IN\n  - FILL_T100:S30.X -> P101.PERM') });
    const p2 = planExport(m2, defaultExportConfig('pdf'));
    expect(p2.sequences[0].usedBy).toEqual([{ output: 'S30.X', strategy: 'P101', strategyFile: P101, input: 'P101.PERM' }]);
    expect(p2.strategies.find((s) => s.name === 'P101')!.links.find((l) => l.from === 'FILL_T100:S30.X')).toMatchObject({ external: true, signalType: 'BOOL' });
  });
  it('accepts sequence files in the export scope', () => {
    const plan = planExport(model, { ...defaultExportConfig('pdf'), strategies: [SEQ] });
    expect(plan.items.map((i) => i.name)).toEqual(['FILL_T100']);
    expect(plan.strategies).toEqual([]);
    expect(plan.types).toEqual([]);
    expect(plan.folders.map((f) => f.path)).toEqual(['ACME', 'ACME/Brno', 'ACME/Brno/WaterTreatment', 'ACME/Brno/WaterTreatment/U100']);
    const only = planExport(model, { ...defaultExportConfig('pdf'), strategies: [`${U100}/P101.yaml`] });
    expect(only.sequences).toEqual([]);
    expect(only.strategies[0].sequenceRefs).toHaveLength(2); // cross references stay, the viewer marks them as not exported
  });
  it('keeps sequence files and their description in viewer payloads', () => {
    const scoped = filesInScope(files, { ...defaultExportConfig('html'), strategies: [SEQ] });
    const readmes = Object.keys(files).filter((f) => f.startsWith('strategies/') && f.endsWith('README.md'));
    expect(Object.keys(scoped).filter((f) => f.startsWith('strategies/')).sort()).toEqual([`${U100}/FILL_T100.md`, SEQ, ...readmes].sort());
    expect(Object.keys(filesInScope(files, defaultExportConfig('html')))).toContain(SEQ);
    const p = payloadFiles(viewerPayload(files, { ...defaultExportConfig('html'), strategies: [SEQ] }, { projectName: 'x' }));
    expect(planExport(loadProject(p), defaultExportConfig('html')).sequences.map((s) => s.name)).toEqual(['FILL_T100']);
  });
  it('exports sequences as data (JSON / TOML)', () => {
    const data = projectData(files, defaultExportConfig('json'), '2026-11-04T00:00:00Z');
    const key = 'ACME/Brno/WaterTreatment/U100/FILL_T100';
    expect(Object.keys(data.sequences)).toEqual([key]);
    expect(data.sequences[key].doc).toContain('First filling of tank T100');
    expect((data.sequences[key].sequence as { sequence: string; steps: Record<string, unknown> }).sequence).toBe('FILL_T100');
    expect(Object.keys((data.sequences[key].sequence as { steps: Record<string, unknown> }).steps)).toEqual(['S0', 'S10', 'S20', 'S25', 'S30']);
    expect(data.strategies[key]).toBeUndefined();
    expect(Object.keys(data.strategies).sort()).toEqual(['FIC101', 'LIC100', 'P101'].map((n) => `ACME/Brno/WaterTreatment/U100/${n}`));
    const only = projectData(files, { ...defaultExportConfig('json'), strategies: [`${U100}/P101.yaml`] });
    expect(only.sequences).toEqual({});
    expect(projectDataToml(data)).toContain('[sequences."ACME/Brno/WaterTreatment/U100/FILL_T100".sequence]');
  });
});
