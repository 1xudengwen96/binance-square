import { binance, liquid, num } from '../collectors/binance.ts';
import { dexTrending } from '../collectors/dex.ts';

/**
 * Per-symbol attention sampling.
 *
 * One signal is noise. A coin that is moving *and* attracting volume *and* drawing
 * open interest is a story worth a professional post, so every symbol is scored on
 * several independent axes and a single-axis spike is deliberately damped.
 */

export interface SignalParts {
  chg24h: number;
  chg1h: number;
  volMultiple: number;
  funding: number | null;
  longRatio: number | null;
  oiChangePct: number | null;
  dexHot: boolean;
}

export interface SymbolSignal extends SignalParts {
  symbol: string;
  price: number;
  quoteVolume24h: number;
  /** 0-100 composite attention score, with the single-axis damping applied. */
  score: number;
  /** Same score before damping. Event detection wants the damped number; the
   *  attention pool must not use it, because a coin can be legitimately hot on
   *  Square while its price sits still. */
  rawScore: number;
  /** Normalised 0-1 contribution of each axis, kept for the post dossier and the UI. */
  parts: Record<string, number>;
  /** How many axes are individually notable — the agreement filter. */
  agreeing: number;
}

const WEIGHTS = {
  chg24h: 0.2,
  chg1h: 0.16,
  vol: 0.22,
  funding: 0.12,
  ratio: 0.08,
  oi: 0.16,
  dex: 0.06,
} as const;

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length || 0)).fill(0).map(async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface SampleOptions {
  /** How many movers to drill into. Each costs a couple of extra requests. */
  depth?: number;
  /** Ignore pairs thinner than this (24h quote volume, USDT). */
  minQuoteVolume?: number;
  /**
   * Symbols that must be sampled regardless of rank. The attention pool passes the
   * coins Square is actually discussing here — a quiet-but-huge coin like BTC never
   * appears in a top-movers list, and we still need its numbers.
   */
  forceSymbols?: string[];
}

export async function sampleSignals(opts: SampleOptions = {}): Promise<SymbolSignal[]> {
  const depth = opts.depth ?? 40;
  const minVol = opts.minQuoteVolume ?? 15_000_000;

  const [futures, premium] = await Promise.all([binance.futuresTickers(), binance.premiumIndex()]);
  const liquidRows = liquid(futures, minVol)
    .map(t => ({ symbol: t.symbol, base: t.symbol.replace(/USDT$/, ''), chg24h: num(t.priceChangePercent), price: num(t.lastPrice), quoteVolume24h: num(t.quoteVolume) }))
    .filter(r => r.base && Number.isFinite(r.chg24h));

  const byBase = new Map(liquidRows.map(r => [r.base, r]));
  const forced = (opts.forceSymbols ?? []).map(s => byBase.get(s.toUpperCase())).filter(Boolean) as typeof liquidRows;
  const movers = [...liquidRows]
    .sort((a, b) => Math.abs(b.chg24h) - Math.abs(a.chg24h))
    .slice(0, depth);

  const seen = new Set<string>();
  const universe = [...forced, ...movers].filter(r => (seen.has(r.symbol) ? false : (seen.add(r.symbol), true)));

  const fundingBySymbol = new Map(premium.map(p => [p.symbol, num(p.lastFundingRate)]));

  let dexHot = new Set<string>();
  try {
    const hot = await dexTrending({ top: 8 });
    dexHot = new Set(hot.map(m => String(m.symbol ?? '').toUpperCase()));
  } catch {
    /* DEX signal is a bonus, not a dependency */
  }

  const results = await mapLimit(universe, 8, async (u): Promise<SymbolSignal> => {
    const parts: SignalParts = {
      chg24h: u.chg24h,
      chg1h: 0,
      volMultiple: 1,
      funding: fundingBySymbol.has(u.symbol) ? (fundingBySymbol.get(u.symbol) ?? null) : null,
      longRatio: null,
      oiChangePct: null,
      dexHot: dexHot.has(u.base),
    };

    // One call gives both the hourly move and the volume expansion.
    try {
      // The TradFi perps (XAU, SOXL, MSTR, SNDK…) have no spot pair, so this call fails and
      // used to leave chg1h at its 0 default — a template then printed "近 1 小时没动", which
      // is a false claim about a move that was never measured. Ask the futures candles too.
      const k = await binance.klines(u.symbol, '1h', 9).catch(() => binance.futuresKlines(u.symbol, '1h', 9));
      const closed = k.slice(0, -1);
      if (closed.length >= 2) {
        const lastClose = num(closed[closed.length - 1]?.[4]);
        const prevClose = num(closed[closed.length - 2]?.[4]);
        if (prevClose) parts.chg1h = ((lastClose - prevClose) / prevClose) * 100;
        const vols = closed.map(r => num(r[7])).filter(Number.isFinite);
        const last = vols[vols.length - 1] ?? 0;
        const prior = vols.slice(-7, -1);
        const mean = prior.length ? prior.reduce((s, v) => s + v, 0) / prior.length : 0;
        if (mean > 0) parts.volMultiple = last / mean;
      }
    } catch {
      /* leave defaults */
    }

    try {
      const oi = await binance.openInterestHist(u.symbol, '1h', 6);
      const first = num(oi[0]?.sumOpenInterestValue);
      const last = num(oi[oi.length - 1]?.sumOpenInterestValue);
      if (first > 0 && Number.isFinite(last)) parts.oiChangePct = ((last - first) / first) * 100;
    } catch {
      /* some pairs have no futures statistics */
    }

    try {
      const ls = await binance.globalLongShort(u.symbol, '1h', 1);
      const r = num(ls[0]?.longShortRatio);
      if (Number.isFinite(r)) parts.longRatio = r;
    } catch {
      /* ignore */
    }

    return toSignal(u.base, u.price, u.quoteVolume24h, parts);
  });

  return results.sort((a, b) => b.score - a.score);
}

export function toSignal(symbol: string, price: number, quoteVolume24h: number, p: SignalParts): SymbolSignal {
  const norm = {
    chg24h: clamp01(Math.abs(p.chg24h) / 15),
    chg1h: clamp01(Math.abs(p.chg1h) / 6),
    vol: clamp01((p.volMultiple - 1) / 4),
    funding: clamp01(Math.abs(p.funding ?? 0) / 0.001),
    ratio: clamp01(Math.abs((p.longRatio ?? 1) - 1) / 1.5),
    oi: clamp01(Math.abs(p.oiChangePct ?? 0) / 25),
    dex: p.dexHot ? 0.7 : 0,
  };

  const raw =
    norm.chg24h * WEIGHTS.chg24h +
    norm.chg1h * WEIGHTS.chg1h +
    norm.vol * WEIGHTS.vol +
    norm.funding * WEIGHTS.funding +
    norm.ratio * WEIGHTS.ratio +
    norm.oi * WEIGHTS.oi +
    norm.dex * WEIGHTS.dex;

  // Agreement filter: one lonely axis is usually a data artefact or a wick.
  const agreeing = Object.values(norm).filter(v => v >= 0.3).length;
  const damped = agreeing <= 1 ? raw * 0.55 : agreeing >= 4 ? raw * 1.12 : raw;

  return {
    symbol,
    price,
    quoteVolume24h,
    ...p,
    rawScore: Math.round(Math.min(100, raw * 100) * 10) / 10,
    score: Math.round(Math.min(100, damped * 100) * 10) / 10,
    parts: norm,
    agreeing,
  };
}
