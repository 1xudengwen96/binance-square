/**
 * Posting cadence and outcome report — what actually went out, when, and what it earned.
 *
 * Read from the live tables, so it reports what the system did rather than what the
 * settings say it should do. The gap between those two is where the interesting problems
 * live (and is exactly where the same-minute burst was found).
 *
 * Run: npx tsx scripts/cadence.ts
 */
import { Store } from '../src/db/index.ts';
import { settingsFrom } from '../src/schedule.ts';

const store = Store.open(process.env.DB_PATH ?? './data/squareforge.db');
const s = settingsFrom(store);
const bj = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(5, 16).replace('T', ' ');
const hour = (ms: number) => String(new Date(ms + 8 * 3600_000).getUTCHours()).padStart(2, '0');

interface Row { id: number; published_at: number; kind: string; cell: string; style: string; views: number | null; likes: number | null; comments: number | null }

const posts = store.db
  .prepare(
    `SELECT p.id, p.published_at, '短帖' AS kind, COALESCE(m.category||'/'||m.sub_type,'-') AS cell,
            COALESCE(t.style,'-') AS style, ps.views, ps.likes, ps.comments
     FROM posts p LEFT JOIN materials m ON m.id = p.material_id
     LEFT JOIN templates t ON t.id = p.template_id LEFT JOIN post_stats ps ON ps.post_id = p.id
     WHERE p.status = 'published'`,
  )
  .all() as Row[];
const articles = store.db
  .prepare(
    `SELECT id, published_at, '文章' AS kind, concept_id AS cell, '教学' AS style,
            (SELECT views FROM studio_observations o WHERE o.article_id = a.id ORDER BY checkpoint DESC LIMIT 1) AS views,
            (SELECT likes FROM studio_observations o WHERE o.article_id = a.id ORDER BY checkpoint DESC LIMIT 1) AS likes,
            (SELECT comments FROM studio_observations o WHERE o.article_id = a.id ORDER BY checkpoint DESC LIMIT 1) AS comments
     FROM studio_articles a WHERE status = 'published'`,
  )
  .all() as Row[];

const all = [...posts, ...articles].filter(r => r.published_at).sort((a, b) => a.published_at - b.published_at);
console.log(`\n共发布 ${all.length} 条（短帖 ${posts.length} · 文章 ${articles.length}）\n`);
console.log('时间(北京)          类型  格子                        风格      浏览   赞  评');
for (const r of all) {
  console.log(
    `  ${bj(r.published_at)}  ${r.kind}  ${r.cell.padEnd(26)} ${r.style.padEnd(8)} ${String(r.views ?? '—').padStart(6)} ${String(r.likes ?? 0).padStart(3)} ${String(r.comments ?? 0).padStart(3)}`,
  );
}

const gaps: number[] = [];
for (let i = 1; i < all.length; i++) gaps.push((all[i]!.published_at - all[i - 1]!.published_at) / 60_000);
const burst = gaps.filter(g => g < 1).length;
const sorted = [...gaps].sort((a, b) => a - b);
console.log('\n=== 节奏 ===');
console.log('  相邻间隔(分钟):', gaps.map(g => g.toFixed(0)).join(', ') || '—');
console.log(`  同一分钟连发 ${burst} 次  ← 设置要求间隔 ${s.minIntervalMinutes} 分钟，应为 0`);
if (sorted.length) console.log(`  中位间隔 ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} 分钟 | 最小 ${sorted[0]!.toFixed(0)} 分钟`);

const byHour = new Map<string, number>();
for (const r of all) byHour.set(`${hour(r.published_at)}:00`, (byHour.get(`${hour(r.published_at)}:00`) ?? 0) + 1);
console.log('\n=== 按小时分布 ===');
for (const k of [...byHour.keys()].sort()) console.log(`   ${k} → ${'█'.repeat(byHour.get(k)!)} ${byHour.get(k)}`);

const byCell = new Map<string, Row[]>();
for (const r of all) (byCell.get(r.cell) ?? byCell.set(r.cell, []).get(r.cell)!).push(r);
console.log('\n=== 按格子（哪类内容真的有人看）===');
for (const [cell, rows] of [...byCell].sort((a, b) => b[1].length - a[1].length)) {
  const v = rows.map(r => r.views ?? 0).sort((a, b) => a - b);
  const med = v[Math.floor(v.length / 2)] ?? 0;
  console.log(`   ${cell.padEnd(28)} ${String(rows.length).padStart(2)} 篇 | 中位浏览 ${String(med).padStart(5)} | 最高 ${String(v[v.length - 1] ?? 0).padStart(5)}`);
}
const byStyle = new Map<string, number[]>();
for (const r of all) (byStyle.get(r.style) ?? byStyle.set(r.style, []).get(r.style)!).push(r.views ?? 0);
console.log('\n=== 按风格 ===');
for (const [style, v] of [...byStyle].sort((a, b) => b[1].length - a[1].length)) {
  const s2 = [...v].sort((x, y) => x - y);
  console.log(`   ${style.padEnd(10)} ${String(v.length).padStart(2)} 篇 | 中位 ${String(s2[Math.floor(s2.length / 2)] ?? 0).padStart(5)}`);
}
const eng = all.reduce((a, r) => a + (r.likes ?? 0) + (r.comments ?? 0), 0);
const views = all.reduce((a, r) => a + (r.views ?? 0), 0);
console.log('\n=== 互动 ===');
console.log(`   累计 ${views} 浏览，赞+评合计 ${eng}。`);
console.log('   广场热榜中位约 3 万浏览、快讯流中位约 250 —— 参照系是"能不能被推出去"，不是措辞。');
const queued = store.db.prepare("SELECT COUNT(*) n FROM posts WHERE status='approved'").get() as { n: number };
console.log(`\n=== 队列 ===\n   待发布 approved ${queued.n} 条 | 时段 ${s.activeStartHour}-${s.activeEndHour}、间隔 ${s.minIntervalMinutes} 分钟 → 上限约 ${Math.floor((s.activeEndHour - s.activeStartHour) * 60 / s.minIntervalMinutes)} 篇/天`);
