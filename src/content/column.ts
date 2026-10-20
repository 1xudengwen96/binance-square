import type { Context, FieldValue } from '../engine/types.ts';
import type { TemplateDef } from '../engine/types.ts';
import type { Material } from '../material/types.ts';
import { fundingIsBaseline } from '../material/derive.ts';

/**
 * The account's recurring column.
 *
 * Measured on 2026-10-11: 36 published posts, median 108 views, nothing ever surfaced. Every one
 * opened on `$COIN` plus a number and closed on the same two disclaimer lines, so a reader who
 * saw three of them could not name what the account was *for*. The board's mid-tier posts are the
 * opposite shape: short, one claim, someone's name attached to a take.
 *
 * So the account does one thing. It looks for the coin where the cost of holding a side has
 * become the story — funding far from the exchange default, or open interest running ahead of
 * price — and says one falsifiable thing about it. «费率账» is the column; nothing else posts
 * from this lane.
 *
 * Why not freeform: the model would invent. The claim here is a *reading* of numbers already in
 * the ledger (who pays, whether the price agrees with that side), never a new number, never a
 * prediction. Each reading names the observation that would prove it wrong, which is what makes
 * it an opinion rather than a description.
 */

export const COLUMN_ID = 'ledger';
export const COLUMN_NAME = '费率账';

const num = (v: FieldValue): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: FieldValue): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Annualised funding below this is not a position, it is the exchange default plus noise. */
export const COLUMN_MIN_ANNUALIZED = 25;
/** Below this 24h turnover the rate is a thin book talking, not a crowd. */
export const COLUMN_MIN_QUOTE_VOLUME = 8_000_000;

export type Reading =
  | 'longs_paying_into_strength'
  | 'longs_paying_into_weakness'
  | 'shorts_paying_into_strength'
  | 'shorts_paying_into_weakness';

/**
 * Several ways to say each of the four readings. They are all the same claim; what varies is the
 * sentence, so three posts in a row stop opening on identical words. Index 0 is the original
 * wording. Digit-free on purpose: every number in a post must come from the fact ledger.
 * `watch` must read after «接下来看：» as well as standing alone.
 */
const VOICE: Record<Reading, { verdict: string[]; watch: string[] }> = {
  longs_paying_into_strength: {
    verdict: [
      '多头在为上涨付费，趋势是真的，但每一次结算都在加重追高的成本',
      '涨得很顺，可多头每隔几小时就要交一次过路费，越往上越贵',
      '价格站在多头这边，费率却在向多头收钱，赢的这一边也不便宜',
    ],
    watch: [
      '下一次费率还是正数，而价格已经不创新高，这笔账就开始变成负担',
      '价格停下来而费率不降，付费的一方撑不了太久',
      '结算前后，涨势能不能覆盖这笔持仓成本',
    ],
  },
  longs_paying_into_weakness: {
    verdict: [
      '价格在跌，多头却还在付费，持有的人在为一笔浮亏继续交钱',
      '跌着还在被收费：多头既亏价差，又付费率',
      '多头没走，费率就还在向他们收钱，这是还没出清的痕迹',
    ],
    watch: [
      '费率转负之前，这个仓位就还没真正出清',
      '费率什么时候回落，才说明多头真的撤了',
      '价格继续跌而费率不降，被动扛单的人会先撑不住',
    ],
  },
  shorts_paying_into_strength: {
    verdict: [
      '价格在涨，空头还在付费，这是被动扛着的仓位，不是主动加的',
      '涨势里空头一边亏价差一边付费率，账是两头算',
      '空头被行情推着走，每次结算还要再交一笔',
    ],
    watch: [
      '价格再往上走一段而费率不回正，空单的回补就会变成推力',
      '空头认输的时点，回补一旦集中，涨势会被放大',
      '费率一直为负而价格不回头，被动回补就离得不远',
    ],
  },
  shorts_paying_into_weakness: {
    verdict: [
      '价格在跌，空头仍在付费，说明做空的人多到愿意交钱维持',
      '价格在跌，站空头这一边的人却仍在付费率，这一边已经很挤',
      '跌势里空头占着价差的便宜，却还要继续交费率，说明这一边挤得很',
    ],
    watch: [
      '价格跌不动而费率仍然为负，空头的优势就在消耗',
      '一旦跌不动，拥挤的空头反而成了反弹的燃料',
      '下一次结算费率若收窄，说明空头在悄悄减',
    ],
  },
};

/** Headlines for 今日反常, kept apart from the 费率账 verdicts so one sentence never serves both. */
export const ANOMALY_HEADLINES: Record<'longs_paying_into_weakness' | 'shorts_paying_into_strength' | 'oi_up_price_down' | 'oi_down_price_up', string[]> = {
  longs_paying_into_weakness: [
    '价格在跌，多头却还在交钱',
    '跌了一天，掏钱的还是多头',
    '一边跌，一边是多头在付费',
    '走势往下，付费的却是多头',
  ],
  shorts_paying_into_strength: [
    '价格在涨，空头却还在交钱',
    '一边涨，一边是空头在付费',
    '涨势里掏钱的反而是空头',
    '涨着涨着，付费的还是空头',
  ],
  oi_up_price_down: [
    '价格在跌，持仓却在往上加',
    '价格往下走，新仓位却越堆越多',
    '跌着跌着，持仓反而多了',
  ],
  oi_down_price_up: [
    '价格在涨，持仓却在往外撤',
    '涨势还在，仓位先退了',
    '价格没停，持仓量倒是先收了',
  ],
};

export const pickAt = <T>(list: readonly T[], seed: number): T => list[Math.abs(Math.trunc(seed)) % list.length] as T;

/**
 * What the funding rate and the price are jointly saying.
 *
 * Four cells, because the interesting statement is the *disagreement* between who pays and which
 * way price went. Longs paying while price falls means holders are being charged to sit through a
 * loss; shorts paying while price rises is the squeeze setup. Both are checkable on the next
 * funding print, which `watch` names.
 */
export function readFunding(f: Context, seed = 0): { reading: Reading; payer: '多头' | '空头'; verdict: string; watch: string } | null {
  const payer = str(f.payer);
  const chg = num(f.chg24h);
  const annualized = num(f.annualized);
  if ((payer !== '多头' && payer !== '空头') || chg === null) return null;
  if (annualized !== null && fundingIsBaseline(annualized)) return null;
  if (annualized !== null && Math.abs(annualized) < COLUMN_MIN_ANNUALIZED) return null;
  // A flat tape tells us nothing about whether the paying side is right.
  if (Math.abs(chg) < 2) return null;

  const up = chg > 0;
  const reading: Reading =
    payer === '多头'
      ? up ? 'longs_paying_into_strength' : 'longs_paying_into_weakness'
      : up ? 'shorts_paying_into_strength' : 'shorts_paying_into_weakness';
  const v = VOICE[reading];
  // Verdict and watch are drawn with different strides so they do not move in lockstep.
  return { reading, payer, verdict: pickAt(v.verdict, seed), watch: pickAt(v.watch, Math.floor(seed / 7) + seed) };
}

/** Whether a funding material is a fit for the column at all. */
export function columnFit(m: Pick<Material, 'category' | 'subType' | 'facts' | 'symbol'>): { ok: true } | { ok: false; why: string } {
  if (m.category !== 'funding' || m.subType !== 'funding_extreme') return { ok: false, why: '不是资金费率素材' };
  if (!m.symbol) return { ok: false, why: '没有币种' };
  const f = m.facts;
  const quote = num(f.quoteVolume24h);
  if (quote === null || quote < COLUMN_MIN_QUOTE_VOLUME) return { ok: false, why: '24 小时成交太薄，费率是薄盘口在说话' };
  const rd = readFunding(f);
  if (!rd) return { ok: false, why: '费率和价格没有给出可读的组合（默认费率、走势太平或缺字段）' };
  return { ok: true };
}

/**
 * Pick the strongest column candidate. Ranked by annualised cost, not by the collector's score,
 * which blends in terms (volume, rank) that say nothing about whether the rate is the story.
 */
export function pickColumnMaterial(pool: readonly Material[]): Material | null {
  const fit = pool.filter(m => columnFit(m).ok);
  if (!fit.length) return null;
  const cost = (m: Material): number => Math.abs(num(m.facts.annualized) ?? (num(m.facts.funding) ?? 0) * 3 * 365 * 100);
  return [...fit].sort((a, b) => cost(b) - cost(a))[0] ?? null;
}

/**
 * The template. One verdict line carries the opinion; the body is only the evidence for it.
 * `verdict` and `watch` are computed above and handed in as context strings, so the template
 * itself never decides what is true — it only lays out what was already decided.
 */
export const columnTemplates: TemplateDef[] = [
  {
    id: 'column.ledger',
    name: '费率账·固定栏目',
    category: 'funding',
    subType: 'funding_extreme',
    angle: '栏目',
    style: 'capital',
    weight: 1,
    requires: [
      { path: 'cashtag' },
      { path: 'funding' },
      { path: 'payer' },
      { path: 'chg24h' },
      { path: 'columnVerdict' },
      { path: 'columnWatch' },
    ],
    // layout 0 leads with the reading, layout 1 with the figures; the facts and the claim are the same.
    body: `{{#if layout == 1}}【费率账】{{cashtag}} 费率 {{funding|rate}}{{#if annualized}}，年化约 {{annualized|abs|fixed:0}}%{{/if}}，{{payer}}付；24 小时 {{chg24h|spct}}。
{{columnVerdict}}。{{#else}}【费率账】{{cashtag}} {{columnVerdict}}。
费率 {{funding|rate}}{{#if annualized}}，年化约 {{annualized|abs|fixed:0}}%{{/if}}，{{payer}}付；24 小时 {{chg24h|spct}}。{{/if}}
{{#if streakPeriods >= 3}}已经连续 {{streakPeriods}} 次结算同向，{{payer}}累计付出 {{streakCostPct|fixed:2}}%。
{{/if}}{{#if memoryLine}}{{memoryLine}}
{{/if}}接下来看：{{columnWatch}}。`,
  },
];

/** Context the column template reads, derived once from the material's own facts. */
export function columnContext(f: Context, seed = 0): Context | null {
  const rd = readFunding(f, seed);
  if (!rd) return null;
  return { ...f, columnVerdict: rd.verdict, columnWatch: rd.watch, columnReading: rd.reading, layout: Math.abs(seed >>> 5) % 2 };
}
