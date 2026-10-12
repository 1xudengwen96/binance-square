import type { Store } from '../db/index.ts';
import type { Settings } from '../config.ts';

/**
 * The three gates the account has to clear, in order, and the metric each one is judged by.
 *
 * A: the platform distributes the posts at all.   B: the people who see them respond.
 * C: the posts keep growing after the first hours (a second round of distribution).
 *
 * Square gives no follower count we can read, so C is a stand-in: a post whose views are still
 * climbing hours after publishing is being shown to people who do not already follow the account.
 *
 * Everything here is arithmetic over rows already in the database. The brain reads the result; it
 * does not decide it, and it cannot move a threshold (`GATE_LINES` is a constant, not a setting).
 */

export const GATE_LINES = {
  /** Median 24h views of posts old enough to have a 24h reading. */
  viewsMedian: 1000,
  /** Distinct calendar days (Beijing) in a row the median must hold, each with enough posts. */
  daysInARow: 7,
  minPostsPerDay: 3,
  /** Comments per 1,000 views, pooled across the window. */
  commentsPer1k: 0.5,
  commentWindowDays: 14,
  /** A post counts as second-round when it kept at least doubling its 3h reading. */
  secondRoundRatio: 2,
  secondRoundMinViews: 1000,
  secondRoundNeeded: 5,
} as const;

export const BREAKER = {
  /** Consecutive published posts whose median 24h-or-latest views are judged. */
  window: 20,
  /**
   * The breaker asks «has the account collapsed», not «has it reached a goal». A fixed 150 sat
   * above the account's own 7-day median (~106) and would have stopped publishing for being
   * ordinary. The floor is now half of the account's baseline (the 30 days before the window),
   * never below `minFloor`, and `floor` is only the fallback when there is no baseline yet.
   */
  floor: 150,
  baselineShare: 0.5,
  minFloor: 30,
  /** A tripped breaker clears itself once this many posts since the trip read back above the floor… */
  recoverWindow: 6,
  /** …or after this long, since a tripped breaker stops the very posts that could clear it. */
  coolOffMs: 48 * 3600_000,
} as const;

/** Half the median reading of the 30 days before `since`, or the fixed fallback without history. */
export function breakerFloor(store: Store, since: number): number {
  const before = rows(store, since - 30 * DAY).filter(r => r.published_at < since);
  const m = before.length >= BREAKER.window ? median(before.map(r => r.v24h ?? r.views ?? 0)) : null;
  return m == null ? BREAKER.floor : Math.max(BREAKER.minFloor, Math.round(m * BREAKER.baselineShare));
}

const DAY = 86_400_000;
const BJ = 8 * 3600_000;
const dayKey = (ms: number): number => Math.floor((ms + BJ) / DAY);

interface PostRow {
  id: number;
  published_at: number;
  views: number | null;
  v3h: number | null;
  v24h: number | null;
  comments: number | null;
}

function rows(store: Store, since: number): PostRow[] {
  return store.db
    .prepare(
      `SELECT p.id, p.published_at, s.views, s.comments, d.v3h, d.v24h
       FROM posts p
       JOIN post_stats s ON s.post_id = p.id
       LEFT JOIN post_distribution d ON d.post_id = p.id
       WHERE p.status = 'published' AND p.published_at >= ?
       ORDER BY p.published_at ASC`,
    )
    .all(since) as PostRow[];
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export interface GateReport {
  asOf: number;
  A: {
    passed: boolean;
    /** Median 24h views of the last 7 days of mature posts; null when there are none. */
    median7d: number | null;
    /** Consecutive most-recent days that met both the median line and the post-count floor. */
    streakDays: number;
    daysNeeded: number;
    line: number;
  };
  B: { passed: boolean; commentsPer1k: number | null; views: number; comments: number; line: number; windowDays: number };
  C: { passed: boolean; secondRound: number; needed: number };
  /** Metric the experiments should be judged by right now. */
  target: 'views' | 'engagement';
  /** Why that target, in one line the panel can show. */
  reason: string;
}

/**
 * Where the account stands.
 *
 * A post is "mature" once its 24h reading exists; judging a 2-hour-old post against a 24h line
 * would fail every gate for the wrong reason. Days with fewer than `minPostsPerDay` mature posts
 * break the streak, so a day with one lucky post cannot pass the gate.
 */
export function gateReport(store: Store, now = Date.now()): GateReport {
  const all = rows(store, now - 30 * DAY);
  const mature = all.filter(r => r.v24h != null);

  const byDay = new Map<number, number[]>();
  for (const r of mature) {
    const k = dayKey(r.published_at);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(r.v24h!);
  }
  const today = dayKey(now);
  let streak = 0;
  // Start from yesterday: today's posts are not mature yet.
  for (let d = today - 1; d > today - 31; d--) {
    const v = byDay.get(d);
    if (!v || v.length < GATE_LINES.minPostsPerDay) break;
    if ((median(v) ?? 0) < GATE_LINES.viewsMedian) break;
    streak++;
  }
  const last7 = mature.filter(r => r.published_at >= now - 7 * DAY).map(r => r.v24h!);
  const aPassed = streak >= GATE_LINES.daysInARow;

  const cWin = all.filter(r => r.published_at >= now - GATE_LINES.commentWindowDays * DAY && r.views != null);
  const views = cWin.reduce((s, r) => s + (r.views ?? 0), 0);
  const comments = cWin.reduce((s, r) => s + (r.comments ?? 0), 0);
  const rate = views > 0 ? (comments / views) * 1000 : null;
  const bPassed = rate != null && rate >= GATE_LINES.commentsPer1k;

  const second = mature.filter(
    r => r.v3h != null && r.v3h > 0 && r.v24h! >= GATE_LINES.secondRoundMinViews && r.v24h! >= GATE_LINES.secondRoundRatio * r.v3h,
  ).length;
  const cPassed = second >= GATE_LINES.secondRoundNeeded;

  const target: GateReport['target'] = aPassed ? 'engagement' : 'views';
  const reason = aPassed
    ? `关卡 A 已连续 ${streak} 天过线，开始按互动质量判定实验。`
    : `关卡 A 还差 ${GATE_LINES.daysInARow - streak} 天（现在连续 ${streak} 天，每天需 ≥ ${GATE_LINES.minPostsPerDay} 条成熟帖且中位数 ≥ ${GATE_LINES.viewsMedian}），先按浏览量判定。`;

  return {
    asOf: now,
    A: { passed: aPassed, median7d: median(last7), streakDays: streak, daysNeeded: GATE_LINES.daysInARow, line: GATE_LINES.viewsMedian },
    B: { passed: bPassed, commentsPer1k: rate == null ? null : Number(rate.toFixed(2)), views, comments, line: GATE_LINES.commentsPer1k, windowDays: GATE_LINES.commentWindowDays },
    C: { passed: cPassed, secondRound: second, needed: GATE_LINES.secondRoundNeeded },
    target,
    reason,
  };
}

/**
 * What the experiments should be judged by.
 *
 * An explicit operator choice (`targetMetric` set from the panel) wins; `auto` follows the gates.
 * `money` is only ever an operator choice, because it depends on figures only the operator has.
 */
export function effectiveTarget(settings: Settings, gates: GateReport): 'views' | 'engagement' | 'money' {
  if (settings.targetMode === 'manual') return settings.targetMetric;
  return gates.target;
}

export interface BreakerState {
  tripped: boolean;
  /** Median of the most recent `window` posts' best view reading, or null when too few. */
  median: number | null;
  n: number;
  floor: number;
  window: number;
}

/**
 * Has the account been publishing into a void?
 *
 * Uses each post's best available reading so a post that is only 4 hours old still counts: the
 * point is to stop a run of failures early, and a post that has had 4 hours has had most of the
 * views it will ever get (the curve is flat after the first hour).
 */
export function breaker(store: Store, since: number, now = Date.now(), floor = breakerFloor(store, since)): BreakerState {
  const recent = rows(store, Math.max(since, now - 30 * DAY))
    .filter(r => now - r.published_at >= 4 * 3600_000)
    .slice(-BREAKER.window);
  const reading = recent.map(r => r.v24h ?? r.views ?? 0);
  const m = recent.length >= BREAKER.window ? median(reading) : null;
  return { tripped: m != null && m < floor, median: m, n: recent.length, floor, window: BREAKER.window };
}

export interface BreakerStatus extends BreakerState {
  /** Only posts published after this moment count, so history from before a change is not held against it. */
  since: number;
  /** Set when it tripped; stays set until the operator resets it. */
  trippedAt: number | null;
  enabled: boolean;
}

interface StoredBreaker {
  since: number;
  trippedAt: number | null;
}

/**
 * Evaluate the breaker and latch it.
 *
 * The plan's floor (150) is above today's baseline (about 104), so counting history would trip it
 * on the first look and block the very change meant to fix the content. The window therefore
 * starts at `since`, which is set the first time the breaker is evaluated and again on every
 * reset. Once tripped it holds until the operator resets it, posts made since read back above the
 * floor, or the cool-off passes — a latch with no one watching it had no way back at all.
 */
export function evaluateBreaker(store: Store, settings: Settings, now = Date.now()): BreakerStatus {
  let st = store.getSetting<StoredBreaker | null>('breaker', null);
  if (!st) {
    st = { since: now, trippedAt: null };
    store.setSetting('breaker', st);
  }
  const live = breaker(store, st.since, now);
  if (!st.trippedAt && settings.breakerEnabled && live.tripped) {
    st = { ...st, trippedAt: now };
    store.setSetting('breaker', st);
    store.log('breaker_trip', { median: live.median, n: live.n, floor: live.floor });
  } else if (st.trippedAt && settings.breakerEnabled) {
    // Two ways out without an operator: posts made since the trip (by hand) read back healthy, or
    // the cool-off ran out — a latch nobody is watching otherwise stops the account for good.
    const after = rows(store, st.trippedAt).filter(r => now - r.published_at >= 4 * 3600_000);
    const m = after.length >= BREAKER.recoverWindow ? median(after.map(r => r.v24h ?? r.views ?? 0)) : null;
    const why = m != null && m >= live.floor ? 'recovered' : now - st.trippedAt >= BREAKER.coolOffMs ? 'cool_off' : null;
    if (why) {
      resetBreaker(store, now);
      store.log('breaker_auto_reset', { why, median: m, n: after.length, floor: live.floor });
      const fresh = breaker(store, now, now);
      return { ...fresh, tripped: false, since: now, trippedAt: null, enabled: settings.breakerEnabled };
    }
  }
  return { ...live, tripped: Boolean(st.trippedAt) && settings.breakerEnabled, since: st.since, trippedAt: st.trippedAt, enabled: settings.breakerEnabled };
}

/**
 * Operator-only. Starts a fresh window and pushes the evaluation date of any in-flight parameter
 * change out by the time it spent frozen, so a pause does not eat its measurement window.
 */
export function resetBreaker(store: Store, now = Date.now()): { frozenMs: number; shifted: number } {
  const st = store.getSetting<StoredBreaker | null>('breaker', null);
  const frozenMs = st?.trippedAt ? Math.max(0, now - st.trippedAt) : 0;
  let shifted = 0;
  if (frozenMs > 0) {
    shifted = store.db.prepare("UPDATE param_changes SET evaluate_at = evaluate_at + ? WHERE status = 'applied'").run(frozenMs).changes;
  }
  store.setSetting('breaker', { since: now, trippedAt: null });
  store.log('breaker_reset', { frozenMs, shifted });
  return { frozenMs, shifted };
}

/** The target experiments are judged by right now, after the operator's mode and the gates. */
export function currentTarget(store: Store, settings: Settings, now = Date.now()): 'views' | 'engagement' | 'money' {
  return effectiveTarget(settings, gateReport(store, now));
}
