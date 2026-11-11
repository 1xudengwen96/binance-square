import type { Store } from '../db/index.ts';

/** All-time status counts and outcomes of the last seven days' generated short posts.
 * Count from the database, not the latest list page. Outcomes can change while a post waits.
 */
export function queueSummary(store: Store, accountId?: number, now = Date.now()) {
  const since = now - 7 * 86_400_000;
  const filter = accountId ? 'AND account_id = ?' : '';
  const args = accountId ? [accountId] : [];
  const counts = Object.fromEntries((store.db.prepare(
    `SELECT status, COUNT(*) n FROM posts WHERE created_at <= ? ${filter} GROUP BY status`,
  ).all(now, ...args) as { status: string; n: number }[]).map(r => [r.status, r.n]));
  const recent = { total: 0, published: 0, expired: 0, duplicate: 0, marketChanged: 0, compliance: 0, otherRejected: 0, failed: 0, uncertain: 0, pending: 0, other: 0 };
  const rows = store.db.prepare(
    `SELECT status, error, COUNT(*) n FROM posts WHERE created_at >= ? AND created_at <= ? ${filter} GROUP BY status, error`,
  ).all(since, now, ...args) as { status: string; error: string | null; n: number }[];
  for (const r of rows) {
    recent.total += r.n;
    if (r.status === 'draft' || r.status === 'approved') recent.pending += r.n;
    else if (r.status === 'rejected') {
      const e = r.error ?? '';
      if (/素材过期|对账草稿超过一天/.test(e)) recent.expired += r.n;
      else if (/重复|近期文案句式相同/.test(e)) recent.duplicate += r.n;
      else if (e.startsWith('发布前复核：')) recent.marketChanged += r.n;
      else if (e.startsWith('发布前合规检查拦下：')) recent.compliance += r.n;
      else recent.otherRejected += r.n;
    } else if (r.status === 'published' || r.status === 'failed' || r.status === 'uncertain') recent[r.status] += r.n;
    else recent.other += r.n;
  }
  return { since, until: now, counts, recent };
}
