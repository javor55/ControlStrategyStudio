// Renders every sheet of the demo project (and composite internals) to out/.
// Usage: npm run demo
import { mkdirSync, writeFileSync } from 'node:fs';
import { demoProjectFiles, layoutDiagram, layoutSequence, loadProject } from '@csd/core';
import { renderSequenceSvg, renderSheetSvg } from '@csd/render';

const project = loadProject(demoProjectFiles());
mkdirSync('out', { recursive: true });
const parts: string[] = [];

for (const s of project.strategies) {
  const sheets = layoutDiagram(s, { defaultScan: s.scan, usedBy: (b, p) => project.usedBy(s.name).filter((r) => r.link.from.block === b && r.link.from.port === p).map((r) => r.strategy.name) });
  for (const l of sheets) {
    const name = `${s.name}-sheet${l.sheet}`;
    const svg = renderSheetSvg(l, { width: l.bounds.w, height: l.bounds.h, categories: project.meta.signalCategories });
    writeFileSync(`out/${name}.svg`, svg);
    const title = s.sheets.find((x) => x.id === l.sheet)?.title ?? '';
    parts.push(`<h2>${s.name} — ${s.title ?? ''} · sheet ${l.sheet} ${title}</h2>${svg}`);
  }
}
for (const q of project.sequences) {
  for (const l of layoutSequence(q)) {
    const svg = renderSequenceSvg(l, { width: l.bounds.w, height: l.bounds.h });
    writeFileSync(`out/${q.name}-sheet${l.sheet}.svg`, svg);
    parts.push(`<h2>${q.name} — ${q.title ?? ''} (sequence) · sheet ${l.sheet}</h2>${svg}`);
  }
}
for (const t of project.types.all.filter((t) => t.diagram)) {
  for (const l of layoutDiagram(t.diagram!, { composite: t })) {
    const svg = renderSheetSvg(l, { width: l.bounds.w, height: l.bounds.h });
    writeFileSync(`out/${t.type}@${t.version}.svg`, svg);
    parts.push(`<h2>${t.library}/${t.type}@${t.version} (composite)</h2>${svg}`);
  }
}
writeFileSync('out/index.html', `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;background:#f3f4f2">${parts.join('\n')}</body>`);

console.log(`Strategies: ${project.strategies.length}, block types: ${project.types.all.length}`);
console.log(`Diagnostics: ${project.diags.length}`);
for (const d of project.diags) console.log(`  ${d.severity.padEnd(7)} ${d.code.padEnd(22)} ${d.file}:${d.line ?? '-'}  ${d.message}`);
