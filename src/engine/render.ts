import { parse } from './parser.ts';
import { applyFilters } from './filters.ts';
import { Rng, hashString } from './prng.ts';
import type { Context, Fact, FieldValue, Node, RenderResult, RenderTrace, TemplateDef } from './types.ts';

export class AbortRender extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/* ------------------------------------------------------------------ */
/* expression evaluation                                               */
/* ------------------------------------------------------------------ */

type ExprTok = { t: 'id' | 'num' | 'str' | 'op' | 'paren'; v: string };

const OPS = ['===', '!==', '==', '!=', '>=', '<=', '&&', '||', '>', '<', '!'];

function lexExpr(src: string): ExprTok[] {
  const out: ExprTok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(' || c === ')') {
      out.push({ t: 'paren', v: c });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        s += src[j];
        j++;
      }
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < src.length && /[0-9._]/.test(src[j] as string)) j++;
      out.push({ t: 'num', v: src.slice(i, j).replace(/_/g, '') });
      i = j;
      continue;
    }
    const op = OPS.find(o => src.startsWith(o, i));
    if (op) {
      out.push({ t: 'op', v: op });
      i += op.length;
      continue;
    }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_$.\u4e00-\u9fff]/.test(src[j] as string)) j++;
    if (j === i) throw new Error(`Cannot parse expression near "${src.slice(i, i + 12)}"`);
    out.push({ t: 'id', v: src.slice(i, j) });
    i = j;
  }
  return out;
}

export function resolve(ctx: Context, path: string): FieldValue {
  let cur: FieldValue = ctx;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? (cur[Number(part)] as FieldValue) : ((cur as Record<string, FieldValue>)[part] as FieldValue);
  }
  return cur;
}

export function truthy(v: FieldValue): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return Object.keys(v).length > 0;
}

class ExprParser {
  constructor(private toks: ExprTok[]) {}

  parse(): FieldValue {
    const v = this.or();
    if (this.toks.length) throw new Error(`Trailing tokens in expression: ${this.toks.map(t => t.v).join(' ')}`);
    return v;
  }

  private or(): FieldValue {
    let left = this.and();
    while (this.peekOp('||')) {
      this.eat();
      const right = this.and();
      left = truthy(left) || truthy(right);
    }
    return left;
  }

  private and(): FieldValue {
    let left = this.cmp();
    while (this.peekOp('&&')) {
      this.eat();
      const right = this.cmp();
      left = truthy(left) && truthy(right);
    }
    return left;
  }

  private cmp(): FieldValue {
    if (this.peekOp('!')) {
      this.eat();
      return !truthy(this.cmp());
    }
    const left = this.primary();
    const op = ['==', '!=', '===', '!==', '>', '<', '>=', '<='].find(o => this.toks[0]?.t === 'op' && this.toks[0]?.v === o);
    if (!op) return left;
    this.eat();
    const right = this.primary();
    return compare(op, left, right);
  }

  private primary(): FieldValue {
    const tok = this.toks[0];
    if (!tok) throw new Error('Unexpected end of expression');
    if (tok.t === 'paren' && tok.v === '(') {
      this.eat();
      const v = this.or();
      const close = this.toks.shift();
      if (!close || close.v !== ')') throw new Error('Unbalanced parentheses');
      return v;
    }
    this.eat();
    if (tok.t === 'num') return Number(tok.v);
    if (tok.t === 'str') return tok.v;
    if (tok.t === 'id') {
      if (tok.v === 'true') return true;
      if (tok.v === 'false') return false;
      if (tok.v === 'null') return null;
      return this.ctxLookup(tok.v);
    }
    throw new Error(`Unexpected token "${tok.v}"`);
  }

  private ctxLookup = (path: string): FieldValue => resolve(this.ctxRef, path);
  ctxRef: Context = {};

  private peekOp(op: string): boolean {
    return this.toks[0]?.t === 'op' && this.toks[0]?.v === op;
  }

  private eat(): void {
    this.toks.shift();
  }
}

function compare(op: string, a: FieldValue, b: FieldValue): boolean {
  const an = typeof a === 'number' ? a : Number(a);
  const bn = typeof b === 'number' ? b : Number(b);
  const numeric = !Number.isNaN(an) && !Number.isNaN(bn) && a !== null && b !== null && a !== '' && b !== '';
  switch (op) {
    case '==':
    case '===':
      return numeric ? an === bn : String(a) === String(b);
    case '!=':
    case '!==':
      return numeric ? an !== bn : String(a) !== String(b);
    case '>':
      return numeric && an > bn;
    case '<':
      return numeric && an < bn;
    case '>=':
      return numeric && an >= bn;
    case '<=':
      return numeric && an <= bn;
    default:
      throw new Error(`Unknown operator ${op}`);
  }
}

const exprCache = new Map<string, ExprTok[]>();

function evalExpr(src: string, ctx: Context): FieldValue {
  let toks = exprCache.get(src);
  if (!toks) {
    toks = lexExpr(src);
    exprCache.set(src, toks);
  }
  const p = new ExprParser([...toks]);
  p.ctxRef = ctx;
  return p.parse();
}

/* ------------------------------------------------------------------ */
/* renderer                                                            */
/* ------------------------------------------------------------------ */

export type WordBank = Record<string, string>;

const NUMBER_RE = /-?\d[\d,]*(?:\.\d+)?/g;

function scanFacts(out: Fact[], surface: string, field: string, kind: Fact['kind']): void {
  if (!surface) return;
  let matched = false;
  for (const m of surface.match(NUMBER_RE) ?? []) {
    matched = true;
    out.push({ surface: m, value: Number(m.replace(/,/g, '')), field, kind: 'number' });
  }
  // A digit-free value (a ticker, a phrase) is still something the renderer produced,
  // so record it to keep the audit from calling it invented.
  if (!matched && kind === 'symbol') out.push({ surface, value: null, field, kind: 'symbol' });
}

interface Sink {
  parts: string[];
  facts: Fact[];
  trace: RenderTrace;
  rng: Rng;
  bank: WordBank;
  depth: number;
}

function emit(sink: Sink, text: string, field: string, kind: Fact['kind'] = 'text'): void {
  if (!text) return;
  sink.parts.push(text);
  scanFacts(sink.facts, text, field, kind);
}

function renderNodes(nodes: Node[], ctx: Context, sink: Sink): void {
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        emit(sink, node.value, 'literal');
        break;

      case 'interp': {
        const v = evalExpr(node.expr, ctx);
        const s = applyFilters(v, node.filters, node.expr);
        emit(sink, s, node.expr, typeof v === 'number' || /\d/.test(s) ? 'number' : 'symbol');
        break;
      }

      case 'pool': {
        const idx = sink.rng.int(node.options.length);
        sink.trace.pools.push(node.options[idx] ? preview(nodeOptions(node.options, idx)) : '');
        const chosen = node.options[idx];
        if (chosen) renderNodes(chosen, ctx, sink);
        break;
      }

      case 'cond': {
        for (const branch of node.branches) {
          if (branch.test === null || truthy(evalExpr(branch.test, ctx))) {
            sink.trace.branches.push(`${branch.test ?? 'else'} => taken`);
            renderNodes(branch.body, ctx, sink);
            break;
          }
        }
        break;
      }

      case 'maybe': {
        if (sink.rng.chance(node.pct)) renderNodes(node.body, ctx, sink);
        else sink.trace.branches.push(`#maybe ${node.pct} => skipped`);
        break;
      }

      case 'each': {
        const src = evalExpr(node.source, ctx);
        const list = Array.isArray(src) ? src.slice(0, node.max) : [];
        list.forEach((item, i) => {
          const child: Context = { ...ctx, [node.alias]: item as FieldValue, [`${node.alias}_index`]: i + 1 };
          if (i > 0) emit(sink, unescapeSep(node.sep), 'literal');
          renderNodes(node.body, child, sink);
        });
        break;
      }

      case 'bank': {
        const body = node.path;
        const source = sink.bank[body];
        if (source === undefined) throw new Error(`Word bank has no entry "@${body}"`);
        if (sink.depth >= 6) throw new Error(`Word bank recursion too deep at "@${body}"`);
        sink.trace.banks.push(body);
        sink.depth++;
        renderNodes(parse(source), ctx, sink);
        sink.depth--;
        break;
      }

      case 'require': {
        const missing = node.fields.filter(f => !truthy(evalExpr(f, ctx)));
        if (missing.length) throw new AbortRender(`missing required field(s): ${missing.join(', ')}`);
        break;
      }
    }
  }
}

function nodeOptions(options: Node[][], idx: number): string {  return options[idx]?.map(n => (n.kind === 'text' ? n.value : '…')).join('') ?? '';
}

function preview(s: string): string {
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/** `#each ... sep="\n"` arrives with a literal backslash; turn it into a real break. */
function unescapeSep(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

export interface RenderOptions {
  seed?: number | string;
  bank?: WordBank;
}

/** Render an already-parsed template body against a material context. */
export function renderNodesToString(nodes: Node[], ctx: Context, opts: RenderOptions = {}): RenderResult & { trace: RenderTrace } {
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const numericSeed = typeof seed === 'string' ? hashString(seed) : seed;
  const sink: Sink = {
    parts: [],
    facts: [],
    trace: { templateId: '', seed: numericSeed, pools: [], banks: [], branches: [] },
    rng: new Rng(numericSeed),
    bank: opts.bank ?? {},
    depth: 0,
  };
  try {
    renderNodes(nodes, ctx, sink);
  } catch (err) {
    if (err instanceof AbortRender) {
      return { ok: false, text: '', facts: [], trace: { ...sink.trace, skipped: err.reason }, reason: err.reason };
    }
    throw err;
  }
  const text = sink.parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { ok: true, text, facts: sink.facts, trace: sink.trace };
}

/**
 * Render a template, first checking its declared data contract.
 * Returns ok:false (never throws) when the material lacks a field the template needs.
 */
export function renderTemplate(def: TemplateDef, ctx: Context, opts: RenderOptions = {}): RenderResult {
  for (const spec of def.requires ?? []) {
    if (spec.required === false) continue;
    if (!truthy(resolve(ctx, spec.path))) {
      const reason = spec.note ? `${spec.path} — ${spec.note}` : `missing required field: ${spec.path}`;
      return { ok: false, text: '', facts: [], reason, trace: { templateId: def.id, seed: 0, pools: [], banks: [], branches: [], skipped: reason } };
    }
  }
  const res = renderNodesToString(parse(def.body), ctx, opts);
  return { ...res, trace: { ...res.trace, templateId: def.id } };
}
