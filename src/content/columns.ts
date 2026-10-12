import type { Context, FieldValue, TemplateDef } from '../engine/types.ts';
import type { Material } from '../material/types.ts';
import type { Store } from '../db/index.ts';
import { fundingIsBaseline } from '../material/derive.ts';
import { readFunding, COLUMN_MIN_QUOTE_VOLUME, ANOMALY_HEADLINES, pickAt } from './column.ts';

/**
 * The account's three fixed shapes.
 *
 *   盘中一问   a number, then a question with two sides  — asks for a reply
 *   今日反常   two numbers that do not agree, then a reading — the one thing a machine that
 *              watches the whole market can say that a person scrolling cannot
 *   昨日对账   yesterday's reading, and whether it held — a record the reader can come back to
 *
 * What a variant is allowed to be: a short phrase with no digit and no first person. That is a
 * structural limit, not a style note. A variant sits next to facts the ledger already holds, so it
 * cannot add a number; and with no «我», it cannot claim a position the account does not have.
 * `isSafeVariant` is the single gate, used for the built-ins, for operator input, and in tests.
 */

export type ColumnKind = 'question' | 'anomaly' | 'recap';
export type VariantSlot = 'ask' | 'watch' | 'close';

export const COLUMN_KINDS: Record<ColumnKind, { label: string; heading: string }> = {
  question: { label: '盘中一问', heading: '【盘中一问】' },
  anomaly: { label: '今日反常', heading: '【今日反常】' },
  recap: { label: '昨日对账', heading: '【昨日对账】' },
};

const num = (v: FieldValue): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: FieldValue): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** No digits, no first person, no instruction to trade, one line, short enough to be a phrase. */
export function isSafeVariant(text: string): { ok: true } | { ok: false; why: string } {
  const t = text.trim();
  if (t.length < 4 || t.length > 40) return { ok: false, why: '变体应是 4–40 字的短语' };
  if (/\n/.test(t)) return { ok: false, why: '变体只能一行' };
  if (/[0-9０-９]/.test(t)) return { ok: false, why: '变体里不能有数字——数字只能来自事实台账' };
  if (/\$|#/.test(t)) return { ok: false, why: '变体里不能带币种或话题标签' };
  if (/我(?!们)|本人|自己的?(仓|单)/.test(t)) return { ok: false, why: '变体里不能有第一人称——账号不做真实交易' };
  if (/建议|买入|卖出|做多|做空|加仓|抄底|上车|目标|必涨|必跌|稳赚/.test(t)) return { ok: false, why: '变体里不能出现买卖或收益字眼' };
  return { ok: true };
}

/** The phrases the columns start with. All pass `isSafeVariant` (a test pins it). */
export const BUILTIN_VARIANTS: { kind: ColumnKind; slot: VariantSlot; text: string }[] = [
  { kind: 'question', slot: 'ask', text: '这个位置，你站哪一边？' },
  { kind: 'question', slot: 'ask', text: '多还是空，说说理由' },
  { kind: 'question', slot: 'ask', text: '你觉得这笔钱是谁在付？' },
  { kind: 'question', slot: 'ask', text: '同意还是不同意？留言说说' },
  { kind: 'anomaly', slot: 'watch', text: '这两个数不该同时出现，往后看哪个先让步' },
  { kind: 'anomaly', slot: 'watch', text: '价格和费率在吵架，下一次结算见分晓' },
  { kind: 'anomaly', slot: 'watch', text: '拥挤的一边最怕的是没人接，接下来盯这一点' },
  { kind: 'anomaly', slot: 'close', text: '你怎么读这组数？' },
  { kind: 'anomaly', slot: 'close', text: '这是信号还是噪音？' },
  { kind: 'question', slot: 'ask', text: '这笔费率你觉得能撑多久？' },
  { kind: 'question', slot: 'ask', text: '拥挤的一边是谁？评论区说说' },
  { kind: 'question', slot: 'ask', text: '价格和费率，你更信哪一个？' },
  { kind: 'question', slot: 'ask', text: '换成你，会先看哪个数？' },
  { kind: 'question', slot: 'ask', text: '下一次结算前，哪一边先松？' },
  { kind: 'question', slot: 'ask', text: '这是拥挤还是共识？' },
  { kind: 'anomaly', slot: 'watch', text: '先看下一次结算，费率有没有收窄' },
  { kind: 'anomaly', slot: 'watch', text: '两个信号总有一个会先认错' },
  { kind: 'anomaly', slot: 'watch', text: '谁先让步，后面的走势就偏向谁' },
  { kind: 'anomaly', slot: 'watch', text: '盯住持仓量，它比价格诚实' },
  { kind: 'anomaly', slot: 'watch', text: '这种背离通常撑不过几次结算' },
  { kind: 'anomaly', slot: 'close', text: '明天同一时间再看一眼' },
  { kind: 'anomaly', slot: 'close', text: '后面发生什么，这里照实记' },
  { kind: 'anomaly', slot: 'close', text: '留言说说你的读法' },
  { kind: 'anomaly', slot: 'close', text: '背离不等于反转，先记下来' },
  { kind: 'recap', slot: 'close', text: '成立几条、不成立几条，原样列出' },
  { kind: 'recap', slot: 'close', text: '判断可以错，账不能改' },
  { kind: 'recap', slot: 'close', text: '对了错了都记在这里' },
  { kind: 'recap', slot: 'close', text: '下一次继续对账' },
];

/** Idempotent: inserts what is missing, never revives a variant the operator switched off. */
export function seedVariants(store: Store, now = Date.now()): number {
  const ins = store.db.prepare('INSERT OR IGNORE INTO column_variants (kind, slot, text, status, origin, created_at) VALUES (?,?,?,?,?,?)');
  let n = 0;
  for (const v of BUILTIN_VARIANTS) n += ins.run(v.kind, v.slot, v.text, 'active', 'builtin', now).changes;
  return n;
}

export function activeVariants(store: Store, kind: ColumnKind, slot: VariantSlot): { id: number; text: string }[] {
  return store.db
    .prepare("SELECT id, text FROM column_variants WHERE kind = ? AND slot = ? AND status = 'active' ORDER BY id")
    .all(kind, slot) as { id: number; text: string }[];
}

/** Deterministic on the seed, so the same post drafted twice picks the same phrase. */
export function pickVariant(list: { id: number; text: string }[], seed: number): { id: number; text: string } | null {
  if (!list.length) return null;
  return list[Math.abs(seed) % list.length] ?? null;
}

/* ---------------------------------------------------------------- fit --- */

/**
 * 盘中一问 needs a coin where the sides are genuinely split, so the question is a real one.
 * «Split» is measured, not assumed: an account long/short ratio near 1 with a rate that is not
 * the exchange default means both sides are there and one of them is paying.
 */
export function questionFit(f: Context): boolean {
  const ratio = num(f.longRatio);
  const payer = str(f.payer);
  const chg = num(f.chg24h);
  const quote = num(f.quoteVolume24h);
  if (ratio === null || chg === null || quote === null || quote < COLUMN_MIN_QUOTE_VOLUME) return false;
  if (!payer) return false;
  const annualized = num(f.annualized);
  if (annualized !== null && fundingIsBaseline(annualized)) return false;
  return ratio >= 0.7 && ratio <= 1.45 && Math.abs(chg) >= 2;
}

/**
 * 今日反常: two readings that point opposite ways.
 *   - the paying side is on the wrong side of the move (readFunding already encodes this), or
 *   - open interest moves hard against the price move, i.e. positions are being added while the
 *     price goes the other way.
 */
export function anomalyReading(f: Context, seed = 0): { headline: string; because: string } | null {
  const rd = readFunding(f);
  const oi = num(f.oiChangePct);
  const chg = num(f.chg24h);
  if (rd && (rd.reading === 'longs_paying_into_weakness' || rd.reading === 'shorts_paying_into_strength')) {
    return { headline: pickAt(ANOMALY_HEADLINES[rd.reading], seed), because: 'funding' };
  }
  if (oi !== null && chg !== null && Math.abs(oi) >= 8 && Math.abs(chg) >= 3 && Math.sign(oi) !== Math.sign(chg)) {
    return {
      headline: pickAt(ANOMALY_HEADLINES[oi > 0 ? 'oi_up_price_down' : 'oi_down_price_up'], seed),
      because: 'oi',
    };
  }
  return null;
}

/* ----------------------------------------------------------- templates --- */

/** Question and anomaly shapes. Recap is built from the call ledger and has its own template. */
export const shapeTemplates: TemplateDef[] = [
  {
    id: 'column.question',
    name: '盘中一问·固定栏目',
    category: 'funding',
    subType: 'funding_extreme',
    angle: '栏目',
    style: 'emotion',
    requires: [{ path: 'cashtag' }, { path: 'funding' }, { path: 'longRatio' }, { path: 'chg24h' }, { path: 'variantAsk' }, { path: 'payer' }],
    body: `【盘中一问】{{cashtag}} 24 小时 {{chg24h|spct}}，账户多空比 {{longRatio|fixed:2}}，费率 {{funding|rate}}，{{payer}}在付。
{{variantAsk}}`,
  },
  {
    id: 'column.anomaly',
    name: '今日反常·固定栏目',
    category: 'funding',
    subType: 'funding_extreme',
    angle: '栏目',
    style: 'capital',
    requires: [{ path: 'cashtag' }, { path: 'chg24h' }, { path: 'anomalyHeadline' }, { path: 'variantWatch' }],
    // layout 0: headline first; layout 1: figures first; layout 2: headline, then the coin.
    body: `{{#if layout == 1}}【今日反常】{{cashtag}} 24 小时 {{chg24h|spct}}{{#if funding}}，费率 {{funding|rate}}{{#if payer}}（{{payer}}付）{{/if}}{{/if}}{{#if oiChangePct}}，持仓量 {{oiChangePct|spct}}{{/if}}。
{{anomalyHeadline}}。{{#elif layout == 2}}【今日反常】{{anomalyHeadline}}：{{cashtag}}。
24 小时 {{chg24h|spct}}{{#if funding}}，费率 {{funding|rate}}{{#if payer}}（{{payer}}付）{{/if}}{{/if}}{{#if oiChangePct}}，持仓量 {{oiChangePct|spct}}{{/if}}。{{#else}}【今日反常】{{cashtag}} {{anomalyHeadline}}。
24 小时 {{chg24h|spct}}{{#if funding}}，费率 {{funding|rate}}{{#if payer}}（{{payer}}付）{{/if}}{{/if}}{{#if oiChangePct}}，持仓量 {{oiChangePct|spct}}{{/if}}。{{/if}}
{{#if memoryLine}}{{memoryLine}}
{{/if}}{{variantWatch}}。{{#if variantClose}}{{variantClose}}{{/if}}`,
  },
  {
    id: 'column.recap',
    name: '昨日对账·固定栏目',
    category: 'funding',
    subType: 'funding_extreme',
    angle: '栏目',
    style: 'data',
    requires: [{ path: 'recapHeld' }, { path: 'recapTotal' }, { path: 'recapLine' }],
    body: `【昨日对账】近期栏目里可以检验的判断，已经核对 {{recapTotal}} 条，成立 {{recapHeld}} 条。
{{recapLine}}
{{variantClose}}`,
  },
];

export function shapeContext(kind: 'question' | 'anomaly', f: Context, picks: { ask?: string; watch?: string; close?: string }, seed = 0): Context | null {
  if (kind === 'question') {
    if (!questionFit(f) || !picks.ask) return null;
    return { ...f, variantAsk: picks.ask };
  }
  const a = anomalyReading(f, seed);
  if (!a || !picks.watch) return null;
  return { ...f, anomalyHeadline: a.headline, anomalyBecause: a.because, variantWatch: picks.watch, variantClose: picks.close ?? '', layout: Math.abs(seed >>> 5) % 3 };
}

/** Which of the two shapes this material suits. A funding material may suit neither. */
export function shapesFor(m: Pick<Material, 'category' | 'subType' | 'facts' | 'symbol'>): ('question' | 'anomaly')[] {
  if (m.category !== 'funding' || !m.symbol) return [];
  const out: ('question' | 'anomaly')[] = [];
  if (anomalyReading(m.facts)) out.push('anomaly');
  if (questionFit(m.facts)) out.push('question');
  return out;
}
