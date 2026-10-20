import type { AccountRow, PostRow, Store } from './db/index.ts';
import type { Settings } from './config.ts';
import type { Context, Fact, FieldValue } from './engine/types.ts';
import type { Material } from './material/types.ts';
import type { ArmPlan } from './rank/experiments.ts';
import { toContext } from './material/types.ts';
import { annualizedFunding, fundingPayer } from './material/derive.ts';
import { binance, num as numStr } from './collectors/binance.ts';
import { renderTemplate } from './engine/render.ts';
import { auditAgainstFacts } from './engine/verify.ts';
import { formatPrice } from './engine/filters.ts';
import { hashString } from './engine/prng.ts';
import { wordBank } from './content/wordbank.ts';
import { templates as builtinTemplates } from './content/templates.ts';
import { COLUMN_KINDS, activeVariants, angleOf, pickVariant, shapeMisfit } from './content/columns.ts';
import { closeColumnText, renderShape } from './column.ts';
import { applyPolish, finishShort, tooThin } from './pipeline.ts';
import { playbook } from './rank/playbook.ts';
import { scoreAll } from './rank/score.ts';
import { personaSeed } from './matrix.ts';
import { settingsForAccount } from './schedule.ts';
import { CHECK_AFTER_MS } from './calls.ts';
import { buildChartFor, cardAnnotation } from './chart/forSymbol.ts';
import { CATEGORY_LABELS } from './stats/insight.ts';

/**
 * The pre-publish check: a draft's numbers, against the market at the minute it goes out.
 *
 * A draft is written for a slot, and the slot is often an hour or more away — measured on the
 * live queue, column posts went out up to 165 minutes after drafting and the other lanes up to
 * 240. A rate quoted that long ago is a rate the reader can see is no longer there, and that is
 * exactly what makes a feed look late. So at the minute of sending:
 *
 *   - the market fields the post printed are re-read from Binance and the post is re-rendered
 *     with them — same template, same seed, same phrases, so only the figures move;
 *   - a column post whose reading no longer holds (the paying side flipped, the split closed)
 *     is dropped rather than sent: «空头还在付费» is not a thing to say once longs are paying;
 *   - an event post whose moment has passed («近 1 小时放量») is dropped for the same reason.
 *
 * Dropping rejects the draft, which frees the day's quota and the slot, so the next tick writes
 * a fresh one. A failed quote never blocks a send: the draft goes out as written, as before.
 *
 * What it will not do is touch a number the collector measured at its own moment or on another
 * venue: a Hyperliquid rate is not replaced by a Binance one, and a one-hour volume burst is not
 * replaced by whatever the current hour looks like.
 */

export interface LiveQuote {
  price: number | null;
  chg24h: number | null;
  chg1h: number | null;
  volMultiple: number | null;
  funding: number | null;
  longRatio: number | null;
  oiChangePct: number | null;
  quoteVolume24h: number | null;
}

export type QuoteFn = (symbol: string) => Promise<LiveQuote | null>;

/**
 * One coin, measured the way the collectors measure it, so a refreshed figure means the same thing:
 * the 24h ticker and rate, the last closed hour against the six before it, open interest over six
 * hours, the global account ratio. All five requests go out at once — the board-wide sampler took
 * 40 seconds per coin through the proxy, most of it fetching coins nobody asked about.
 */
export const liveQuote: QuoteFn = async symbol => {
  const pair = `${symbol.toUpperCase()}USDT`;
  const [ticker, premium, candles, oi, ls] = await Promise.allSettled([
    binance.futuresTicker(pair),
    binance.premiumIndexFor(pair),
    binance.klines(pair, '1h', 9).catch(() => binance.futuresKlines(pair, '1h', 9)),
    binance.openInterestHist(pair, '1h', 6),
    binance.globalLongShort(pair, '1h', 1),
  ]);
  if (ticker.status !== 'fulfilled') return null;
  const chg24h = numStr(ticker.value.priceChangePercent);
  if (!Number.isFinite(chg24h)) return null;
  const q: LiveQuote = {
    price: finite(numStr(ticker.value.lastPrice)),
    chg24h,
    chg1h: null,
    volMultiple: null,
    funding: premium.status === 'fulfilled' ? finite(numStr(premium.value.lastFundingRate)) : null,
    longRatio: null,
    oiChangePct: null,
    quoteVolume24h: finite(numStr(ticker.value.quoteVolume)),
  };
  // A failed candle read leaves both hour figures unknown, never 0 and 1: a «近 1 小时没动»
  // printed from defaults would be a false claim.
  if (candles.status === 'fulfilled') {
    const closed = candles.value.slice(0, -1);
    if (closed.length >= 2) {
      const last = numStr(closed[closed.length - 1]?.[4]);
      const prev = numStr(closed[closed.length - 2]?.[4]);
      if (prev) q.chg1h = finite(((last - prev) / prev) * 100);
      const vols = closed.map(r => numStr(r[7])).filter(Number.isFinite);
      const prior = vols.slice(-7, -1);
      const mean = prior.length ? prior.reduce((s, v) => s + v, 0) / prior.length : 0;
      if (mean > 0) q.volMultiple = finite((vols[vols.length - 1] ?? 0) / mean);
    }
  }
  if (oi.status === 'fulfilled') {
    const first = numStr(oi.value[0]?.sumOpenInterestValue);
    const last = numStr(oi.value[oi.value.length - 1]?.sumOpenInterestValue);
    const pct = first > 0 ? ((last - first) / first) * 100 : NaN;
    if (Number.isFinite(pct) && Math.abs(pct) <= 100) q.oiChangePct = pct;
  }
  if (ls.status === 'fulfilled') q.longRatio = finite(numStr(ls.value[0]?.longShortRatio));
  return q;
};

const finite = (v: number): number | null => (Number.isFinite(v) ? v : null);

const LIVE_FIELDS = ['price', 'chg24h', 'chg1h', 'volMultiple', 'funding', 'longRatio', 'oiChangePct', 'quoteVolume24h'] as const;
type LiveField = (typeof LIVE_FIELDS)[number];

/**
 * Fields a collector measured at its own moment or on another venue. The quote does not replace
 * them: Hyperliquid's price and rate are not Binance's, a pool's 24h move is not the perp's, and
 * an event's own window (the hour of a volume burst, the span of an open-interest shift) is over.
 */
const NATIVE: Partial<Record<string, readonly LiveField[]>> = {
  onchain: ['price', 'chg24h', 'funding'],
  dex: ['chg24h'],
  open_interest: ['oiChangePct', 'price', 'chg24h'],
  leaderboard: ['chg24h'],
  market_move: ['chg1h', 'volMultiple'],
};

/**
 * Event posts that describe one recent window and stop being true when it closes. The figure is
 * the window the copy names: a market_move post says «1 小时», so after an hour it is history.
 */
const EVENT_FRESH_MINUTES: Partial<Record<string, number>> = {
  market_move: 60,
};

/** A draft this young was rendered against a quote that is still the market. */
export const FRESH_ENOUGH_MS = 10 * 60_000;

const r1 = (v: number): number => Number(v.toFixed(1));
const r2 = (v: number): number => Number(v.toFixed(2));
const ROUND: Record<LiveField, (v: number) => number> = {
  price: v => v, chg24h: r2, chg1h: r2, volMultiple: r2, funding: v => v, longRatio: r2, oiChangePct: r1, quoteVolume24h: Math.round,
};

export interface Drift {
  field: LiveField;
  from: number;
  to: number;
  /** Moved enough that a reader comparing the post with the screen would notice. */
  big: boolean;
}

function isBig(k: LiveField, from: number, to: number): boolean {
  switch (k) {
    case 'price': return from !== 0 && Math.abs(to - from) / Math.abs(from) >= 0.03;
    case 'funding': return Math.sign(to) !== Math.sign(from) || Math.abs(to) < Math.abs(from) * 0.5;
    case 'longRatio': return Math.abs(to - from) >= 0.15;
    case 'volMultiple': return from > 0 && Math.abs(to - from) / from >= 0.5;
    case 'quoteVolume24h': return false;
    default: return Math.abs(to - from) >= 3 || (Math.sign(to) !== Math.sign(from) && Math.abs(to) >= 0.5);
  }
}

/** The material's facts with the live market fields swapped in, and what moved. Pure. */
export function freshFacts(m: Pick<Material, 'category' | 'facts'>, q: LiveQuote): { facts: Context; drift: Drift[] } {
  const f: Record<string, FieldValue> = { ...(m.facts as Record<string, FieldValue>) };
  const native = new Set<LiveField>(NATIVE[m.category] ?? []);
  const drift: Drift[] = [];
  for (const k of LIVE_FIELDS) {
    if (native.has(k)) continue;
    const v = q[k];
    if (v === null || !Number.isFinite(v)) continue;
    const to = ROUND[k](v);
    const from = typeof f[k] === 'number' && Number.isFinite(f[k]) ? (f[k] as number) : null;
    f[k] = to;
    if (from !== null && from !== to) drift.push({ field: k, from, to, big: isBig(k, from, to) });
  }
  if (!native.has('funding') && typeof f.funding === 'number' && drift.some(d => d.field === 'funding')) {
    const hours = typeof f.intervalHours === 'number' ? f.intervalHours : 8;
    if ('annualized' in f) f.annualized = annualizedFunding(f.funding, hours);
    if ('payer' in f) {
      const before = f.payer;
      f.payer = fundingPayer(f.funding, typeof f.annualized === 'number' ? f.annualized : null);
      // A streak is a run of one side paying; once the other side pays, the run is over.
      if (before !== f.payer) {
        delete f.streakPeriods;
        delete f.streakCostPct;
      }
    }
  }
  if (typeof f.volume24h === 'number' && typeof f.quoteVolume24h === 'number' && f.quoteVolume24h > 0 && 'venueSharePct' in f) {
    f.venueSharePct = r1((f.volume24h / f.quoteVolume24h) * 100);
  }
  return { facts: f, drift };
}

const LABEL: Record<LiveField, string> = {
  price: '价格', chg24h: '24h 涨跌', chg1h: '1h 涨跌', volMultiple: '量能', funding: '费率',
  longRatio: '多空比', oiChangePct: '持仓变化', quoteVolume24h: '成交额',
};

function show(k: LiveField, v: number): string {
  if (k === 'funding') return `${(v * 100).toFixed(3)}%`;
  if (k === 'price') return formatPrice(v);
  if (k === 'longRatio') return v.toFixed(2);
  if (k === 'volMultiple') return `${v.toFixed(1)} 倍`;
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

/** Which way a post talks about its figures: the column says the size and puts the sign in words. */
const ALIAS: Record<string, LiveField> = { moveAbs: 'chg24h', rateAbs: 'funding', oiAbs: 'oiChangePct' };
const ORDER: LiveField[] = ['funding', 'chg24h', 'oiChangePct', 'longRatio', 'chg1h', 'volMultiple', 'price', 'quoteVolume24h'];

/** The live fields a rendered post actually printed, under their market names. */
export function printedFields(facts: Fact[]): Set<LiveField> {
  const out = new Set<LiveField>();
  for (const f of facts) {
    if (f.kind !== 'number') continue;
    const k = String(f.field).split('.').pop() ?? '';
    const live = ALIAS[k] ?? ((LIVE_FIELDS as readonly string[]).includes(k) ? (k as LiveField) : null);
    if (live) out.add(live);
  }
  return out;
}

/** The moves a reader would notice, biggest first, in one line for the log and the panel. */
export function describeDrift(drift: Drift[], printed?: Set<LiveField>): string {
  return drift
    .filter(d => d.field !== 'quoteVolume24h' && show(d.field, d.from) !== show(d.field, d.to) && (!printed || printed.has(d.field)))
    .sort((a, b) => Number(b.big) - Number(a.big) || ORDER.indexOf(a.field) - ORDER.indexOf(b.field))
    .slice(0, 3)
    .map(d => `${LABEL[d.field]} ${show(d.field, d.from)} → ${show(d.field, d.to)}`)
    .join('，');
}

export type FreshenResult =
  | { kind: 'keep'; why: string }
  | { kind: 'drop'; why: string }
  | {
      kind: 'update';
      text: string;
      facts: Fact[];
      drift: string;
      trace: Record<string, unknown>;
      /** A rebuilt chart, or null to keep the one the draft had. */
      images: string[] | null;
      /** The arm that actually ran, when a rewrite could not be repeated. */
      arm?: { experiment: string; arm: string };
      /** The column's checkable statement, restated against the figures that went out. */
      call?: { payer: '多头' | '空头'; rate: number; annualized: number | null; price: number | null; checkAt: number };
    };

export interface FreshenOptions {
  quote?: QuoteFn;
  now?: number;
  chart?: typeof buildChartFor;
}

const parseTrace = (raw: string | null): Record<string, unknown> => {
  try {
    return (JSON.parse(raw ?? 'null') as Record<string, unknown> | null) ?? {};
  } catch {
    return {};
  }
};

const LIVE_SET = new Set<string>([...LIVE_FIELDS, 'annualized']);

/** Whether the post printed any figure the quote can re-read. A news post usually did not. */
function printsLiveNumbers(post: PostRow): boolean {
  try {
    const facts = (JSON.parse(post.facts_json ?? '[]') as Fact[] | null) ?? [];
    return facts.some(f => f.kind === 'number' && LIVE_SET.has(String(f.field).split('.').pop() ?? ''));
  } catch {
    return false;
  }
}

function armsOf(store: Store, postId: number): ArmPlan {
  const rows = store.db.prepare('SELECT experiment, arm FROM post_arms WHERE post_id = ?').all(postId) as { experiment: string; arm: string }[];
  return Object.fromEntries(rows.map(r => [r.experiment, r.arm]));
}

const num = (v: FieldValue): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

type Rewritten = { text: string; facts: Fact[]; trace: Record<string, unknown>; arm?: { experiment: string; arm: string } } | { why: string };

async function refreshColumn(
  store: Store, eff: Settings, post: PostRow, m: Material, kind: 'question' | 'anomaly',
  trace: Record<string, unknown>, account: AccountRow | null, now: number,
): Promise<Rewritten> {
  const slotAt = post.scheduled_at ?? post.created_at;
  const seed = typeof trace.seed === 'number' && trace.seed ? trace.seed : hashString(personaSeed(m.id, post.account_id ?? 0, slotAt));
  // The same phrases the draft drew, by id: a switched-off variant still reads the same.
  const ids = Array.isArray(trace.variants) ? (trace.variants as unknown[]).filter((x): x is number => typeof x === 'number') : [];
  const textOf = (id: number | undefined): string | undefined =>
    id === undefined ? undefined : (store.db.prepare('SELECT text FROM column_variants WHERE id = ?').get(id) as { text: string } | undefined)?.text;
  const picks = kind === 'question'
    ? { ask: textOf(ids[0]) ?? pickVariant(activeVariants(store, 'question', 'ask'), seed)?.text }
    : {
        watch: textOf(ids[0]) ?? pickVariant(activeVariants(store, 'anomaly', 'watch'), seed)?.text,
        close: ids.length ? textOf(ids[1]) : pickVariant(activeVariants(store, 'anomaly', 'close'), seed >>> 3)?.text,
      };
  const r = renderShape(store, kind, m, seed, picks, now);
  if (!r.ok) return { why: r.why };
  if (!auditAgainstFacts(r.text, r.facts).ok) return { why: '重写后出现台账外的数字' };

  let text = r.text;
  let arm: { experiment: string; arm: string } | undefined;
  let polishNote: string | undefined;
  // A post drawn into the rewrite arm is rewritten again; if the rewrite cannot be repeated, it
  // goes out as the template and is recorded under the arm it actually ran.
  if (armsOf(store, post.id).h_column_polish === 'polished') {
    const p = await applyPolish(store, eff, text, r.facts, account?.persona_note ?? '', {
      category: m.category, subType: m.subType, symbol: m.symbol, voice: true,
    });
    if (p.text !== text) text = p.text;
    else arm = { experiment: 'h_column_polish', arm: 'raw' };
    polishNote = p.note ?? 'ai_unavailable';
  }
  text = closeColumnText(eff, text, { material: m, accountId: post.account_id ?? 0, slotAt });
  return { text, facts: r.facts, trace: { ...r.trace, angle: angleOf(kind, m.facts), ...(polishNote ? { polish: polishNote } : {}) }, arm };
}

async function refreshShort(
  store: Store, eff: Settings, post: PostRow, m: Material, trace: Record<string, unknown>, account: AccountRow | null,
): Promise<Rewritten> {
  const def = store.allTemplates().find(t => t.id === post.template_id) ?? builtinTemplates.find(t => t.id === post.template_id);
  if (!def) return { why: '原模板已不在库里' };
  if (typeof trace.seed !== 'number') return { why: '原稿没有记录渲染种子' };
  const res = renderTemplate(def, toContext(m), { seed: trace.seed, bank: wordBank });
  if (!res.ok) return { why: res.reason ?? '模板渲染被拒' };
  if (!auditAgainstFacts(res.text, res.facts).ok) return { why: '重写后出现台账外的数字' };
  const verdicts = scoreAll(store, { writeMemory: false });
  const pb = playbook(store, { verdicts, arms: armsOf(store, post.id) });
  const voiceSeed = typeof trace.voiceSeed === 'string' || typeof trace.voiceSeed === 'number'
    ? trace.voiceSeed
    : m.category === 'attention' ? m.id : personaSeed(m.id, post.account_id ?? 0, post.scheduled_at ?? post.created_at);
  // The rewrite pass runs again only on a post that had one, so the refreshed copy keeps its kind.
  const fin = await finishShort(store, eff, res, m, pb, voiceSeed, {
    persona: account?.persona_note ?? '', verdicts, polish: trace.polish === 'ai_polished',
  });
  const thin = tooThin(res.facts, fin.text);
  if (thin) return { why: thin };
  return { text: fin.text, facts: res.facts, trace: { ...res.trace, ...(fin.polishNote ? { polish: fin.polishNote } : {}) } };
}

const COLUMN_SHAPES: Record<string, 'question' | 'anomaly'> = { 'column.question': 'question', 'column.anomaly': 'anomaly' };

export async function freshenForPublish(
  store: Store,
  settings: Settings,
  post: PostRow,
  account: AccountRow | null,
  opts: FreshenOptions = {},
): Promise<FreshenResult> {
  const now = opts.now ?? Date.now();
  if (now - post.created_at < FRESH_ENOUGH_MS) return { kind: 'keep', why: '草稿刚写好，数字还是新的' };
  if (!post.material_id) return { kind: 'keep', why: '没有关联素材' };
  const m = store.materialById(post.material_id);
  if (!m?.symbol) return { kind: 'keep', why: '素材不针对单一币种' };

  const kind = COLUMN_SHAPES[post.template_id ?? ''] ?? null;
  if (!kind) {
    const limit = EVENT_FRESH_MINUTES[m.category];
    const age = Math.round((now - m.at) / 60_000);
    if (limit && age > limit) return { kind: 'drop', why: `这条异动发生在 ${age} 分钟前，帖子里「近 1 小时」的说法已经过时` };
    if (!printsLiveNumbers(post)) return { kind: 'keep', why: '帖子没有引用实时行情数字' };
  }

  const q = await (opts.quote ?? liveQuote)(m.symbol).catch(() => null);
  if (!q) return { kind: 'keep', why: '实时行情读取失败，按原稿发出' };
  const { facts, drift } = freshFacts(m, q);
  const fresh: Material = { ...m, facts };
  const eff = account ? settingsForAccount(settings, account) : settings;
  const trace = parseTrace(post.trace_json);

  const out = kind
    ? await refreshColumn(store, eff, post, fresh, kind, trace, account, now)
    : await refreshShort(store, eff, post, fresh, trace, account);
  if ('why' in out) {
    const driftText = describeDrift(drift);
    if (kind) {
      const misfit = shapeMisfit(kind, toContext(fresh));
      return { kind: 'drop', why: `${COLUMN_KINDS[kind].label}的前提已经不成立：${misfit ?? out.why}${driftText ? `（${driftText}）` : ''}` };
    }
    return drift.some(d => d.big)
      ? { kind: 'drop', why: `行情已经变了（${driftText}），按最新数字也写不出这一条` }
      : { kind: 'keep', why: `按最新数字重写不出来（${out.why}），但数字变化不大，按原稿发出` };
  }
  if (out.text === post.text) return { kind: 'keep', why: '数字没有变化' };
  const driftText = describeDrift(drift, printedFields(out.facts));

  // A chart drawn when the draft was written stops at that hour. Redraw it; if that fails, the
  // old one still goes out rather than none.
  let images: string[] | null = null;
  let hadChart = false;
  try {
    hadChart = ((JSON.parse(post.images_json ?? '[]') as string[] | null) ?? []).length > 0;
  } catch {
    hadChart = false;
  }
  if (hadChart) {
    const built = await (opts.chart ?? buildChartFor)({
      symbol: m.symbol, chg24h: num(facts.chg24h), volMultiple: num(facts.volMultiple),
      funding: num(facts.funding), oiChangePct: num(facts.oiChangePct), longRatio: num(facts.longRatio),
    }, undefined, undefined, {
      column: kind ? COLUMN_KINDS[kind].label : (CATEGORY_LABELS[m.category] ?? m.category),
      // The rewritten copy is what goes out, so the cover quotes the rewritten first line.
      annotation: cardAnnotation(out.text),
      watermark: account ? `@ ${account.label}` : undefined,
    }).catch(() => null);
    if (built) images = built.card ? [built.card, built.path] : [built.path];
  }

  const payer = facts.payer === '多头' || facts.payer === '空头' ? facts.payer : null;
  const rate = num(facts.funding);
  return {
    kind: 'update',
    text: out.text,
    facts: out.facts,
    drift: driftText,
    trace: out.trace,
    images,
    arm: out.arm,
    call: kind && payer && rate !== null
      ? { payer, rate, annualized: num(facts.annualized), price: num(facts.price), checkAt: now + CHECK_AFTER_MS }
      : undefined,
  };
}

/** Write a refreshed draft back, with a note of what moved, before the send gates read it. */
export function applyFreshen(store: Store, post: PostRow, fr: Extract<FreshenResult, { kind: 'update' }>, now = Date.now()): void {
  const trace = { ...parseTrace(post.trace_json), ...fr.trace, refreshed: { at: now, drift: fr.drift } };
  store.db
    .prepare('UPDATE posts SET text = ?, facts_json = ?, trace_json = ?, images_json = COALESCE(?, images_json) WHERE id = ?')
    .run(fr.text, JSON.stringify(fr.facts), JSON.stringify(trace), fr.images ? JSON.stringify(fr.images) : null, post.id);
  if (fr.arm) {
    store.db.prepare('UPDATE post_arms SET arm = ? WHERE post_id = ? AND experiment = ?').run(fr.arm.arm, post.id, fr.arm.experiment);
  }
  if (fr.call) {
    // The recap judges what the post said a day after it said it, against the rate it quoted.
    store.db
      .prepare("UPDATE column_calls SET payer = ?, rate_at = ?, annualized_at = ?, price_at = ?, check_at = ? WHERE post_id = ? AND status = 'open'")
      .run(fr.call.payer, fr.call.rate, fr.call.annualized, fr.call.price, fr.call.checkAt, post.id);
  }
}
