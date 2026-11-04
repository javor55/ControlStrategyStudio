// Parsing of diagrams — the common body of strategies and composite block types.
import type { BlockInst, BlockTypeDef, Diag, Diagram, Endpoint, LinkInst, NoteInst, SheetDef } from './types';
import { isObj, lineAt, num, pickExt, pos2, str, type ParsedYaml, type YamlPath } from './yamlutil';

/** Pseudo-blocks addressing a composite block's own interface. */
export const IFACE_IN = 'in';
export const IFACE_OUT = 'out';
export const RESERVED_IDS = new Set([IFACE_IN, IFACE_OUT]);

export const TAG_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const ENDPOINT_RE = /^\s*(?:([A-Za-z_][A-Za-z0-9_-]*):)?([A-Za-z_][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*$/;
const ARROW_RE = /\s*-+>\s*/;

export function parseEndpoint(s: string): Endpoint | undefined {
  const m = ENDPOINT_RE.exec(s);
  if (!m) return undefined;
  return m[1] ? { strategy: m[1], block: m[2], port: m[3] } : { block: m[2], port: m[3] };
}

export function formatEndpoint(e: Endpoint): string {
  return `${e.strategy ? e.strategy + ':' : ''}${e.block}.${e.port}`;
}

export function parseLinkString(s: string): { from?: Endpoint; to?: Endpoint } {
  const parts = s.split(ARROW_RE);
  if (parts.length !== 2) return {};
  return { from: parseEndpoint(parts[0]), to: parseEndpoint(parts[1]) };
}

export function formatLink(from: Endpoint | string, to: Endpoint | string): string {
  const f = typeof from === 'string' ? from : formatEndpoint(from);
  const t = typeof to === 'string' ? to : formatEndpoint(to);
  return `${f} -> ${t}`;
}

export function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return a.block === b.block && a.port === b.port && (a.strategy ?? '') === (b.strategy ?? '');
}

export type TypeResolution = { def?: BlockTypeDef; error?: { code: string; message: string } };
export type TypeResolver = (ref: string) => TypeResolution;

export interface DiagramContext {
  file: string;
  parsed: ParsedYaml;
  /** YAML path of the diagram body (`[]` for strategies, `['diagram']` for composites). */
  base: YamlPath;
}

/** Parses the `sheets / blocks / links / notes` body. Unknown types are reported here. */
export function parseDiagram(
  data: Record<string, unknown>,
  resolve: TypeResolver,
  ctx: DiagramContext,
): { diagram: Diagram; diags: Diag[] } {
  const diags: Diag[] = [];
  const at = (...p: YamlPath) => lineAt(ctx.parsed, [...ctx.base, ...p]);

  const sheets: SheetDef[] = [];
  if (Array.isArray(data.sheets)) {
    data.sheets.forEach((s, i) => {
      if (!isObj(s) || num(s.id) === undefined) return;
      const id = num(s.id)!;
      if (sheets.some((x) => x.id === id)) {
        diags.push({ severity: 'error', code: 'duplicate-sheet', message: `Sheet ${id} is defined twice`, file: ctx.file, line: at('sheets', i) });
        return;
      }
      sheets.push({ id, title: str(s.title) });
    });
  }
  if (!sheets.length) sheets.push({ id: 1 });
  sheets.sort((a, b) => a.id - b.id);

  const blocks: BlockInst[] = [];
  if (isObj(data.blocks)) {
    for (const [id, raw] of Object.entries(data.blocks)) {
      const b = isObj(raw) ? raw : {};
      const typeRef = str(b.type) ?? '';
      if (RESERVED_IDS.has(id)) {
        diags.push({ severity: 'error', code: 'reserved-id', message: `"${id}" is reserved and cannot name a block`, file: ctx.file, line: at('blocks', id), block: id });
      }
      const r = typeRef ? resolve(typeRef) : { error: { code: 'missing-type', message: 'Block has no type' } };
      if (r.error) {
        diags.push({ severity: 'error', code: r.error.code, message: `${id}: ${r.error.message}`, file: ctx.file, line: at('blocks', id, 'type'), block: id });
      }
      blocks.push({
        id,
        typeRef,
        def: r.def,
        description: str(b.description),
        doc: str(b.doc),
        comment: str(b.comment),
        scan: str(b.scan),
        order: num(b.order),
        sheet: num(b.sheet) ?? 1,
        params: isObj(b.params) ? { ...b.params } : {},
        pos: pos2(b.pos),
        ext: pickExt(b),
      });
    }
  }

  const links: LinkInst[] = [];
  if (Array.isArray(data.links)) {
    data.links.forEach((raw, index) => {
      let from: Endpoint | undefined;
      let to: Endpoint | undefined;
      let comment: string | undefined;
      let label: string | undefined;
      let category: string | undefined;
      let ext = {};
      if (typeof raw === 'string') {
        ({ from, to } = parseLinkString(raw));
      } else if (isObj(raw)) {
        from = typeof raw.from === 'string' ? parseEndpoint(raw.from) : undefined;
        to = typeof raw.to === 'string' ? parseEndpoint(raw.to) : undefined;
        comment = str(raw.comment);
        label = str(raw.label);
        category = str(raw.category);
        ext = pickExt(raw);
      }
      if (!from || !to) {
        diags.push({
          severity: 'error',
          code: 'bad-link',
          message: `Link ${index + 1}: expected "BLOCK.PORT -> BLOCK.PORT" (source may be "STRATEGY:BLOCK.PORT")`,
          file: ctx.file,
          line: at('links', index),
          link: index,
        });
        return;
      }
      links.push({ index, from, to, comment, label, category, ext });
    });
  }

  const notes: NoteInst[] = [];
  if (Array.isArray(data.notes)) {
    data.notes.forEach((raw, index) => {
      if (!isObj(raw) || typeof raw.text !== 'string') return;
      notes.push({ index, text: raw.text, sheet: num(raw.sheet) ?? 1, pos: pos2(raw.pos), width: num(raw.width) });
    });
  }

  return { diagram: { sheets, blocks, links, notes }, diags };
}
