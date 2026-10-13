import type { AccountRow, Store } from './db/index.ts';
import type { Settings } from './config.ts';
import { beijingDayStart } from './schedule.ts';
import { labelRenderable } from './labels.ts';
import { ALERT_KINDS, raise as raiseAlert } from './alerts/bus.ts';
import type { Material } from './material/types.ts';
import type { Context, Fact, FieldValue } from './engine/types.ts';
import { COLUMN_NAME } from './content/column.ts';
import { DEFAULT_SETTINGS } from './config.ts';
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

// 定稿 §2 停用「费率账独立帖（降为素材）」：可发布 kind 白名单就是 3+1 里的三个短帖形态。
// ledger 模板与历史数据一律保留不动（不删行、不改历史帖），只是不再进可发布集合。
type Kind = ColumnKind;

export async function generateColumn(
  store: Store,
  settings: Settings,
  account: AccountRow,
  opts: { dryRun?: boolean; now?: number } = {},
): Promise<ColumnReport> {
  const report: ColumnReport = { created: [], skipped: [] };
  const now = opts.now ?? Date.now();
  // P0-7 渲染闸门（同 generate）：栏目是账号的定位本身，人设空着出的栏目帖仍是无定位发帖。
  if (!opts.dryRun) {
    const lg = labelRenderable(store);
    if (!lg.ok) {
      // P1 证据包（定稿 v1.6 裁定二配套）：drawn 前后的每一岔都要在 funnel 里有落点。闸门这岔
      // 与 label_gate_refusal 告警同码，灯和台账说的是同一件事。
      store.log('column_funnel', { outcome: 'dropped', drop: 'persona_gate', reason: lg.reason });
      report.skipped.push(lg.reason!);
      raiseAlert(store, { kind: ALERT_KINDS.labelGateRefusal, severity: 'warning', key: 'short', extra: { reason: lg.reason } });
      return report;
    }
  }
  const eff = settingsForAccount(settings, account);
  const perDay = Math.max(1, settings.columnPostsPerDay);
  seedVariants(store, now);

  // The ceiling is on posts that exist or are about to, not on what has already gone out: a draft
  // queued behind this tick is still a post the account will make today.
  const queued = store.columnPostsSince(account.id, now - 24 * 3600_000);
  if (!opts.dryRun && queued >= perDay) {
    store.log('column_funnel', { outcome: 'dropped', drop: 'queued_ceiling', queued, perDay });
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
  // 显式兜底 + 不静默：settingsFrom 已合并 default（实测 stored 缺这个键时运行时读到 24，
  // 从未 NaN——PM/测试的 NaN 指控经运行时探针证伪，见完成帖）；这里再写一层 ?? default 是为了
  // 任何绕过 settingsFrom 的调用面也不许拿到 undefined。
  const cooldownHours = settings.columnCoinCooldownHours ?? DEFAULT_SETTINGS.columnCoinCooldownHours;
  if (!Number.isFinite(cooldownHours)) throw new Error(`columnCoinCooldownHours 读到了非数值：${String(cooldownHours)}`);
  const coinCooldownMs = Math.max(1, cooldownHours) * 3600_000;
  const funnel: { pool: number; noSymbol: number; claimed: number; cooldown: number; usable: number; counted: number; q: number; a: number; noneFit?: number } =
    { pool: pool.length, noSymbol: 0, claimed: 0, cooldown: 0, usable: 0, counted: 0, q: 0, a: 0 };
  const usable = pool.filter(m => {
    if (!m.symbol) { funnel.noSymbol++; return false; }
    if (claimedByOther(m.symbol)) { funnel.claimed++; return false; }
    if (store.coinPostsSince(account.id, m.symbol, now - coinCooldownMs) > 0) { funnel.cooldown++; return false; }
    funnel.usable++;
    const sh = shapesFor(m);
    if (sh.includes('question')) funnel.q++;
    if (sh.includes('anomaly')) funnel.a++;
    return sh.length > 0;
  });

  // Candidate (material, kind) pairs. 费率账 keeps its original, stricter rule so it stays what it
  // was; the two new shapes ask different questions of the same row.
  const pairs: { material: Material; kind: Kind }[] = [];
  for (const m of usable) for (const k of shapesFor(m)) pairs.push({ material: m, kind: k });

  // The recap is not about any coin: it exists when enough rulings have accumulated, and at most
  // once a day, and each ruling is recapped once.
  const owed = unrecapped(store, 3);
  const recapIn20h = store.columnKindSince(account.id, 'column.recap', now - 20 * 3600_000);
  const haveRecap = owed.length >= RECAP_MIN_CALLS && recapIn20h === 0;

  if (!pairs.length && !haveRecap) {
    store.log('column_funnel', { ...funnel, outcome: 'refused', why: '没有够格的币，也没有可复盘的判断', owed: owed.length, recapIn20h });
    report.skipped.push(`${COLUMN_NAME}：本轮没有够格的币（${pool.length} 条费率素材，${pool.length - usable.length} 条被占用或冷却）`);
    return report;
  }

  // 定稿 v1.6 裁定二：先定「这个槽要不要发」，再抽「发哪栏」。旧顺序是按小时 seed 抽签、按槽发帖，
  // 同一小时的 4 轮 tick 抽出完全一样的 kind 并被记成 4 次 drawn（10-13 线上 42 条 drawn、其中
  // recap 16 条全部不落槽）——小时级的一次决定被读数成了四次，且 drawn 之后的丢弃全无落码。
  const slot = nextSlotFor(store, settings, account, now, null, true);
  if (!slot.allowed) {
    store.log('column_funnel', { ...funnel, outcome: 'dropped', drop: 'no_legal_slot', slot_at: slot.at, why: slot.reason });
    report.skipped.push(slot.reason);
    return report;
  }
  if (!opts.dryRun && slot.reason.includes('已顺延')) {
    store.log('column_funnel', { ...funnel, outcome: 'dropped', drop: 'slot_deferred', slot_at: slot.at, why: slot.reason });
    report.skipped.push('今天的发帖时段已排满，再写就只能排到明天');
    return report;
  }

  const verdicts = scoreAll(store, { writeMemory: false, target: currentTarget(store, settings, now) });
  const available: string[] = [...new Set(pairs.map(p => p.kind))];
  if (haveRecap) available.push('recap');
  // seed 跟着发帖槽走：同一槽位上的抽签（含臂分配）是同一决定，不同槽位才是不同的抽签。
  const arms = planArms({ seed: hashString(`${account.id}:${Math.floor(slot.at / 3_600_000)}:col`), verdicts, only: settings.activeExperiments });
  const kind = pickAvailable(available, arms.h_column ?? null, hashString(`${slot.at}:${account.id}`));
  funnel.counted = pairs.length;
  if (kind === null) {
    funnel.noneFit = 1;
    store.log('column_funnel', { ...funnel, outcome: 'refused', why: '白名单内没有可用形态', slot_at: slot.at, owed: owed.length, recapIn20h });
    report.skipped.push(`${COLUMN_NAME}：白名单（盘中一问/今日反常/昨日对账）内本轮无可用形态`);
    return report;
  }
  store.log('column_funnel', { ...funnel, outcome: 'drawn', kind, slot_at: slot.at, owed: owed.length, recapIn20h });

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
    if (!res.ok) {
      store.log('column_funnel', { ...funnel, outcome: 'dropped', drop: 'render_refused', kind, slot_at: slot.at, why: res.reason });
      report.skipped.push(`对账：${res.reason}`);
      return report;
    }
    text = res.text; facts = res.facts; trace = { ...res.trace }; tplId = tpl.id;
    // 16 轮 drawn-recap 零出稿的真实死因（tick note「对账: 台账外的数字 」后为空＝数字清单是空的，
    // 拒的是 *币种*——recapLineFor 里的 `$BTC` 来自 column_calls 的在册事实，但渲染器只把带数字的
    // 表面登记进 facts，$ 币种没有；auditAgainstFacts 按 inventedSymbols 拒稿，而旧消息只打印
    // inventedNumbers，看起来像空拒绝。把每行币种补登为 symbol fact，审计才看得见它们是事实。
    for (const c of owed) facts.push({ surface: `$${c.symbol}`, value: null, field: 'recap.symbol', kind: 'symbol' });
    usedCalls = owed.map(o => o.id);
    variantIds = close ? [close.id] : [];
  } else {
    const ofKind = pairs.filter(p => p.kind === kind);
    if (!ofKind.length) {
      store.log('column_funnel', { ...funnel, outcome: 'dropped', drop: 'no_material_fit', kind, slot_at: slot.at, why: '本轮没有适合这个栏目的币' });
      report.skipped.push('本轮没有适合这个栏目的币');
      return report;
    }
    // Within a shape, the strongest candidate: the original ranking for the ledger, otherwise the
    // largest move, so the post is about the coin where the shape is most visible.
    material = [...ofKind].sort((a, b) => Math.abs(Number(b.material.facts.chg24h ?? 0)) - Math.abs(Number(a.material.facts.chg24h ?? 0)))[0]!.material;
    if (!opts.dryRun && slot.at >= expiresAt(material.category, material.at)) {
      store.log('column_funnel', { ...funnel, outcome: 'dropped', drop: 'shelf_expired', kind, slot_at: slot.at, symbol: material.symbol, why: '下一个时段已超过这条费率的保质期' });
      report.skipped.push(`${material.symbol}: 下一个时段已超过这条费率的保质期，不写注定作废的草稿`);
      return report;
    }
    const seed = hashString(personaSeed(material.id, account.id, slot.at));
    const base = toContext(material);
    {
      // 旧 ledger 渲染分支已随停用形态摘除（模板与历史数据留在 content/column.ts，不删）。
      const ask = pickVariant(activeVariants(store, 'question', 'ask'), seed);
      const watch = pickVariant(activeVariants(store, 'anomaly', 'watch'), seed);
      const close = pickVariant(activeVariants(store, 'anomaly', 'close'), seed >>> 3);
      const ctx = shapeContext(kind, { ...base, memoryLine: kind === 'anomaly' ? memoryLineFor(store, material.symbol!, seed, now) : '' }, { ask: ask?.text, watch: watch?.text, close: close?.text }, seed);
      if (!ctx) {
        store.log('column_funnel', { ...funnel, outcome: 'dropped', drop: 'no_material_fit', kind, slot_at: slot.at, symbol: material.symbol, why: '没有可读的组合' });
        report.skipped.push(`${material.symbol}: 没有可读的组合`);
        return report;
      }
      const tpl = shapeTemplates.find(x => x.id === `column.${kind}`)!;
      const res = renderTemplate(tpl, ctx, { seed, bank: wordBank });
      if (!res.ok) {
        store.log('column_funnel', { ...funnel, outcome: 'dropped', drop: 'render_refused', kind, slot_at: slot.at, symbol: material.symbol, why: res.reason });
        report.skipped.push(`${material.symbol}: ${res.reason}`);
        return report;
      }
      text = res.text; facts = res.facts; trace = { ...res.trace }; tplId = tpl.id;
      variantIds = kind === 'question' ? (ask ? [ask.id] : []) : [watch?.id, close?.id].filter((x): x is number => typeof x === 'number');
    }
  }

  const audit = auditAgainstFacts(text, facts);
  if (!audit.ok) {
    const inv = [...audit.inventedNumbers, ...audit.inventedSymbols].join('、');
    store.log('column_funnel', { ...funnel, outcome: 'dropped', drop: 'fact_audit', kind, slot_at: slot.at, symbol: material?.symbol ?? null, why: `台账外：${inv}` });
    // 旧消息只拼 inventedNumbers，而 recap 的拒绝全在 symbols，于是线上「台账外的数字 」后为空——
    // 数字清单当然是空的，被拒的是币种。两条都打出来。
    report.skipped.push(`${material?.symbol ?? '对账'}: 台账外的数字/币种 ${inv}`);
    return report;
  }

  // The shapes are fixed, so near-duplicate checks are against *content*, not structure.
  // The shapes are fixed, so near-duplicate checks are against *content*, not structure.
  const dup = isDuplicate(text, recentTexts, 0.8);
  if (dup) {
    store.log('column_funnel', { ...funnel, outcome: 'dropped', drop: 'near_duplicate', kind, slot_at: slot.at, symbol: material?.symbol ?? null, why: '与近期帖子几乎一样' });
    report.skipped.push(`${material?.symbol ?? '对账'}: 与近期帖子几乎一样`);
    return report;
  }

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
  // P1 证据包：drawn→出稿这条岔也要有显式落点，funnel 里 generated 带 postId，串得起同一条帖。
  store.log('column_funnel', { ...funnel, outcome: 'generated', kind, slot_at: slot.at, post_id: id });
  return report;
}

/** The fixed 【栏目】 heading a column post opens with, if any. */
export function headingOf(text: string): string | null {
  return /^\s*(【[^】]{1,8}】)/.exec(text)?.[1] ?? null;
}

/**
 * Honour the drawn arm when that shape is available, otherwise fall back to one that is.
 */
export function pickAvailable(available: string[], armed: string | null, seed: number): Kind | null {
  // 白名单外的 kind 不可能从这里出来；没有可用形态就返回 null，由调用方落拒稿事件——
  // 旧代码在这里兜底 'ledger'，那正是 id=338 用已停用形态发出去的出口（口径库 A3-1）。
  if (!available.includes('question') && !available.includes('anomaly') && !available.includes('recap')) return null;
  const pool = available.filter(k => k === 'question' || k === 'anomaly' || k === 'recap');
  if (armed && (pool as string[]).includes(armed)) return armed as Kind;
  return pool[Math.abs(seed) % pool.length] as Kind;
}
