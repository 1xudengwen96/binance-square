import type { Store } from '../db/index.ts';

/**
 * Turning a daily rebate figure into a per-post number.
 *
 * Binance will not tell us which post a click came from, and no public endpoint returns clicks at
 * all — the operator reads the dashboard once a day and types in the totals. What this does is
 * apportion each day's total across the posts that were live that day, weighted by the views each
 * one had accumulated by then.
 *
 * That is a defensible guess and it is not an accounting statement. It assumes views cause money
 * proportionally, which is exactly the hypothesis the rest of the system is trying to test, so a
 * money-based verdict is only as trustworthy as that assumption. The panel labels every number
 * that comes out of here as an apportionment.
 */

const DAY = 86_400_000;
const BJ = 8 * 3600_000;
const dayKey = (ms: number) => new Date(ms + BJ).toISOString().slice(0, 10);

/** How far back a day's earnings are allowed to reach. Longer windows smear credit over more posts. */
export const ATTRIBUTION_WINDOW_HOURS = 36;

/**
 * A post needs this many views before it can carry any of the day's money.
 *
 * Without a floor, a post that two people saw can absorb a tenth of the day's rebate, and the
 * per-thousand figure it feeds into the experiment becomes a division artifact rather than a
 * measurement. The remainder stays unattributed and is reported as such.
 */
export const MIN_VIEWS_FOR_CREDIT = 20;

export interface AttributionResult {
  days: number;
  posts: number;
  totalRebate: number;
  unattributed: number;
}

export function attributeConversions(store: Store, opts: { days?: number; windowHours?: number; now?: number } = {}): AttributionResult {
  const days = opts.days ?? 30;
  const windowMs = (opts.windowHours ?? ATTRIBUTION_WINDOW_HOURS) * 3600_000;
  const now = opts.now ?? Date.now();
  const since = now - days * DAY;

  store.db.prepare('DELETE FROM post_conversion WHERE attributed_at < ?').run(now - days * DAY);
  const rows = store.db
    .prepare('SELECT day, clicks, followers, rebate_usd FROM conversion_daily WHERE day >= ? ORDER BY day')
    .all(dayKey(since)) as { day: string; clicks: number | null; followers: number | null; rebate_usd: number | null }[];
  if (!rows.length) return { days: 0, posts: 0, totalRebate: 0, unattributed: 0 };

  const posts = store.db
    .prepare('SELECT id, published_at FROM posts WHERE status = \'published\' AND published_at >= ?')
    .all(since - windowMs) as { id: number; published_at: number }[];
  const checks = store.db
    .prepare(
      `SELECT c.post_id, c.at, c.views FROM post_stat_checks c JOIN posts p ON p.id = c.post_id
       WHERE c.views IS NOT NULL AND p.status = 'published' AND p.published_at >= ?`,
    )
    .all(since - windowMs) as { post_id: number; at: number; views: number }[];
  const byPost = new Map<number, { at: number; views: number }[]>();
  for (const c of checks) (byPost.get(c.post_id) ?? byPost.set(c.post_id, []).get(c.post_id)!).push(c);
  for (const list of byPost.values()) list.sort((a, b) => a.at - b.at);

  const credit = new Map<number, { rebate: number; clicks: number }>();
  let unattributed = 0;

  for (const r of rows) {
    // The reading covers the day it was taken, so attribute against the end of that day.
    const at = Date.parse(`${r.day}T23:59:59+08:00`);
    const rebate = r.rebate_usd ?? 0;
    const clicks = r.clicks ?? 0;
    if (!rebate && !clicks) continue;

    const live = posts
      .map(p => {
        const seen = (byPost.get(p.id) ?? []).filter(c => c.at <= at).pop();
        return { id: p.id, views: seen?.views ?? 0, eligible: at - p.published_at <= windowMs && at >= p.published_at };
      })
      .filter(p => p.eligible && p.views >= MIN_VIEWS_FOR_CREDIT);
    const total = live.reduce((s, p) => s + p.views, 0);
    if (!total) {
      unattributed += rebate;
      continue;
    }
    for (const p of live) {
      const share = p.views / total;
      const e = credit.get(p.id) ?? { rebate: 0, clicks: 0 };
      e.rebate += rebate * share;
      e.clicks += clicks * share;
      credit.set(p.id, e);
    }
  }

  const ins = store.db.prepare(
    `INSERT INTO post_conversion (post_id, rebate_usd, clicks, attributed_at) VALUES (?,?,?,?)
     ON CONFLICT(post_id) DO UPDATE SET rebate_usd = excluded.rebate_usd, clicks = excluded.clicks, attributed_at = excluded.attributed_at`,
  );
  for (const [id, e] of credit) ins.run(id, Number(e.rebate.toFixed(4)), Number(e.clicks.toFixed(2)), now);
  const totalRebate = rows.reduce((s, r) => s + (r.rebate_usd ?? 0), 0);
  return { days: rows.length, posts: credit.size, totalRebate, unattributed: Number(unattributed.toFixed(2)) };
}
