import { sampleSignals } from '../hot/signals.ts';
import { annualizedFunding } from './derive.ts';
import type { Material } from './types.ts';

/**
 * Give every symbol-bearing material the same market dimensions the attention path has.
 *
 * This is what makes the writing styles real rather than decorative. 资金追踪派 and
 * 情绪派 looking at a `market_move` material were handed five fields — tf, chg, price,
 * chg24h, volMultiple — so the only thing left to vary between seven styles was which
 * synonym opened the sentence. With funding, positioning and open-interest change present,
 * each style has a different fact to point at, which is the only thing that makes a reader
 * scanning a feed find something in one post that was not in the next.
 *
 * Never overwrites a value the collector already measured: the collector's number is the
 * one tied to the event's moment, and this is the market as of now.
 */
export async function enrichWithMarketContext(materials: Material[], fundingIntervalHours = 8): Promise<number> {
  const symbols = [...new Set(materials.map(m => m.symbol).filter((s): s is string => Boolean(s)))];
  if (!symbols.length) return 0;

  const signals = await sampleSignals({ forceSymbols: symbols, depth: Math.min(60, symbols.length) }).catch(() => []);
  const by = new Map(signals.map(s => [s.symbol.toUpperCase(), s]));

  let touched = 0;
  for (const m of materials) {
    const s = m.symbol ? by.get(m.symbol.toUpperCase()) : undefined;
    if (!s) continue;
    const f = m.facts as Record<string, unknown>;
    const add = (k: string, v: unknown): void => {
      if (v !== null && v !== undefined && (f[k] === undefined || f[k] === null)) f[k] = v;
    };
    add('funding', s.funding);
    add('longRatio', s.longRatio == null ? null : Number(s.longRatio.toFixed(2)));
    add('oiChangePct', s.oiChangePct == null || Math.abs(s.oiChangePct) > 100 ? null : Number(s.oiChangePct.toFixed(1)));
    add('chg1h', Number(s.chg1h.toFixed(2)));
    add('volMultiple', s.volMultiple == null ? null : Number(s.volMultiple.toFixed(2)));
    add('quoteVolume24h', Math.round(s.quoteVolume24h));
    // A Hyperliquid material carries that venue's own turnover, which on its own tells a
    // reader nothing about whether the move matters. Next to Binance's volume for the same
    // coin it does — and the expression language has no arithmetic, so the ratio is
    // measured here, where both figures are present, rather than invented at render time.
    if (typeof f.volume24h === 'number' && typeof f.quoteVolume24h === 'number' && f.quoteVolume24h > 0) {
      add('venueSharePct', Number(((f.volume24h / f.quoteVolume24h) * 100).toFixed(1)));
    }
    if (typeof f.funding === 'number' && f.annualized == null) {
      add('annualized', annualizedFunding(f.funding, fundingIntervalHours));
    }
    if (typeof f.funding === 'number' && f.payer == null) {
      add('payer', f.funding > 0 ? '多头' : f.funding < 0 ? '空头' : null);
    }
    touched++;
  }
  return touched;
}
