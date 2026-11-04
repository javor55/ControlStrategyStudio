// PDF writer: draws an ExportPlan as a landscape A3 / A4 document with frame
// and title block on every page. Needs a DOM (svg2pdf parses SVG elements).
//
//   const blob = await exportPdf(planExport(model, config), { files: model.files });
import { jsPDF } from 'jspdf';
import type { Files } from '@csd/core';
import { PRINT_THEME, renderSheetSvg, type Theme } from '@csd/render';
import { exportRenderOptions, type ExportPlan, type FolderPlan, type SheetPlan, type StrategyPlan, type TypePlan } from '../plan';
import { APP_LOGO_SVG } from '../logo';
import { MONO, registerFonts, SANS } from './fonts';
import { fitBox, hierarchyPath, normalizePath, pagesFor, sniffImage } from './util';
import { C, PT, PX, rgb, Writer, type Ctx, type PageInfo } from './writer';

export interface PdfOptions {
  files: Files;
  onProgress?: (done: number, total: number) => void;
}

/** Print theme with the embedded fonts (svg2pdf maps font-family to jsPDF fonts). */
export const PDF_THEME: Theme = { ...PRINT_THEME, fontSans: SANS, fontMono: MONO };

interface Entry {
  depth: number;
  text: string;
  mono?: string;
  page: number;
  bold?: boolean;
  /** Outline (bookmark) parent key and own key. */
  parent?: string;
  key?: string;
}

const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));

const typeLabel = (t: TypePlan) => `${t.def.library}/${t.def.type}@${t.def.version}`;

export async function exportPdf(plan: ExportPlan, opts: PdfOptions): Promise<Blob> {
  const paper = plan.config.paper === 'A4' ? 'a4' : 'a3';
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: paper, compress: true, putOnlyUsedFonts: true });
  const coverage = await registerFonts(doc);
  const w = new Writer(doc, plan.config.paper, coverage, opts.files);
  const sec = plan.config.sections;
  const total = plan.strategies.length + (sec.library ? plan.types.length : 0) + 2;
  let done = 0;
  const progress = () => opts.onProgress?.(++done, total);

  doc.setProperties({ title: plan.meta.name, subject: 'Control strategies', author: plan.author ?? '', creator: 'Control Strategy Studio' });
  const entries: Entry[] = [];
  const subEntries = new Map<string, { title: string; page: number }[]>();
  const sub = (key: string, title: string) => {
    const list = subEntries.get(key) ?? [];
    list.push({ title, page: w.page });
    subEntries.set(key, list);
  };
  const base: Omit<PageInfo, 'section' | 'document'> = {};

  // 1. Cover ---------------------------------------------------------------
  let front = 0;
  if (sec.cover) {
    w.newPage({ ...base, section: 'cover', document: plan.meta.name, title: 'Cover sheet' });
    await cover(w, plan, opts.files);
    front = doc.getNumberOfPages();
  }
  progress();

  // 2. Content (contents pages are inserted afterwards) -------------------
  // Revision history comes first, so it directly follows the cover and contents.
  if (plan.history.length) {
    w.newPage({ section: 'history', document: plan.meta.name, title: 'Revision history' });
    entries.push({ depth: 0, text: 'Revision history', page: w.page, bold: true, key: 'history' });
    revisionHistory(w, plan);
  }
  if (plan.projectReadme) {
    w.newPage({ section: 'project', document: plan.meta.name, title: 'Project description' });
    entries.push({ depth: 0, text: 'Project description', page: w.page, bold: true, key: 'project' });
    await w.markdown(plan.projectReadme.markdown, { ...w.ctx(), file: plan.projectReadme.file });
  }

  const byFile = new Map(plan.strategies.map((s) => [s.file, s]));
  const printed = new Set<string>();
  const minDepth = Math.min(...plan.folders.filter((f) => f.path).map((f) => f.depth), 99);
  let lastWasFolder = false;
  for (const folder of plan.folders) {
    const depth = folder.path ? folder.depth - minDepth : 0;
    const key = `folder:${folder.path}`;
    const parent = parentFolderKey(plan.folders, folder);
    if (folder.path) {
      const label = folder.level ? `${folder.level} ${folder.name}` : folder.name;
      if (folder.readme) {
        const info: PageInfo = { section: 'folder', document: label, title: 'Description', hierarchy: folder.path.split('/').join(' / ') };
        if (lastWasFolder && w.remaining > 60) {
          w.info = info;
          w.y += 6;
        } else w.newPage(info);
        entries.push({ depth, text: label, page: w.page, bold: true, key, parent });
        w.eyebrow(`${folder.level ?? 'Folder'} · ${folder.path.split('/').join(' / ')}`);
        await w.markdown(folder.readme.markdown, { ...w.ctx(), file: folder.readme.file });
        lastWasFolder = true;
      } else {
        // Points at its first content (next page written).
        entries.push({ depth, text: label, page: -1, bold: true, key, parent });
      }
    }
    for (const file of folder.strategies) {
      const s = byFile.get(file);
      if (!s || printed.has(file)) continue;
      printed.add(file);
      const first = await strategy(w, plan, s, folder.path ? depth + 1 : 0, key, entries, sub);
      if (first) lastWasFolder = false;
      progress();
      await yieldToBrowser();
    }
  }
  for (const s of plan.strategies) {
    if (printed.has(s.file)) continue;
    await strategy(w, plan, s, 0, undefined, entries, sub);
    progress();
    await yieldToBrowser();
  }

  // 3. Library appendix -----------------------------------------------------
  if (sec.library && plan.types.length) {
    w.newPage({ section: 'library', document: 'Library appendix', title: 'Block types used' });
    entries.push({ depth: 0, text: 'Library appendix', page: w.page, bold: true, key: 'library' });
    w.heading('Library appendix', 1, w.fullCtx);
    w.para(`Interfaces of the ${plan.types.length} block types used by the exported strategies. Pins marked “connected” are drawn only when the input is linked or set.`, w.ctx(), { color: C.muted, size: 9 });
    for (const t of plan.types) {
      await libraryType(w, plan, t, entries);
      progress();
      await yieldToBrowser();
    }
  }

  // Folder entries without README point at their first content.
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].page < 0) entries[i].page = entries[i + 1]?.page ?? doc.getNumberOfPages();
  w.sync();

  // 4. Contents: written at the end, moved behind the cover ---------------
  let shift = 0;
  if (sec.contents && entries.length) {
    shift = contentsPageCount(w, entries.length);
    for (const e of entries) if (e.page > front) e.page += shift;
    for (const list of subEntries.values()) for (const e of list) if (e.page > front) e.page += shift;
    const firstNew = w.isFresh ? 1 : doc.getNumberOfPages() + 1;
    contents(w, plan, entries, shift);
    w.sync();
    const contentsInfos = w.pages.slice(firstNew - 1);
    w.pages = [...w.pages.slice(0, front), ...contentsInfos, ...w.pages.slice(front, firstNew - 1)];
    for (let i = 0; i < shift; i++) if (firstNew + i !== front + 1 + i) doc.movePage(firstNew + i, front + 1 + i);
  }

  // 5. Frames, title blocks, bookmarks -------------------------------------
  const logo = projectLogo(plan, opts.files, doc);
  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p);
    await titleBlock(w, plan, w.pages[p - 1] ?? w.info, p, n, logo);
  }
  outline(doc, front, shift, entries, subEntries);
  progress();
  return doc.output('blob');
}

function parentFolderKey(folders: FolderPlan[], f: FolderPlan): string | undefined {
  const i = f.path.lastIndexOf('/');
  if (i < 0) return undefined;
  const p = f.path.slice(0, i);
  return folders.some((x) => x.path === p) ? `folder:${p}` : undefined;
}

// ---------------------------------------------------------------------------
// Cover
// ---------------------------------------------------------------------------

async function cover(w: Writer, plan: ExportPlan, files: Files) {
  const { geo, doc } = w;
  const x = geo.left + 4;
  let y = geo.top + 14;
  const logo = projectLogo(plan, files, w.doc);
  const logoBox = geo.paper === 'A3' ? 34 : 26;
  await drawLogo(w, logo, x, y, logoBox, logoBox);
  const tx = x + logoBox + 10;
  const big = geo.paper === 'A3' ? 30 : 24;
  w.text('Control strategies', tx, y + 6, { size: 10, color: C.accent, style: 'bold' });
  w.text(plan.meta.name, tx, y + 6 + big * PT * 1.05, { size: big, style: 'bold', maxWidth: geo.right - tx });
  y += Math.max(logoBox, 6 + big * PT * 1.3) + 6;
  w.y = y;
  const ctx: Ctx = { x: tx, width: Math.min(geo.right - tx, 230) };
  if (plan.meta.description) w.para(plan.meta.description, ctx, { size: 12, color: C.ink, gapAfter: 6 });
  w.y += 4;

  const scope = plan.config.strategies.length ? `${plan.strategies.length} selected ${plan.strategies.length === 1 ? 'strategy' : 'strategies'}` : `All strategies (${plan.strategies.length})`;
  const sections = Object.entries(plan.config.sections)
    .filter(([, v]) => v)
    .map(([k]) => SECTION_NAMES[k] ?? k);
  const rows: [string, string][] = [
    ['Author', plan.author ?? '—'],
    ['Revision', plan.revision ?? '—'],
    ['Date', plan.date],
    ['Scope', scope],
    ['Folders', plan.folders.filter((f) => f.path).length ? String(plan.folders.filter((f) => f.path).length) : '—'],
    ['Block types', String(plan.types.length)],
    ['Contents', sections.join(', ')],
    ['Paper', `${plan.config.paper} landscape`],
  ];
  for (const [k, v] of rows) {
    const lines = w.split(v, ctx.width - 40, SANS, 'normal', 10);
    w.text(k, ctx.x, w.y + 4, { size: 8.5, color: C.muted });
    lines.forEach((l, i) => w.text(l, ctx.x + 40, w.y + 4 + i * 5, { size: 10 }));
    w.y += Math.max(1, lines.length) * 5 + 1.5;
  }
  w.y += 6;

  // Problems summary.
  const { errors, warnings, items } = plan.diags;
  const color = errors ? C.error : warnings ? C.warning : '#2f7d4a';
  doc.setFillColor(...rgb(color));
  doc.circle(ctx.x + 1.6, w.y + 2.9, 1.6, 'F');
  w.text(`${errors ? `${errors} error${errors === 1 ? '' : 's'}` : 'No errors'}, ${warnings} warning${warnings === 1 ? '' : 's'}`, ctx.x + 5, w.y + 4, { size: 10.5, style: 'bold', color });
  w.y += 7;
  const errs = items.filter((d) => d.severity === 'error');
  if (errs.length) {
    const max = 25;
    const body = errs.slice(0, max).map((d) => [d.file ? `${d.file}${d.line ? `:${d.line}` : ''}` : '', d.message]);
    if (errs.length > max) body.push(['', `… and ${errs.length - max} more`]);
    w.table({ ctx: { x: ctx.x, width: Math.min(geo.right - ctx.x, 300) }, head: [['File', 'Error']], body, columnStyles: { 0: { font: MONO, cellWidth: 90 } } });
  } else if (warnings) {
    w.para('Warnings are listed with each strategy.', ctx, { size: 9, color: C.muted });
  }
}

const SECTION_NAMES: Record<string, string> = {
  cover: 'cover',
  contents: 'contents',
  projectReadme: 'project description',
  folderReadmes: 'folder descriptions',
  functionDescription: 'function descriptions',
  diagrams: 'diagrams',
  blockSettings: 'block settings',
  links: 'links',
  library: 'library appendix',
  librarySource: 'implementation source',
  history: 'revision history',
};

// ---------------------------------------------------------------------------
// Revision history
// ---------------------------------------------------------------------------

function revisionHistory(w: Writer, plan: ExportPlan) {
  const ctx = w.fullCtx;
  w.heading('Revision history', 1, ctx);
  const revisions = plan.history.filter((h) => h.tags.length).length;
  w.para(
    `${plan.history.length} ${plan.history.length === 1 ? 'commit' : 'commits'}${revisions ? `, ${revisions} marked as ${revisions === 1 ? 'revision' : 'revisions'}` : ''}, newest first.`,
    w.ctx(),
    { size: 9, color: C.muted },
  );
  if (plan.uncommitted) {
    w.para('Exported with uncommitted changes: the content of this document is newer than the last commit listed below.', w.ctx(), { size: 9.5, style: 'bold', color: C.warning, gapAfter: 3 });
  }
  const revLabel = (t: string) => t.replace(/^rev-/i, '');
  w.table({
    ctx,
    head: [['Revision', 'Date', 'Author', 'Summary', 'Commit']],
    body: plan.history.map((h) => [h.tags.map(revLabel).join(', '), h.date, h.author, h.message.split('\n').filter((l, i) => i === 0 || l.trim()).join('\n'), h.oid.slice(0, 7)]),
    columnStyles: {
      0: { cellWidth: 22, fontStyle: 'bold' },
      1: { cellWidth: 22 },
      2: { cellWidth: ctx.width * 0.16 },
      4: { cellWidth: 18, font: MONO, textColor: rgb(C.muted) },
    },
    keep: 20,
    cellHook: (d) => {
      if (d.section !== 'body') return;
      const h = plan.history[d.row.index];
      if (d.column.index === 0 && h.tags.length) d.cell.styles.textColor = rgb(C.accent);
    },
  });
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

function strategyInfo(plan: ExportPlan, s: StrategyPlan, title: string): PageInfo {
  return {
    section: 'strategy',
    document: s.title ? `${s.name} — ${s.title}` : s.name,
    title,
    hierarchy: hierarchyPath(s.hierarchy),
    revision: plan.config.titleBlock.revision || s.revision || plan.revision,
    drawn: plan.meta.titleBlock.drawn || s.author || plan.author,
  };
}

/** Writes all parts of a strategy; returns false when nothing was printed. */
async function strategy(
  w: Writer,
  plan: ExportPlan,
  s: StrategyPlan,
  depth: number,
  parent: string | undefined,
  entries: Entry[],
  sub: (key: string, title: string) => void,
): Promise<boolean> {
  const sec = plan.config.sections;
  const key = `strategy:${s.file}`;
  let started = false;
  const start = (title: string) => {
    if (!started) entries.push({ depth, text: s.title ?? '', mono: s.name, page: w.page, key, parent });
    started = true;
    sub(key, title);
  };

  if (sec.functionDescription) {
    w.newPage(strategyInfo(plan, s, 'Function description'));
    start('Function description');
    strategyHeader(w, plan, s);
    if (s.doc) await w.markdown(s.doc.markdown, { ...w.ctx(), file: s.doc.file }, { headingOffset: 0 });
    if (s.blocks.length) {
      w.heading('Blocks', 2, w.fullCtx, { keep: 20 });
      w.table({
        head: [['Block', 'Type', 'Description', 'Purpose']],
        body: s.blocks.map((b) => [b.id, b.type, b.description ?? '', [b.doc, b.doc ? '' : b.typeDescription ? `(${b.typeDescription})` : ''].filter(Boolean).join('')]),
        columnStyles: { 0: { font: MONO, fontStyle: 'bold', cellWidth: 34 }, 1: { font: MONO, cellWidth: 38 }, 2: { cellWidth: 90 } },
        cellHook: (d) => {
          if (d.section === 'body' && d.column.index === 3 && !s.blocks[d.row.index].doc) d.cell.styles.textColor = rgb(C.muted);
        },
      });
    }
  }

  if (sec.diagrams) {
    for (const sh of s.sheets) {
      const n = s.sheets.length;
      const title = `Sheet ${sh.id}${n > 1 ? ` of ${n}` : ''}${sh.title ? ` — ${sh.title}` : ''}`;
      w.newPage(strategyInfo(plan, s, title));
      start(title);
      await diagramPage(w, plan, sh, s.name, `${s.title ? `${s.title} · ` : ''}${title}`, hierarchyPath(s.hierarchy));
    }
  }

  if (sec.blockSettings) {
    w.newPage(strategyInfo(plan, s, 'Block settings'));
    start('Block settings');
    w.heading('Block settings', 1, w.fullCtx, { mono: `${s.name} ·` });
    w.para(plan.config.parameters === 'set' ? 'Values set in the strategy (bold) and linked inputs (←). Unlisted parameters keep their defaults.' : 'All parameters; values set in the strategy are bold, linked inputs show their source (←).', w.ctx(), { size: 8.5, color: C.muted });
    for (const b of s.blocks) blockSettings(w, b, plan);
  }

  if (sec.links) {
    if (!started || w.remaining < 70 || !sec.blockSettings) w.newPage(strategyInfo(plan, s, 'Links and cross references'));
    else {
      w.info = strategyInfo(plan, s, 'Block settings, links');
      w.pages[w.page - 1] = w.info;
      w.y += 6;
    }
    start('Links and cross references');
    links(w, plan, s);
  }
  return started;
}

function strategyHeader(w: Writer, plan: ExportPlan, s: StrategyPlan) {
  const ctx = w.fullCtx;
  if (s.hierarchy.length) w.eyebrow(s.hierarchy.map((h) => (h.level ? `${h.level} ${h.name}` : h.name)).join('  ›  '));
  w.heading(s.title ? `— ${s.title}` : '', 1, ctx, { mono: s.name });
  if (s.description) w.para(s.description, w.ctx(), { size: 10.5, gapAfter: 2 });
  const facts = [
    s.scan ? `Scan ${s.scan}` : undefined,
    s.revision ? `Revision ${s.revision}` : undefined,
    s.author ? `Author ${s.author}` : undefined,
    `${s.blocks.length} block${s.blocks.length === 1 ? '' : 's'}`,
    `${s.links.length} link${s.links.length === 1 ? '' : 's'}`,
    `${s.sheets.length} sheet${s.sheets.length === 1 ? '' : 's'}`,
    s.usedBy.length ? `used by ${[...new Set(s.usedBy.map((u) => u.strategy))].join(', ')}` : undefined,
    `file ${s.file}`,
  ].filter(Boolean);
  w.para(facts.join('  ·  '), w.fullCtx, { size: 8.5, color: C.muted, gapAfter: 3 });
  const problems = s.diags.filter((d) => d.severity !== 'info');
  if (problems.length) {
    const errs = problems.filter((d) => d.severity === 'error').length;
    w.box(
      `Problems: ${errs} error${errs === 1 ? '' : 's'}, ${problems.length - errs} warning${problems.length - errs === 1 ? '' : 's'}`,
      problems.map((d) => `${d.severity === 'error' ? 'Error' : 'Warning'}${d.line ? ` (line ${d.line})` : ''}: ${d.message}`),
      w.ctx(),
      { color: errs ? C.error : C.warning },
    );
  }
  w.y += 2;
}

// ---------------------------------------------------------------------------
// Diagram sheets
// ---------------------------------------------------------------------------

async function diagramPage(w: Writer, plan: ExportPlan, sheet: SheetPlan, name: string, title: string, sub: string) {
  const { geo } = w;
  const yTitle = geo.top + 4;
  w.text(name, geo.left, yTitle, { family: MONO, style: 'bold', size: 12 });
  w.font(MONO, 'bold', 12);
  const nx = geo.left + w.doc.getTextWidth(w.clean(name, MONO)) + 3;
  w.text(title, nx, yTitle, { size: 11, maxWidth: geo.right - nx });
  if (sub) w.text(sub, geo.right, yTitle, { size: 8, color: C.muted, align: 'right' });
  const area = { x: geo.left, y: geo.top + 9, w: geo.right - geo.left, h: geo.bottom - geo.top - 9 };
  // On paper the ▾ of expanded parameters cannot be clicked: drop it (collapsed blocks keep their "N parameters" line).
  const layout = sheet.layout; // exportRenderOptions() turns off the expand / collapse arrows
  const svg = renderSheetSvg(layout, { ...exportRenderOptions(plan), theme: PDF_THEME, background: false });
  const b = sheet.layout.bounds;
  const f = fitBox(b.w, b.h, area.w, area.h, 1.6 * PX);
  if (!f.w) return;
  const x = area.x + (area.w - f.w) / 2;
  const y = area.y + (area.h - f.h) / 2;
  await w.svg(svg, x, y, f.w, f.h);
  if (f.scale < PX * 0.55) w.text(`Scale ${Math.round((f.scale / PX) * 100)} %`, geo.left, geo.bottom + 3, { size: 6.5, color: C.muted });
}

// ---------------------------------------------------------------------------
// Block settings
// ---------------------------------------------------------------------------

const BLOCK_FIELDS: [label: string, frac: number][] = [
  ['Order', 0.05],
  ['Block', 0.11],
  ['Type', 0.12],
  ['Scan', 0.085],
  ['Sheet', 0.135],
  ['Description', 0.25],
  ['Comment', 0.25],
];

function blockSettings(w: Writer, b: StrategyPlanBlock, plan: ExportPlan) {
  const ctx = w.fullCtx;
  const { doc } = w;
  const values = [
    b.order !== undefined ? String(b.order) : '—',
    b.id,
    b.type,
    b.scan ? (b.scanInherited ? `(${b.scan})` : b.scan) : '—',
    `${b.sheet}${b.sheetTitle ? ` ${b.sheetTitle}` : ''}`,
    b.description ?? '',
    b.comment ?? '',
  ];
  const size = 8.5;
  const lh = size * PT * 1.3;
  const cols = BLOCK_FIELDS.map(([label, frac], i) => {
    const cw = ctx.width * frac;
    const mono = i === 1 || i === 2;
    const lines = values[i] ? w.split(values[i], cw - 3, mono ? MONO : SANS, i === 1 ? 'bold' : 'normal', size) : [];
    return { label, cw, mono, lines };
  });
  const h = 5 + Math.max(1, ...cols.map((c) => c.lines.length)) * lh + 1.2;
  const rowsShown = Math.min(3, Math.max(1, b.params.length));
  w.ensure(h + (b.params.length ? 6 + rowsShown * 5 : 6) + 2);
  w.y += 2;
  let x = ctx.x;
  doc.setFillColor(...rgb(C.tint));
  doc.setDrawColor(...rgb(C.rule));
  doc.setLineWidth(0.15);
  doc.rect(ctx.x, w.y, ctx.width, h, 'FD');
  for (const c of cols) {
    if (x > ctx.x) doc.line(x, w.y, x, w.y + h);
    w.text(c.label, x + 1.5, w.y + 2.9, { size: 6, color: C.muted });
    c.lines.forEach((l, i) =>
      w.text(l, x + 1.5, w.y + 5 + lh * 0.75 + i * lh, {
        family: c.mono ? MONO : SANS,
        style: c.label === 'Block' ? 'bold' : 'normal',
        size,
        color: c.label === 'Scan' && b.scanInherited ? C.muted : C.ink,
      }),
    );
    x += c.cw;
  }
  w.y += h;
  if (!b.params.length) {
    w.text(plan.config.parameters === 'set' ? 'No parameters set — type defaults apply.' : 'The block type has no parameters.', ctx.x + 1.5, w.y + 4, { size: 8, style: 'italic', color: C.muted });
    w.y += 6.5;
    return;
  }
  const rows = b.params;
  w.table({
    // Only what the strategy sets (and linked inputs) — type defaults belong to the library appendix.
    head: [['Name', 'Kind', 'Value', 'Unit', 'Description']],
    body: rows.map((p) => [p.name, p.kind === 'input' ? 'input' : 'param', p.linkedFrom ? `← ${p.linkedFrom}${p.value !== undefined ? `  (${p.value})` : ''}` : (p.value ?? ''), p.unit ?? '', p.description ?? '']),
    columnStyles: {
      0: { font: MONO, cellWidth: ctx.width * 0.14 },
      1: { cellWidth: ctx.width * 0.055, textColor: rgb(C.muted) },
      2: { cellWidth: ctx.width * 0.22 },
      3: { cellWidth: ctx.width * 0.07 },
    },
    headStyles: { fillColor: [255, 255, 255], textColor: rgb(C.muted), fontStyle: 'bold', fontSize: 7 },
    cellHook: (d) => {
      if (d.section !== 'body' || d.column.index !== 2) return;
      const p = rows[d.row.index];
      if (p.linkedFrom) {
        d.cell.styles.font = MONO;
        d.cell.styles.textColor = rgb(C.accent);
      } else if (p.set) d.cell.styles.fontStyle = 'bold';
    },
  });
  w.y -= 1;
}

type StrategyPlanBlock = StrategyPlan['blocks'][number];

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function links(w: Writer, plan: ExportPlan, s: StrategyPlan) {
  w.heading('Links and cross references', 1, w.fullCtx, { mono: `${s.name} ·` });
  if (!s.links.length) w.para('The strategy has no links.', w.ctx(), { size: 9, color: C.muted });
  else {
    const notes = (l: StrategyPlan['links'][number]) =>
      [
        l.feedback ? `z⁻¹ value from previous cycle (#${l.feedback.sourceOrder} ≥ #${l.feedback.targetOrder})` : '',
        l.crossSheet ? 'other sheet' : '',
        l.external ? 'other strategy' : '',
      ]
        .filter(Boolean)
        .join('; ');
    const ctx = w.fullCtx;
    w.table({
      head: [['#', 'From', 'To', 'Signal', 'Type', 'Category', 'Comment', 'Notes']],
      body: s.links.map((l) => [String(l.index + 1), l.from, l.to, l.label ?? '', l.signalType ?? '', l.category ?? '', l.comment ?? '', notes(l)]),
      columnStyles: {
        0: { cellWidth: 8, halign: 'right', textColor: rgb(C.muted) },
        1: { font: MONO, cellWidth: ctx.width * 0.15 },
        2: { font: MONO, cellWidth: ctx.width * 0.15 },
        3: { font: MONO, cellWidth: ctx.width * 0.09 },
        4: { font: MONO, cellWidth: ctx.width * 0.05 },
        5: { cellWidth: ctx.width * 0.07 },
        6: { cellWidth: ctx.width * 0.2 },
      },
      keep: 25,
      cellHook: (d) => {
        if (d.section !== 'body') return;
        const l = s.links[d.row.index];
        if (d.column.index === 5 && l.category) d.cell.styles.textColor = rgb(plan.categories[l.category]?.color ?? C.ink);
        if (d.column.index === 1 && l.external) d.cell.styles.textColor = rgb('#8a5a12');
        if (d.column.index === 7 && l.feedback) d.cell.styles.textColor = rgb(C.accent);
      },
    });
  }
  w.heading('Signals used by other strategies', 2, w.fullCtx, { keep: 16 });
  if (!s.usedBy.length) w.para('No other strategy reads signals of this strategy.', w.ctx(), { size: 9, color: C.muted });
  else
    w.table({
      ctx: w.ctx(),
      head: [['Output', 'Used by strategy', 'Input']],
      body: s.usedBy.map((u) => [`${s.name}:${u.output}`, u.strategy, u.input]),
      columnStyles: { 0: { font: MONO }, 1: { font: MONO, fontStyle: 'bold' }, 2: { font: MONO } },
      keep: 16,
    });
}

// ---------------------------------------------------------------------------
// Library appendix
// ---------------------------------------------------------------------------

async function libraryType(w: Writer, plan: ExportPlan, t: TypePlan, entries: Entry[]) {
  const label = typeLabel(t);
  const d = t.def;
  w.info = { section: 'library', document: 'Library appendix', title: label };
  if (w.remaining < 80) w.newPage();
  else {
    if (w.pages[w.page - 1]?.section === 'library' && w.pages[w.page - 1].title !== 'Block types used') w.pages[w.page - 1] = { ...w.info, title: 'Block types' };
    w.y += 4;
  }
  entries.push({ depth: 1, text: '', mono: label, page: w.page, parent: 'library' });
  w.heading('', 2, w.fullCtx, { mono: label, keep: 30 });
  const facts = [d.category, d.kind === 'composite' ? 'composite block' : 'basic block', t.usedIn.length ? `used in ${t.usedIn.map((u) => `${u.strategy}.${u.block}`).join(', ')}` : 'used inside composite blocks', d.file].filter(Boolean);
  w.para(facts.join('  ·  '), w.fullCtx, { size: 8.5, color: C.muted, gapAfter: 1 });
  if (d.description) w.para(d.description, w.ctx(), { size: 9.5, gapAfter: 2 });
  const groups: [string, typeof d.inputs][] = [
    ['Inputs', d.inputs],
    ['Outputs', d.outputs],
    ['Parameters', d.params],
  ];
  const ctx = w.fullCtx;
  for (const [name, ports] of groups) {
    if (!ports.length) continue;
    w.table({
      head: [[{ content: `${name} (${ports.length})`, colSpan: 6, styles: { fillColor: rgb(C.tint), fontStyle: 'bold' } }], ['Name', 'Type', 'Default', 'Unit', 'Pin', 'Description']],
      body: ports.map((p) => [
        p.name,
        p.type,
        p.default === undefined ? '' : typeof p.default === 'string' ? p.default : JSON.stringify(p.default),
        p.unit ?? '',
        name === 'Parameters' ? '—' : (p.visibility ?? 'always'),
        [p.description ?? '', p.values?.length ? `Values: ${p.values.join(', ')}` : ''].filter(Boolean).join(' — '),
      ]),
      columnStyles: {
        0: { font: MONO, cellWidth: ctx.width * 0.13 },
        1: { font: MONO, cellWidth: ctx.width * 0.08 },
        2: { cellWidth: ctx.width * 0.1 },
        3: { cellWidth: ctx.width * 0.06 },
        4: { cellWidth: ctx.width * 0.07, textColor: rgb(C.muted) },
      },
      headStyles: { fillColor: [255, 255, 255], textColor: rgb(C.muted), fontStyle: 'bold', fontSize: 7 },
      keep: 22,
    });
  }
  if (plan.config.sections.librarySource && d.implementation?.source) {
    w.heading(`Implementation${d.implementation.language ? ` (${d.implementation.language})` : ''}`, 3, w.fullCtx, { keep: 12 });
    w.code(d.implementation.source, w.fullCtx);
  }
  for (const sh of t.sheets) {
    const n = t.sheets.length;
    const title = `Inner diagram${n > 1 ? `, sheet ${sh.id} of ${n}` : ''}`;
    w.newPage({ section: 'library', document: 'Library appendix', title: `${label} — ${title}` });
    await diagramPage(w, plan, sh, label, title, d.description);
    // Following types continue on a fresh page.
    w.y = w.geo.bottom;
  }
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

const CONTENTS_LINE = 5.6;

function contentsLayout(w: Writer) {
  const { geo } = w;
  const headH = 16;
  const colGap = 14;
  const cols = 2;
  const colW = (geo.right - geo.left - colGap * (cols - 1)) / cols;
  const perColFirst = Math.floor((geo.bottom - geo.top - headH) / CONTENTS_LINE);
  const perCol = Math.floor((geo.bottom - geo.top) / CONTENTS_LINE);
  return { headH, colGap, cols, colW, perFirst: perColFirst * cols, perRest: perCol * cols, perColFirst, perCol };
}

function contentsPageCount(w: Writer, count: number): number {
  const l = contentsLayout(w);
  return pagesFor(count, l.perFirst, l.perRest);
}

function contents(w: Writer, plan: ExportPlan, entries: Entry[], pages: number) {
  const { geo, doc } = w;
  const l = contentsLayout(w);
  let i = 0;
  for (let p = 0; p < pages; p++) {
    w.newPage({ section: 'contents', document: plan.meta.name, title: 'Contents' });
    let top = geo.top;
    if (p === 0) {
      w.y = geo.top;
      w.heading('Contents', 1, w.fullCtx, { keep: 0 });
      top = geo.top + l.headH;
    }
    const perCol = p === 0 ? l.perColFirst : l.perCol;
    for (let c = 0; c < l.cols && i < entries.length; c++) {
      const x0 = geo.left + c * (l.colW + l.colGap);
      for (let r = 0; r < perCol && i < entries.length; r++, i++) {
        const e = entries[i];
        const y = top + r * CONTENTS_LINE + CONTENTS_LINE * 0.72;
        const x = x0 + e.depth * 5;
        const size = e.bold ? 9.5 : 9;
        let tx = x;
        if (e.mono) {
          w.text(e.mono, tx, y, { family: MONO, style: 'bold', size: size * 0.95 });
          tx += doc.getTextWidth(w.clean(e.mono, MONO)) + 2.5;
        }
        const num = String(e.page);
        const numX = x0 + l.colW;
        w.font(SANS, 'normal', size);
        const numW = doc.getTextWidth(num);
        if (e.text) w.text(e.text, tx, y, { size, style: e.bold ? 'bold' : 'normal', maxWidth: numX - numW - 6 - tx });
        const endX = e.text ? tx + doc.getTextWidth(w.truncate(w.clean(e.text), numX - numW - 6 - tx)) : tx - 2.5;
        // Dotted leader.
        doc.setDrawColor(...rgb(C.rule));
        doc.setLineWidth(0.2);
        doc.setLineDashPattern([0.3, 1.2], 0);
        if (numX - numW - 2 > endX + 2) doc.line(endX + 2, y, numX - numW - 2, y);
        doc.setLineDashPattern([], 0);
        w.text(num, numX, y, { size, align: 'right', color: C.muted });
        doc.link(x, y - CONTENTS_LINE * 0.72, numX - x, CONTENTS_LINE, { pageNumber: e.page });
      }
    }
  }
}

function outline(doc: jsPDF, front: number, shift: number, entries: Entry[], subEntries: Map<string, { title: string; page: number }[]>) {
  const o = (doc as unknown as { outline?: { add(parent: unknown, title: string, opts: { pageNumber: number }): unknown } }).outline;
  if (!o) return;
  if (front) o.add(null, 'Cover', { pageNumber: 1 });
  if (shift) o.add(null, 'Contents', { pageNumber: front + 1 });
  const nodes = new Map<string, unknown>();
  for (const e of entries) {
    const parent = e.parent ? (nodes.get(e.parent) ?? null) : null;
    const node = o.add(parent, [e.mono, e.text].filter(Boolean).join(' — '), { pageNumber: e.page });
    if (e.key) nodes.set(e.key, node);
    for (const s of (e.key && subEntries.get(e.key)) || []) o.add(node, s.title, { pageNumber: s.page });
  }
}

// ---------------------------------------------------------------------------
// Frame and title block
// ---------------------------------------------------------------------------

type Logo = { kind: 'svg'; svg: string; w: number; h: number } | { kind: 'image'; path: string; data: Uint8Array; w: number; h: number };

function projectLogo(plan: ExportPlan, files: Files, doc: jsPDF): Logo {
  const p = plan.meta.titleBlock.logo;
  const path = p ? normalizePath(p) : undefined;
  const content = path ? files[path] : undefined;
  if (path && content !== undefined) {
    const kind = sniffImage(content, path);
    if (kind === 'svg') {
      const svg = typeof content === 'string' ? content : new TextDecoder().decode(content);
      const m = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(svg);
      return { kind: 'svg', svg, w: m ? +m[1] : 1, h: m ? +m[2] : 1 };
    }
    if (kind && typeof content !== 'string') {
      try {
        const props = doc.getImageProperties(content);
        return { kind: 'image', path, data: content, w: props.width, h: props.height };
      } catch {
        /* fall back */
      }
    }
  }
  return { kind: 'svg', svg: APP_LOGO_SVG, w: 64, h: 64 };
}

async function drawLogo(w: Writer, logo: Logo, x: number, y: number, bw: number, bh: number) {
  const f = fitBox(logo.w, logo.h, bw, bh);
  const lx = x + (bw - f.w) / 2;
  const ly = y + (bh - f.h) / 2;
  try {
    if (logo.kind === 'svg') await w.svg(logo.svg, lx, ly, f.w, f.h);
    else w.doc.addImage(logo.data, sniffImage(logo.data)!.toUpperCase(), lx, ly, f.w, f.h, `logo:${logo.path}`, 'FAST');
  } catch {
    /* a broken logo must not stop the export */
  }
}

async function titleBlock(w: Writer, plan: ExportPlan, info: PageInfo, page: number, pages: number, logo: Logo) {
  const { doc, geo } = w;
  const { frame, tb } = geo;
  const k = tb.k;
  doc.setDrawColor(...rgb(C.ink));
  doc.setLineWidth(0.5);
  doc.rect(frame.x, frame.y, frame.w, frame.h, 'S');
  w.text(`Control Strategy Studio · ${plan.meta.name} · ${plan.date}`, frame.x, geo.H - 4.5, { size: 6, color: C.muted });

  doc.setFillColor(255, 255, 255);
  doc.setLineWidth(0.35);
  doc.rect(tb.x, tb.y, tb.w, tb.h, 'FD');
  const r = 7 * k;
  const xLogo = tb.x + 26 * k;
  const xRight = tb.x + 120 * k;
  const half = (tb.x + tb.w - xRight) / 2;
  doc.setLineWidth(0.2);
  doc.setDrawColor(...rgb('#7c8791'));
  doc.line(xLogo, tb.y, xLogo, tb.y + tb.h);
  doc.line(xRight, tb.y, xRight, tb.y + tb.h);
  doc.line(xLogo, tb.y + r, tb.x + tb.w, tb.y + r);
  doc.line(xLogo, tb.y + 2 * r, tb.x + tb.w, tb.y + 2 * r);
  doc.line(xRight, tb.y + 3 * r, tb.x + tb.w, tb.y + 3 * r);
  doc.line(xRight + half, tb.y, xRight + half, tb.y + 3 * r);

  const label = 5 * k + 0.6;
  const value = 7.5 * k + 0.4;
  const cell = (x: number, y: number, cw: number, ch: number, name: string, v: string | undefined, o: { bold?: boolean; size?: number; mono?: boolean } = {}) => {
    w.text(name, x + 1.2, y + 2.3 * k + 0.2, { size: label, color: C.muted });
    w.text(v || '—', x + 1.2, y + ch - 1.7 * k, { size: o.size ?? value, style: o.bold ? 'bold' : 'normal', family: o.mono ? MONO : SANS, color: v ? C.ink : C.rule, maxWidth: cw - 2.4 });
  };
  const mainW = xRight - xLogo;
  cell(xLogo, tb.y, mainW, r, 'Project', plan.meta.name, { bold: true });
  cell(xLogo, tb.y + r, mainW, r, 'Hierarchy', info.hierarchy);
  // Document cell: two lines.
  const dy = tb.y + 2 * r;
  w.text(info.section === 'strategy' ? 'Strategy' : 'Document', xLogo + 1.2, dy + 2.3 * k + 0.2, { size: label, color: C.muted });
  w.text(info.document || '—', xLogo + 1.2, dy + 2.3 * k + 0.2 + value * PT * 1.25 + 0.4, { size: value + 1, style: 'bold', maxWidth: mainW - 2.4 });
  if (info.title) w.text(info.title, xLogo + 1.2, dy + 2 * r - 1.7 * k, { size: value, maxWidth: mainW - 2.4 });

  const tbm = plan.meta.titleBlock;
  cell(xRight, tb.y, half, r, 'Revision', info.revision ?? plan.revision);
  cell(xRight + half, tb.y, half, r, 'Date', plan.date);
  cell(xRight, tb.y + r, half, r, 'Drawn', info.drawn ?? tbm.drawn ?? plan.author);
  cell(xRight + half, tb.y + r, half, r, 'Checked', tbm.checked);
  cell(xRight, tb.y + 2 * r, half, r, 'Approved', tbm.approved);
  cell(xRight + half, tb.y + 2 * r, half, r, 'Format', `${geo.paper} landscape`);
  cell(xRight, tb.y + 3 * r, 2 * half, r, 'Sheet', `${page} / ${pages}`, { bold: true });

  await drawLogo(w, logo, tb.x + 3 * k, tb.y + 3 * k, 20 * k, tb.h - 6 * k);
}
