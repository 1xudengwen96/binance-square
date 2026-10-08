import { binance, liquid, num, type SpotTicker24h } from './binance.ts';
import { makeMaterial, type Material } from '../material/types.ts';
import { annualizedFunding } from '../material/derive.ts';

/**
 * Detectors turn raw series into *events worth posting about*. Every number that
 * lands in a Material here is computed from an exchange response — nothing is invented
 * downstream.
 */

export interface DetectOptions {
  /** How many symbols to drill into for short-window moves. Each costs one klines call. */
  scanLimit?: number;
  /** Minimum 24h quote volume (USDT) for a symbol to be considered. */
  minQuoteVolume?: number;
  /** Percent move inside a short window that counts as an anomaly. */
  spikePct?: number;
  volumeSurgeMultiple?: number;
}

const DEFAULTS: Required<Omit<DetectOptions, 'scanLimit'>> = {
  minQuoteVolume: 20_000_000,
  spikePct: 3,
  volumeSurgeMultiple: 3,
};

function baseAsset(symbol: string): string {
  return symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
}

function scoreFor(pct: number, volMultiple: number): number {
  return Math.max(40, Math.min(92, Math.round(45 + Math.abs(pct) * 3 + Math.min(volMultiple, 8) * 2.5)));
}

/**
 * Short-window pumps and dumps, plus volume surges and 24h extremes.
 * RSI / MA breaks are computed locally because Binance exposes no such endpoint.
 */
export async function detectPriceMoves(opts: DetectOptions = {}): Promise<Material[]> {
  const o = { ...DEFAULTS, ...opts };
  const tickers = liquid(await binance.spotTickers(), o.minQuoteVolume);
  const byMove = [...tickers]
    .map(t => ({ t, chg: num(t.priceChangePercent) }))
    .filter(r => Number.isFinite(r.chg))
    .sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg))
    .slice(0, opts.scanLimit ?? 20);

  const out: Material[] = [];
  const now = Date.now();

  for (const { t } of byMove) {
    let k: Awaited<ReturnType<typeof binance.klines>>;
    try {
      k = await binance.klines(t.symbol, '1m', 61);
    } catch {
      continue; // one bad symbol must not lose the whole cycle
    }
    if (k.length < 12) continue;

    const last = k[k.length - 1]!;
    const price = num(last[4]);
    const chg24h = num(t.priceChangePercent);

    const windowPct = (minutes: number): number => {
      const idx = Math.max(0, k.length - 1 - minutes);
      const then = num(k[idx]![4]);
      return then === 0 ? 0 : ((price - then) / then) * 100;
    };

    // Volume surge: last full hour vs the mean of the six hours before it.
    const hourly = await hourlyVolumes(t.symbol);
    const volMultiple = hourly.multiple;

    const windows: { label: string; minutes: number; pct: number }[] = [
      { label: '5分钟', minutes: 5, pct: windowPct(5) },
      { label: '15分钟', minutes: 15, pct: windowPct(15) },
      { label: '1小时', minutes: 60, pct: windowPct(60) },
    ];
    const biggest = windows.reduce((a, b) => (Math.abs(b.pct) > Math.abs(a.pct) ? b : a));

    if (Math.abs(biggest.pct) >= o.spikePct) {
      const up = biggest.pct > 0;
      out.push(
        makeMaterial({
          category: 'market_move',
          subType: up ? 'spike' : 'dump',
          title: `${baseAsset(t.symbol)} ${biggest.label}${up ? '拉升' : '跳水'} ${Math.abs(biggest.pct).toFixed(2)}%`,
          symbol: baseAsset(t.symbol),
          source: '币安行情异动',
          at: now,
          sentiment: up ? 'bull' : 'bear',
          score: scoreFor(biggest.pct, volMultiple),
          facts: { tf: biggest.label, chg: Math.abs(biggest.pct), price, chg24h, volMultiple },
        }),
      );
    }

    if (volMultiple >= o.volumeSurgeMultiple) {
      out.push(
        makeMaterial({
          category: 'market_move',
          subType: 'volume_surge',
          title: `${baseAsset(t.symbol)} 1小时成交额放大 ${volMultiple.toFixed(1)} 倍`,
          symbol: baseAsset(t.symbol),
          source: '币安行情异动',
          at: now,
          sentiment: chg24h >= 0 ? 'bull' : 'bear',
          score: scoreFor(chg24h, volMultiple),
          facts: { volMultiple, price, chg24h, quoteVolumeHour: hourly.last },
        }),
      );
    }

    const high24 = num(t.highPrice);
    const low24 = num(t.lowPrice);
    if (high24 > 0 && price >= high24 * 0.998) {
      out.push(
        makeMaterial({
          category: 'market_move',
          subType: 'new_high',
          title: `${baseAsset(t.symbol)} 逼近 24 小时新高`,
          symbol: baseAsset(t.symbol),
          source: '币安行情异动',
          at: now,
          sentiment: 'bull',
          score: scoreFor(chg24h, 1),
          facts: { price, extreme: high24, chg24h },
        }),
      );
    } else if (low24 > 0 && price <= low24 * 1.002) {
      out.push(
        makeMaterial({
          category: 'market_move',
          subType: 'new_low',
          title: `${baseAsset(t.symbol)} 触及 24 小时新低`,
          symbol: baseAsset(t.symbol),
          source: '币安行情异动',
          at: now,
          sentiment: 'bear',
          score: scoreFor(chg24h, 1),
          facts: { price, extreme: low24, chg24h },
        }),
      );
    }
  }

  return out.sort((a, b) => b.score - a.score);
}

async function hourlyVolumes(symbol: string): Promise<{ multiple: number; last: number }> {
  try {
    const k = await binance.klines(symbol, '1h', 8);
    if (k.length < 3) return { multiple: 1, last: 0 };
    const closed = k.slice(0, -1); // drop the still-forming candle
    const last = num(closed[closed.length - 1]![7]);
    const prior = closed.slice(-7, -1).map(r => num(r[7])).filter(Number.isFinite);
    if (!prior.length) return { multiple: 1, last };
    const mean = prior.reduce((s, v) => s + v, 0) / prior.length;
    return { multiple: mean > 0 ? last / mean : 1, last };
  } catch {
    return { multiple: 1, last: 0 };
  }
}

/** Gainers and losers boards, built from futures 24h tickers. */
export async function detectLeaderboards(minQuoteVolume = 30_000_000): Promise<Material[]> {
  const rows = liquid(await binance.futuresTickers(), minQuoteVolume)
    .map(t => ({ symbol: baseAsset(t.symbol), chg: num(t.priceChangePercent) }))
    .filter(r => Number.isFinite(r.chg));

  const now = Date.now();
  const out: Material[] = [];
  const board = (list: typeof rows, subType: 'gainers' | 'losers') =>
    list.slice(0, 5).map((r, i) => ({ rank: i + 1, symbol: r.symbol, chg: Number(r.chg.toFixed(2)) }));

  const gainers = [...rows].sort((a, b) => b.chg - a.chg);
  const losers = [...rows].sort((a, b) => a.chg - b.chg);

  if (gainers[0] && gainers[0].chg > 5) {
    out.push(
      makeMaterial({
        category: 'leaderboard', subType: 'gainers',
        title: `24小时涨幅榜：${gainers[0].symbol} +${gainers[0].chg.toFixed(2)}% 领涨`,
        symbol: gainers[0].symbol, source: '币安行情异动', at: now, sentiment: 'bull', score: 68,
        facts: { scope: '24小时', board: board(gainers, 'gainers'), topChg: gainers[0].chg },
      }),
    );
  }
  if (losers[0] && losers[0].chg < -5) {
    out.push(
      makeMaterial({
        category: 'leaderboard', subType: 'losers',
        title: `24小时跌幅榜：${losers[0].symbol} ${losers[0].chg.toFixed(2)}% 领跌`,
        symbol: losers[0].symbol, source: '币安行情异动', at: now, sentiment: 'bear', score: 66,
        facts: { scope: '24小时', board: board(losers, 'losers'), topChg: losers[0].chg },
      }),
    );
  }
  return out;
}

/**
 * Funding rates far from zero are the most postable derivatives signal: they are
 * concrete, verifiable and change often enough to fill a schedule.
 */
export async function detectFundingExtremes(threshold = 0.0004, limit = 8): Promise<Material[]> {
  const rows = await binance.premiumIndex();
  const now = Date.now();
  const extreme = rows
    .filter(r => r.symbol.endsWith('USDT') && Number.isFinite(num(r.lastFundingRate)))
    .map(r => ({ ...r, rate: num(r.lastFundingRate) }))
    .filter(r => Math.abs(r.rate) >= threshold)
    .sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate))
    .slice(0, limit);

  const out: Material[] = [];
  for (const r of extreme) {
    // Funding interval differs per symbol (4h/8h), so read it from actual settlements.
    let intervalHours = 8;
    try {
      const hist = await binance.fundingHistory(r.symbol, 3);
      if (hist.length >= 2) {
        const gaps: number[] = [];
        for (let i = 1; i < hist.length; i++) gaps.push((hist[i]!.fundingTime - hist[i - 1]!.fundingTime) / 3_600_000);
        const avg = gaps.reduce((s, v) => s + v, 0) / gaps.length;
        if (avg > 0 && avg <= 24) intervalHours = Math.round(avg);
      }
    } catch {
      /* keep the 8h default */
    }
    out.push(
      makeMaterial({
        category: 'funding',
        subType: 'funding_extreme',
        title: `${baseAsset(r.symbol)} 资金费率 ${(r.rate * 100).toFixed(3)}%`,
        symbol: baseAsset(r.symbol),
        source: '币安资金费率',
        at: now,
        sentiment: r.rate > 0 ? 'bull' : 'bear',
        score: Math.max(50, Math.min(90, Math.round(50 + Math.abs(r.rate) * 100 * 40))),
        facts: {
          funding: r.rate,
          annualized: annualizedFunding(r.rate, intervalHours),
          payer: r.rate > 0 ? '多头' : '空头',
          intervalHours,
          price: num(r.markPrice),
        },
      }),
    );
  }
  return out;
}

export async function detectLongShortSkew(symbols: string[], period: '1h' | '4h' = '1h'): Promise<Material[]> {
  const now = Date.now();
  const out: Material[] = [];
  for (const asset of symbols.slice(0, 10)) {
    const symbol = `${asset}USDT`;
    try {
      const rows = await binance.globalLongShort(symbol, period, 2);
      const cur = rows[rows.length - 1];
      const prev = rows[0];
      if (!cur) continue;
      const ratio = num(cur.longShortRatio);
      if (!Number.isFinite(ratio) || ratio === 0) continue;
      // A ratio inside the ordinary band is not worth a post.
      if (ratio >= 0.85 && ratio <= 1.25) continue;
      const prevRatio = prev ? num(prev.longShortRatio) : ratio;
      out.push(
        makeMaterial({
          category: 'long_short',
          subType: 'account_ratio',
          title: `${asset} ${period === '1h' ? '1小时' : '4小时'}多空比 ${ratio.toFixed(2)}`,
          symbol: asset,
          source: '币安多空比',
          at: now,
          sentiment: ratio > 1 ? 'bull' : 'bear',
          score: Math.max(45, Math.min(80, Math.round(50 + Math.abs(ratio - 1) * 60))),
          facts: {
            scope: period === '1h' ? '1小时' : '4小时',
            ratio: Number(ratio.toFixed(2)),
            longPct: Number((num(cur.longAccount) * 100).toFixed(1)),
            shortPct: Number((num(cur.shortAccount) * 100).toFixed(1)),
            prevRatio: Number(prevRatio.toFixed(2)),
            ratioDiff: Number((ratio - prevRatio).toFixed(2)),
          },
        }),
      );
    } catch {
      continue;
    }
  }
  return out;
}

export type { SpotTicker24h };

/**
 * Open interest moving without the price dragging it, or moving ahead of it, is one of the
 * few remaining signals that distinguishes new positions from stop runs. Binance exposes
 * the series directly, so this is a real detector rather than an inference.
 *
 * The scan is deliberately wide: sorting by turnover and taking the top few names means
 * only the largest, calmest contracts are ever measured, which is why a tighter threshold
 * produced nothing at all. Measured over 40 names, 5% is roughly where the signal starts.
 */
export async function detectOpenInterestMoves(opts: {
  minQuoteVolume?: number;
  thresholdPct?: number;
  minOiUsd?: number;
  scanLimit?: number;
} = {}): Promise<Material[]> {
  const minVol = opts.minQuoteVolume ?? 40_000_000;
  const threshold = opts.thresholdPct ?? 5;
  const minOi = opts.minOiUsd ?? 10_000_000;
  const scan = liquid(await binance.futuresTickers().catch(() => []), minVol)
    .sort((a, b) => num(b.quoteVolume) - num(a.quoteVolume))
    .slice(0, opts.scanLimit ?? 40);

  const now = Date.now();
  const out: Material[] = [];
  for (const t of scan) {
    const hist = await binance.openInterestHist(t.symbol, '1h', 6).catch(() => null);
    if (!hist || hist.length < 3) continue;
    const first = num(hist[0]!.sumOpenInterestValue);
    const last = num(hist[hist.length - 1]!.sumOpenInterestValue);
    if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) continue;
    const pct = ((last - first) / first) * 100;
    if (Math.abs(pct) < threshold) continue;
    // A contract with 17M of open interest can print "+779%" off a near-zero base. The
    // arithmetic is real and the signal is not, and posting it reads like a broken tool.
    if (Math.abs(pct) > 100) continue;
    if (last < minOi) continue;

    const base = baseAsset(t.symbol);
    const chg24h = num(t.priceChangePercent);
    // OI up with price up is new longs; OI up with price down is new shorts. Saying which
    // is the whole point of the detector, so the pair is carried as one fact.
    const shape = pct > 0 ? (chg24h >= 0 ? '多头开仓' : '空头开仓') : chg24h >= 0 ? '空头回补' : '多头止损';
    out.push(
      makeMaterial({
        category: 'open_interest',
        subType: 'oi_shift',
        // Deliberately no percentage in the title: the fingerprint is built from it, so an
        // embedded number would reword itself every tick and the 12h cooldown would never
        // collapse the repeats — six near-identical materials per coin per tick. The live
        // figure stays in facts, which is where templates read it.
        title: `${base} 近 ${hist.length - 1} 小时持仓量${pct > 0 ? '增加' : '减少'}`,
        symbol: base,
        source: '币安持仓异动',
        at: now,
        sentiment: pct > 0 ? 'bull' : 'bear',
        score: Math.max(50, Math.min(90, Math.round(52 + Math.abs(pct) * 1.4))),
        facts: {
          window: `${hist.length - 1}小时`,
          oiChangePct: Number(pct.toFixed(1)),
          oiUsd: Math.round(last),
          price: Number(num(t.lastPrice).toFixed(4)),
          chg24h: Number(chg24h.toFixed(2)),
          dir: pct > 0 ? '增加' : '减少',
          shape,
          // The template compares the position change against the price change, and the
          // expression language has no arithmetic — so the ratio is measured here, where
          // both numbers are known, instead of being invented at render time.
          gapRatio: Number((Math.abs(pct) / Math.max(0.5, Math.abs(chg24h))).toFixed(2)),
        },
      }),
    );
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 6);
}

function sma(closes: number[], n: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i]!;
    if (i >= n) sum -= closes[i - n]!;
    out.push(i >= n - 1 ? sum / n : NaN);
  }
  return out;
}

/**
 * Crosses worth a post. The daily pair is the headline event but it is rare — measured over
 * the 40 most-traded contracts, 0 crossed the daily MA20/200 on the last closed bar while 2
 * crossed the 4h MA20/55. Both are checked: the daily one is what a reader screenshots, the
 * 4h one is what keeps the technical style fed.
 */
const MA_PAIRS = [
  { interval: '1d' as const, fast: 20, slow: 200, tf: '日线', score: 86 },
  { interval: '4h' as const, fast: 20, slow: 55, tf: '4 小时', score: 74 },
];

/**
 * Moving-average crosses, computed locally — Binance has no endpoint for them and the
 * technical-analysis style has nothing to say without them. Only a fresh cross on the last
 * closed bar counts; "price is above the MA" is a state, not an event, and would let one
 * coin occupy the queue for days.
 */
export async function detectMaCrosses(opts: { scanLimit?: number } = {}): Promise<Material[]> {
  const tickers = liquid(await binance.futuresTickers().catch(() => []), 60_000_000)
    .sort((a, b) => num(b.quoteVolume) - num(a.quoteVolume))
    .slice(0, opts.scanLimit ?? 40);

  const now = Date.now();
  const out: Material[] = [];
  for (const t of tickers) {
    for (const p of MA_PAIRS) {
      const need = p.fast + p.slow + 2;
      const k = await binance.futuresKlines(t.symbol, p.interval, need).catch(() => null);
      if (!k || k.length < need) continue;
      const closes = k.map(r => num(r[4])).filter(Number.isFinite);
      if (closes.length < need) continue;
      const fast = sma(closes, p.fast);
      const slow = sma(closes, p.slow);
      // The row Binance returns last is the bar still forming, whose close is a guess. A
      // cross that only exists there can be gone by the close, so the event is read one row
      // back and the live ticker price is reported separately.
      const i = closes.length - 2;
      if (!Number.isFinite(fast[i - 1]!) || !Number.isFinite(slow[i - 1]!)) continue;
      const up = fast[i]! > slow[i]!;
      if (up === (fast[i - 1]! > slow[i - 1]!)) continue;

      const base = baseAsset(t.symbol);
      const price = num(t.lastPrice);
      out.push(
        makeMaterial({
          category: 'market_move',
          subType: up ? 'ma_golden' : 'ma_death',
          // No changing number in the title: the fingerprint is built from it, and a wording
          // that shifts every tick turns one cross into a stack of materials.
          title: `${base} ${p.tf} MA${p.fast} ${up ? '上穿' : '下穿'} MA${p.slow}`,
          symbol: base,
          source: '币安均线突破',
          at: now,
          sentiment: up ? 'bull' : 'bear',
          score: p.score,
          facts: {
            tf: p.tf,
            price: Number(price.toFixed(4)),
            maFast: Number(fast[i]!.toFixed(4)),
            maSlow: Number(slow[i]!.toFixed(4)),
            fastLen: p.fast,
            slowLen: p.slow,
            // How far price sits from the faster line: the number a reader can act on.
            gapPct: Number((((price - fast[i]!) / fast[i]!) * 100).toFixed(2)),
            chg24h: Number(num(t.priceChangePercent).toFixed(2)),
            dir: up ? '上穿' : '下穿',
            cross: up ? '金叉' : '死叉',
          },
        }),
      );
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4);
}
