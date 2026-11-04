import { describe, expect, it } from 'vitest';
import { renderSequenceSvg, renderSheetSvg } from '@csd/render';
import { defaultExportConfig, planExport, renderChartSvg } from '@csd/export';
import { wireViolations } from './wirecheck';
import { demoProjectFiles, exampleProjects, feedbackOrders, layoutDiagram, layoutSequence, loadProject } from '../src';

type Box = { id: string; x: number; y: number; w: number; h: number };

function overlaps(boxes: Box[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) out.push(`${a.id} / ${b.id}`);
    }
  return out;
}

describe('example projects', () => {
  const examples = exampleProjects();

  it('starts with the demo project and has unique ids', () => {
    expect(examples[0].id).toBe('water-treatment');
    expect(examples[0].files()).toEqual(demoProjectFiles());
    expect(new Set(examples.map((e) => e.id)).size).toBe(examples.length);
    for (const e of examples) expect(e.name && e.description).toBeTruthy();
  });

  for (const ex of examples) {
    describe(ex.name, () => {
      const files = ex.files();
      const p = loadProject(files);

      it('loads without errors and warnings', () => {
        expect(p.diags.filter((d) => d.severity !== 'info')).toEqual([]);
        expect(p.meta.name).toBe(ex.name);
      });

      it('lays out every strategy, sequence and composite without overlapping blocks', () => {
        for (const s of p.strategies) {
          const sheets = layoutDiagram(s);
          expect(sheets.length, s.name).toBe(s.sheets.length);
          for (const l of sheets) expect(overlaps(l.blocks), `${s.name} sheet ${l.sheet}`).toEqual([]);
        }
        for (const q of p.sequences) {
          for (const l of layoutSequence(q)) {
            const boxes = [
              ...l.steps.map((g) => ({ id: g.id, x: g.x, y: g.y, w: g.w, h: g.h })),
              ...l.steps.filter((g) => g.actionBox).map((g) => ({ id: `${g.id} actions`, ...g.actionBox! })),
            ];
            expect(overlaps(boxes), `${q.name} sheet ${l.sheet}`).toEqual([]);
          }
        }
        for (const t of p.types.all.filter((t) => t.diagram)) {
          for (const l of layoutDiagram(t.diagram!, { composite: t })) expect(overlaps(l.blocks), `${t.library}/${t.type}`).toEqual([]);
        }
      });

      it('routes wires around blocks and never on top of another signal', () => {
        const bad: string[] = [];
        for (const s of p.strategies) {
          const ctx = {
            usedBy: (b: string, port: string) => [
              ...p.usedBy(s.name, b).filter((r) => r.link.from.port === port).map((r) => r.strategy.name),
              ...p.sequenceRefs(s.name, b).filter((r) => r.kind === 'reads' && r.port === port).map((r) => r.sequence),
            ],
            writtenBy: (b: string, port: string) => p.sequenceRefs(s.name, b).filter((r) => r.kind === 'writes' && r.port === port).map((r) => r.sequence),
          };
          for (const l of layoutDiagram(s, ctx)) bad.push(...wireViolations(l, `${s.name}/${l.sheet}`));
        }
        for (const t of p.types.all.filter((t) => t.diagram)) for (const l of layoutDiagram(t.diagram!, { composite: t })) bad.push(...wireViolations(l, t.type));
        expect(bad).toEqual([]);
      });

      it('renders every sheet to SVG', () => {
        for (const s of p.strategies) {
          for (const l of layoutDiagram(s)) {
            const svg = renderSheetSvg(l, { width: l.bounds.w, height: l.bounds.h, categories: p.meta.signalCategories });
            expect(svg.startsWith('<svg'), s.name).toBe(true);
            for (const b of l.blocks) expect(svg).toContain(b.id);
          }
        }
        for (const q of p.sequences) {
          for (const l of layoutSequence(q)) {
            const svg = renderSequenceSvg(l, { width: l.bounds.w, height: l.bounds.h });
            for (const g of l.steps) expect(svg).toContain(g.id);
          }
        }
      });

      it('renders the charts of its documentation', () => {
        for (const [file, text] of Object.entries(files)) {
          if (!file.endsWith('.md') || typeof text !== 'string') continue;
          for (const m of text.matchAll(/```chart\n([\s\S]*?)```/g)) expect(renderChartSvg(m[1]), file).not.toHaveProperty('error');
        }
      });

      it('plans a PDF export of the whole project', () => {
        const plan = planExport(p, defaultExportConfig('pdf'), { date: '2026-11-04' });
        expect(plan.strategies.map((s) => s.name).sort()).toEqual(p.strategies.map((s) => s.name).sort());
        expect(plan.sequences.map((s) => s.name).sort()).toEqual(p.sequences.map((s) => s.name).sort());
        for (const s of plan.strategies) expect(s.sheets.length, s.name).toBeGreaterThan(0);
      });
    });
  }
});

describe('Dosing & CIP example', () => {
  const ex = exampleProjects().find((e) => e.id === 'dosing-cip')!;
  const p = loadProject(ex.files());

  it('has the ISA-88 hierarchy with documented folders', () => {
    const units = p.strategies.map((s) => s.folder).concat(p.sequences.map((q) => q.folder));
    expect([...new Set(units)].sort()).toEqual(['ACME/Ostrava/CIP/U310', 'ACME/Ostrava/Dosing/U210', 'ACME/Ostrava/Dosing/U220', 'ACME/Ostrava/Utilities/U110']);
    const walk = (n: typeof p.root): string[] => [n.path, ...n.folders.flatMap(walk)];
    for (const path of walk(p.root).filter(Boolean)) expect(p.files[`strategies/${path}/README.md`], path).toBeTypeOf('string');
    expect(p.root.folders[0].folders[0].folders.map((f) => f.level)).toEqual(['Area', 'Area', 'Area']);
  });

  it('uses the company library: composites, a basic block with SCL', () => {
    const acme = p.libraries.find((l) => l.folder === 'acme')!;
    expect(acme.types.map((t) => `${t.type}:${t.kind}`).sort()).toEqual(['AI_2OO3:composite', 'DUTY_STANDBY:composite', 'TANK_VOL:basic']);
    expect(acme.types.find((t) => t.type === 'TANK_VOL')!.implementation?.language).toBe('SCL');
    const used = new Set(p.strategies.flatMap((s) => s.blocks.map((b) => b.def && `${b.def.library}/${b.def.type}`)));
    for (const t of ['acme/DUTY_STANDBY', 'acme/AI_2OO3', 'acme/TANK_VOL']) expect(used.has(t), t).toBe(true);
  });

  it('shows interlocks, alarms, tracking feedback and cross references', () => {
    const links = p.strategies.flatMap((s) => s.links.map((l) => ({ s, l })));
    for (const c of ['interlock', 'alarm', 'tracking']) expect(links.some(({ l }) => l.category === c), c).toBe(true);
    const feedback = p.strategies.filter((s) => s.links.some((l) => feedbackOrders(s, l))).map((s) => s.name);
    expect(feedback).toEqual(expect.arrayContaining(['FIC211', 'FFIC214', 'FIC311']));
    const dutyStandby = p.types.resolve('acme/DUTY_STANDBY').def!.diagram!;
    expect(dutyStandby.links.filter((l) => feedbackOrders(dutyStandby, l))).toHaveLength(2);
    // Strategies read sequence signals, and sequences write strategy inputs.
    expect(p.usedBy('BATCH_T210').map((r) => r.strategy.name)).toContain('XV217');
    expect(p.usedBy('CIP_T210').map((r) => r.strategy.name).sort()).toEqual(['QIC313', 'QIC313', 'XV217', 'XV217', 'XV217']);
    expect([...new Set(p.sequenceRefs('TIC213').filter((r) => r.kind === 'writes').map((r) => `${r.sequence}→${r.port}`))].sort()).toEqual(['BATCH_T210→SP_EXT', 'BATCH_T210→SP_EXT_ON']);
    expect(p.strategies.some((s) => s.blocks.some((b) => b.display?.params === false))).toBe(true);
  });

  it('uses parallel and alternative branches and monitoring times', () => {
    const batch = p.sequenceByName.get('BATCH_T210')!;
    expect(batch.transitions.some((t) => t.to.length > 1)).toBe(true);
    expect(batch.transitions.some((t) => t.from.length > 1)).toBe(true);
    expect(batch.transitions.filter((t) => t.from.join() === 'S50')).toHaveLength(2);
    expect(batch.steps.find((s) => s.id === 'S50')!.time).toEqual({ min: '30min', max: '4h' });
    const quals = new Set(p.sequences.flatMap((q) => q.steps.flatMap((s) => s.actions.map((a) => a.q))));
    for (const q of ['N', 'S', 'R', 'P1', 'D', 'L']) expect(quals.has(q as never), q).toBe(true);
  });
});
