import { Store } from '../db/index.ts';
import { sampleSignals, type SymbolSignal } from './signals.ts';
import { readSquare, type SquareSnapshot } from './square.ts';
import type { Settings } from '../config.ts';
import type { Context } from '../engine/types.ts';
import { annualizedFunding } from '../material/derive.ts';

/**
 * The attention pool.
 *
 * Square decides *who* is worth writing about; the market feeds decide *what* is
 * actually true about them. A coin must hold that position for a while before we
 * post — the point is the considered follow-up, not the first reflex.
 */

export interface PoolEntry {
  symbol: string;
  rank: number;
  score: number;
  squareRank: number;
  squareViews: number;
  squarePosts: number;
  squareDiscuss: number;
  tag: string | null;
  market: SymbolSignal | null;
  /** Number of samples seen inside the lookback window. */
  samples: number;
  /** How long it has continuously been above the threshold. */
  sustainedMinutes: number;
  firstSeenAt: number;
  scoreStart: number;
  scorePeak: number;
  agreeing: number;
  mature: boolean;
  blocked: string | null;
}

export interface RefreshReport {
  sampled: number;
  squareCoins: number;
  squareTopics: number;
  errors: string[];
}

const LOOKBACK_MS = 6 * 3600_000;

/**
 * Is there anything concrete to report? Being talked about is the reason to look;
 * a number worth putting in the post is what makes it worth posting.
 */
function hasSubstance(m: SymbolSignal, agreeing: number): boolean {
  return (
    agreeing >= 2 ||
    m.volMultiple >= 1.5 ||
    Math.abs(m.chg24h) >= 5 ||
    Math.abs(m.chg1h) >= 2 ||
    Math.abs(m.oiChangePct ?? 0) >= 8 ||
    Math.abs(m.funding ?? 0) >= 0.0003
  );
}

function logScale(v: number, ceiling: number): number {
  if (v <= 0) return 0;
  return Math.min(1, Math.log10(v + 1) / Math.log10(ceiling + 1));
}

/** Pull both feeds and write one attention sample per candidate coin. */
export async function refreshPool(store: Store, settings: Settings): Promise<RefreshReport> {
  const report: RefreshReport = { sampled: 0, squareCoins: 0, squareTopics: 0, errors: [] };
  const ts = Math.floor(Date.now() / 60_000) * 60_000; // bucket to the minute so repeats collapse

  // Square chooses the candidates; the market layer is then asked about exactly those.
  const square = await readSquare({});
  report.errors.push(...square.errors);

  const signals = await sampleSignals({
    forceSymbols: square.coins.slice(0, 25).map(c => c.symbol),
    depth: 25,
  }).catch(err => {
    report.errors.push(`signals: ${String(err).slice(0, 120)}`);
    return [] as SymbolSignal[];
  });

  report.squareCoins = square.coins.length;
  report.squareTopics = square.topics.length;

  const bySymbol = new Map(signals.map(s => [s.symbol.toUpperCase(), s]));
  const candidates = square.coins.slice(0, 25);

  for (const [i, c] of candidates.entries()) {
    const market = bySymbol.get(c.symbol) ?? null;
    // Square discussion volume is the reason to write; the market feed is the
    // material. Weighting it that way keeps a quiet-but-everyone-is-talking coin
    // like BTC eligible instead of burying it under a mover ranking.
    const squareScore = 100 * Math.max(
      logScale(c.views, 2_000_000) * 0.7,
      logScale(c.discuss, 2000) * 0.3,
    );
    const marketScore = market?.rawScore ?? 0;
    const combined = squareScore * 0.75 + marketScore * 0.25;

    store.recordSample({
      symbol: c.symbol,
      ts,
      score: Math.round(combined * 10) / 10,
      price: market?.price ?? null,
      parts: {
        squareViews: c.views,
        squarePosts: c.posts,
        squareDiscuss: c.discuss,
        squareRank: i + 1,
        tag: c.bestTag,
        marketScore,
        agreeing: market?.agreeing ?? 0,
        chg24h: market?.chg24h ?? null,
        chg1h: market?.chg1h ?? null,
        volMultiple: market?.volMultiple ?? null,
        funding: market?.funding ?? null,
        oiChangePct: market?.oiChangePct ?? null,
        longRatio: market?.longRatio ?? null,
      },
    });
    report.sampled++;
  }

  store.pruneSamples(Date.now() - settings.sampleRetentionHours * 3600_000);
  store.log('attention', report);
  return report;
}

function build(store: Store, settings: Settings, square: SquareSnapshot): PoolEntry[] {
  const now = Date.now();
  const entries: PoolEntry[] = [];

  for (const c of square.coins.slice(0, 25)) {
    const samples = store.samplesFor(c.symbol, now - LOOKBACK_MS);
    if (!samples.length) continue;
    const latest = samples[samples.length - 1]!;
    if (now - latest.ts > 25 * 60_000) continue; // stale — we stopped seeing it

    // Count the unbroken tail of samples that stayed over the threshold.
    let sustainedFrom = latest.ts;
    for (let i = samples.length - 1; i >= 0; i--) {
      if ((samples[i] as { score: number }).score >= settings.attentionThreshold) sustainedFrom = (samples[i] as { ts: number }).ts;
      else break;
    }
    const parts = (latest.parts ?? {}) as Record<string, number | string | null>;

    const entry: PoolEntry = {
      symbol: c.symbol,
      rank: 0,
      score: latest.score,
      squareRank: Number(parts.squareRank ?? 0),
      squareViews: Number(parts.squareViews ?? c.views),
      squarePosts: Number(parts.squarePosts ?? c.posts),
      squareDiscuss: Number(parts.squareDiscuss ?? c.discuss),
      tag: typeof parts.tag === 'string' ? parts.tag : c.bestTag,
      market: null,
      samples: samples.filter(s => s.score >= settings.attentionThreshold).length,
      sustainedMinutes: Math.round((latest.ts - sustainedFrom) / 60_000),
      firstSeenAt: sustainedFrom,
      scoreStart: (samples.find(s => s.ts >= sustainedFrom) ?? latest).score,
      scorePeak: Math.max(...samples.map(s => s.score)),
      agreeing: Number(parts.agreeing ?? 0),
      mature: false,
      blocked: null,
    };
    entries.push(entry);
  }

  return entries
    .sort((a, b) => b.score - a.score)
    .slice(0, settings.poolTopN)
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

/** Current pool with maturity verdicts. Market detail is attached so callers need not refetch. */
export async function pool(store: Store, settings: Settings, square?: SquareSnapshot): Promise<{ entries: PoolEntry[]; square: SquareSnapshot; errors: string[] }> {
  const snap = square ?? (await readSquare({}));
  const signals = await sampleSignals({
    forceSymbols: snap.coins.slice(0, 25).map(c => c.symbol),
    depth: 25,
  }).catch(() => [] as SymbolSignal[]);
  const bySymbol = new Map(signals.map(s => [s.symbol.toUpperCase(), s]));

  const entries = build(store, settings, snap).map(e => {
    const market = bySymbol.get(e.symbol) ?? null;
    const withMarket = { ...e, market };
    if (e.score < settings.attentionThreshold) withMarket.blocked = `分数 ${e.score} 未达门槛 ${settings.attentionThreshold}`;
    else if (e.samples < settings.matureSamples) withMarket.blocked = `只采样到 ${e.samples} 次，需要 ${settings.matureSamples} 次`;
    else if (e.sustainedMinutes < settings.matureMinutes) withMarket.blocked = `持续 ${e.sustainedMinutes} 分，未达 ${settings.matureMinutes} 分`;
    else if (!market) withMarket.blocked = '没有币安行情数据，无法写出可核对的数字';
    // Substance gate: we need at least one concrete thing to report, not just hype.
    else if (!hasSubstance(market, e.agreeing)) withMarket.blocked = '行情侧没有可写的实质变化（无量、无波动、无持仓变化）';
    else {
      const claim = store.getClaim(e.symbol);
      const cooldownMs = settings.claimCooldownMinutes * 60_000;
      if (claim && Date.now() - claim.claimed_at < cooldownMs) {
        const left = Math.ceil((cooldownMs - (Date.now() - claim.claimed_at)) / 60_000);
        withMarket.blocked = `${Math.round(cooldownMs / 3600_000)} 小时内已经写过一次，还需 ${left} 分钟`;
      } else withMarket.mature = true;
    }
    return withMarket;
  });

  return { entries, square: snap, errors: snap.errors };
}

/**
 * Everything a template is allowed to know about one coin. Each field is either a
 * measured market number or an observed Square count — no speculation reaches the copy.
 */
export function dossier(e: PoolEntry): Context {
  const m = e.market;
  const funding = m?.funding ?? null;
  const intervalHours = 8;
  const annualized = annualizedFunding(funding, intervalHours);
  const hours = e.sustainedMinutes >= 60 ? Number((e.sustainedMinutes / 60).toFixed(1)) : null;

  return {
    cashtag: `$${e.symbol}`,
    symbol: e.symbol,
    price: m?.price ?? null,
    chg24h: m ? Number(m.chg24h.toFixed(2)) : null,
    chg1h: m ? Number(m.chg1h.toFixed(2)) : null,
    volMultiple: m ? Number(m.volMultiple.toFixed(1)) : null,
    funding,
    annualized,
    oiChangePct: m?.oiChangePct != null ? Number(m.oiChangePct.toFixed(1)) : null,
    longRatio: m?.longRatio != null ? Number(m.longRatio.toFixed(2)) : null,
    agreeing: e.agreeing,
    attentionScore: e.score,
    rank: e.rank,
    squareRank: e.squareRank,
    squareViews: e.squareViews,
    squarePosts: e.squarePosts,
    squareDiscuss: e.squareDiscuss,
    hashtag: e.tag ?? '',
    sustainedMinutes: e.sustainedMinutes,
    sustainedHours: hours,
    samples: e.samples,
    scoreStart: e.scoreStart,
    scorePeak: e.scorePeak,
    dir: (m?.chg24h ?? 0) >= 0 ? '涨' : '跌',
    quoteVolume24h: m?.quoteVolume24h ?? null,
  };
}
