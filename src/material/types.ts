import type { Context, FieldValue } from '../engine/types.ts';
import { materialFingerprint } from '../engine/guard.ts';

export type MaterialCategory =
  | 'attention'
  | 'announcement'
  | 'newsflash'
  | 'market_move'
  | 'funding'
  | 'open_interest'
  | 'liquidation'
  | 'long_short'
  | 'leaderboard'
  | 'sentiment'
  | 'etf_flow'
  | 'stablecoin'
  | 'unlock'
  | 'onchain'
  | 'trending'
  | 'onchain'
  | 'dex';

export type Sentiment = 'bull' | 'bear' | 'neutral';

/**
 * A material is one *verifiable event*. `facts` is the only place a template may
 * read numbers from — anything not in here cannot be rendered, which is what
 * keeps generated copy honest.
 */
export interface Material {
  id: string;
  category: MaterialCategory;
  subType: string;
  title: string;
  symbol: string | null;
  symbols: string[];
  sentiment: Sentiment;
  /** 0-100 relative newsworthiness; drives the抢发 path. */
  score: number;
  source: string;
  /** Epoch ms of the underlying event, not of the crawl. */
  at: number;
  facts: Context;
  fingerprint: string;
  collectedAt: number;
}

export interface MaterialDraft {
  category: MaterialCategory;
  subType: string;
  title: string;
  symbol?: string | null;
  symbols?: string[];
  sentiment?: Sentiment;
  score?: number;
  source: string;
  at: number;
  facts: Context;
}

export function makeMaterial(d: MaterialDraft): Material {
  const symbols = d.symbols ?? (d.symbol ? [d.symbol] : []);
  return {
    id: `${d.category}:${d.subType}:${d.at}:${symbols.join(',') || '-'}`,
    category: d.category,
    subType: d.subType,
    title: d.title,
    symbol: d.symbol ?? symbols[0] ?? null,
    symbols,
    sentiment: d.sentiment ?? 'neutral',
    score: clamp(d.score ?? 50, 0, 100),
    source: d.source,
    at: d.at,
    facts: d.facts,
    fingerprint: materialFingerprint({ category: d.category, symbol: d.symbol ?? symbols[0] ?? null, title: d.title, at: d.at }),
    collectedAt: Date.now(),
  };
}

/** Flatten a material into the context templates render against. */
export function toContext(m: Material): Context {
  const ctx: Context = {
    ...m.facts,
    title: m.title,
    category: m.category,
    subType: m.subType,
    source: m.source,
    sentiment: m.sentiment,
    symbol: m.symbol ?? '',
    cashtag: m.symbol ? `$${m.symbol}` : '',
    cashtags: m.symbols.map(s => `$${s}`).join(' '),
    hashtags: m.symbols.map(s => `#${s}`).join(' '),
    date: formatDate(m.at),
    time: formatTime(m.at),
  };
  return ctx;
}

/** Fields every template may assume exist, for contract validation. */
export function contextKeys(ctx: Context): string[] {
  return Object.keys(ctx);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Beijing time, since that is the timezone the posting schedule is expressed in. */
function beijing(d: Date): Date {
  return new Date(d.getTime() + (d.getTimezoneOffset() + -480) * 60000);
}

export function formatDate(at: number): string {
  const d = beijing(new Date(at));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatTime(at: number): string {
  const d = beijing(new Date(at));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function isFieldArray(v: FieldValue | undefined): v is FieldValue[] {
  return Array.isArray(v);
}
