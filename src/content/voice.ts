import type { Context, FieldValue } from '../engine/types.ts';
import { wordBank } from './wordbank.ts';

/**
 * The two lines the platform says a post is missing.
 *
 * Binance Square's own creator guidance reduces to `方向 + 观点 + 晒单` for trade content and
 * `事件 + 配图 + 个人观点 + 真实晒单` for news, with a "three-second rule": if the opening does
 * not hold a reader, nothing after it matters. Measured against that, every post this system has
 * published is a data chip on the first line and no interpretation anywhere — `$STRK 费率 -1.2%，
 * 年化 -70%` is the whole post. The third ingredient, 晒单, is unavailable and deliberately not
 * faked: the account does not trade, and the same guidance lists mismatched positions and fake
 * screenshots among the things that quietly destroy account weight. So we take the parts we can
 * take honestly, and nothing beyond them.
 *
 * Two hard rules follow from that, and both are structural rather than requested:
 *
 * 1. **No new numbers.** A hook or a stance line must be a re-statement of a fact already in the
 *    ledger. Nothing here emits a digit, so `auditAgainstFacts` can never be the thing that
 *    catches it — the sentence is incapable of inventing.
 * 2. **No first-person position.** Every pool below is about the data, never about what the
 *    author holds or did. `preflight` also blocks position language on its own, because a
 *    fabricated "我建仓了" is a false trade claim and the platform treats it as one.
 *
 * When no fact supports a line, these return `null` and the post keeps its data-first opening.
 * A missing hook is a missed experiment arm, not a licence to write an unsupported sentence.
 */

const num = (v: FieldValue): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: FieldValue): string | null => (typeof v === 'string' && v.trim() ? v : null);

function pick(key: string, seed: string | number): string | null {
  const raw = wordBank[key];
  if (!raw) return null;
  const options = raw.match(/\{([^{}]*)\}/)?.[1];
  if (!options) return raw;
  const list = options.split('|');
  // Deterministic on the caller's seed so a reroll of the same post produces the same line, and
  // so the arm recorded before drafting is the arm the reader actually sees.
  let h = 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return list[h % list.length] ?? null;
}

/**
 * Whether the body already says the thing this hook would say.
 *
 * Without this, the tension arm is not "opens with a hook" — it is "says the same fact twice and
 * is 12 characters longer", and the comparison would end up measuring length, which the registry
 * already tests separately under `h_length_band`. A hook that repeats the body is worse than no
 * hook, so the line is suppressed rather than emitted anyway.
 */
function alreadySaid(text: string, kind: 'payer' | 'skew' | 'vol' | 'oi' | 'move'): boolean {
  switch (kind) {
    case 'payer': return /(付费|付钱|付的一方|在付)/.test(text);
    case 'skew': return /(多空比|多头明显|空头占优|一边倒|占优|多头很集中|空头很集中)/.test(text);
    case 'vol': return /(量能|放量|缩量)/.test(text);
    case 'oi': return /(持仓量|持仓和价格|OI)/.test(text);
    case 'move': return /(急涨|急跌|拉了|掉了|大幅)/.test(text);
  }
}

/** The strongest available direction signal, said plainly and briefly. */
export function tensionLine(f: Context, seed: string | number, body?: string): string | null {
  const funding = num(f.funding) ?? num(f.fundingPct);
  const payer = str(f.payer);
  const longRatio = num(f.longRatio);
  const chg24h = num(f.chg24h);
  const volMultiple = num(f.volMultiple);
  const oiChangePct = num(f.oiChangePct);
  const said = (kind: Parameters<typeof alreadySaid>[1]) => body !== undefined && alreadySaid(body, kind);

  // Order matters: this is the ranking of "which fact is worth leading with", so funding (which
  // has a paying side, and therefore a story) beats a bare price move.
  if (payer && funding != null && funding !== 0 && !said('payer')) {
    return pick(payer === '空头' ? 'hook.tension.payerShort' : 'hook.tension.payerLong', seed);
  }
  if (longRatio != null && (longRatio >= 0.7 || longRatio <= 0.3) && !said('skew')) {
    return pick(longRatio >= 0.5 ? 'hook.tension.skewLong' : 'hook.tension.skewShort', seed);
  }
  if (volMultiple != null && volMultiple >= 2 && chg24h != null && chg24h !== 0 && !said('vol')) {
    return pick(chg24h > 0 ? 'hook.tension.volUp' : 'hook.tension.volDown', seed);
  }
  if (oiChangePct != null && Math.abs(oiChangePct) >= 8 && chg24h != null && chg24h !== 0 && !said('oi')) {
    const sameDirection = Math.sign(oiChangePct) === Math.sign(chg24h);
    return pick(sameDirection ? 'hook.tension.oiWithPrice' : 'hook.tension.oiVsPrice', seed);
  }
  if (chg24h != null && Math.abs(chg24h) >= 8 && !said('move')) {
    return pick(chg24h > 0 ? 'hook.tension.upHard' : 'hook.tension.downHard', seed);
  }
  // Nothing left that the body has not already said. No hook is a lost sample; a paraphrase of
  // the second line is a worse post and a polluted comparison.
  return null;
}

/**
 * Interpretive language the templates already emit.
 *
 * A post gets at most one reading. `short.funding` and the Hyperliquid cells already carry their
 * own conclusions («并不是没量的空涨», «仓位在增加»), and two interpretations computed with
 * different thresholds can contradict each other in the same four lines — which is what #318
 * shipped: the template said volume was there, the stance line said it was not. Such a post is not
 * a weak sample, it is a broken one, because the arm no longer means "has a reading".
 */
const STANCE_MARKERS = /(不是没量|没量的空涨|空涨|量价配合|量能配合|缩量|放量杀跌|更难应对|踩踏|一边倒|反转|带不动大盘|看起来热闹|更敏感|推着走)/;

/**
 * A reading of the shape, not a recommendation.
 *
 * The line is derived from the same facts the body already cites, and each pool says something
 * that follows from that particular shape rather than a generic hedge. "这种极值一般撑不长" is a
 * claim about funding extremes as a pattern; it is falsifiable, it is not a directive, and it is
 * the kind of sentence the platform says makes a reader remember who wrote it.
 */
export function stanceLine(f: Context, seed: string | number, body?: string): string | null {
  // One voice per post: if the template already interpreted the data, the stance arm cannot add a
  // second opinion, or the two will eventually disagree.
  if (body !== undefined && STANCE_MARKERS.test(body)) return null;
  const funding = num(f.funding) ?? num(f.fundingPct);
  const annualized = num(f.annualized);
  const longRatio = num(f.longRatio);
  const chg24h = num(f.chg24h);
  const volMultiple = num(f.volMultiple);
  const oiChangePct = num(f.oiChangePct);

  if (annualized != null && Math.abs(annualized) >= 50) return pick('stance.fundingExtreme', seed);
  if (funding != null && Math.abs(funding) >= 0.0005 && str(f.payer)) return pick('stance.fundingExtreme', seed);
  if (longRatio != null && (longRatio >= 0.75 || longRatio <= 0.25)) return pick('stance.skewExtreme', seed);
  if (volMultiple != null && chg24h != null && chg24h > 4) {
    return pick(volMultiple >= 2 ? 'stance.volConfirm' : 'stance.volGap', seed);
  }
  if (volMultiple != null && chg24h != null && chg24h < -4 && volMultiple >= 2) return pick('stance.sellPressure', seed);
  if (oiChangePct != null && Math.abs(oiChangePct) >= 12) return pick('stance.oiBuild', seed);
  return null;
}

/** The platform-sanctioned follower ask. Requesting a follow is allowed; buying one is not. */
export function followCta(seed: string | number): string | null {
  return pick('cta.follow', seed);
}

/** What the writer was told to do, for the trace and the panel. */
export function voiceUsed(f: Context): { tension: string | null; stance: string | null } {
  return { tension: tensionLine(f, 'probe'), stance: stanceLine(f, 'probe') };
}
