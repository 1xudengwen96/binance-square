import type { Store } from '../db/index.ts';
import { DIMENSIONS, HYPOTHESES, type Dimension, type Hypothesis, type Metric } from './hypotheses.ts';
import type { Verdict } from './score.ts';
import { remember } from '../brain/memory.ts';
import { hashString } from '../engine/prng.ts';

/**
 * The hypothesis registry, as data rather than source code.
 *
 * This is the piece that lets the loop close. Until now the system could test a hypothesis,
 * measure it, and remember the result — but the set of things it was willing to test was frozen
 * in an array in `hypotheses.ts`, so "what should we try next?" had no destination. The brain's
 * own answer to that question was demonstrably a restatement of the three experiments already
 * running, because restating them was the only move available to it.
 *
 * The gate matters more than the openness. A proposal is only accepted if it can actually be
 * measured: its dimension must exist, its metric must exist, and if it claims to be an experiment
 * the dimension must be a knob the writer can be told to turn. Anything else would record arms,
 * spend exploration traffic, and measure nothing — which is worse than not measuring, because it
 * produces a confident null.
 */

/** How many brain-proposed hypotheses may exist at once, counting unapproved ones. */
export const MAX_PROPOSED = 2;
/** A proposed hypothesis that has still drawn zero samples after this long gets retired. */
export const STALL_DAYS = 21;

const METRICS: Metric[] = ['views24h', 'growth1h', 'engagementPer1k', 'qualityPer1k', 'rebatePer1k'];
const isDimension = (x: string): x is Dimension => Object.prototype.hasOwnProperty.call(DIMENSIONS, x);
const isMetric = (x: string): x is Metric => (METRICS as string[]).includes(x);

interface HypoRow {
  id: string; claim: string; mode: 'experiment' | 'observed'; dimension: Dimension; metric: Metric;
  min_samples: number; how: string; risk: string; origin: string; status: string; created_at: number;
  proposed_from: string | null;
}

const toHypothesis = (r: HypoRow): Hypothesis => ({
  id: r.id, claim: r.claim, mode: r.mode, dimension: r.dimension,
  // Arms always come from the dimension, never from the row. Storing them would allow a row
  // whose arms do not match what `armOf` actually produces, which scores as an empty group.
  arms: DIMENSIONS[r.dimension].arms,
  metric: r.metric, minSamples: r.min_samples, how: r.how, risk: r.risk,
});

/**
 * Seed the curated list into the registry table the first time it is read.
 *
 * Before this the built-ins lived in source and the proposals lived in the table, so «what are we
 * testing, judged by what» had two answers: one that needed a code deploy to change and one that
 * didn't. A verdict written against one copy and audited against the other is exactly the class of
 * bug this round produced twice. Seeding happens once, when the table is empty.
 */
export function seedRegistry(store: Store, now = Date.now()): number {
  const existing = (store.db.prepare('SELECT COUNT(*) AS n FROM hypotheses').get() as { n: number }).n;
  if (existing > 0) return 0;
  const ins = store.db.prepare(
    `INSERT INTO hypotheses (id, claim, mode, dimension, metric, min_samples, how, risk, origin, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO NOTHING`,
  );
  for (const h of HYPOTHESES) {
    ins.run(h.id, h.claim, h.mode, h.dimension, h.metric, h.minSamples, h.how, h.risk, 'builtin', 'active', now);
  }
  return HYPOTHESES.length;
}

/** Everything the engine is currently willing to test — the registry table is the only source. */
export function registry(store: Store): Hypothesis[] {
  seedRegistry(store);
  // `rowid` is the insertion order: the curated list is seeded in source order, and anything
  // registered later lands after it. Sorting by id would alphabetise the registry and reorder it
  // under whoever is reading it.
  const rows = store.db
    .prepare("SELECT * FROM hypotheses WHERE status = 'active' ORDER BY created_at, rowid")
    .all() as HypoRow[];
  return rows.map(toHypothesis);
}

/** Proposal rows, for the panel, with the sentence that would run if approved. */
export function proposals(store: Store): (HypoRow & { dimension_label: string; source_text: string | null })[] {
  const rows = store.db
    .prepare("SELECT * FROM hypotheses WHERE status = 'proposed' ORDER BY created_at DESC")
    .all() as HypoRow[];
  return rows.map(r => ({
    ...r,
    dimension_label: DIMENSIONS[r.dimension].label,
    source_text: r.proposed_from
      ? (store.db.prepare('SELECT text FROM brain_memory WHERE key = ?').get(r.proposed_from) as { text: string } | undefined)?.text ?? null
      : null,
  }));
}

export interface Proposal {
  claim: string;
  mode: string;
  dimension: string;
  metric: string;
  minSamples?: number;
  how?: string;
  risk?: string;
  origin: 'brain' | 'operator';
  /** The `brain_memory` key this came from, so the panel can show the model's raw words. */
  proposedFrom?: string;
  now?: number;
}

export type ProposalResult = { ok: true; id: string; status: 'active' | 'proposed' } | { ok: false; reason: string };

/**
 * Accept a hypothesis only if it can be measured, and say plainly why it was not.
 *
 * The rejection reasons are written to be read by the model as well as the operator: `reflect()`
 * feeds them back on the next pass, so "已经在测了" teaches it not to propose the same thing again
 * instead of quietly dropping a row it will never see.
 */
export function propose(store: Store, p: Proposal): ProposalResult {
  const now = p.now ?? Date.now();
  const claim = p.claim.trim();
  if (claim.length < 8) return { ok: false, reason: '主张太短，写不清楚的主张也测不清楚' };
  if (!isDimension(p.dimension)) {
    return { ok: false, reason: `「${p.dimension}」不是系统能分组的维度。可用：${Object.values(DIMENSIONS).map(d => d.label).join('、')}` };
  }
  if (!isMetric(p.metric)) {
    return { ok: false, reason: `「${p.metric}」不是系统能测量的指标。可用：${METRICS.join('、')}` };
  }
  if (p.mode !== 'experiment' && p.mode !== 'observed') return { ok: false, reason: '模式只能是 experiment 或 observed' };
  if (p.mode === 'experiment' && DIMENSIONS[p.dimension].kind !== 'knob') {
    return {
      ok: false,
      reason: `「${DIMENSIONS[p.dimension].label}」是观测维度，写作层没法主动改变它，所以不能随机分配 —— 只能作为观察假设（结论封顶是线索，不是规则）。`,
    };
  }

  const all = registry(store);
  const dupe = all.find(h => h.dimension === p.dimension && h.metric === p.metric);
  if (dupe) return { ok: false, reason: `这个维度用这个指标已经在测了（${dupe.claim}）。提一个还没被覆盖的比较。` };
  const sameClaim = all.find(h => h.claim === claim);
  if (sameClaim) return { ok: false, reason: '这条主张已经在登记表里了' };

  if (p.origin === 'brain') {
    const open = (store.db
      .prepare("SELECT COUNT(*) AS n FROM hypotheses WHERE origin = 'brain' AND status IN ('active','proposed')")
      .get() as { n: number }).n;
    if (open >= MAX_PROPOSED) return { ok: false, reason: `大脑提议的假设已有 ${open} 条在跑，先到上限 ${MAX_PROPOSED} 条 —— 同时开太多，每条都攒不够样本。` };
  }

  const id = `bh:${hashString(claim).toString(36).slice(0, 7)}`;
  const minSamples = Math.max(5, Math.min(40, p.minSamples ?? 6));
  store.db
    .prepare(
      `INSERT INTO hypotheses (id, claim, mode, dimension, metric, min_samples, how, risk, origin, status, proposed_from, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      id, claim, p.mode, p.dimension, p.metric, minSamples,
      p.how?.trim() || `在「${DIMENSIONS[p.dimension].label}」这一个维度上分组比较${p.metric === 'views24h' ? ' 24 小时浏览量' : p.metric}。`,
      p.risk?.trim() || (p.mode === 'experiment' ? '分配到这个臂的帖子可能表现更差 —— 这是唯一能证明因果的代价。' : '观察而非实验：只能看方向，不能当因果。'),
      p.origin,
      // A model proposing a knob experiment is asking to spend real traffic on an idea it cannot
      // be held to. An observed hypothesis costs nothing to run, so it may enter on its own.
      p.origin === 'brain' && p.mode === 'experiment' ? 'proposed' : 'active',
      p.proposedFrom ?? null,
      now,
    );

  const stored = store.db.prepare('SELECT status FROM hypotheses WHERE id = ?').get(id) as { status: string } | undefined;
  if (!stored) return { ok: false, reason: '这条已经提过了' };
  return { ok: true, id, status: stored.status as 'active' | 'proposed' };
}

/** Approve or refuse a pending proposal. Only rows awaiting approval may be resolved this way. */
export function resolveProposal(store: Store, id: string, approve: boolean, reason: string, now = Date.now()): boolean {
  const res = approve
    ? store.db.prepare("UPDATE hypotheses SET status = 'active' WHERE id = ? AND status = 'proposed'").run(id)
    : store.db
        .prepare("UPDATE hypotheses SET status = 'retired', retired_at = ?, retire_reason = ? WHERE id = ? AND status = 'proposed'")
        .run(now, `操作者拒绝：${reason}`, id);
  return res.changes > 0;
}

export function retire(store: Store, id: string, reason: string, now = Date.now()): boolean {
  const res = store.db
    .prepare("UPDATE hypotheses SET status = 'retired', retired_at = ?, retire_reason = ? WHERE id = ? AND status = 'active'")
    .run(now, reason, id);
  return res.changes > 0;
}

/**
 * Retire a registered comparison that cannot get off the ground.
 *
 * A stalled hypothesis is not neutral: it keeps its share of the exploration budget, so the
 * hypotheses that *could* be measured get sampled more slowly. The curated built-ins are protected
 * from auto-retirement — they now live in this table too, so the protection has to be explicit — and
 * the count is still reported, because a registry where four of seven rows are starved is information
 * about the registry. A built-in is retired only by an operator decision (`retire`), never by a clock.
 */
export function retireStalled(store: Store, verdicts: Verdict[], now = Date.now()): string[] {
  const rows = store.db
    .prepare("SELECT id, claim, created_at FROM hypotheses WHERE status = 'active' AND origin <> 'builtin'")
    .all() as { id: string; claim: string; created_at: number }[];
  const retired: string[] = [];
  for (const r of rows) {
    const ageDays = (now - r.created_at) / 86_400_000;
    if (ageDays < STALL_DAYS) continue;
    const v = verdicts.find(x => x.id === r.id);
    const samples = v ? v.arms.reduce((s, a) => s + a.n, 0) : 0;
    if (samples > 0) continue;
    if (!retire(store, r.id, `登记 ${Math.round(ageDays)} 天，一条样本都没攒到 —— 这个比较在当前发帖量下测不动。`, now)) continue;
    remember(store, {
      kind: 'engine-model',
      key: `rank:stalled:${r.id}`,
      text: `「${r.claim}」测不了：${Math.round(ageDays)} 天零样本。要么它需要的臂根本不会出现，要么发帖量还不够。别再提这条。`,
      confidence: 0.5,
      source: 'registry',
    });
    retired.push(r.id);
  }
  return retired;
}

/** How many registered hypotheses are drawing zero samples — the shape of a starved registry. */
export function starved(verdicts: Verdict[], now = Date.now()): { id: string; claim: string; missing: number }[] {
  return verdicts
    .filter(v => v.status === 'observing' && v.missing > 0)
    .map(v => ({ id: v.id, claim: v.claim, missing: v.missing }));
}
