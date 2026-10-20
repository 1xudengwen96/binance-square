import type { Context, FieldValue, TemplateDef } from '../engine/types.ts';
import type { Material } from '../material/types.ts';
import type { Store } from '../db/index.ts';
import { fundingIsBaseline } from '../material/derive.ts';
import { claimsPosition } from '../engine/preflight.ts';
import { readFunding, COLUMN_MIN_QUOTE_VOLUME, ANOMALY_HEADLINES, pickAt } from './column.ts';

/**
 * The account's three fixed shapes.
 *
 *   盘中一问   a number, then a question with two sides  — asks for a reply
 *   今日反常   two numbers that do not agree, then a reading — the one thing a machine that
 *              watches the whole market can say that a person scrolling cannot
 *   昨日对账   yesterday's reading, and whether it held — a record the reader can come back to
 *
 * The shapes are fixed; the wording is not. The posts used to open with the same 【栏目】 bracket
 * and the same figure dump every time, which read as a feed rather than a person. The shape now
 * lives in what the post *does*, and the phrasing rotates underneath it.
 *
 * What a variant is allowed to be: a short phrase with no digit, and first person only to describe
 * watching. A variant sits next to facts the ledger already holds, so it cannot add a number; and
 * it may say 「我更在意…」 but never claim a position the account does not have. `isSafeVariant` is
 * the single gate, used for the built-ins, for operator input, and in tests.
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

/** What may follow 「我」 in a variant: watching verbs only. */
const FIRST_PERSON_OK = /^(们|觉得|更在意|更关心|会先看|会先盯|会接着盯|会盯|在看|盯着|注意到|好奇|想知道|关心|习惯先看)/;

/** No digits, first person only for watching, no instruction to trade, one line, short enough to be a phrase. */
export function isSafeVariant(text: string): { ok: true } | { ok: false; why: string } {
  const t = text.trim();
  if (t.length < 4 || t.length > 40) return { ok: false, why: '变体应是 4–40 字的短语' };
  if (/\n/.test(t)) return { ok: false, why: '变体只能一行' };
  if (/[0-9０-９]/.test(t)) return { ok: false, why: '变体里不能有数字——数字只能来自事实台账' };
  if (/\$|#/.test(t)) return { ok: false, why: '变体里不能带币种或话题标签' };
  if (/本人|自己的?(仓|单)/.test(t)) return { ok: false, why: '变体里不能有第一人称持仓——账号不做真实交易' };
  for (let i = t.indexOf('我'); i !== -1; i = t.indexOf('我', i + 1)) {
    if (!FIRST_PERSON_OK.test(t.slice(i + 1))) {
      return { ok: false, why: '「我」只能用来说在看什么（我更在意/我会盯/我注意到），不能说做了什么——账号不做真实交易' };
    }
  }
  if (/建议|买入|卖出|做多|做空|加仓|抄底|上车|目标|必涨|必跌|稳赚/.test(t)) return { ok: false, why: '变体里不能出现买卖或收益字眼' };
  // The publish boundary refuses these anyway; refusing them here keeps them out of the pool.
  const position = claimsPosition(t);
  if (position) return { ok: false, why: `发布前会被拦：${position}` };
  return { ok: true };
}

/** The phrases the columns rotate through. All pass `isSafeVariant` (a test pins it). */
export const BUILTIN_VARIANTS: { kind: ColumnKind; slot: VariantSlot; text: string }[] = [
  { kind: 'question', slot: 'ask', text: '这个位置，你站哪一边？' },
  { kind: 'question', slot: 'ask', text: '你觉得这笔钱是谁在付？' },
  { kind: 'question', slot: 'ask', text: '这笔费率你觉得能撑多久？' },
  { kind: 'question', slot: 'ask', text: '换成你，会先看哪个数？' },
  { kind: 'question', slot: 'ask', text: '下一次结算前，哪一边先松？' },
  { kind: 'question', slot: 'ask', text: '这是拥挤还是共识？' },
  { kind: 'question', slot: 'ask', text: '我更在意费率，你呢？' },
  { kind: 'question', slot: 'ask', text: '这种盘面你一般怎么看？' },
  { kind: 'question', slot: 'ask', text: '我好奇大家怎么看这组数。' },
  { kind: 'question', slot: 'ask', text: '你觉得谁会先扛不住？' },
  { kind: 'question', slot: 'ask', text: '你更信价格，还是更信费率？' },
  { kind: 'question', slot: 'ask', text: '两边人数差不多，你觉得谁更急？' },
  { kind: 'question', slot: 'ask', text: '评论区聊聊，我在看大家怎么想。' },
  { kind: 'anomaly', slot: 'watch', text: '这两个数不该同时出现，往后看哪个先让步' },
  { kind: 'anomaly', slot: 'watch', text: '先看下一次结算，费率有没有收窄' },
  { kind: 'anomaly', slot: 'watch', text: '两个信号总有一个会先认错' },
  { kind: 'anomaly', slot: 'watch', text: '谁先让步，后面的走势就偏向谁' },
  { kind: 'anomaly', slot: 'watch', text: '盯住持仓量，它比价格诚实' },
  { kind: 'anomaly', slot: 'watch', text: '这种背离通常撑不过几次结算' },
  { kind: 'anomaly', slot: 'watch', text: '我会先盯下一次结算的费率' },
  { kind: 'anomaly', slot: 'watch', text: '这种局面一般不会拖太久' },
  { kind: 'anomaly', slot: 'watch', text: '要么价格先停，要么付费的一方先撤' },
  { kind: 'anomaly', slot: 'watch', text: '付钱的一方扛得越久，后面的动静越大' },
  { kind: 'anomaly', slot: 'watch', text: '我注意到这种搭配并不常见' },
  { kind: 'anomaly', slot: 'close', text: '明天同一时间再看一眼。' },
  { kind: 'anomaly', slot: 'close', text: '后面发生什么，这里照实记。' },
  { kind: 'anomaly', slot: 'close', text: '留言说说你的读法。' },
  { kind: 'anomaly', slot: 'close', text: '背离不等于反转，先记下来。' },
  { kind: 'anomaly', slot: 'close', text: '先记下，明天回来对一下。' },
  { kind: 'anomaly', slot: 'close', text: '我会接着盯，有变化再说。' },
  { kind: 'anomaly', slot: 'close', text: '你见过这种组合最后怎么走的吗？' },
  { kind: 'anomaly', slot: 'close', text: '有不同看法的，评论区聊。' },
  { kind: 'recap', slot: 'close', text: '对了错了都记着，过几天再回头看。' },
  { kind: 'recap', slot: 'close', text: '我更在意的是哪些费率还在撑着。' },
  { kind: 'recap', slot: 'close', text: '费率会变，记下来才知道变了多少。' },
  { kind: 'recap', slot: 'close', text: '你当时怎么看的？评论区对一下。' },
];

/**
 * Built-ins that read as a feed rather than a person — the bracket-and-tally era. Switched off on
 * seeding rather than deleted, so posts that used them keep a variant id that still resolves.
 */
export const RETIRED_BUILTIN_VARIANTS: string[] = [
  '多还是空，说说理由',
  '同意还是不同意？留言说说',
  '拥挤的一边是谁？评论区说说',
  '价格和费率，你更信哪一个？',
  '价格和费率在吵架，下一次结算见分晓',
  '拥挤的一边最怕的是没人接，接下来盯这一点',
  '你怎么读这组数？',
  '这是信号还是噪音？',
  '明天同一时间再看一眼',
  '后面发生什么，这里照实记',
  '留言说说你的读法',
  '背离不等于反转，先记下来',
  '成立几条、不成立几条，原样列出',
  '判断可以错，账不能改',
  '对了错了都记在这里',
  '下一次继续对账',
  // Collided with 「你见过这种组合…」 in the close slot — the same noun twice in one line.
  '我注意到这种组合并不常见',
];

/** Idempotent: inserts what is missing, never revives a variant the operator switched off. */
export function seedVariants(store: Store, now = Date.now()): number {
  const ins = store.db.prepare('INSERT OR IGNORE INTO column_variants (kind, slot, text, status, origin, created_at) VALUES (?,?,?,?,?,?)');
  let n = 0;
  for (const v of BUILTIN_VARIANTS) n += ins.run(v.kind, v.slot, v.text, 'active', 'builtin', now).changes;
  const off = store.db.prepare(
    "UPDATE column_variants SET status = 'off', off_reason = ?, off_at = ? WHERE origin = 'builtin' AND status = 'active' AND text = ?",
  );
  for (const t of RETIRED_BUILTIN_VARIANTS) off.run('读起来像机器播报，换成更口语的说法', now, t);
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

/**
 * Question and anomaly shapes. Recap is built from the call ledger and has its own template.
 *
 * Three layouts each, plus synonym pools inside them, so two posts in a row do not share a
 * skeleton. Figures are said the way a person says them — 「涨了 22%」, 「空头在付 0.35%」 — with
 * the sign carried by the words around the number instead of a +/− and a parenthesis.
 */
export const shapeTemplates: TemplateDef[] = [
  {
    id: 'column.question',
    name: '盘中一问·固定栏目',
    category: 'funding',
    subType: 'funding_extreme',
    angle: '栏目',
    style: 'emotion',
    requires: [{ path: 'cashtag' }, { path: 'funding' }, { path: 'longRatio' }, { path: 'chg24h' }, { path: 'variantAsk' }, { path: 'payer' }, { path: 'moveVerb' }],
    body: `{{#if layout == 1}}{盯了一下|翻了翻盘面|刚看了一眼} {{cashtag}}：一天{{moveVerb}}了 {{moveAbs|apct}}，多空比停在 {{longRatio|fixed:2}}，{{ratioRead}}。
{{payer}}在付费，每次结算 {{rateAbs|hrate}}。
{{variantAsk}}{{#elif layout == 2}}{{cashtag}} {这里有点意思|这个盘面有点拧巴|值得多看一眼}。
一天{{moveVerb}}了 {{moveAbs|apct}}，多空比 {{longRatio|fixed:2}}，{{ratioRead}}；付费的是{{payer}}，{{rateAbs|hrate}} 一次。
{{variantAsk}}{{#else}}{{cashtag}} 过去一天{{moveVerb}}了 {{moveAbs|apct}}，账户多空比 {{longRatio|fixed:2}}，{{ratioRead}}。
费率是{{rateSign}}的，{{payer}}每次结算要付 {{rateAbs|hrate}}。
{{variantAsk}}{{/if}}`,
  },
  {
    id: 'column.anomaly',
    name: '今日反常·固定栏目',
    category: 'funding',
    subType: 'funding_extreme',
    angle: '栏目',
    style: 'capital',
    requires: [{ path: 'cashtag' }, { path: 'chg24h' }, { path: 'anomalyHeadline' }, { path: 'variantWatch' }, { path: 'moveVerb' }],
    // layout 0: headline first; layout 1: figures first; layout 2: the find, then the figures.
    body: `{{#if layout == 1}}{{cashtag}} 一天{{moveVerb}}了 {{moveAbs|apct}}{{#if payer}}，{{payer}}在付 {{rateAbs|hrate}} 的费率{{/if}}{{#if oiChangePct}}，持仓{{oiVerb}} {{oiAbs|apct}}{{/if}}。
{别扭的地方在这|反常的地方在于|有意思的是}：{{anomalyHeadline}}。
{{#elif layout == 2}}{今天|刚才}{扫到|翻到}一个{别扭|反常|拧巴}的组合：{{cashtag}}。
{{anomalyHeadline}}——一天{{moveVerb}}了 {{moveAbs|apct}}{{#if payer}}，{{payer}}付 {{rateAbs|hrate}}{{/if}}{{#if oiChangePct}}，持仓{{oiVerb}} {{oiAbs|apct}}{{/if}}。
{{#else}}{{cashtag}} {{anomalyHeadline}}。
一天{{moveVerb}}了 {{moveAbs|apct}}{{#if payer}}，费率 {{rateAbs|hrate}} 由{{payer}}付{{/if}}{{#if oiChangePct}}，持仓{{oiVerb}} {{oiAbs|apct}}{{/if}}。
{{/if}}{{#if memoryLine}}{{memoryLine}}
{{/if}}{{variantWatch}}。{{#if variantClose}}{{variantClose}}{{/if}}`,
  },
  {
    id: 'column.recap',
    name: '昨日对账·固定栏目',
    category: 'funding',
    subType: 'funding_extreme',
    angle: '栏目',
    style: 'data',
    // The running tally used to open this post, and every post that quoted it advertised a hit
    // rate. The recap is about what happened to each coin; the tally stays on the panel.
    requires: [{ path: 'recapLine' }],
    body: `{回头看看前两天聊过的几个币：|之前提过的几个费率，今天回头对一下：|翻回前两天说过的几个币，看看后来怎么样：}
{{recapLine}}
{{variantClose}}`,
  },
];

/** End a closing phrase with punctuation, so the line never trails off into the hashtags. */
const endPunct = (s: string): string => (/[。？！?!…]$/.test(s.trim()) ? s.trim() : `${s.trim()}。`);

/** The words around the numbers: which way, who pays, how the crowd splits. */
function humanWords(f: Context): Context {
  const chg = num(f.chg24h);
  const oi = num(f.oiChangePct);
  const rate = num(f.funding);
  const ratio = num(f.longRatio);
  return {
    moveVerb: chg !== null && chg < 0 ? '跌' : '涨',
    moveAbs: chg === null ? null : Math.abs(chg),
    oiVerb: oi !== null && oi < 0 ? '少了' : '多了',
    oiAbs: oi === null ? null : Math.abs(oi),
    rateAbs: rate === null ? null : Math.abs(rate),
    rateSign: str(f.payer) === '空头' ? '负' : '正',
    ratioRead: ratio === null ? '' : ratio >= 1.15 ? '做多的账户略多' : ratio <= 0.87 ? '做空的账户略多' : '两边人数几乎五五开',
  };
}

export function shapeContext(kind: 'question' | 'anomaly', f: Context, picks: { ask?: string; watch?: string; close?: string }, seed = 0): Context | null {
  if (kind === 'question') {
    if (!questionFit(f) || !picks.ask) return null;
    return { ...f, ...humanWords(f), variantAsk: endPunct(picks.ask), layout: Math.abs(seed >>> 4) % 3 };
  }
  const a = anomalyReading(f, seed);
  if (!a || !picks.watch) return null;
  return {
    ...f, ...humanWords(f),
    anomalyHeadline: a.headline, anomalyBecause: a.because,
    variantWatch: picks.watch.trim().replace(/[。.！!]+$/, ''),
    variantClose: picks.close ? endPunct(picks.close) : '',
    layout: Math.abs(seed >>> 5) % 3,
  };
}

/**
 * What a post is *about*, a level below its shape. Two 今日反常 posts can be different stories
 * (the paying side is on the wrong side of the move / positions are leaving while price runs),
 * and the rotation is enforced on this, not on the heading.
 */
export type ColumnAngle = 'payer' | 'oi' | 'split' | 'recap';

export function angleOf(kind: ColumnKind, f: Context): ColumnAngle {
  if (kind === 'recap') return 'recap';
  if (kind === 'question') return 'split';
  return anomalyReading(f)?.because === 'oi' ? 'oi' : 'payer';
}

/**
 * Why a coin no longer suits a shape, as one sentence for the operator's log; null when it still
 * does. The pre-publish check drops a draft on this, so the reason has to say what changed, not
 * that a predicate returned false.
 */
export function shapeMisfit(kind: 'question' | 'anomaly', f: Context): string | null {
  if (kind === 'question' ? questionFit(f) : anomalyReading(f)) return null;
  const chg = num(f.chg24h);
  const payer = str(f.payer);
  const annualized = num(f.annualized);
  const move = (c: number): string => `${c > 0 ? '+' : ''}${c.toFixed(1)}%`;
  if (!payer || (annualized !== null && fundingIsBaseline(annualized))) return '费率回到了默认水平，没有哪一边在额外付费';
  if (chg === null) return '读不到 24h 涨跌';
  if (kind === 'question') {
    const ratio = num(f.longRatio);
    const quote = num(f.quoteVolume24h);
    if (quote !== null && quote < COLUMN_MIN_QUOTE_VOLUME) return '成交太薄，费率是薄盘口在说话';
    if (ratio !== null && (ratio < 0.7 || ratio > 1.45)) return `多空比 ${ratio.toFixed(2)} 已经一边倒，不再是两边僵持`;
    if (Math.abs(chg) < 2) return `24h 涨跌只剩 ${move(chg)}，盘面太平`;
    return '读数不全';
  }
  if (Math.abs(chg) < 2) return `24h 涨跌只剩 ${move(chg)}，走势太平，谈不上背离`;
  const up = chg > 0;
  if ((payer === '空头' && !up) || (payer === '多头' && up)) {
    return `现在是${payer}在付、价格也在往${up ? '上' : '下'}走，付费的一方和走势站到了同一边`;
  }
  return '费率太低，算不上谁在为走势付费';
}

/** Which of the two shapes this material suits. A funding material may suit neither. */
export function shapesFor(m: Pick<Material, 'category' | 'subType' | 'facts' | 'symbol'>): ('question' | 'anomaly')[] {
  if (m.category !== 'funding' || !m.symbol) return [];
  const out: ('question' | 'anomaly')[] = [];
  if (anomalyReading(m.facts)) out.push('anomaly');
  if (questionFit(m.facts)) out.push('question');
  return out;
}
