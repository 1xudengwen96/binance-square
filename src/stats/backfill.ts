import { Store } from '../db/index.ts';
import { fetchJson } from '../collectors/http.ts';
import { ALERT_KINDS, raise as raiseAlert } from '../alerts/bus.ts';

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
  /** Hosted URLs of the images Square actually kept. Empty when an upload was dropped. */
  imageList?: string[];
  /** Articles only. On a post the text sits in `content`; on an article `content` is empty. */
  bodyTextOnly?: string;
  /** Articles only — a post cannot be subscribed to, an article can. */
  subscribeCount?: number;
  // 旗标三件套（P0-3）。平台不给键时保持 undefined —— 一等列写 NULL，绝不默认成「没被旗标」。
  isCreatedByAI?: boolean | number;
  factCheckStatus?: string | number;
  blockType?: string | number;
  rejectReason?: string;
}

/**
 * missing ≠ pass: the envelope carries an explicit null only where the platform actually
 * answered. An absent key must stay null in the column — 「读不到」 is not 「没事」, the same
 * rule the subscribers column got in P0-1, now applied to the flags that gate auto-flow.
 */
export function platformFlags(vo: RawVo): import('../db/index.ts').PlatformFlags {
  const n = (v: unknown): number | null =>
    v === undefined || v === null ? null : typeof v === 'boolean' ? (v ? 1 : 0) : Number.isFinite(Number(v)) ? Number(v) : null;
  const s = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));
  return { createdByAi: n(vo.isCreatedByAI), factCheckStatus: s(vo.factCheckStatus), blockType: s(vo.blockType), rejectReason: s(vo.rejectReason) };
}

export interface BackfillReport {
  due: number;
  read: number;
  updated: number;
  errors: string[];
}

/** Square's own post reader. Open, no auth, live counters. */
export async function readPost(contentId: string): Promise<RawVo | null> {
  const res = await fetchJson<{ data?: RawVo }>(`${B}/v1/public/pgc/content/${contentId}`, { timeoutMs: 15_000, retries: 1 });
  return res?.data ?? null;
}

/**
 * Did the article body actually land?
 *
 * The read route puts a post's text in `content` and an article's in `bodyTextOnly`, leaving
 * `content` empty. Checking the wrong field makes a successful publish look exactly like a
 * silently-truncated one, which is the difference between "retry" and "leave it alone" — and
 * retrying a publish duplicates it. So this asserts on the field articles actually use.
 */
export async function verifyArticlePublished(contentId: string, expectedBody: string): Promise<{ ok: boolean; storedChars: number; detail: string }> {
  const vo = await readPost(contentId);
  if (!vo) return { ok: false, storedChars: 0, detail: '读不到这篇内容' };
  const stored = (vo.bodyTextOnly ?? '').trim();
  const want = expectedBody.trim();
  if (!stored) return { ok: false, storedChars: 0, detail: 'bodyTextOnly 为空，文章正文可能未写入' };
  if (stored.length < want.length) {
    return { ok: false, storedChars: stored.length, detail: `正文被截断：发出 ${want.length} 字，广场只存下 ${stored.length} 字` };
  }
  return { ok: true, storedChars: stored.length, detail: `正文完整存入 ${stored.length} 字` };
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
    const flags = platformFlags(vo);
    const sample = {
      views: Number(vo.viewCount ?? 0),
      likes: Number(vo.likeCount ?? 0),
      // commentCount missing ≠ «the platform said zero». Writing 0 here made two weeks of unread
      // counters indistinguishable from a genuine zero-comment rate, which is exactly the finding
      // the sentinel then filed. NULL keeps «read as 0» and «read nothing» apart.
      comments: vo.commentCount === undefined || vo.commentCount === null ? null : Number(vo.commentCount),
      shares: Number(vo.shareCount ?? 0),
      reactions: Number(vo.totalReactionCount ?? 0),
      flags,
      raw: vo,
    };
    store.recordPostStats(post.id, due, sample);
    report.updated++;

    // 定稿 §2 自动流转熔断：旗标非零单条即切。只有平台明确说了的非零值才算「被旗标」，
    // 键缺失走 NULL 分支，绝不升档成告警——那是把读不到当证据。
    const flagged = (flags.blockType !== null && flags.blockType !== '0' && flags.blockType !== '')
      || (flags.rejectReason !== null && flags.rejectReason !== '');
    if (flagged && !store.hasEvent('breaker_tripped', post.id)) {
      store.log('breaker_tripped', { postId: post.id, flags, note: '平台旗标非零，单条即切自动流转' });
      raiseAlert(store, {
        kind: ALERT_KINDS.breakerTripped, severity: 'breach', key: `post:${post.id}`,
        subreason: 'platform_flag', extra: { flags },
      });
    }
    // We attached a chart but Square shows none: the post ran as text under a chart label, which
    // would quietly pull the image comparison toward zero. Leave the arm alone (the assignment is
    // on record) and say so once per post, so the shortfall is countable.
    const sentImages = post.images_json && post.images_json !== '[]';
    if (sentImages && !(vo.imageList?.length) && !store.hasEvent('image_missing', post.id)) {
      store.log('image_missing', { postId: post.id, squarePostId: post.square_post_id });
    }
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
    // The weight is a function of the evidence, not of its own history. Multiplying the current
    // weight by the ratio every tick compounded the same all-time averages until four templates sat
    // at the 3.0 ceiling. Now: the weight a template's ratio earns (shrunk toward 1 when the sample
    // is thin), approached by at most `step` per run — calling this twice on the same data is a
    // no-op the second time once it has arrived.
    const shrink = r.posts / (r.posts + 10);
    const earned = Math.max(0.3, Math.min(3, 1 + (ratio - 1) * shrink));
    const target = Math.abs(earned - current) <= step ? earned : current + Math.sign(earned - current) * step;
    const next = Math.round(target * 100) / 100;
    if (Math.abs(next - current) < 0.01) continue;
    store.setTemplateWeight(r.template_id, next);
    adjusted.push({ templateId: r.template_id, from: current, to: next, posts: r.posts, avgViews: Math.round(r.avg_views) });
  }
  store.log('tune', { overall: Math.round(overall), adjusted });
  return { adjusted, skipped: '' };
}
