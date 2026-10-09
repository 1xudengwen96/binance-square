import type { Store } from '../db/index.ts';
import { CHECK_OFFSETS_MS } from '../stats/backfill.ts';

export interface Distribution {
  post_id: number;
  first_read: number | null;
  v1h: number | null;
  v3h: number | null;
  v8h: number | null;
  v24h: number | null;
  /** Views at the 1-hour mark divided by the 20-minute mark. ~1 means it stopped being pushed. */
  growth_1h: number | null;
  /** How much of the day's traffic arrived after the first hour. High = the engine, not the followers. */
  late_share: number | null;
  surfaced: number;
  board_kind: string | null;
  hours_to_board: number | null;
}

const idxOf = (minutes: number) => CHECK_OFFSETS_MS.findIndex(ms => Math.round(ms / 60_000) === minutes);

function ratio(a: number | null, b: number | null): number | null {
  if (a == null || b == null || b <= 0) return null;
  return Number((a / b).toFixed(3));
}

/**
 * Recompute the distribution facts for every post that has at least one reading.
 *
 * Cheap and idempotent: it reads rows the stats sweep already wrote. Returns how many posts were
 * refreshed, which is the number the panel shows so a stalled curve is visible.
 */
export function observeDistribution(store: Store, now = Date.now()): number {
  const posts = store.db
    .prepare("SELECT id, published_at, square_post_id FROM posts WHERE status = 'published' AND published_at IS NOT NULL")
    .all() as { id: number; published_at: number; square_post_id: string | null }[];

  let touched = 0;
  for (const p of posts) {
    const checks = store.db
      .prepare('SELECT checkpoint, views FROM post_stat_checks WHERE post_id = ? AND views IS NOT NULL').all(p.id) as { checkpoint: number; views: number }[];
    if (!checks.length) continue;
    const at = (minutes: number): number | null => {
      const i = idxOf(minutes);
      const hit = checks.find(c => c.checkpoint === i);
      return hit ? hit.views : null;
    };
    const first = at(20);
    const v1 = at(60);
    const v3 = at(180);
    const v8 = at(480);
    const v24 = at(1440);

    let surfaced = 0;
    let boardKind: string | null = null;
    let hoursToBoard: number | null = null;
    if (p.square_post_id) {
      const b = store.db
        .prepare('SELECT board, MIN(sampled_at) AS first_seen FROM square_board_samples WHERE content_id = ? GROUP BY board ORDER BY first_seen LIMIT 1')
        .get(p.square_post_id) as { board: string; first_seen: number } | undefined;
      if (b) {
        surfaced = 1;
        boardKind = b.board;
        hoursToBoard = Number(((b.first_seen - p.published_at) / 3600_000).toFixed(2));
      }
    }

    store.db
      .prepare(
        `INSERT INTO post_distribution (post_id, first_read, v1h, v3h, v8h, v24h, growth_1h, late_share, surfaced, board_kind, hours_to_board, computed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(post_id) DO UPDATE SET first_read = excluded.first_read, v1h = excluded.v1h, v3h = excluded.v3h,
           v8h = excluded.v8h, v24h = excluded.v24h, growth_1h = excluded.growth_1h, late_share = excluded.late_share,
           surfaced = excluded.surfaced, board_kind = excluded.board_kind, hours_to_board = excluded.hours_to_board,
           computed_at = excluded.computed_at`,
      )
      .run(p.id, first, v1, v3, v8, v24, ratio(v1, first), ratio(v24 !== null && v1 !== null ? v24 - v1 : null, v24), surfaced, boardKind, hoursToBoard, now);
    touched++;
  }
  return touched;
}

/** The curve, in the shape a human reads it: what it was at each checkpoint, with the gaps filled. */
export function distributionOf(store: Store, postId: number): Distribution | null {
  return (store.db.prepare('SELECT * FROM post_distribution WHERE post_id = ?').get(postId) as Distribution | undefined) ?? null;
}

/** Every distribution row joined to what the post was, for scoring and for the panel. */
export function distributionRows(store: Store, days = 30): (Distribution & {
  account_id: number | null; category: string | null; sub_type: string | null; style: string | null;
  template_id: string | null; symbol: string | null; chars: number; has_chart: number; published_at: number; text: string;
  /** Apportioned from the operator's daily entry — a guess weighted by views, not a bill. */
  rebate_usd: number | null; click_credit: number | null;
  material_score: number | null;
  /** Latest counters for the post; null until the stats sweep has read it once. */
  likes: number | null; comments: number | null; shares: number | null;
})[] {
  return store.db
    .prepare(
      `SELECT d.*, p.account_id, p.published_at, p.text, LENGTH(p.text) AS chars,
              m.score AS material_score,
              cv.rebate_usd AS rebate_usd, cv.clicks AS click_credit,
              s.likes AS likes, s.comments AS comments, s.shares AS shares,
              CASE WHEN p.images_json IS NOT NULL AND p.images_json NOT IN ('', '[]') THEN 1 ELSE 0 END AS has_chart,
              m.category, m.sub_type, t.style, t.id AS template_id, m.symbol
       FROM post_distribution d JOIN posts p ON p.id = d.post_id
       LEFT JOIN materials m ON m.id = p.material_id
       LEFT JOIN templates t ON t.id = p.template_id
       LEFT JOIN post_conversion cv ON cv.post_id = d.post_id
       LEFT JOIN post_stats s ON s.post_id = d.post_id
       WHERE p.status = 'published' AND p.published_at >= ?
       ORDER BY p.published_at DESC`,
    )
    .all(Date.now() - days * 86_400_000) as never;
}
