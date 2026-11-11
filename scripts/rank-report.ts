import { Store } from '../src/db/index.ts';
import { observeDistribution } from '../src/rank/observations.ts';
import { scoreAll } from '../src/rank/score.ts';
import { recallBrief } from '../src/brain/memory.ts';
import { formatMetric, metricDescription, MEASUREMENT_SAMPLE } from '../src/rank/metrics.ts';

const s = Store.open('data/squareforge.db');
console.log('observed posts:', observeDistribution(s));
console.log('--- curve ---');
for (const r of s.db.prepare('SELECT * FROM post_distribution ORDER BY post_id').all() as any[]) {
  console.log(`#${String(r.post_id).padStart(3)} 20m=${r.first_read} 1h=${r.v1h} 3h=${r.v3h} 8h=${r.v8h} 24h=${r.v24h} 增速=${r.growth_1h} 后段占比=${r.late_share} 上榜=${r.surfaced} 到榜=${r.hours_to_board}h`);
}
console.log('--- verdicts ---');
console.log(`近 30 天；${MEASUREMENT_SAMPLE}`);
for (const v of scoreAll(s, { writeMemory: false })) {
  console.log(`[${v.status}] ${v.id} 置信=${v.confidence} 差=${v.effect} 还需=${v.missing}`);
  console.log(`     指标：${metricDescription(v.metric)}；${v.arms.map(a => `${a.arm}: median=${formatMetric(v.metric, a.median)}, n=${a.n}`).join('  ')}`);
}
console.log('--- memory after scoring ---');
scoreAll(s, { writeMemory: true });
for (const m of s.memoryLedger()) console.log(`  (${m.kind}) ${m.key}: ${m.text.slice(0, 90)} 置信=${m.confidence} n=${m.evidence_n}`);
console.log('--- a briefing for a funding post ---');
console.log(recallBrief(s, { about: '资金费率 · 费率极值 BWET 资金追踪派', max: 5 }).text || '（空）');
s.close();
