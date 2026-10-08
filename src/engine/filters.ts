import type { FieldValue } from './types.ts';

export type FilterFn = (v: FieldValue, arg?: string) => string;

function num(v: FieldValue): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function group(n: number, dp: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Price with magnitude-appropriate precision: 68,432.10 / 3.42 / 0.0821 / 0.00004312 */
export function formatPrice(v: FieldValue): string {
  const n = num(v);
  if (n === null) return String(v ?? '');
  const a = Math.abs(n);
  if (a >= 1000) return group(n, 2);
  if (a >= 1) return group(n, a >= 100 ? 2 : 4).replace(/\.?0+$/, '') || String(n);
  if (a >= 0.01) return n.toFixed(4);
  if (a === 0) return '0';
  return n.toPrecision(3);
}

/** Human-readable USD amount using 亿 / 万 for a Chinese audience. */
export function formatUsd(v: FieldValue, suffix = '美元'): string {
  const n = num(v);
  if (n === null) return String(v ?? '');
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(2)} 亿${suffix}`;
  if (a >= 1e4) return `${sign}${group(a / 1e4, a / 1e4 >= 100 ? 0 : 1)} 万${suffix}`;
  return `${sign}$${group(a, a >= 100 ? 0 : 2)}`;
}

/** A raw funding rate (0.00082) rendered as a percentage (0.082%). */
export function formatRate(v: FieldValue): string {
  const n = num(v);
  return n === null ? String(v ?? '') : `${(n * 100).toFixed(3)}%`;
}

/** `$BTC` — cashtag for a bare symbol. */
export function toCashtag(v: FieldValue): string {
  return v == null || v === '' ? '' : `$${String(v).replace(/^\$/, '')}`;
}

export const filters: Record<string, FilterFn> = {
  price: formatPrice,
  usd: v => formatUsd(v),
  money: v => formatUsd(v, ''),
  pct: v => {
    const n = num(v);
    return n === null ? String(v ?? '') : `${n.toFixed(2)}%`;
  },
  spct: v => {
    const n = num(v);
    if (n === null) return String(v ?? '');
    return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
  },
  pcta: v => {
    const n = num(v);
    return n === null ? String(v ?? '') : `${Math.abs(n).toFixed(2)}%`;
  },
  rate: formatRate,
  fixed: (v, arg) => {
    const n = num(v);
    return n === null ? String(v ?? '') : n.toFixed(Number(arg ?? 2));
  },
  abs: v => {
    const n = num(v);
    return n === null ? String(v ?? '') : String(Math.abs(n));
  },
  round: v => {
    const n = num(v);
    return n === null ? String(v ?? '') : String(Math.round(n));
  },
  comma: v => {
    const n = num(v);
    if (n === null) return String(v ?? '');
    // Only ever applied to counts (open interest, views). A number this large carrying
    // ".20" reads like a bug, and it is one: the raw feed value, decimals and all.
    if (Math.abs(n) >= 1000) return group(Math.round(n), 0);
    return group(n, Number.isInteger(n) ? 0 : 2);
  },
  /** A bare count in the units a Chinese reader actually uses: 23.2 万, not 231,730. */
  count: v => {
    const n = num(v);
    if (n === null) return String(v ?? '');
    const sign = n < 0 ? '-' : '';
    const a = Math.abs(n);
    if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(1)} 亿`;
    if (a >= 1e4) return `${sign}${group(a / 1e4, a / 1e4 >= 100 ? 0 : 1)} 万`;
    return `${sign}${Math.round(a)}`;
  },
  upper: v => String(v ?? '').toUpperCase(),
  lower: v => String(v ?? '').toLowerCase(),
  cash: toCashtag,
  /** `#BTC` — hashtag. */
  hash: v => (v == null || v === '' ? '' : `#${String(v).replace(/^#/, '')}`),
  trim: v => String(v ?? '').trim(),
};

export function applyFilters(value: FieldValue, calls: { name: string; arg?: string }[], expr: string): string {
  let out: FieldValue = value;
  for (const call of calls) {
    const fn = filters[call.name];
    if (!fn) throw new Error(`Unknown filter "{{...|${call.name}}}" in "${expr}"`);
    out = fn(out, call.arg);
  }
  if (out === null || out === undefined) return '';
  if (typeof out === 'object') return JSON.stringify(out);
  return String(out);
}
