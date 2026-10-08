import type { FilterCall, Node } from './types.ts';

type Tok = { type: 'text'; v: string } | { type: 'tag'; v: string } | { type: 'pool'; options: string[] };

/** Split `s` on `sep`, ignoring separators nested inside () [] {} or quotes. */
export function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (quote) {
      cur += c;
      if (c === quote && s[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (depth === 0 && s.startsWith(sep, i)) {
      out.push(cur);
      cur = '';
      i += sep.length - 1;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Index of the `}` closing the `{` at `start`, or -1 when unbalanced. */
function matchBrace(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i] as string;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf) {
      toks.push({ type: 'text', v: buf });
      buf = '';
    }
  };

  while (i < src.length) {
    const c = src[i] as string;

    if (c === '{' && src[i + 1] === '{') {
      const end = src.indexOf('}}', i + 2);
      if (end === -1) {
        buf += c;
        i++;
        continue;
      }
      flush();
      toks.push({ type: 'tag', v: src.slice(i + 2, end).trim() });
      i = end + 2;
      continue;
    }

    if (c === '{') {
      const end = matchBrace(src, i);
      if (end !== -1) {
        const inner = src.slice(i + 1, end);
        // A synonym pool is `{a|b|c}` with no nested braces and no empty arms.
        if (!/[{}]/.test(inner) && inner.includes('|')) {
          const options = splitTop(inner, '|').map(o => o.trim());
          if (options.every(o => o.length > 0)) {
            flush();
            toks.push({ type: 'pool', options });
            i = end + 1;
            continue;
          }
        }
      }
    }

    buf += c;
    i++;
  }
  flush();
  return toks;
}

/** Split an interpolation into base expression and `|filter:arg` pipeline. */
function splitFilters(expr: string): { expr: string; filters: FilterCall[] } {
  // Only single `|` starts a filter; `||` is the logical-or operator.
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i] as string;
    if (quote) {
      cur += c;
      if (c === quote && expr[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (depth === 0 && c === '|' && expr[i + 1] !== '|' && expr[i - 1] !== '|') {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);

  const base = (parts.shift() ?? '').trim();
  const filters: FilterCall[] = parts.map(p => {
    const t = p.trim();
    const colon = t.indexOf(':');
    return colon === -1 ? { name: t } : { name: t.slice(0, colon).trim(), arg: t.slice(colon + 1).trim() };
  });
  return { expr: base, filters };
}

interface Cursor {
  toks: Tok[];
  i: number;
}

const CLOSE = /^\/(if|maybe|each)$/;

function parseSequence(cur: Cursor, stopAt: (tag: string) => boolean): Node[] {
  const nodes: Node[] = [];
  while (cur.i < cur.toks.length) {
    const tok = cur.toks[cur.i] as Tok;
    if (tok.type === 'text') {
      nodes.push({ kind: 'text', value: tok.v });
      cur.i++;
      continue;
    }
    if (tok.type === 'pool') {
      cur.i++;
      nodes.push({ kind: 'pool', options: tok.options.map(o => parseSequence({ toks: tokenize(o), i: 0 }, () => false)) });
      continue;
    }
    const tag = tok.v;
    if (stopAt(tag)) return nodes;
    cur.i++;
    const node = parseTag(tag, cur);
    if (node) nodes.push(node);
  }
  return nodes;
}

function parseTag(tag: string, cur: Cursor): Node | null {
  if (CLOSE.test(tag)) {
    throw new Error(`Unexpected {{${tag}}}`);
  }

  if (tag.startsWith('#if ')) {
    const branches: { test: string | null; body: Node[] }[] = [];
    let test: string | null = tag.slice(4).trim();
    for (;;) {
      const body = parseSequence(cur, t => t === '#else' || t.startsWith('#elif ') || t === '/if');
      branches.push({ test, body });
      const closing = (cur.toks[cur.i] as Tok | undefined) ?? null;
      const t = closing?.type === 'tag' ? closing.v : null;
      if (t === '#else') {
        cur.i++;
        const elseBody = parseSequence(cur, x => x === '/if');
        branches.push({ test: null, body: elseBody });
        expect(cur, '/if');
        break;
      }
      if (t && t.startsWith('#elif ')) {
        cur.i++;
        test = t.slice(6).trim();
        continue;
      }
      if (t === '/if') {
        cur.i++;
        break;
      }
      throw new Error('Unterminated {{#if}} block');
    }
    return { kind: 'cond', branches };
  }

  if (tag.startsWith('#maybe ')) {
    const pct = Number(tag.slice(7).trim());
    if (!Number.isFinite(pct)) throw new Error(`Bad {{#maybe}} percentage in "{{tag}}"`);
    const body = parseSequence(cur, t => t === '/maybe');
    expect(cur, '/maybe');
    return { kind: 'maybe', pct, body };
  }

  if (tag.startsWith('#each ')) {
    const attrs = parseAttrs(tag.slice(6).trim());
    const source = attrs.positional[0] ?? '';
    const asIndex = attrs.positional.indexOf('as');
    const alias = attrs.named.as ?? (asIndex >= 0 ? attrs.positional[asIndex + 1] : undefined) ?? 'item';
    const sep = unquote(attrs.named.sep ?? ', ');
    const max = Number(attrs.named.max ?? '20');
    const body = parseSequence(cur, t => t === '/each');
    expect(cur, '/each');
    return { kind: 'each', source, alias, sep, max: Number.isFinite(max) ? max : 20, body };
  }

  if (tag.startsWith('#require ')) {
    const fields = tag
      .slice(9)
      .split(/[,|\s]+/)
      .map(s => s.trim())
      .filter(Boolean);
    return { kind: 'require', fields };
  }

  if (tag.startsWith('@')) {
    const { expr, filters } = splitFilters(tag);
    return { kind: 'bank', path: expr.replace(/^@/, ''), filters };
  }

  const { expr, filters } = splitFilters(tag);
  return { kind: 'interp', expr, filters };
}

function expect(cur: Cursor, tag: string): void {
  const tok = cur.toks[cur.i];
  if (!tok || tok.type !== 'tag' || tok.v !== tag) {
    throw new Error(`Expected {{${tag}}}`);
  }
  cur.i++;
}

function unquote(s: string): string {
  const q = s[0];
  if ((q === '"' || q === "'") && s.length > 1 && s.endsWith(q)) return s.slice(1, -1);
  return s;
}

function parseAttrs(src: string): { positional: string[]; named: Record<string, string> } {
  const positional: string[] = [];
  const named: Record<string, string> = {};
  for (const piece of splitTop(src, ' ').map(s => s.trim()).filter(Boolean)) {
    const eq = piece.indexOf('=');
    if (eq === -1) positional.push(piece);
    else named[piece.slice(0, eq)] = piece.slice(eq + 1);
  }
  return { positional, named };
}

export function parse(src: string): Node[] {
  return parseSequence({ toks: tokenize(src), i: 0 }, () => false);
}
