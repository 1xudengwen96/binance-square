import type { AccountRow, Store } from './db/index.ts';
import type { Settings } from './config.ts';
import { beijingDayStart } from './schedule.ts';
import type { Material } from './material/types.ts';
import type { Context, Fact, FieldValue } from './engine/types.ts';
import { columnContext, columnTemplates, pickColumnMaterial, COLUMN_NAME } from './content/column.ts';
import {
  activeVariants, pickVariant, seedVariants, shapeContext, shapeTemplates, shapesFor, type ColumnKind,
} from './content/columns.ts';
import { renderTemplate } from './engine/render.ts';
import { auditAgainstFacts } from './engine/verify.ts';
import { isDuplicate } from './engine/guard.ts';
import { hashString } from './engine/prng.ts';
import { wordBank } from './content/wordbank.ts';
import { expiresAt } from './lifecycle.ts';
import { nextSlotFor, settingsForAccount } from './schedule.ts';
import { personaSeed } from './matrix.ts';
import { applyPolish, carriesDisclaimer, withHashtags } from './pipeline.ts';
import { buildChartFor } from './chart/forSymbol.ts';
import { toContext } from './material/types.ts';
import { enrichWithMarketContext } from './material/enrich.ts';
import { scoreAll } from './rank/score.ts';
import { planArms, recordArms } from './rank/experiments.ts';
import { playbook } from './rank/playbook.ts';
import { markRecapped, memoryLineFor, recapLineFor, registerCall, tally, unrecapped } from './calls.ts';
import { currentTarget } from './rank/gates.ts';

/**
 * The column lane.
 *
 * The old lane asked «what is hot, say something about it» across fourteen categories and
 * twelve voices, which is how the account ended up with 36 posts and no identity. This lane has
 * four fixed shapes under four fixed headings and nothing else posts from it:
 *
 *   费率账   the cost of holding a side has become the story (the original column)
 *   盘中一问  a split market and a question with two sides
 *   今日反常  two readings that disagree
 *   昨日对账  whether yesterday's readings held, judged by code
 *
 * Which shape a post takes is drawn before the post exists and recorded as the `h_column` arm, so
 * «which shape do readers answer» is measured with the same machinery as everything else rather
 * than argued about. A shape is only drawn from those the material actually suits.
 *
 * What it will not do: write when nothing qualifies. A quiet market produces no post, and that is
 * the intended behaviour — three posts that each say something beat eight that say the same thing.
 * The daily number is a ceiling, not a target.
 */

export interface ColumnReport {
  created: { id: number; symbol: string; text: string; scheduledAt: number; kind?: string }[];
  skipped: string[];
}

/** The recap needs this many rulings before it is worth a post. */
const RECAP_MIN_CALLS = 2;

type Kind = ColumnKind | 'ledger';

export async function generateColumn(
  store: Store,
  settings: Settings,
  account: AccountRow,
  opts: { dryRun?: boolean; now?: number } = {},
): Promise<ColumnReport> {
  const report: ColumnReport = { created: [], skipped: [] };
  const now = opts.now ?? Date.now();
  const eff = settingsForAccount(settings, account);
  const perDay = Math.max(1, settings.columnPostsPerDay);
  seedVariants(store, now);

  // The ceiling is on posts that exist or are about to, not on what has already gone out: a draft
  // queued behind this tick is still a post the account will make today.
  const queued = store.columnPostsSince(account.id, now - 24 * 3600_000);
  if (!opts.dryRun && queued >= perDay) {
    report.skipped.push(`${COLUMN_NAME}：近 24 小时已有 ${queued} 条（上限 ${perDay}），不再生成`);
    return report;
  }

  // Funding rows are read on their own. Taking the top 200 of every category by score let 100+
  // onchain rows crowd the newest funding rows out, so the lane saw only stale ones.
  const pool = store.unusedByCategory('funding', now);
  // The 24h move is only added at collection time, and only for coins the sampler covered. A row
  // that lacks it cannot be read, so fill it in now for the few rows that would otherwise qualify.
  const missing = pool.filter(m => typeof m.facts.chg24h !== 'number' && m.symbol).slice(0, 15);
  if (missing.length) await enrichWithMarketContext(missing).catch(() => 0);
  const recentTexts = store.recentPostTexts(40, ['published', 'approved', 'uncertain', 'draft'], account.id);

  const claimedByOther = (symbol: string): boolean => {
    const claim = store.getClaim(symbol.toUpperCase());
    // Another account's coin stays theirs, same as the mixed lane.
    return Boolean(claim && claim.account_id !== null && claim.account_id !== account.id && now - claim.claimed_at < settings.crossAccountCoinExclusionMinutes * 60_000);
  };
  // Rolling window in which the column may not name the same coin twice; the param loop may move it.
  const coinCooldownMs = Math.max(1, settings.columnCoinCooldownHours) * 3600_000;
  const usable = pool.filter(m => m.symbol && !claimedByOther(m.symbol) && store.coinPostsSince(account.id, m.symbol, now - coinCooldownMs) === 0);

  // Candidate (material, kind) pairs. 费率账 keeps its original, stricter rule so it stays what it
  // was; the two new shapes ask different questions of the same row.
  const ledger = pickColumnMaterial(usable);
  const pairs: { material: Material; kind: Kind }[] = [];
  if (ledger) pairs.push({ material: ledger, kind: 'ledger' });
  for (const m of usable) for (const k of shapesFor(m)) pairs.push({ material: m, kind: k });

  // The recap is not about any coin: it exists when enough rulings have accumulated, and at most
  // once a day, and each ruling is recapped once.
  const owed = unrecapped(store, 3);
  const haveRecap = owed.length >= RECAP_MIN_CALLS && store.columnKindSince(account.id, 'column.recap', now - 20 * 3600_000) === 0;

  if (!pairs.length && !haveRecap) {
    report.skipped.push(`${COLUMN_NAME}：本轮没有够格的币（${pool.length} 条费率素材，${pool.length - usable.length} 条被占用或冷却）`);
    return report;
  }

  // Draw the shape before anything else, from the kinds that are actually available.
  const verdicts = scoreAll(store, { writeMemory: false, target: currentTarget(store, settings, now) });
  const available: string[] = [...new Set(pairs.map(p => p.kind))];
  if (haveRecap) available.push('recap');
  const arms = planArms({ seed: hashString(`${account.id}:${Math.floor(now / 3_600_000)}:col`), verdicts, only: settings.activeExperiments });
  const kind = pickAvailable(available, arms.h_column ?? null, hashString(`${now}:${account.id}`));

  const slot = nextSlotFor(store, settings, account, now, null, true);
  if (!slot.allowed) { report.skipped.push(slot.reason); return report; }
  if (!opts.dryRun && slot.reason.includes('已顺延')) {
    report.skipped.push('今天的发帖时段已排满，再写就只能排到明天');
    return report;
  }

  let material: Material | null = null;
  let text = '';
  let facts: Fact[] = [];
  let trace: Record<string, unknown> = {};
  let tplId = '';
  let usedCalls: number[] = [];
  let variantIds: number[] = [];

  if (kind === 'recap') {
    const lines = owed.map(recapLineFor).join('\n');
    const t = tally(store);
    const close = pickVariant(activeVariants(store, 'recap', 'close'), hashString(`${now}:recap`));
    const tpl = shapeTemplates.find(x => x.id === 'column.recap')!;
    const ctx: Context = { recapHeld: t.held, recapTotal: t.total, recapLine: lines, variantClose: close?.text ?? '' };
    const res = renderTemplate(tpl, ctx, { seed: hashString(`${account.id}:${now}:recap`), bank: wordBank });
    if (!res.ok) { report.skipped.push(`对账：${res.reason}`); return report; }
    text = res.text; facts = res.facts; trace = { ...res.trace }; tplId = tpl.id;
    usedCalls = owed.map(o => o.id);
    variantIds = close ? [close.id] : [];
  } else {
    const ofKind = pairs.filter(p => p.kind === kind);
    if (!ofKind.length) { report.skipped.push('本轮没有适合这个栏目的币'); return report; }
    // Within a shape, the strongest candidate: the original ranking for the ledger, otherwise the
    // largest move, so the post is about the coin where the shape is most visible.
    material = kind === 'ledger'
      ? ofKind[0]!.material
      : [...ofKind].sort((a, b) => Math.abs(Number(b.material.facts.chg24h ?? 0)) - Math.abs(Number(a.material.facts.chg24h ?? 0)))[0]!.material;
    if (!opts.dryRun && slot.at >= expiresAt(material.category, material.at)) {
      report.skipped.push(`${material.symbol}: 下一个时段已超过这条费率的保质期，不写注定作废的草稿`);
      return report;
    }
    const seed = hashString(personaSeed(material.id, account.id, slot.at));
    const base = toContext(material);
    if (kind === 'ledger') {
      const ctx = columnContext({ ...base, memoryLine: memoryLineFor(store, material.symbol!, seed, now) }, seed);
      if (!ctx) { report.skipped.push(`${material.symbol}: 没有可读的组合`); return report; }
      const tpl = columnTemplates[0]!;
      const res = renderTemplate(tpl, ctx, { seed, bank: wordBank });
      if (!res.ok) { report.skipped.push(`${material.symbol}: ${res.reason}`); return report; }
      text = res.text; facts = res.facts; trace = { ...res.trace }; tplId = tpl.id;
    } else {
      const ask = pickVariant(activeVariants(store, 'question', 'ask'), seed);
      const watch = pickVariant(activeVariants(store, 'anomaly', 'watch'), seed);
      const close = pickVariant(activeVariants(store, 'anomaly', 'close'), seed >>> 3);
      const ctx = shapeContext(kind, { ...base, memoryLine: kind === 'anomaly' ? memoryLineFor(store, material.symbol!, seed, now) : '' }, { ask: ask?.text, watch: watch?.text, close: close?.text }, seed);
      if (!ctx) { report.skipped.push(`${material.symbol}: 没有可读的组合`); return report; }
      const tpl = shapeTemplates.find(x => x.id === `column.${kind}`)!;
      const res = renderTemplate(tpl, ctx, { seed, bank: wordBank });
      if (!res.ok) { report.skipped.push(`${material.symbol}: ${res.reason}`); return report; }
      text = res.text; facts = res.facts; trace = { ...res.trace }; tplId = tpl.id;
      variantIds = kind === 'question' ? (ask ? [ask.id] : []) : [watch?.id, close?.id].filter((x): x is number => typeof x === 'number');
    }
  }

  const audit = auditAgainstFacts(text, facts);
  if (!audit.ok) { report.skipped.push(`${material?.symbol ?? '对账'}: 台账外的数字 ${audit.inventedNumbers.join('、')}`); return report; }

  // The shapes are fixed, so near-duplicate checks are against *content*, not structure.
  const dup = isDuplicate(text, recentTexts, 0.8);
  if (dup) { report.skipped.push(`${material?.symbol ?? '对账'}: 与近期帖子几乎一样`); return report; }

  // Half the column is handed to the rewriter, as the h_column_polish arm, so «does the AI make it
  // read less mechanical» is answered by views rather than by taste. The heading is the column's
  // identity and must survive; a rewrite that drops it, or fails the fact audit, is discarded and
  // the post is recorded under the arm it actually ran.
  let polishArm: 'raw' | 'polished' | null = arms.h_column_polish === 'polished' || arms.h_column_polish === 'raw' ? arms.h_column_polish : null;
  let polishNote: string | undefined;
  if (polishArm === 'polished' && !opts.dryRun) {
    const p = await applyPolish(store, eff, text, facts, account.persona_note ?? '', {
      category: material?.category, subType: material?.subType ?? null, symbol: material?.symbol ?? null, verdicts,
    });
    const heading = headingOf(text);
    if (p.text !== text && (!heading || p.text.trimStart().startsWith(heading))) text = p.text;
    else { polishArm = 'raw'; polishNote = p.note ?? (p.text !== text ? 'ai_rejected: 栏目标题被改动' : 'ai_unavailable'); }
    polishNote ??= p.note;
  }

  // One disclaimer, at the bottom, once.
  if (eff.appendDisclaimer && !carriesDisclaimer(text)) text = `${text}\n${wordBank['disclaimer.soft']}`;
  if (material && eff.appendHashtags) text = withHashtags(text, material, 1);

  // The chart goes through the same playbook as every other post, so the h_chart arm decides it
  // and the comparison is not contaminated by this lane always attaching one.
  const pb = playbook(store, { verdicts, arms });
  let images: string[] = [];
  if (!opts.dryRun && material && eff.attachChart && pb.attachChart && material.symbol) {
    try {
      const f = material.facts as Record<string, unknown>;
      const pick = (k: string): number | null => (typeof f[k] === 'number' ? (f[k] as number) : null);
      const built = await buildChartFor({
        symbol: material.symbol, chg24h: pick('chg24h'), volMultiple: pick('volMultiple'),
        funding: pick('funding'), oiChangePct: pick('oiChangePct'), longRatio: pick('longRatio'),
      });
      if (built) images = [built.path];
    } catch (err) {
      report.skipped.push(`${material.symbol}: 图表失败 ${String(err).slice(0, 60)}`);
    }
  }

  if (opts.dryRun) {
    report.created.push({ id: 0, symbol: material?.symbol ?? '—', text, scheduledAt: slot.at, kind });
    return report;
  }

  const id = store.addPost({
    materialId: material?.id ?? null,
    templateId: tplId,
    text,
    status: eff.autoPublish ? 'approved' : 'draft',
    scheduledAt: slot.at,
    facts,
    trace: { ...trace, lane: 'column', kind, variants: variantIds, account: account.label, ...(polishNote ? { polish: polishNote } : {}) },
    images,
    // P0-2: bound at the write, not in a follow-up update; label_id defaults to the primary
    // label inside addPost and refuses the insert if none is active. Column posts spend the
    // account's short lane — the lease row is the audit half of lane accounting.
    accountId: account.id,
  });
  store.recordLaneLease(account.id, 'short', beijingDayStart(Date.now()), slot.at, 'matrix');
  // The arm on record is the shape that actually ran, not the one drawn: a draw that had to fall
  // back must not be counted under an arm the post did not carry.
  recordArms(store, id, { ...arms, h_column: kind, ...(polishArm ? { h_column_polish: polishArm } : {}) });

  if (material) {
    store.markMaterialUsed(material.id);
    store.claim(material.symbol!, id, material.score, account.id);
    // Every post that names a payer makes a checkable statement; register it so a day later code
    // can rule on it.
    const f = material.facts as Record<string, FieldValue>;
    const payer = f.payer === '多头' || f.payer === '空头' ? f.payer : null;
    if (payer && typeof f.funding === 'number') {
      registerCall(store, {
        postId: id, symbol: material.symbol!, reading: kind, payer, rate: f.funding,
        annualized: typeof f.annualized === 'number' ? f.annualized : null,
        intervalHours: typeof f.intervalHours === 'number' ? f.intervalHours : 8,
        price: typeof f.price === 'number' ? f.price : null, now,
      });
    }
  }
  if (usedCalls.length) markRecapped(store, usedCalls, id);

  report.created.push({ id, symbol: material?.symbol ?? '—', text, scheduledAt: slot.at, kind });
  store.log('column_generate', { id, kind, symbol: material?.symbol ?? null, account: account.label });
  return report;
}

/** The fixed 【栏目】 heading a column post opens with, if any. */
export function headingOf(text: string): string | null {
  return /^\s*(【[^】]{1,8}】)/.exec(text)?.[1] ?? null;
}

/**
 * Honour the drawn arm when that shape is available, otherwise fall back to one that is.
 */
export function pickAvailable(available: string[], armed: string | null, seed: number): Kind {
  if (!available.length) return 'ledger';
  if (armed && available.includes(armed)) return armed as Kind;
  return available[Math.abs(seed) % available.length] as Kind;
}
