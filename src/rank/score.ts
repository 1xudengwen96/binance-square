import type { Store } from '../db/index.ts';
import { distributionRows, type Distribution } from './observations.ts';
import { CONFIDENCE_TO_ACT, HYPOTHESES, type Hypothesis, type Metric } from './hypotheses.ts';
import { remember } from '../brain/memory.ts';

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

type Row = Distribution & {
  account_id: number | null; category: string | null; style: string | null; template_id: string | null;
  symbol: string | null; chars: number; has_chart: number; published_at: number; text: string;
  material_score: number | null; rebate_usd: number | null;
  likes: number | null; comments: number | null; shares: number | null;
  arms?: Record<string, string>;
  repeatGapHours?: number | null;
};

/**
 * The reading a row is allowed to speak for.
 *
 * Comparing a post measured at 20 minutes against one measured at a day is not a comparison, and
 * with a handful of posts a day it is the easy mistake to make. Rows younger than the 3-hour
 * checkpoint are left out of every outcome here rather than being counted at their partial value.
 */
const MATURITY_FLOOR_MS = 3 * 3600_000;

function outcome(row: Row, metric: Metric): number | null {
  const views = row.v24h ?? row.v8h ?? row.v3h;
  switch (metric) {
    case 'views24h':
      return views ?? null;
    case 'growth1h':
      return row.growth_1h;
    case 'engagementPer1k': {
      if (!views || views <= 0) return null;
      // Null counters mean the sweep has not read this post yet; that is not zero engagement.
      if (row.likes == null && row.comments == null && row.shares == null) return null;
      return (((row.likes ?? 0) + (row.comments ?? 0) + (row.shares ?? 0)) / views) * 1000;
    }
    case 'rebatePer1k': {
      // Views are the denominator the operator's daily figure can be spread over; a post with no
      // reading cannot carry any credit, so it is excluded rather than scored as zero money.
      const rebate = row.rebate_usd;
      if (!views || views <= 0 || rebate == null) return null;
      return (rebate / views) * 1000;
    }
  }
}

function armOf(row: Row, h: Hypothesis): string | null {
  if (h.mode === 'experiment') return row.arms?.[h.id] ?? null;
  switch (h.id) {
    case 'h_length_band':
      return row.chars < 120 ? 'short' : row.chars <= 220 ? 'mid' : 'long';
    case 'h_hour_band': {
      const hour = new Date(row.published_at + 8 * 3600_000).getUTCHours();
      return hour < 8 ? 'late' : hour < 11 ? 'morning' : hour < 15 ? 'midday' : hour < 19 ? 'afternoon' : hour < 23 ? 'evening' : 'late';
    }
    case 'h_repeat_interval': {
      if (row.repeatGapHours == null) return null;
      return row.repeatGapHours < 6 ? 'within6h' : row.repeatGapHours < 24 ? '6to24h' : 'over24h';
    }
    case 'h_surfacing_shape':
      return row.surfaced ? 'surfaced' : 'unsurfaced';
    default:
      return null;
  }
}

export interface ArmStat {
  arm: string;
  n: number;
  median: number | null;
  best: number | null;
}

export interface Verdict {
  id: string;
  claim: string;
  metric: Metric;
  mode: Hypothesis['mode'];
  how: string;
  risk: string;
  arms: ArmStat[];
  winner: string | null;
  loser: string | null;
  /** The naive all-posts-together gap. Kept visible so a rule that evaporates under stratification is obvious. */
  effect: number;
  /** Same comparison inside (category × heat) strata. This is the number promotion is judged on. */
  stratified: { gap: number | null; rel: number | null; strata: number; dropped: number; winner: string | null };
  /** Did the second half of the sample reproduce what the first half found? */
  replicated: boolean | null;
  confidence: number;
  status: 'observing' | 'leaning' | 'rule' | 'flat';
  /** What it would change if acted on, in one sentence the panel can show. */
  action: string | null;
  /** Why it is not a rule yet, in the operator's language. */
  note: string | null;
  missing: number;
}

function fmt(metric: Metric, v: number | null): string {
  if (v == null) return '—';
  if (metric === 'views24h') return Math.round(v).toLocaleString('en-US');
  return v.toFixed(2);
}

/**
 * Score every hypothesis against what the engine actually did, and write the ones that have
 * earned it into long-term memory as rules.
 *
 * The status ladder is the point: `observing` is what the system must say most of the time, and
 * a rule only exists once the sample and the gap both clear their floor. Anything else is a
 * machine inventing folklore about an algorithm it cannot read.
 */
export function scoreAll(store: Store, opts: { days?: number; writeMemory?: boolean; now?: number; target?: 'views' | 'money' } = {}): Verdict[] {
  const days = opts.days ?? 30;
  const now = opts.now ?? Date.now();
  const rows = distributionRows(store, days) as Row[];
  // Pointing the system at money is a real switch, but it only becomes real once the operator
  // has entered a figure. Until then the verdicts stay on views and say so.
  const moneyReady = opts.target === 'money' && rows.some(r => r.rebate_usd != null);
  const armsByPost = new Map<number, Record<string, string>>();
  for (const a of store.db.prepare('SELECT post_id, experiment, arm FROM post_arms').all() as { post_id: number; experiment: string; arm: string }[]) {
    (armsByPost.get(a.post_id) ?? armsByPost.set(a.post_id, {}).get(a.post_id)!)[a.experiment] = a.arm;
  }
  // Hours since the previous post about the same coin and the same signal — the self-suppression
  // measurement, computed here so the observation stays a property of the row.
  const lastSeen = new Map<string, number>();
  for (const r of [...rows].reverse()) {
    const k = `${r.symbol}|${r.category}`;
    const prev = lastSeen.get(k);
    r.repeatGapHours = prev == null ? null : (r.published_at - prev) / 3600_000;
    lastSeen.set(k, r.published_at);
  }
  for (const r of rows) r.arms = armsByPost.get(r.post_id) ?? {};

  const eligible = rows.filter(r => now - r.published_at >= MATURITY_FLOOR_MS);
  const out: Verdict[] = [];

  for (const h of HYPOTHESES) {
    // Money replaces views as the target only for the arms we randomise; an observed comparison
    // would just be a smaller version of the same confounding.
    const metric: Metric = moneyReady && h.mode === 'experiment' ? 'rebatePer1k' : h.metric;
    const groups = new Map<string, number[]>();
    for (const r of eligible) {
      const arm = armOf(r, h);
      const v = outcome(r, metric);
      if (!arm || v == null) continue;
      (groups.get(arm) ?? groups.set(arm, []).get(arm)!).push(v);
    }
    const arms: ArmStat[] = h.arms.map(arm => {
      const vs = groups.get(arm) ?? [];
      return { arm, n: vs.length, median: median(vs), best: vs.length ? Math.max(...vs) : null };
    });
    const scored = arms.filter(a => a.median != null);
    const minN = Math.min(...scored.map(a => a.n), Infinity);
    const enough = scored.length >= 2 && minN >= h.minSamples;

    const ranked = [...scored].sort((a, b) => (b.median ?? 0) - (a.median ?? 0));
    const winner = ranked.length > 1 ? ranked[0]!.arm : null;
    const loser = ranked.length > 1 ? ranked[ranked.length - 1]!.arm : null;
    const pooled = median(scored.flatMap(a => groups.get(a.arm) ?? [])) ?? 1;
    const effect = ranked.length > 1 ? (ranked[0]!.median ?? 0) - (ranked[ranked.length - 1]!.median ?? 0) : 0;
    const rel = effect / Math.max(Math.abs(pooled), 1);

    // Two independent questions, both must be yes: is there a gap once the coin's heat is held
    // constant, and does the later half of the sample reproduce the earlier half?
    const st = stratify(eligible, h, metric);
    const [first, second] = halves(eligible);
    const a = stratify(first, h, metric);
    const b = stratify(second, h, metric);
    const replicated = a.winner && b.winner ? a.winner === b.winner : null;

    let confidence = 0.5;
    let status: Verdict['status'] = 'observing';
    let note: string | null = null;
    if (!enough) {
      note = `每臂至少 ${h.minSamples} 条才能比，现在最少那臂只有 ${Number.isFinite(minN) ? minN : 0} 条。`;
    } else if (st.strata === 0) {
      note = '分层之后没有任何一层同时有两个臂的数据 —— 帖子太分散，比不了。';
    } else {
      const nFactor = Math.min(1, minN / (h.minSamples * 2));
      confidence = Math.min(0.95, 0.5 + 0.5 * (st.rel ?? 0) * nFactor);
      const bigEnough = Math.abs(st.rel ?? 0) >= 0.15;
      // Two things make an *observed* comparison weaker than an experimental one, and both bit on
      // the first live run: the arms were chosen by history rather than at random (posts at 23:00
      // are different coins on different nights, not the same post at a different hour), and one
      // lucky stratum can carry the whole result. So observation tops out at 'leaning' — a lead
      // worth acting on deliberately, never something the writer is told to believe.
      const thinSlicing = st.strata < 2;
      if (h.mode === 'observed' && bigEnough) {
        status = 'leaning';
        note = '这是观察不是实验：两组的币和日子本来就不同，只能当线索。要当规则，得让它变成随机分配的臂。';
      } else if (!bigEnough) {
        status = 'flat';
        note = st.rel != null && Math.abs(rel) >= 0.15 ? '混着比看着有差，分层之后差没了 —— 那个差是币的热度，不是写法。' : null;
      } else if (thinSlicing) {
        status = 'leaning';
        note = `只有 ${st.strata} 层同时有两个臂的数据，一层定输赢太便宜。`;
      } else if (replicated === true && st.winner && confidence >= CONFIDENCE_TO_ACT) {
        status = 'rule';
      } else {
        status = 'leaning';
        note = replicated === false ? '前后两半各赢一次，赢家不一样 —— 这就是噪声，不是规则。' : confidence < CONFIDENCE_TO_ACT ? `置信 ${(confidence * 100).toFixed(0)}%，还没到 ${(CONFIDENCE_TO_ACT * 100).toFixed(0)}% 的线。` : null;
      }
    }
    const missing = enough ? 0 : Math.max(0, h.minSamples - (Number.isFinite(minN) ? minN : 0));

    const verdict: Verdict = {
      id: h.id, claim: h.claim, metric, mode: h.mode, how: h.how, risk: h.risk,
      arms, winner, loser, effect: Number(rel.toFixed(3)),
      stratified: { gap: st.gap, rel: st.rel, strata: st.strata, dropped: st.dropped, winner: st.winner },
      replicated,
      confidence: Number(confidence.toFixed(2)), status,
      action: status === 'rule' ? `以后按「${st.winner}」这一档来写：同热度同格子内它比另一档高约 ${st.gap}（${((st.rel ?? 0) * 100).toFixed(0)}%）。` : null,
      note, missing,
    };
    out.push(verdict);

    if (opts.writeMemory !== false && (status === 'rule' || status === 'flat')) {
      const detail = arms.map(a2 => `${a2.arm} ${fmt(metric, a2.median)}（${a2.n} 条）`).join('，');
      remember(store, {
        kind: 'rank-rule',
        key: `rank:${h.id}`,
        text: status === 'rule'
          ? `${h.claim} —— 成立（${st.strata} 层内复现，前后两半一致）：${detail}。`
          : `${h.claim} —— 测过了，差别不大：${detail}。不值得为它改写法。`,
        confidence: status === 'rule' ? confidence : 0.6,
        evidenceN: arms.reduce((s, a2) => s + a2.n, 0),
        source: 'rank-score',
      });
    }
  }
  return out;
}

/**
 * Which comparison a post belongs in.
 *
 * The single largest driver of a post's view count is which coin it was about and how hot that
 * coin was at the time — an effect one or two orders of magnitude bigger than anything a wording
 * choice can do. Comparing arms across all posts therefore measures the luck of the draw. Inside
 * a stratum (same category, same heat band) the coin factor is roughly held constant, so the
 * remaining difference is much more plausibly the arm.
 */
function stratumOf(r: Row): string {
  const score = r.material_score ?? 0;
  const band = score >= 85 ? '高热' : score >= 70 ? '中热' : score >= 55 ? '低热' : '冷门';
  return `${r.category ?? '未分类'}|${band}`;
}

interface StratumResult {
  /** Average of (best arm − worst arm) within each stratum, strata weighted equally. */
  gap: number | null;
  /** Relative to the pooled median, so it is comparable across metrics. */
  rel: number | null;
  winner: string | null;
  strata: number;
  /** Strata where one arm simply has no rows — the honest cost of slicing thin. */
  dropped: number;
}

function stratify(rows: Row[], h: Hypothesis, metric: Metric): StratumResult {
  const byStratum = new Map<string, Map<string, number[]>>();
  for (const r of rows) {
    const arm = armOf(r, h);
    const v = outcome(r, metric);
    if (!arm || v == null) continue;
    const s = stratumOf(r);
    if (!byStratum.has(s)) byStratum.set(s, new Map());
    const arms = byStratum.get(s)!;
    (arms.get(arm) ?? arms.set(arm, []).get(arm)!).push(v);
  }
  const gaps: number[] = [];
  const wins = new Map<string, number>();
  const pooledAll: number[] = [];
  let dropped = 0;
  for (const arms of byStratum.values()) {
    const present = [...arms.entries()].filter(([, vs]) => vs.length > 0);
    for (const [, vs] of present) pooledAll.push(...vs);
    if (present.length < 2) {
      dropped++;
      continue;
    }
    const ranked = present
      .map(([arm, vs]) => ({ arm, m: median(vs)! }))
      .sort((a, b) => b.m - a.m);
    gaps.push(ranked[0]!.m - ranked[ranked.length - 1]!.m);
    wins.set(ranked[0]!.arm, (wins.get(ranked[0]!.arm) ?? 0) + 1);
  }
  if (!gaps.length) return { gap: null, rel: null, winner: null, strata: 0, dropped };
  const gap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const centre = median(pooledAll) ?? 1;
  const top = [...wins.entries()].sort((a, b) => b[1] - a[1]);
  const clear = top.length > 1 ? top[0]![1] > top[1]![1] : top.length === 1;
  return {
    gap: Number(gap.toFixed(2)),
    rel: Number((gap / Math.max(Math.abs(centre), 1)).toFixed(3)),
    winner: clear ? top[0]![0] : null,
    strata: gaps.length,
    dropped,
  };
}

/** Split at the time midpoint: a rule must win in both halves, not just wherever it was found. */
function halves(rows: Row[]): [Row[], Row[]] {
  const byTime = [...rows].sort((a, b) => a.published_at - b.published_at);
  const mid = Math.ceil(byTime.length / 2);
  return [byTime.slice(0, mid), byTime.slice(mid)];
}
export function scoreSummary(verdicts: Verdict[]): { rules: number; leaning: number; observing: number; flat: number } {
  return {
    rules: verdicts.filter(v => v.status === 'rule').length,
    leaning: verdicts.filter(v => v.status === 'leaning').length,
    observing: verdicts.filter(v => v.status === 'observing').length,
    flat: verdicts.filter(v => v.status === 'flat').length,
  };
}
