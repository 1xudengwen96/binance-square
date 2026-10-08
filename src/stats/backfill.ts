import { Store } from '../db/index.ts';
import { fetchJson } from '../collectors/http.ts';

/**
 * Performance backfill.
 *
 * The Square OpenAPI is create-only, but the reader the web uses is open:
 * `v1/public/pgc/content/{id}` returns the live counters for any post, ours included,
 * with no auth. That is strictly better than scanning the hot/news boards and matching
 * ids — a post does not have to be surfacing anywhere to be measured, and it costs one
 * request per due post instead of eight pages per sweep.
 *
 * (Verified on the first real post: 49 views three minutes after publishing, while the
 * same post was absent from all 158 entries on the boards we used to scan.)
 */

const B = 'https://www.binance.com/bapi/composite';

/**
 * A post's view count is mostly settled early, so checking it on a fixed loop wastes
 * requests. These checkpoints follow the shape a Square post actually decays on:
 * a first read at 20 minutes, then hourly-ish, then daily.
 */
export const CHECK_OFFSETS_MS = [
  20 * 60_000,
  60 * 60_000,
  3 * 3600_000,
  8 * 3600_000,
  24 * 3600_000,
  72 * 3600_000,
];

/**
 * The checkpoint a post should be sampled at now, or -1 when there is nothing to do
 * (younger than the first checkpoint, or this checkpoint is already on record).
 *
 * Returns the *largest* due index on purpose. A post first seen 30 hours after it went
 * out cannot have its 20-minute number recovered, and filing the 30-hour reading under
 * "20m" would invent a growth curve that was never measured. Skipping strictly below
 * the highest recorded index keeps that true even if the loop stalls for a day.
 */
export function nextCheckDue(postedAt: number, checked: number[], now = Date.now()): number {
  const highest = checked.length ? Math.max(...checked) : -1;
  for (let i = CHECK_OFFSETS_MS.length - 1; i > highest; i--) {
    if (now - postedAt >= CHECK_OFFSETS_MS[i]!) return i;
  }
  return -1;
}

interface RawVo {
  id?: string;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  totalReactionCount?: number;
}

export interface BackfillReport {
  due: number;
  read: number;
  updated: number;
  errors: string[];
}

/** Square's own post reader. Open, no auth, live counters. */
async function readPost(contentId: string): Promise<RawVo | null> {
  const res = await fetchJson<{ data?: RawVo }>(`${B}/v1/public/pgc/content/${contentId}`, { timeoutMs: 15_000, retries: 1 });
  return res?.data ?? null;
}

export async function backfillStats(store: Store): Promise<BackfillReport> {
  const report: BackfillReport = { due: 0, read: 0, updated: 0, errors: [] };

  for (const post of store.publishedWithSquareId(80)) {
    const due = nextCheckDue(post.posted_at, store.statCheckpoints(post.id));
    if (due < 0) continue;
    report.due++;
    // Drills used to write a literal 'dry-run' here; that is not an id worth fetching.
    if (!/^\d{6,}$/.test(post.square_post_id)) continue;

    let vo: RawVo | null;
    try {
      vo = await readPost(post.square_post_id);
    } catch (err) {
      report.errors.push(`${post.square_post_id}: ${String(err).slice(0, 80)}`);
      continue;
    }
    if (!vo) continue;
    report.read++;
    const sample = {
      views: Number(vo.viewCount ?? 0),
      likes: Number(vo.likeCount ?? 0),
      comments: Number(vo.commentCount ?? 0),
      shares: Number(vo.shareCount ?? 0),
      reactions: Number(vo.totalReactionCount ?? 0),
      raw: vo,
    };
    store.recordPostStats(post.id, due, sample);
    report.updated++;
  }

  store.log('backfill', report);
  return report;
}

export interface TuneReport {
  adjusted: { templateId: string; from: number; to: number; posts: number; avgViews: number }[];
  skipped: string;
}

/**
 * Nudge template weights toward what actually gets read.
 *
 * Deliberately slow and bounded: a single lucky post must not take over the feed,
 * so a template needs several measured posts before moving, and each step is capped.
 */
export function tuneTemplateWeights(store: Store, opts: { minPosts?: number; step?: number } = {}): TuneReport {
  const minPosts = opts.minPosts ?? 3;
  const step = opts.step ?? 0.15;
  const rows = store.templatePerformance();
  const measured = rows.filter(r => r.posts >= minPosts);
  if (measured.length < 2) {
    return { adjusted: [], skipped: `有足够样本的模版不足（${measured.length}/${rows.length}），至少需要 2 个` };
  }
  const overall = measured.reduce((s, r) => s + r.avg_views * r.posts, 0) / measured.reduce((s, r) => s + r.posts, 0);
  if (overall <= 0) return { adjusted: [], skipped: '平均浏览为 0，暂不调权' };

  const adjusted: TuneReport['adjusted'] = [];
  for (const r of measured) {
    const current = (store.db.prepare('SELECT weight FROM templates WHERE id = ?').get(r.template_id) as { weight: number } | undefined)?.weight;
    if (current === undefined) continue;
    const ratio = r.avg_views / overall;
    // Move a bounded fraction toward the observed ratio, then clamp.
    const target = Math.max(0.3, Math.min(3, current * (1 + Math.max(-0.5, Math.min(0.5, ratio - 1)) * (step / 0.15))));
    const next = Math.round(target * 100) / 100;
    if (Math.abs(next - current) < 0.01) continue;
    store.setTemplateWeight(r.template_id, next);
    adjusted.push({ templateId: r.template_id, from: current, to: next, posts: r.posts, avgViews: Math.round(r.avg_views) });
  }
  store.log('tune', { overall: Math.round(overall), adjusted });
  return { adjusted, skipped: '' };
}
