import { makeMaterial, type Material } from '../material/types.ts';

/**
 * Hyperliquid perpetual market.
 *
 * A second derivatives venue is worth having: funding and open interest there move
 * ahead of, or diverge from, Binance, and the numbers are free and complete.
 * Whale tracking was deliberately skipped — it needs a curated address list, and
 * without one "whale bought" is just a random large trade.
 */

interface HlAsset {
  szDecimals: number;
  name: string;
}

interface HlCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  markPx: string;
  oraclePx: string;
}

/**
 * `metaAndAssetCtxs` returns two index-parallel arrays — the ctxs carry no coin name,
 * so zipping by position is the only way to know which market a number belongs to.
 */
async function markets(): Promise<{ name: string; ctx: HlCtx }[]> {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    signal: AbortSignal.timeout(15_000),
  });
  const [meta, ctxs] = (await res.json()) as [{ universe?: HlAsset[] }?, HlCtx[]?];
  const universe = meta?.universe ?? [];
  const out: { name: string; ctx: HlCtx }[] = [];
  for (let i = 0; i < Math.min(universe.length, ctxs?.length ?? 0); i++) {
    const name = universe[i]!.name;
    const ctx = ctxs![i]!;
    if (name && ctx) out.push({ name, ctx });
  }
  return out;
}

function score(fundingPct: number, chgPct: number, volumeUsd: number): number {
  return Math.max(48, Math.min(88, Math.round(50 + Math.abs(fundingPct) * 220 + Math.abs(chgPct) * 1.6 + Math.log10(Math.max(volumeUsd, 1)) * 2)));
}

export async function hyperliquid(opts: { fundingThreshold?: number; minVolumeUsd?: number; limit?: number } = {}): Promise<Material[]> {
  const threshold = opts.fundingThreshold ?? 0.0002;
  const minVolume = opts.minVolumeUsd ?? 3_000_000;
  const now = Date.now();

  let rows: { name: string; ctx: HlCtx }[];
  try {
    rows = await markets();
  } catch {
    return [];
  }

  const out: Material[] = [];
  for (const { name, ctx: r } of rows) {
    const funding = Number(r.funding);
    const mark = Number(r.markPx);
    const prev = Number(r.prevDayPx);
    const vol = Number(r.dayNtlVlm);
    if (![funding, mark, prev, vol].every(Number.isFinite) || prev <= 0 || vol < minVolume) continue;

    const chg = ((mark - prev) / prev) * 100;
    const fundingPct = funding * 100;
    const notable = Math.abs(funding) >= threshold || Math.abs(chg) >= 8;
    if (!notable) continue;

    const fundingLed = Math.abs(funding) >= threshold;
    out.push(
      makeMaterial({
        category: 'onchain',
        subType: fundingLed ? 'hl_funding' : 'hl_move',
        title: fundingLed
          ? `${name} 在 Hyperliquid 费率 ${fundingPct.toFixed(3)}%`
          : `${name} 在 Hyperliquid 24 小时${chg >= 0 ? '涨' : '跌'} ${Math.abs(chg).toFixed(2)}%`,
        symbol: name,
        source: 'Hyperliquid',
        at: now,
        sentiment: funding > 0 ? 'bull' : funding < 0 ? 'bear' : chg >= 0 ? 'bull' : 'bear',
        score: score(fundingPct, chg, vol),
        facts: {
          venue: 'Hyperliquid',
          funding,
          fundingPct: Number(fundingPct.toFixed(3)),
          price: mark,
          chg24h: Number(chg.toFixed(2)),
          volume24h: vol,
          openInterest: Number(r.openInterest),
          // HL reports open interest in *coins*, which no reader can parse — 551,919,293
          // of $W is nine million dollars. Cross-checked against Binance's own
          // sumOpenInterestValue for the same coins, so mark × size is the right USD figure.
          oiUsd: Math.round(Number(r.openInterest) * mark),
          // Annualised at the hourly settlement cadence Hyperliquid actually uses.
          annualized: Number((funding * 24 * 365 * 100).toFixed(1)),
          payer: funding > 0 ? '多头' : funding < 0 ? '空头' : '',
        },
      }),
    );
  }
  return out.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 8);
}
