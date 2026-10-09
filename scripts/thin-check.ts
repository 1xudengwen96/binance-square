/**
 * Does the thin-content gate starve a category?
 *
 * A floor that blocks one bad template is a fix; a floor that silences six categories is a
 * wrecking ball that will be quietly lowered later. This runs the real generator over the real
 * material backlog in a throwaway copy of the database and reports, per category, how many
 * drafts survive and what stopped the rest.
 *
 * Run: npx tsx scripts/thin-check.ts
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { generate } from '../src/pipeline.ts';
import { settingsFrom } from '../src/schedule.ts';

const dir = mkdtempSync(join(tmpdir(), 'sf-thin-'));
const file = join(dir, 'check.db');
copyFileSync('data/squareforge.db', file);
const store = Store.open(file);

try {
  // Empty the queue so the day's capacity guard doesn't stop generation before the gate does.
  store.db.prepare("DELETE FROM posts WHERE status IN ('draft','approved')").run();
  const settings = { ...settingsFrom(store), autoPublish: true, dailyCap: 200, postsPerDay: 60 };
  const mats = store.db.prepare('SELECT category, COUNT(*) n FROM materials WHERE used_count = 0 AND discarded = 0 GROUP BY 1 ORDER BY 1').all() as { category: string; n: number }[];
  console.log('unused materials by category:', mats.map(m => `${m.category}=${m.n}`).join(' '));

  const r = await generate(store, settings, 60);
  const byCat = new Map<string, { ok: number; thin: number; other: number }>();
  for (const c of r.created) {
    const cat = (store.db.prepare('SELECT m.category FROM posts p JOIN materials m ON m.id = p.material_id WHERE p.id = ?').get(c.id) as { category: string } | undefined)?.category ?? '?';
    const e = byCat.get(cat) ?? { ok: 0, thin: 0, other: 0 };
    e.ok++;
    byCat.set(cat, e);
  }
  for (const s of r.skipped) {
    const cat = s.split(' ')[0]?.split(':')[0] ?? '?';
    const e = byCat.get(cat) ?? { ok: 0, thin: 0, other: 0 };
    if (s.includes('信息量不足')) e.thin++;
    else e.other++;
    byCat.set(cat, e);
  }
  console.log(`\n生成 ${r.created.length} 条，跳过 ${r.skipped.length} 条\n`);
  console.log('格子                     通过  被信息量闸门挡住  其他原因');
  for (const [cat, e] of [...byCat.entries()].sort((a, b) => b[1].ok - a[1].ok)) {
    console.log(`  ${cat.padEnd(22)} ${String(e.ok).padStart(4)} ${String(e.thin).padStart(10)} ${String(e.other).padStart(12)}`);
  }
  const thin = r.skipped.filter(s => s.includes('信息量不足'));
  if (thin.length) {
    console.log('\n被挡下的原文（这就是不该发的东西）：');
    for (const t of thin.slice(0, 8)) console.log('  ·', t.slice(0, 150));
  }
  const arms = store.db.prepare('SELECT experiment, arm, COUNT(*) n FROM post_arms GROUP BY 1,2 ORDER BY 1,2').all() as { experiment: string; arm: string; n: number }[];
  console.log('\n实验臂分配：', arms.map(a => `${a.experiment.replace('h_', '')}:${a.arm}=${a.n}`).join(' '));
  const tags = store.db.prepare("SELECT text FROM posts WHERE status = 'approved'").all() as { text: string }[];
  const counts = new Map<number, number>();
  for (const t of tags) {
    const n = (t.text.match(/#[^\s#]+/g) ?? []).length;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  console.log('每条帖子的标签数分布：', JSON.stringify([...counts.entries()].sort()));
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
