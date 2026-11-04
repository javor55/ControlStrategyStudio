// Semantic validation of a diagram (strategy or composite internals).
import { IFACE_IN, IFACE_OUT, formatEndpoint } from './diagram';
import { checkValue, compatible, parseDuration } from './signals';
import { sequenceSignalType } from './sequence';
import type { BlockInst, BlockTypeDef, Diag, Diagram, Endpoint, PortDef, Sequence, Strategy } from './types';
import { lineAt, type ParsedYaml, type YamlPath } from './yamlutil';

export interface ValidateContext {
  file: string;
  parsed: ParsedYaml;
  base: YamlPath;
  /** Composite type whose internals are validated (enables `in` / `out` / `$PARAM`). */
  composite?: BlockTypeDef;
  /** Other strategies by name, for cross-strategy references. */
  strategies?: ReadonlyMap<string, Strategy>;
  /** Sequences by name: strategies may read their step / sequence signals. */
  sequences?: ReadonlyMap<string, Sequence>;
}

export function findPort(def: BlockTypeDef | undefined, dir: 'in' | 'out', name: string): PortDef | undefined {
  if (!def) return undefined;
  return (dir === 'in' ? def.inputs : def.outputs).find((p) => p.name === name);
}

/** Type of the signal at a link source, or undefined when unresolved. */
function sourceType(ep: Endpoint, diagram: Diagram, ctx: ValidateContext): string | undefined {
  if (ep.strategy) {
    const q = ctx.sequences?.get(ep.strategy);
    if (q) return sequenceSignalType(q, ep.block, ep.port);
    const s = ctx.strategies?.get(ep.strategy);
    return findPort(s?.blocks.find((b) => b.id === ep.block)?.def, 'out', ep.port)?.type;
  }
  if (ctx.composite && ep.block === IFACE_IN) return ctx.composite.inputs.find((p) => p.name === ep.port)?.type;
  return findPort(diagram.blocks.find((b) => b.id === ep.block)?.def, 'out', ep.port)?.type;
}

export function validateDiagram(diagram: Diagram, ctx: ValidateContext): Diag[] {
  const diags: Diag[] = [];
  const at = (...p: YamlPath) => lineAt(ctx.parsed, [...ctx.base, ...p]);
  const push = (d: Omit<Diag, 'file'>) => diags.push({ ...d, file: ctx.file });
  const blocks = new Map<string, BlockInst>(diagram.blocks.map((b) => [b.id, b]));
  const sheetIds = new Set(diagram.sheets.map((s) => s.id));

  // --- blocks -------------------------------------------------------------
  const orders = new Map<number, string[]>();
  for (const b of diagram.blocks) {
    if (b.scan !== undefined && parseDuration(b.scan) === undefined) {
      push({ severity: 'warning', code: 'bad-scan', message: `${b.id}: scan "${b.scan}" is not a duration (e.g. 100ms, 1s)`, line: at('blocks', b.id, 'scan'), block: b.id });
    }
    if (!sheetIds.has(b.sheet)) {
      push({ severity: 'warning', code: 'unknown-sheet', message: `${b.id}: sheet ${b.sheet} is not defined in "sheets"`, line: at('blocks', b.id, 'sheet'), block: b.id });
    }
    if (b.order !== undefined) orders.set(b.order, [...(orders.get(b.order) ?? []), b.id]);
    if (!b.def) continue;
    for (const [name, value] of Object.entries(b.params)) {
      const def = b.def.params.find((p) => p.name === name) ?? b.def.inputs.find((p) => p.name === name);
      if (!def) {
        push({ severity: 'warning', code: 'unknown-param', message: `${b.id}: ${b.def.type} has no parameter or input "${name}"`, line: at('blocks', b.id, 'params', name), block: b.id });
        continue;
      }
      if (typeof value === 'string' && value.startsWith('$')) {
        const ref = value.slice(1);
        if (!ctx.composite) {
          push({ severity: 'warning', code: 'param-ref-outside-composite', message: `${b.id}.${name}: "$" references only work inside composite blocks`, line: at('blocks', b.id, 'params', name), block: b.id });
        } else if (!ctx.composite.params.some((p) => p.name === ref) && !ctx.composite.inputs.some((p) => p.name === ref)) {
          push({ severity: 'error', code: 'unknown-param-ref', message: `${b.id}.${name}: ${ctx.composite.type} has no parameter "${ref}"`, line: at('blocks', b.id, 'params', name), block: b.id });
        }
        continue;
      }
      const err = checkValue(def, value);
      if (err) push({ severity: 'warning', code: 'bad-value', message: `${b.id}.${name} = ${String(value)}: ${err}`, line: at('blocks', b.id, 'params', name), block: b.id });
    }
  }
  if (orders.size) {
    for (const [o, ids] of orders) {
      if (ids.length > 1) {
        for (const id of ids) push({ severity: 'warning', code: 'duplicate-order', message: `${id}: order ${o} is shared with ${ids.filter((x) => x !== id).join(', ')}`, line: at('blocks', id, 'order'), block: id });
      }
    }
    for (const b of diagram.blocks) {
      if (b.order === undefined) push({ severity: 'warning', code: 'missing-order', message: `${b.id}: no execution order (other blocks have one)`, line: at('blocks', b.id), block: b.id });
    }
  }

  // --- links --------------------------------------------------------------
  const drivers = new Map<string, number[]>();
  for (const l of diagram.links) {
    const line = at('links', l.index);
    const bad = (code: string, message: string) => push({ severity: 'error', code, message: `Link ${formatEndpoint(l.from)} -> ${formatEndpoint(l.to)}: ${message}`, line, link: l.index });

    // source
    let srcOk = true;
    if (l.from.strategy) {
      if (ctx.composite) {
        bad('ext-in-composite', 'composite blocks cannot reference strategies');
        srcOk = false;
      } else if (ctx.sequences?.has(l.from.strategy)) {
        const q = ctx.sequences.get(l.from.strategy)!;
        if (!sequenceSignalType(q, l.from.block, l.from.port)) {
          bad('unknown-port', `sequence ${q.name} has no signal "${l.from.block}.${l.from.port}" (use STEP.X, STEP.T or SEQ.RUNNING / DONE / ALARM / STEP)`);
          srcOk = false;
        }
      } else {
        const s = ctx.strategies?.get(l.from.strategy);
        const sb = s?.blocks.find((b) => b.id === l.from.block);
        if (!s) (bad('unknown-strategy', `strategy "${l.from.strategy}" does not exist`), (srcOk = false));
        else if (!sb) (bad('unknown-block', `block "${l.from.block}" does not exist in ${s.name}`), (srcOk = false));
        else if (sb.def && !findPort(sb.def, 'out', l.from.port)) (bad('unknown-port', `${sb.def.type} has no output "${l.from.port}"`), (srcOk = false));
      }
    } else if (ctx.composite && l.from.block === IFACE_IN) {
      if (!ctx.composite.inputs.some((p) => p.name === l.from.port)) (bad('unknown-port', `${ctx.composite.type} has no input "${l.from.port}"`), (srcOk = false));
    } else if (l.from.block === IFACE_OUT) {
      bad('wrong-direction', '"out" can only be a link target');
      srcOk = false;
    } else {
      const sb = blocks.get(l.from.block);
      if (!sb) (bad('unknown-block', `block "${l.from.block}" does not exist`), (srcOk = false));
      else if (sb.def && !findPort(sb.def, 'out', l.from.port)) {
        bad(findPort(sb.def, 'in', l.from.port) ? 'wrong-direction' : 'unknown-port', findPort(sb.def, 'in', l.from.port) ? `${l.from.port} is an input, a link must start at an output` : `${sb.def.type} has no output "${l.from.port}"`);
        srcOk = false;
      }
    }

    // target
    let dstType: string | undefined;
    if (l.to.strategy) {
      bad('ext-target', 'a link can only pull a signal from another strategy; write it in the receiving strategy');
      continue;
    }
    if (ctx.composite && l.to.block === IFACE_OUT) {
      const p = ctx.composite.outputs.find((x) => x.name === l.to.port);
      if (!p) {
        bad('unknown-port', `${ctx.composite.type} has no output "${l.to.port}"`);
        continue;
      }
      dstType = p.type;
    } else if (l.to.block === IFACE_IN) {
      bad('wrong-direction', '"in" can only be a link source');
      continue;
    } else {
      const tb = blocks.get(l.to.block);
      if (!tb) {
        bad('unknown-block', `block "${l.to.block}" does not exist`);
        continue;
      }
      if (tb.def) {
        const p = findPort(tb.def, 'in', l.to.port);
        if (!p) {
          bad(findPort(tb.def, 'out', l.to.port) ? 'wrong-direction' : 'unknown-port', findPort(tb.def, 'out', l.to.port) ? `${l.to.port} is an output, a link must end at an input` : `${tb.def.type} has no input "${l.to.port}"`);
          continue;
        }
        dstType = p.type;
        if (l.to.port in tb.params) {
          push({ severity: 'warning', code: 'linked-and-constant', message: `${tb.id}.${l.to.port} is linked and also has a constant value; the link wins`, line: at('blocks', tb.id, 'params', l.to.port), block: tb.id });
        }
      }
    }
    const key = `${l.to.block}.${l.to.port}`;
    drivers.set(key, [...(drivers.get(key) ?? []), l.index]);

    if (srcOk && dstType) {
      const st = sourceType(l.from, diagram, ctx);
      if (st && compatible(st, dstType) === 'mismatch') {
        push({ severity: 'warning', code: 'type-mismatch', message: `Link ${formatEndpoint(l.from)} -> ${formatEndpoint(l.to)}: ${st} into ${dstType}`, line, link: l.index });
      }
    }
  }
  for (const [key, idx] of drivers) {
    if (idx.length > 1) {
      for (const i of idx) push({ severity: 'error', code: 'multiple-drivers', message: `Input ${key} is driven by ${idx.length} links`, line: at('links', i), link: i });
    }
  }

  // --- composite interface ------------------------------------------------
  if (ctx.composite) {
    for (const o of ctx.composite.outputs) {
      if (!drivers.has(`${IFACE_OUT}.${o.name}`)) {
        push({ severity: 'warning', code: 'unconnected-output', message: `${ctx.composite.type}: output ${o.name} is not connected inside the diagram`, line: at() });
      }
    }
  }
  return diags;
}

/** Topological execution order (10, 20, …) following signal flow; cycles keep declaration order. */
export function autoOrder(diagram: Diagram, step = 10): Map<string, number> {
  const ids = diagram.blocks.map((b) => b.id);
  const preds = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (const l of diagram.links) {
    if (l.from.strategy || !preds.has(l.from.block) || !preds.has(l.to.block) || l.from.block === l.to.block) continue;
    preds.get(l.to.block)!.add(l.from.block);
  }
  const result = new Map<string, number>();
  const placed = new Set<string>();
  let n = 0;
  while (placed.size < ids.length) {
    let progressed = false;
    for (const id of ids) {
      if (placed.has(id)) continue;
      if ([...preds.get(id)!].every((p) => placed.has(p))) {
        placed.add(id);
        result.set(id, ++n * step);
        progressed = true;
      }
    }
    if (!progressed) {
      // Break a feedback loop at the first unplaced block in declaration order.
      const id = ids.find((x) => !placed.has(x))!;
      placed.add(id);
      result.set(id, ++n * step);
    }
  }
  return result;
}
