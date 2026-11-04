// Page writer: page geometry, flowing text, tables, SVG / images, Markdown,
// frames and title blocks. The document structure lives in index.ts.
import type { jsPDF } from 'jspdf';
import 'svg2pdf.js';
import autoTable, { type CellHookData, type UserOptions } from 'jspdf-autotable';
import { Lexer, type Token, type Tokens } from 'marked';
import type { Files } from '@csd/core';
import { CHART_COLORS, renderChartSvg } from '../chart';
import { MONO, SANS, type Family } from './fonts';
import { fitBox, inlineRuns, plainText, resolveAssetPath, sanitizeText, sniffImage, svgSize, wrapRuns, type Run, type RunStyle } from './util';

export const C = {
  ink: '#1d2328',
  muted: '#5b6670',
  rule: '#b3bab7',
  accent: '#1f5f8b',
  fill: '#eef1f0',
  tint: '#e8eff5',
  error: '#b3261e',
  warning: '#a35a00',
  code: '#f3f5f4',
};

/** Millimetres per SVG / CSS pixel (96 dpi). */
export const PX = 25.4 / 96;
/** Points → millimetres. */
export const PT = 25.4 / 72;

export function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.replace(/./g, '$&$&') : h;
  const n = parseInt(f.slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [0, 0, 0];
}

export interface Geometry {
  paper: 'A3' | 'A4';
  W: number;
  H: number;
  /** Frame rectangle. */
  frame: { x: number; y: number; w: number; h: number };
  /** Title block rectangle (bottom right inside the frame). */
  tb: { x: number; y: number; w: number; h: number; k: number };
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Width of running text (narrower than the page on A3 for readability). */
  textWidth: number;
}

export function geometry(paper: 'A3' | 'A4'): Geometry {
  const [W, H] = paper === 'A3' ? [420, 297] : [297, 210];
  const m = 10;
  const k = paper === 'A3' ? 1 : 0.8;
  const frame = { x: m, y: m, w: W - 2 * m, h: H - 2 * m };
  const tb = { w: 180 * k, h: 28 * k, x: 0, y: 0, k };
  tb.x = frame.x + frame.w - tb.w;
  tb.y = frame.y + frame.h - tb.h;
  const left = frame.x + 8;
  const right = frame.x + frame.w - 8;
  return { paper, W, H, frame, tb, left, right, top: frame.y + 8, bottom: tb.y - 5, textWidth: Math.min(right - left, 250) };
}

export interface PageInfo {
  /** Document part (cover, contents, strategy …). */
  section: string;
  /** Main line of the title block. */
  document: string;
  /** Second line: sheet title / part of the strategy. */
  title?: string;
  hierarchy?: string;
  revision?: string;
  drawn?: string;
}

export interface Ctx {
  x: number;
  width: number;
  /** Markdown file (for relative image paths). */
  file?: string;
  color?: string;
}

type ImageRef = { image: { href: string; alt: string } };
const isImage = (r: Run | ImageRef): r is ImageRef => 'image' in r;

export class Writer {
  readonly geo: Geometry;
  /** Page infos, index = page number − 1. */
  pages: PageInfo[] = [];
  info: PageInfo;
  y: number;
  private fresh = true;

  constructor(
    readonly doc: jsPDF,
    paper: 'A3' | 'A4',
    readonly coverage: Record<Family, (cp: number) => boolean>,
    readonly files: Files,
  ) {
    this.geo = geometry(paper);
    this.info = { section: '', document: '' };
    this.y = this.geo.top;
  }

  // -------------------------------------------------------------------------
  // Pages
  // -------------------------------------------------------------------------

  get page(): number {
    return this.doc.getCurrentPageInfo().pageNumber;
  }

  /** Assigns the current page info to pages added by others (autotable). */
  sync() {
    const n = this.doc.getNumberOfPages();
    while (this.pages.length < n) this.pages.push(this.info);
  }

  newPage(info?: PageInfo) {
    if (info) this.info = info;
    if (this.fresh) this.fresh = false;
    else {
      this.sync();
      this.doc.addPage();
    }
    this.sync();
    this.pages[this.page - 1] = this.info;
    this.y = this.geo.top;
  }

  /** Starts a new page unless `h` fits below the current position. */
  ensure(h: number) {
    if (this.y + h > this.geo.bottom + 1e-6) this.newPage();
  }

  /** True until the first page has been started. */
  get isFresh(): boolean {
    return this.fresh;
  }

  get remaining(): number {
    return this.geo.bottom - this.y;
  }

  // -------------------------------------------------------------------------
  // Text primitives
  // -------------------------------------------------------------------------

  clean(s: string, family: Family = SANS): string {
    return sanitizeText(s, this.coverage[family]);
  }

  font(family: Family, style: RunStyle, size: number, color = C.ink) {
    this.doc.setFont(family, style);
    this.doc.setFontSize(size);
    this.doc.setTextColor(...rgb(color));
  }

  /** Single line of text at (x, baseline y). */
  text(s: string, x: number, y: number, o: { family?: Family; style?: RunStyle; size?: number; color?: string; align?: 'left' | 'right' | 'center'; maxWidth?: number } = {}) {
    const family = o.family ?? SANS;
    this.font(family, o.style ?? 'normal', o.size ?? 9.5, o.color);
    let t = this.clean(s, family);
    if (o.maxWidth !== undefined) t = this.truncate(t, o.maxWidth);
    this.doc.text(t, x, y, { align: o.align ?? 'left', baseline: 'alphabetic' });
  }

  /** Shortens text with an ellipsis to fit `w` (current font). */
  truncate(s: string, w: number): string {
    if (this.doc.getTextWidth(s) <= w) return s;
    const ell = this.coverage[SANS](0x2026) ? '…' : '...';
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.doc.getTextWidth(s.slice(0, mid) + ell) <= w) lo = mid;
      else hi = mid - 1;
    }
    return s.slice(0, lo).trimEnd() + ell;
  }

  /** Wrapped lines of plain text in the given font. */
  split(s: string, w: number, family: Family, style: RunStyle, size: number): string[] {
    this.font(family, style, size);
    return this.doc.splitTextToSize(this.clean(s, family), w) as string[];
  }

  /** Flowing paragraph of styled runs; breaks pages between lines. */
  runs(runs: Run[], ctx: Ctx, o: { size?: number; lineHeight?: number; gapAfter?: number } = {}) {
    const size = o.size ?? 9.5;
    const lh = o.lineHeight ?? size * PT * 1.42;
    const clean = runs.map((r) => ({ ...r, text: this.clean(r.text, r.mono ? MONO : SANS) }));
    const measure = (t: string, r: Run) => {
      this.doc.setFont(r.mono ? MONO : SANS, r.style);
      this.doc.setFontSize(r.mono ? size * 0.92 : size);
      return this.doc.getTextWidth(t);
    };
    const lines = wrapRuns(clean, ctx.width, measure);
    for (const line of lines) {
      this.ensure(lh);
      const base = this.y + lh * 0.72;
      for (const seg of line.segments) {
        const r = seg.run;
        const x = ctx.x + seg.x;
        if (r.mono && seg.text.trim()) {
          this.doc.setFillColor(...rgb(C.code));
          this.doc.rect(x - 0.3, this.y + lh * 0.12, seg.w + 0.6, lh * 0.8, 'F');
        }
        this.font(r.mono ? MONO : SANS, r.style, r.mono ? size * 0.92 : size, r.color ?? ctx.color ?? C.ink);
        this.doc.text(seg.text, x, base, { baseline: 'alphabetic' });
        if (r.strike) {
          this.doc.setDrawColor(...rgb(r.color ?? ctx.color ?? C.ink));
          this.doc.setLineWidth(0.2);
          this.doc.line(x, base - size * PT * 0.3, x + seg.w, base - size * PT * 0.3);
        }
        if (r.link && /^(https?:|mailto:)/i.test(r.link)) this.doc.link(x, this.y, seg.w, lh, { url: r.link });
      }
      this.y += lh;
    }
    this.y += o.gapAfter ?? 0;
  }

  /** Plain paragraph helper. */
  para(s: string, ctx: Ctx, o: { size?: number; style?: RunStyle; color?: string; mono?: boolean; gapAfter?: number } = {}) {
    this.runs([{ text: s, style: o.style ?? 'normal', color: o.color, mono: o.mono }], ctx, { size: o.size, gapAfter: o.gapAfter ?? 2 });
  }

  heading(s: string, level: number, ctx: Ctx = this.ctx(), o: { keep?: number; mono?: string } = {}) {
    const size = level <= 1 ? 14 : level === 2 ? 12 : level === 3 ? 10.5 : 9.5;
    const lh = size * PT * 1.3;
    const before = level <= 1 ? 4 : level === 2 ? 3 : 2;
    if (this.y > this.geo.top + 0.1) this.y += before;
    this.ensure(lh + (o.keep ?? 14));
    const base = this.y + lh * 0.78;
    let x = ctx.x;
    if (o.mono) {
      this.text(o.mono, x, base, { family: MONO, style: 'bold', size, color: C.ink });
      x += this.doc.getTextWidth(this.clean(o.mono, MONO)) + (s ? 2 : 0);
    }
    if (s) this.text(s, x, base, { style: 'bold', size, color: level <= 1 ? C.ink : C.ink, maxWidth: ctx.x + ctx.width - x });
    this.y += lh;
    if (level <= 1) {
      this.doc.setDrawColor(...rgb(C.accent));
      this.doc.setLineWidth(0.5);
      this.doc.line(ctx.x, this.y + 0.6, ctx.x + ctx.width, this.y + 0.6);
      this.y += 2.5;
    } else this.y += 1;
  }

  /** Small muted line above headings (hierarchy path, section kind). */
  eyebrow(s: string, ctx: Ctx = this.ctx()) {
    this.ensure(5 + 14);
    this.text(s, ctx.x, this.y + 3, { size: 8, color: C.muted, maxWidth: ctx.width });
    this.y += 4.5;
  }

  hr(ctx: Ctx) {
    this.ensure(4);
    this.doc.setDrawColor(...rgb(C.rule));
    this.doc.setLineWidth(0.25);
    this.doc.line(ctx.x, this.y + 2, ctx.x + ctx.width, this.y + 2);
    this.y += 4;
  }

  ctx(width?: number): Ctx {
    return { x: this.geo.left, width: width ?? this.geo.textWidth };
  }

  get fullCtx(): Ctx {
    return { x: this.geo.left, width: this.geo.right - this.geo.left };
  }

  // -------------------------------------------------------------------------
  // Tables
  // -------------------------------------------------------------------------

  /**
   * jspdf-autotable with the document style. `cellHook` may adjust cells;
   * all text is sanitized for the embedded fonts.
   */
  table(o: UserOptions & { ctx?: Ctx; cellHook?: (d: CellHookData) => void; keep?: number }) {
    const ctx = o.ctx ?? this.fullCtx;
    if (o.keep) this.ensure(o.keep);
    const { ctx: _c, cellHook, keep: _k, ...rest } = o;
    autoTable(this.doc, {
      startY: this.y,
      margin: { top: this.geo.top, left: ctx.x, right: this.geo.W - (ctx.x + ctx.width), bottom: this.geo.H - this.geo.bottom },
      theme: 'grid',
      rowPageBreak: 'avoid',
      styles: {
        font: SANS,
        fontSize: 8,
        textColor: rgb(C.ink),
        lineColor: rgb(C.rule),
        lineWidth: 0.15,
        cellPadding: { top: 1.1, bottom: 1.1, left: 1.5, right: 1.5 },
        overflow: 'linebreak',
        valign: 'top',
      },
      headStyles: { fillColor: rgb(C.fill), textColor: rgb(C.ink), fontStyle: 'bold' },
      ...rest,
      didParseCell: (d) => {
        cellHook?.(d);
        const fam = d.cell.styles.font === MONO ? MONO : SANS;
        d.cell.text = d.cell.text.map((t) => this.clean(t, fam));
      },
      didDrawPage: () => {
        this.sync();
      },
    });
    this.sync();
    const last = (this.doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
    this.y = (last?.finalY ?? this.y) + 3;
  }

  // -------------------------------------------------------------------------
  // Graphics
  // -------------------------------------------------------------------------

  /** Draws SVG markup (vector) into the box. */
  async svg(markup: string, x: number, y: number, w: number, h: number) {
    const el = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
    if (!el || el.nodeName.toLowerCase() !== 'svg') return false;
    // Text the fonts cannot show (z⁻¹ …) gets replacements; both families are possible.
    const both = (cp: number) => this.coverage[SANS](cp) && this.coverage[MONO](cp);
    const walker = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue) n.nodeValue = sanitizeText(n.nodeValue, both);
    // svg2pdf keeps the current font style for text without explicit style.
    this.font(SANS, 'normal', 10);
    await this.doc.svg(el, { x, y, width: w, height: h });
    return true;
  }

  /** Bitmap or SVG asset of the project at (x, y) with size (w, h). */
  async asset(content: string | Uint8Array, path: string, x: number, y: number, w: number, h: number) {
    const kind = sniffImage(content, path);
    if (kind === 'svg') return this.svg(typeof content === 'string' ? content : new TextDecoder().decode(content), x, y, w, h);
    if (!kind || typeof content === 'string') return false;
    this.doc.addImage(content, kind.toUpperCase(), x, y, w, h, `asset:${path}`, 'FAST');
    return true;
  }

  /** Natural size of an asset in mm (SVG: user units at 96 dpi; bitmaps: pixels at 96 dpi). */
  assetSize(content: string | Uint8Array, path: string): { w: number; h: number } | undefined {
    const kind = sniffImage(content, path);
    if (kind === 'svg') {
      const s = svgSize(typeof content === 'string' ? content : new TextDecoder().decode(content));
      return s && { w: s.w * PX, h: s.h * PX };
    }
    if (!kind || typeof content === 'string') return undefined;
    try {
      const p = this.doc.getImageProperties(content);
      return { w: p.width * PX, h: p.height * PX };
    } catch {
      return undefined;
    }
  }

  /** Bordered note box with a title line (errors, placeholders). */
  box(title: string, body: string[], ctx: Ctx, o: { color?: string; mono?: boolean } = {}) {
    const size = 8;
    const lh = size * PT * 1.4;
    const family = o.mono ? MONO : SANS;
    const lines = body.flatMap((b) => this.split(b, ctx.width - 6, family, 'normal', size));
    let i = 0;
    let first = true;
    while (first || i < lines.length) {
      this.ensure(lh * 2 + 4);
      const fit = Math.max(1, Math.floor((this.remaining - 4 - (first ? lh : 0)) / lh));
      const chunk = lines.slice(i, i + fit);
      const h = (first ? lh : 0) + chunk.length * lh + 3;
      this.doc.setDrawColor(...rgb(o.color ?? C.rule));
      this.doc.setFillColor(...rgb(C.code));
      this.doc.setLineWidth(0.3);
      this.doc.rect(ctx.x, this.y, ctx.width, h, 'FD');
      let yy = this.y + 1.5;
      if (first) {
        this.text(title, ctx.x + 3, yy + lh * 0.75, { style: 'bold', size, color: o.color ?? C.muted, maxWidth: ctx.width - 6 });
        yy += lh;
      }
      for (const l of chunk) {
        this.text(l, ctx.x + 3, yy + lh * 0.75, { family, size, color: C.ink });
        yy += lh;
      }
      this.y += h + 2;
      i += chunk.length;
      first = false;
    }
  }

  /** Preformatted code (mono), split across pages. */
  code(source: string, ctx: Ctx, o: { size?: number } = {}) {
    const size = o.size ?? 8;
    const lh = size * PT * 1.35;
    const pad = 2;
    const clean = this.clean(source.replace(/\n$/, ''), MONO);
    const measure = (t: string) => {
      this.doc.setFont(MONO, 'normal');
      this.doc.setFontSize(size);
      return this.doc.getTextWidth(t);
    };
    const lines = clean.split('\n').flatMap((l) => wrapRuns([{ text: l, style: 'normal', mono: true }], ctx.width - 2 * pad, (t) => measure(t), { preserveSpaces: true }).map((x) => x.segments.map((s) => s.text).join('')));
    let i = 0;
    while (i < lines.length) {
      this.ensure(lh + 2 * pad);
      const fit = Math.max(1, Math.floor((this.remaining - 2 * pad) / lh));
      const chunk = lines.slice(i, i + fit);
      const h = chunk.length * lh + 2 * pad;
      this.doc.setFillColor(...rgb(C.code));
      this.doc.setDrawColor(...rgb('#dde2df'));
      this.doc.setLineWidth(0.2);
      this.doc.rect(ctx.x, this.y, ctx.width, h, 'FD');
      this.font(MONO, 'normal', size, C.ink);
      chunk.forEach((l, j) => this.doc.text(l, ctx.x + pad, this.y + pad + j * lh + lh * 0.75, { baseline: 'alphabetic' }));
      this.y += h;
      i += chunk.length;
    }
    this.y += 2.5;
  }

  // -------------------------------------------------------------------------
  // Markdown
  // -------------------------------------------------------------------------

  async markdown(md: string, ctx: Ctx, o: { headingOffset?: number } = {}) {
    const tokens = Lexer.lex(md, { gfm: true });
    await this.blocks(tokens, ctx, o.headingOffset ?? 0);
  }

  private async blocks(tokens: Token[], ctx: Ctx, hOff: number, tight = false) {
    for (const t of tokens) await this.block(t, ctx, hOff, tight);
  }

  private async block(t: Token, ctx: Ctx, hOff: number, tight: boolean) {
    switch (t.type) {
      case 'space':
      case 'def':
      case 'html':
        return;
      case 'heading': {
        const h = t as Tokens.Heading;
        this.heading(plainText(h.tokens), Math.min(4, h.depth + hOff), ctx);
        return;
      }
      case 'paragraph':
      case 'text': {
        const p = t as Tokens.Paragraph | Tokens.Text;
        const items = 'tokens' in p && p.tokens ? inlineRuns(p.tokens) : [{ text: p.text, style: 'normal' as const }];
        await this.inline(items, ctx, t.type === 'paragraph' || !tight ? 2.2 : 0.6);
        return;
      }
      case 'list':
        await this.list(t as Tokens.List, ctx, hOff);
        return;
      case 'blockquote': {
        const q = t as Tokens.Blockquote;
        const startPage = this.page;
        const startY = this.y;
        await this.blocks(q.tokens, { ...ctx, x: ctx.x + 5, width: ctx.width - 5, color: C.muted }, hOff);
        const y0 = this.page === startPage ? startY : this.geo.top;
        this.doc.setDrawColor(...rgb(C.rule));
        this.doc.setLineWidth(0.8);
        this.doc.line(ctx.x + 1.2, y0 + 0.5, ctx.x + 1.2, this.y - 2);
        return;
      }
      case 'hr':
        this.hr(ctx);
        return;
      case 'code': {
        const c = t as Tokens.Code;
        const lang = (c.lang ?? '').trim().split(/\s+/)[0].toLowerCase();
        if (lang === 'chart') await this.chart(c.text, ctx);
        else if (lang === 'mermaid') this.box('Mermaid diagram — not rendered in PDF', c.text.split('\n'), ctx, { mono: true });
        else this.code(c.text, ctx);
        return;
      }
      case 'table':
        this.mdTable(t as Tokens.Table, ctx);
        return;
      default: {
        const g = t as Tokens.Generic;
        if (g.tokens) await this.blocks(g.tokens, ctx, hOff, tight);
        else if (typeof g.text === 'string') this.para(g.text, ctx);
      }
    }
  }

  private async inline(items: (Run | ImageRef)[], ctx: Ctx, gap: number) {
    let buf: Run[] = [];
    const flush = (g: number) => {
      if (buf.some((r) => r.text.trim())) this.runs(buf, ctx, { gapAfter: g });
      buf = [];
    };
    for (const it of items) {
      if (isImage(it)) {
        flush(1);
        await this.image(it.image.href, it.image.alt, ctx);
      } else buf.push(it);
    }
    flush(gap);
  }

  private async list(l: Tokens.List, ctx: Ctx, hOff: number) {
    const start = typeof l.start === 'number' ? l.start : 1;
    const indent = l.ordered ? 7 : 5;
    for (let i = 0; i < l.items.length; i++) {
      const item = l.items[i];
      const marker = item.task ? (item.checked ? '[x]' : '[ ]') : l.ordered ? `${start + i}.` : '•';
      this.ensure(9.5 * PT * 1.42);
      this.text(marker, ctx.x + (l.ordered ? 0 : 1), this.y + 9.5 * PT * 1.42 * 0.72, { size: 9.5, color: ctx.color ?? C.ink });
      const tokens = item.task ? item.tokens.filter((x) => x.type !== 'checkbox') : item.tokens;
      await this.blocks(tokens, { ...ctx, x: ctx.x + indent + (item.task ? 2 : 0), width: ctx.width - indent - (item.task ? 2 : 0) }, hOff, !l.loose);
    }
    this.y += 1.6;
  }

  private mdTable(t: Tokens.Table, ctx: Ctx) {
    const head = t.header.map((c) => plainText(c.tokens));
    const body = t.rows.map((r) => r.map((c) => plainText(c.tokens)));
    // Natural width: as narrow as the content, at most the available width.
    this.font(SANS, 'bold', 8);
    const widths = head.map((h, i) => Math.max(this.doc.getTextWidth(this.clean(h)), ...body.map((r) => this.doc.getTextWidth(this.clean(r[i] ?? '')))) + 3.2);
    const natural = widths.reduce((a, b) => a + b, 0) + 0.5;
    const columnStyles: UserOptions['columnStyles'] = {};
    t.align.forEach((a, i) => {
      if (a) columnStyles[i] = { halign: a };
    });
    this.table({ ctx, head: [head], body, tableWidth: Math.min(natural, ctx.width), columnStyles, keep: 20 });
    this.y += 0.5;
  }

  private async chart(source: string, ctx: Ctx) {
    const res = renderChartSvg(source, { ...CHART_COLORS, font: SANS });
    if ('error' in res) {
      this.box('Chart error', [res.error], ctx, { color: C.error });
      return;
    }
    const f = fitBox(res.width * PX, res.height * PX, ctx.width, (this.geo.bottom - this.geo.top) * 0.7, 1.15);
    this.ensure(f.h + 3);
    await this.svg(res.svg, ctx.x, this.y, f.w, f.h);
    this.y += f.h + 3;
  }

  private async image(href: string, alt: string, ctx: Ctx) {
    const path = resolveAssetPath(href, ctx.file, (p) => p in this.files);
    const content = path ? this.files[path] : undefined;
    const size = content !== undefined && path ? this.assetSize(content, path) : undefined;
    if (!path || content === undefined || !size) {
      this.box(`Image not available: ${href}`, alt ? [alt] : [], ctx, { color: C.warning });
      return;
    }
    const f = fitBox(size.w, size.h, ctx.width, (this.geo.bottom - this.geo.top) * 0.62, 1);
    this.ensure(f.h + (alt ? 6 : 2));
    const ok = await this.asset(content, path, ctx.x, this.y, f.w, f.h).catch(() => false);
    if (!ok) {
      this.box(`Image could not be drawn: ${href}`, [], ctx, { color: C.warning });
      return;
    }
    this.y += f.h + 1;
    if (alt) {
      this.text(alt, ctx.x, this.y + 2.8, { style: 'italic', size: 8, color: C.muted, maxWidth: ctx.width });
      this.y += 4;
    }
    this.y += 2;
  }
}
