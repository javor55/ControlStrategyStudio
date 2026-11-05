// Condition expressions of sequence transitions.
//
//   START_CMD and not LIC100:LAL100.QH
//   LIC100:LT100.PV >= 3.5 or S20.T > 10min
//   (FT101_OK or BYPASS) and FIC101:FIC101.ER < 2 * TOL
//
// Grammar (lowest to highest precedence):
//   or   := and ( ('or' | '||') and )*
//   and  := not ( ('and' | '&&') not )*
//   not  := ('not' | '!') not | cmp
//   cmp  := sum ( ('<' | '<=' | '=' | '==' | '<>' | '!=' | '>=' | '>') sum )?
//   sum  := prod ( ('+' | '-') prod )*
//   prod := unary ( ('*' | '/') unary )*
//   unary:= '-' unary | atom
//   atom := number | duration | TRUE | FALSE | reference | '(' or ')'
//   number   := digits ( '.' digits )? ( ('e' | 'E') ('+' | '-')? digits )?
//   duration := ( 'T#' )? digits ( '.' digits )? ( 'ms' | 's' | 'min' | 'm' | 'h' )
//               (same syntax as step times: 500ms, 5s, 2min, 2m, 1h, T#5s; case-insensitive)
// Keywords (case-insensitive): and, or, not, TRUE, FALSE.
// References: NAME, NAME.PORT, OTHER:NAME.PORT (other strategy / sequence).
//   NAME   sequence input (letters, digits, "_")
//   S10.X  step active, S10.T time in step, SEQ.RUNNING / DONE / ALARM / STEP
//   LIC100:LT100.PV  signal of another strategy (or another sequence)
// Tags may contain "-" (FT-101.PV, P-101:P-101.RUNNING): a "-" belongs to a
// name only when the reference goes on with "." or ":". In a bare name it is
// the minus operator, so `CNT-1 > 0` means CNT - 1 > 0. Write spaces around
// a minus between two tag references (`A.X - B.Y`).

export type Expr =
  | { kind: 'bool'; value: boolean }
  | { kind: 'num'; value: number }
  | { kind: 'dur'; ms: number; text: string }
  | { kind: 'ref'; text: string; scope?: string; name: string; port?: string; at: number }
  | { kind: 'not'; arg: Expr }
  | { kind: 'neg'; arg: Expr }
  | { kind: 'logic'; op: 'and' | 'or'; left: Expr; right: Expr }
  | { kind: 'cmp'; op: '<' | '<=' | '=' | '<>' | '>=' | '>'; left: Expr; right: Expr }
  | { kind: 'arith'; op: '+' | '-' | '*' | '/'; left: Expr; right: Expr };

export class ExprError extends Error {
  constructor(
    message: string,
    /** 0-based character position. */
    readonly at: number,
  ) {
    super(message);
    this.name = 'ExprError';
  }
}

type Tok = { t: 'num' | 'dur' | 'id' | 'op' | 'lp' | 'rp' | 'end'; v: string; at: number };

const DUR = /^(?:T#)?(\d+(?:\.\d+)?)(ms|s|min|m|h)\b/i;
const NUM = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const REF = /^[A-Za-z_][A-Za-z0-9_-]*(?::[A-Za-z_][A-Za-z0-9_-]*)?(?:\.[A-Za-z_][A-Za-z0-9_]*)?/;
const OPS = ['<=', '>=', '<>', '!=', '==', '&&', '||', '<', '>', '=', '+', '-', '*', '/', '!'];
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, min: 60000, m: 60000, h: 3600000 };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if ((m = DUR.exec(rest))) {
      out.push({ t: 'dur', v: m[0], at: i });
      i += m[0].length;
    } else if ((m = NUM.exec(rest))) {
      out.push({ t: 'num', v: m[0], at: i });
      i += m[0].length;
    } else if ((m = REF.exec(rest))) {
      // A bare name (no "." / ":") never contains "-": there it is the minus operator.
      const v = /[.:]/.test(m[0]) ? m[0] : m[0].split('-')[0];
      out.push({ t: 'id', v, at: i });
      i += v.length;
    } else if (c === '(') out.push({ t: 'lp', v: c, at: i++ });
    else if (c === ')') out.push({ t: 'rp', v: c, at: i++ });
    else {
      const op = OPS.find((o) => rest.startsWith(o));
      if (!op) throw new ExprError(`Unexpected character "${c}"`, i);
      out.push({ t: 'op', v: op, at: i });
      i += op.length;
    }
  }
  out.push({ t: 'end', v: '', at: src.length });
  return out;
}

export function parseExpr(src: string): Expr {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isWord = (w: string) => peek().t === 'id' && peek().v.toLowerCase() === w;
  const isOp = (...ops: string[]) => peek().t === 'op' && ops.includes(peek().v);

  const or = (): Expr => {
    let left = and();
    while (isWord('or') || isOp('||')) {
      p++;
      left = { kind: 'logic', op: 'or', left, right: and() };
    }
    return left;
  };
  const and = (): Expr => {
    let left = not();
    while (isWord('and') || isOp('&&')) {
      p++;
      left = { kind: 'logic', op: 'and', left, right: not() };
    }
    return left;
  };
  const not = (): Expr => {
    if (isWord('not') || isOp('!')) {
      p++;
      return { kind: 'not', arg: not() };
    }
    return cmp();
  };
  const cmp = (): Expr => {
    const left = sum();
    if (isOp('<', '<=', '=', '==', '<>', '!=', '>=', '>')) {
      const raw = toks[p++].v;
      const op = raw === '==' ? '=' : raw === '!=' ? '<>' : (raw as '<' | '<=' | '=' | '<>' | '>=' | '>');
      return { kind: 'cmp', op, left, right: sum() };
    }
    return left;
  };
  const sum = (): Expr => {
    let left = prod();
    while (isOp('+', '-')) {
      const op = toks[p++].v as '+' | '-';
      left = { kind: 'arith', op, left, right: prod() };
    }
    return left;
  };
  const prod = (): Expr => {
    let left = unary();
    while (isOp('*', '/')) {
      const op = toks[p++].v as '*' | '/';
      left = { kind: 'arith', op, left, right: unary() };
    }
    return left;
  };
  const unary = (): Expr => {
    if (isOp('-')) {
      p++;
      return { kind: 'neg', arg: unary() };
    }
    return atom();
  };
  const atom = (): Expr => {
    const t = peek();
    if (t.t === 'num') {
      p++;
      return { kind: 'num', value: Number(t.v) };
    }
    if (t.t === 'dur') {
      p++;
      const m = DUR.exec(t.v)!;
      return { kind: 'dur', ms: Number(m[1]) * UNIT_MS[m[2].toLowerCase()], text: t.v };
    }
    if (t.t === 'lp') {
      p++;
      const e = or();
      if (peek().t !== 'rp') throw new ExprError('Missing ")"', peek().at);
      p++;
      return e;
    }
    if (t.t === 'id') {
      const low = t.v.toLowerCase();
      if (low === 'true' || low === 'false') {
        p++;
        return { kind: 'bool', value: low === 'true' };
      }
      if (['and', 'or', 'not'].includes(low)) throw new ExprError(`Unexpected "${t.v}"`, t.at);
      p++;
      const m = /^(?:([^:]+):)?([^.]+)(?:\.(.+))?$/.exec(t.v)!;
      return { kind: 'ref', text: t.v, scope: m[1], name: m[2], port: m[3], at: t.at };
    }
    throw new ExprError(t.t === 'end' ? 'Condition is incomplete' : `Unexpected "${t.v}"`, t.at);
  };

  if (!src.trim()) throw new ExprError('Condition is empty', 0);
  const e = or();
  if (peek().t !== 'end') throw new ExprError(`Unexpected "${peek().v}"`, peek().at);
  return e;
}

export type RefExpr = Extract<Expr, { kind: 'ref' }>;

/**
 * Rewrites references inside condition text in place (formatting and spacing
 * stay as written). `fn` returns the new text of a reference, or undefined to
 * keep it. Text that does not parse is returned unchanged.
 */
export function rewriteExprRefs(src: string, fn: (r: RefExpr) => string | undefined): string {
  let e: Expr;
  try {
    e = parseExpr(src);
  } catch {
    return src;
  }
  let text = src;
  for (const r of exprRefs(e).sort((x, y) => y.at - x.at)) {
    const n = fn(r);
    if (n !== undefined && n !== r.text) text = text.slice(0, r.at) + n + text.slice(r.at + r.text.length);
  }
  return text;
}

/** All references in an expression. */
export function exprRefs(e: Expr): Extract<Expr, { kind: 'ref' }>[] {
  switch (e.kind) {
    case 'ref':
      return [e];
    case 'not':
    case 'neg':
      return exprRefs(e.arg);
    case 'logic':
    case 'cmp':
    case 'arith':
      return [...exprRefs(e.left), ...exprRefs(e.right)];
    default:
      return [];
  }
}

export type ExprType = 'BOOL' | 'NUM' | 'TIME' | 'ANY';

/**
 * Infers the type of an expression; `refType` resolves references (undefined =
 * unknown reference → reported via `onError`). Returns the type of `e`.
 */
export function typeOf(e: Expr, refType: (r: Extract<Expr, { kind: 'ref' }>) => ExprType | undefined, onError: (msg: string, at?: number) => void): ExprType {
  const t = (x: Expr): ExprType => typeOf(x, refType, onError);
  switch (e.kind) {
    case 'bool':
      return 'BOOL';
    case 'num':
      return 'NUM';
    case 'dur':
      return 'TIME';
    case 'ref': {
      const r = refType(e);
      if (!r) {
        onError(`Unknown signal "${e.text}"`, e.at);
        return 'ANY';
      }
      return r;
    }
    case 'not': {
      const a = t(e.arg);
      if (a !== 'BOOL' && a !== 'ANY') onError('"not" needs a BOOL value');
      return 'BOOL';
    }
    case 'neg': {
      const a = t(e.arg);
      if (a === 'BOOL') onError('Cannot negate a BOOL value');
      return a;
    }
    case 'logic': {
      for (const s of [t(e.left), t(e.right)]) if (s !== 'BOOL' && s !== 'ANY') onError(`"${e.op}" needs BOOL values`);
      return 'BOOL';
    }
    case 'cmp': {
      const a = t(e.left);
      const b = t(e.right);
      if (a !== 'ANY' && b !== 'ANY' && a !== b) onError(`Cannot compare ${a} with ${b}`);
      if ((a === 'BOOL' || b === 'BOOL') && e.op !== '=' && e.op !== '<>') onError(`"${e.op}" does not apply to BOOL values`);
      return 'BOOL';
    }
    case 'arith': {
      const a = t(e.left);
      const b = t(e.right);
      if (a === 'BOOL' || b === 'BOOL') onError(`"${e.op}" does not apply to BOOL values`);
      return a === 'TIME' || b === 'TIME' ? 'TIME' : a === 'ANY' || b === 'ANY' ? 'ANY' : 'NUM';
    }
  }
}

/** Maps a signal data type to an expression type. */
export function exprTypeOf(signalType: string | undefined): ExprType | undefined {
  if (!signalType) return undefined;
  if (signalType === 'BOOL') return 'BOOL';
  if (signalType === 'TIME') return 'TIME';
  if (['INT', 'DINT', 'REAL', 'ANY_NUM'].includes(signalType)) return 'NUM';
  return 'ANY';
}
