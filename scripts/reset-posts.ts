/**
 * Reset the working data so the panel shows only what is real, without touching the
 * machinery: templates, accounts, settings and the collected materials all survive.
 *
 * What gets removed is everything the tool *produced* locally and never published —
 * drafts, rejections, the bulk-approved backlog, the coin locks that referenced them, and
 * the run log. Those are the rows that make the queue look busy while meaning nothing.
 *
 * Published posts stay on purpose: they are live on Square, they are the only rows with a
 * real measurement attached, and deleting them would throw away the thing this whole
 * feature exists to observe.
 *
 * Run: npx tsx scripts/reset-posts.ts [--apply]
 */
import { Store } from '../src/db/index.ts';

const apply = process.argv.includes('--apply');
const store = Store.open(process.env.DB_PATH ?? './data/squareforge.db');

const count = (sql: string, ...args: unknown[]) => (store.db.prepare(sql).get(...args) as { c: number }).c;

const doomedPosts = count("SELECT COUNT(*) AS c FROM posts WHERE status != 'published'");
const keepPosts = count("SELECT COUNT(*) AS c FROM posts WHERE status = 'published'");
const doomedStats = count(
  "SELECT COUNT(*) AS c FROM post_stats WHERE post_id IN (SELECT id FROM posts WHERE status != 'published')",
);
const doomedChecks = count(
  "SELECT COUNT(*) AS c FROM post_stat_checks WHERE post_id IN (SELECT id FROM posts WHERE status != 'published')",
);
const events = count('SELECT COUNT(*) AS c FROM events');
const claims = count('SELECT COUNT(*) AS c FROM attention_claims');

console.log(`\n会删除：
  未发布的帖子        ${doomedPosts}
  对应统计行          ${doomedStats}
  对应检查点          ${doomedChecks}
  币种占用锁          ${claims}
  运行日志            ${events}`);
console.log(`会保留：
  已发布帖子          ${keepPosts}（真实发布，带真实读数）
  模版                ${count('SELECT COUNT(*) AS c FROM templates')}
  账号                ${count('SELECT COUNT(*) AS c FROM accounts')}
  素材                ${count('SELECT COUNT(*) AS c FROM materials')}
  广场基准样本        ${count('SELECT COUNT(*) AS c FROM square_board_samples')}
  热度采样            ${count('SELECT COUNT(*) AS c FROM attention_samples')}
  设置                ${count('SELECT COUNT(*) AS c FROM settings')}`);

if (!apply) {
  console.log('\ndry-run，没有改动。加 --apply 才会真的删。');
  process.exit(0);
}

const report = store.db.transaction(() => {
  // Children first: post_stats and post_stat_checks both hold foreign keys onto posts.
  const checks = store.db
    .prepare("DELETE FROM post_stat_checks WHERE post_id IN (SELECT id FROM posts WHERE status != 'published')")
    .run().changes;
  const stats = store.db
    .prepare("DELETE FROM post_stats WHERE post_id IN (SELECT id FROM posts WHERE status != 'published')")
    .run().changes;
  const posts = store.db.prepare("DELETE FROM posts WHERE status != 'published'").run().changes;
  // A claim whose post is gone locks a coin for nothing.
  const staleClaims = store.db
    .prepare('DELETE FROM attention_claims WHERE post_id IS NOT NULL AND post_id NOT IN (SELECT id FROM posts)')
    .run().changes;
  const evs = store.db.prepare('DELETE FROM events').run().changes;
  return { posts, stats, checks, staleClaims, evs };
})();

console.log('\n已删除：', JSON.stringify(report));
console.log('剩余帖子：', JSON.stringify(store.db.prepare('SELECT status, COUNT(*) n FROM posts GROUP BY status').all()));
console.log('模版/账号/设置仍在：', count('SELECT COUNT(*) AS c FROM templates'), count('SELECT COUNT(*) AS c FROM accounts'), count('SELECT COUNT(*) AS c FROM settings'));
