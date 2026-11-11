import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db/index.ts';
import { reflect } from '../src/brain/author.ts';
import { buildSnapshot } from '../src/brain/snapshot.ts';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import { METRIC_DEFINITIONS } from '../src/rank/metrics.ts';
import type { Brain } from '../src/brain/brain.ts';

test('reflection labels the actual metric, its units and sample, including money override', async () => {
  const store = Store.open(':memory:');
  try {
    const id = store.addPost({ materialId: null, templateId: null, text: 'metric sample', status: 'published', scheduledAt: null, images: [] });
    const at = Date.now() - 2 * 86_400_000;
    store.db.prepare('UPDATE posts SET published_at = ? WHERE id = ?').run(at, id);
    store.db.prepare('INSERT INTO post_distribution (post_id, v24h, computed_at) VALUES (?, 200, ?)').run(id, at);
    store.db.prepare("INSERT INTO post_arms (post_id, experiment, arm, assigned_at) VALUES (?, 'h_chart', 'chart', ?)").run(id, at);
    store.db.prepare('INSERT INTO post_conversion (post_id, rebate_usd, attributed_at) VALUES (?, 0.05, ?)').run(id, at);
    let context = '';
    const brain: Brain = { provider: 'test', model: 'test', async ask(task) { context = task.context; return { ok: true, text: '' }; } };
    await reflect(store, brain, { days: 7, target: 'money' });
    const chart = context.split('\n').find(l => l.startsWith('h_chart '))!;
    assert.match(chart, /实际判定指标：rebatePer1k/);
    assert.match(chart, /USDT\/千次浏览/);
    assert.match(chart, /chart: median=0\.25, n=1/);
    assert.match(chart, /text: median=—, n=0/);
    assert.match(context, /最近 7 天/);
    assert.match(context, /满 24 小时/);
    assert.match(context, /缺读数不计为 0/);
    assert.match(context, /h_chart: .*登记指标：views24h/);
  } finally { store.close(); }
});

test('weekly snapshot attaches matching definitions to every metric and distinguishes latest counters', () => {
  const store = Store.open(':memory:');
  try {
    const snap = buildSnapshot(store, DEFAULT_SETTINGS);
    for (const h of snap.hypotheses) {
      assert.deepEqual(h.metricDefinition, METRIC_DEFINITIONS[h.metric as keyof typeof METRIC_DEFINITIONS]);
    }
    assert.match(METRIC_DEFINITIONS.qualityPer1k.formula, /3 × 最新评论数 \+ 4 × 最新分享数/);
    assert.match(METRIC_DEFINITIONS.engagementPer1k.formula, /最新点赞数/);
    assert.match(METRIC_DEFINITIONS.growth1h.formula, /1h 浏览数 ÷ 20 分钟浏览数/);
    assert.ok(snap.definitions.some(d => d.includes('未必与 24h 分母同龄')));
  } finally { store.close(); }
});
