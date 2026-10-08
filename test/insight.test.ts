import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type BoardSample } from '../src/db/index.ts';
import { MIN_CORPUS, MIN_SAMPLE, analyze } from '../src/stats/insight.ts';

const DAY = 86_400_000;

function tempStore(): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-insight-'));
  const file = join(dir, 't.db');
  const store = Store.open(file);
  return { store, close: () => { store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/**
 * Seed one published post with a known outcome. Everything the analysis attributes on goes
 * through a real join, so the fixtures have to look like the pipeline's own output.
 */
function seedPost(
  store: Store,
  o: {
    category: string;
    subType?: string;
    style?: string;
    templateId?: string;
    templateName?: string;
    symbol?: string;
    text?: string;
    images?: string[];
    views?: number | null;
    likes?: number;
    comments?: number;
    shares?: number;
    ageHours?: number;
    hour?: number;
    squarePostId?: string;
  },
): number {
  const now = Date.now();
  const materialId = `mat:${o.category}:${now}:${Math.random().toString(36).slice(2, 8)}`;
  store.insertMaterial({
    id: materialId,
    category: o.category as never,
    subType: o.subType ?? 'generic',
    title: 't',
    symbol: o.symbol ?? null,
    symbols: o.symbol ? [o.symbol] : [],
    sentiment: 'neutral',
    score: 60,
    source: 'test',
    at: now,
    collectedAt: now,
    facts: {},
    fingerprint: `fp:${materialId}`,
  });

  const tpl = o.templateId ?? `tpl.${o.category}`;
  if (o.templateId) {
    store.db
      .prepare('INSERT OR REPLACE INTO templates (id, name, category, sub_type, style, body, requires_json, weight, enabled, source) VALUES (?,?,?,?,?,?,?,?,1,?)')
      .run(tpl, o.templateName ?? tpl, o.category, o.subType ?? 'generic', o.style ?? 'any', 'x', '[]', 1, 'seed');
  }

  const publishedAt = now - (o.ageHours ?? 3) * 3_600_000;
  const id = store.addPost({
    materialId,
    templateId: tpl,
    text: o.text ?? '一条测试帖子'.repeat(20),
    status: 'published',
    scheduledAt: null,
    images: o.images ?? [],
  });
  store.db
    .prepare('UPDATE posts SET published_at = ?, square_post_id = ? WHERE id = ?')
    .run(new Date(publishedAt).setHours(o.hour ?? 10, 0, 0, 0), o.squarePostId ?? `9${id}0000`, id);

  if (o.views !== undefined && o.views !== null) {
    store.recordPostStats(id, 0, {
      views: o.views,
      likes: o.likes ?? 0,
      comments: o.comments ?? 0,
      shares: o.shares ?? 0,
      reactions: 0,
    });
  }
  return id;
}

/** Enough identical posts to cross MIN_SAMPLE in one group. */
function seedMany(store: Store, category: string, views: number[], extra: Record<string, unknown> = {}): void {
  views.forEach((v, i) => seedPost(store, { category, symbol: `C${i}`, views: v, ...extra }));
}

function boardRow(over: Partial<BoardSample> = {}): BoardSample {
  const base = {
    content_id: '100001', board: 'trend', title: 'x', author: null, coin: null, coins_json: '[]',
    hashtags_json: '[]', card_type: 'BUZZ_SHORT', has_image: 0, lang: 'en', chars: 100,
    views: 1000, likes: 1, comments: 0, shares: 0, reactions: 1,
    posted_at: Date.now() - DAY, sampled_at: Date.now(), is_ours: 0,
  };
  return { ...base, ...over };
}

test('a group under the sample floor is shown but never ranked', () => {
  const { store, close } = tempStore();
  try {
    // Two viral announcement posts vs six mediocre market_move posts. The lucky group has the
    // higher median and must still lose the ranking, or one fluke restructures the account.
    seedPost(store, { category: 'announcement', views: 5000 });
    seedPost(store, { category: 'announcement', views: 4000 });
    seedMany(store, 'market_move', [10, 12, 9, 11, 10, 8]);

    const r = analyze(store, { days: 30 });
    const cat = r.dimensions.find(d => d.key === 'category')!;
    const announcement = cat.groups.find(g => g.label === '币安公告')!;
    const move = cat.groups.find(g => g.label === '行情异动')!;

    assert.equal(announcement.rankable, false, '2 posts must not be rankable');
    assert.equal(move.rankable, true, '6 posts must be rankable');
    assert.equal(cat.groups[0]!.label, '行情异动', 'rankable groups sort ahead of lucky small ones');
    assert.ok(!r.insights.some(i => i.kind === 'lead' && i.text.includes('币安公告')), 'no recommendation off a 2-post group');
  } finally {
    close();
  }
});

test('the median is used, so one viral post cannot carry a group', () => {
  const { store, close } = tempStore();
  try {
    seedMany(store, 'funding', [10, 10, 10, 10, 10, 9000]);
    const r = analyze(store, { days: 30 });
    const g = r.dimensions.find(d => d.key === 'category')!.groups.find(x => x.label === '资金费率')!;
    assert.equal(g.medianViews, 10, 'median ignores the outlier');
    assert.ok(g.meanViews > 1500, 'mean is kept so the reader can see the skew, not hidden');
    assert.equal(g.bestViews, 9000);
  } finally {
    close();
  }
});

test('a recommendation needs a real gap, not a 1.5x wobble', () => {
  const { store, close } = tempStore();
  try {
    seedMany(store, 'funding', [100, 110, 90, 105, 95]);
    seedMany(store, 'market_move', [60, 65, 55, 70, 58]);
    const r = analyze(store, { days: 30 });
    assert.equal(r.insights.some(i => i.kind === 'lead'), false, '1.7x across 5 posts is noise');

    // Widen it past the bar and the same code must speak up.
    seedMany(store, 'leaderboard', [600, 700, 650, 800, 720]);
    const r2 = analyze(store, { days: 30 });
    const lead = r2.insights.find(i => i.kind === 'lead');
    assert.ok(lead, 'a 10x spread should produce a direction');
    assert.match(lead!.text, /n=5/, 'every recommendation states its own sample size');
  } finally {
    close()
    ;
  }
});

test('views with zero engagement is reported as its own finding', () => {
  const { store, close } = tempStore();
  try {
    for (let i = 0; i < MIN_CORPUS; i++) seedPost(store, { category: 'newsflash', symbol: `N${i}`, views: 300 + i, likes: 0, comments: 0, shares: 0 });
    const r = analyze(store, { days: 30 });
    assert.equal(r.totals.likes, 0);
    assert.ok(r.totals.views > 1000);
    assert.ok(r.insights.some(i => i.kind === 'cut' && i.text.includes('点赞+评论+转发合计 0')), 'must name the reach/attraction split');
  } finally {
    close();
  }
});

test('engagement is measured per thousand views, not rounded to a flat zero', () => {
  const { store, close } = tempStore();
  try {
    seedMany(store, 'dex', [400, 500, 450, 480, 520], { likes: 1 });
    const g = r_group(store, 'category', 'DEX 热门');
    assert.ok(g.engagementPer1k > 0, 'a percentage would round this away; a rate per thousand keeps it');
  } finally {
    close();
  }
});

function r_group(store: Store, dim: string, label: string) {
  const r = analyze(store, { days: 30 });
  const g = r.dimensions.find(d => d.key === dim)!.groups.find(x => x.label === label);
  assert.ok(g, `${dim}/${label} missing`);
  return g!;
}

test('our own posts stay out of the comparison pool', () => {
  const { store, close } = tempStore();
  try {
    const id = seedPost(store, { category: 'market_move', views: 80, squarePostId: '555000' });
    store.upsertBoardSamples([boardRow({ content_id: '555000', views: 80, is_ours: 1 })]);
    store.upsertBoardSamples([boardRow({ content_id: '555001', views: 30000 }), boardRow({ content_id: '555002', views: 40000 }), boardRow({ content_id: '555003', views: 20000 }), boardRow({ content_id: '555004', views: 50000 })]);
    const pool = store.boardViewPool();
    assert.equal(pool.length, 4, 'the 80-view row is ours and must not deflate our own benchmark');
    assert.ok(!pool.includes(80));
    assert.ok(store.surfacedPostIds(['555000']).has('555000'), 'appearing on the board is what 上榜 means');
    assert.ok(id > 0);
  } finally {
    close();
  }
});

test('no benchmark comparison is offered when the pool is too small', () => {
  const { store, close } = tempStore();
  try {
    seedMany(store, 'funding', [10, 20, 30, 40, 50]);
    store.upsertBoardSamples([boardRow({ content_id: '700001', views: 900 }), boardRow({ content_id: '700002', views: 900 })]);
    const r = analyze(store, { days: 30 });
    assert.equal(r.benchmark.pool, 2);
    assert.ok(r.caveats.some(c => c.includes('基准样本')), 'must say the comparison is not valid yet');
    assert.ok(!r.insights.some(i => i.text.includes('热榜同类中位')));
  } finally {
    close();
  }
});

test('the waterline sentence distinguishes 上不了榜 from 写得差', () => {
  const { store, close } = tempStore();
  try {
    store.upsertBoardSamples(
      [30_000, 32_000, 28_000, 40_000, 25_000].map((v, i) => boardRow({ content_id: `8${i}`, views: v, board: 'trend' })),
    );
    store.upsertBoardSamples(
      [200, 300, 250, 180, 260].map((v, i) => boardRow({ content_id: `9${i}`, views: v, board: 'news' })),
    );

    // Below even the news stream: the gap is reach, not craft.
    seedMany(store, 'funding', [20, 30, 25, 40, 22]);
    let r = analyze(store, { days: 30 });
    const low = r.insights.find(i => i.kind === 'watch')!;
    assert.match(low.text, /连快讯流的常态水位/);
    assert.match(low.text, /能不能被推出去/);

    // Between the two bands: it clears ordinary posts but has not made the front page.
    const dir = mkdtempSync(join(tmpdir(), 'sf-insight2-'));
    const s2 = Store.open(join(dir, 't.db'));
    s2.upsertBoardSamples([
      ...[30_000, 32_000, 28_000, 40_000, 25_000].map((v, i) => boardRow({ content_id: `8${i}`, views: v, board: 'trend' })),
      ...[200, 300, 250, 180, 260].map((v, i) => boardRow({ content_id: `9${i}`, views: v, board: 'news' })),
    ]);
    seedMany(s2, 'funding', [900, 800, 850, 950, 880]);
    r = analyze(s2, { days: 30 });
    assert.match(r.insights.find(i => i.kind === 'watch')!.text, /高于快讯流的常态水位/);
    s2.db.close();
    rmSync(dir, { recursive: true, force: true });
  } finally {
    close();
  }
});

test('an unattributable post is not silently dropped from the totals', () => {
  const { store, close } = tempStore();
  try {
    // A post whose material row is gone still counts in `posts`, because it was published.
    const id = store.addPost({ materialId: null, templateId: null, text: '孤儿帖子', status: 'published', scheduledAt: null });
    store.recordPostStats(id, 0, { views: 500, likes: 0, comments: 0, shares: 0, reactions: 0 });
    store.db.prepare("UPDATE posts SET published_at = ? WHERE id = ?").run(Date.now(), id);
    const r = analyze(store, { days: 30 });
    assert.equal(r.totals.posts, 1);
    assert.equal(r.totals.measured, 1);
    assert.equal(r.totals.views, 500);
    assert.equal(r.dimensions.find(d => d.key === 'category')!.groups.length, 0, 'it cannot be grouped');
  } finally {
    close();
  }
});

test('unmeasured posts count in the corpus but not in the conclusions', () => {
  const { store, close } = tempStore();
  try {
    seedMany(store, 'stablecoin', [10, 20, 30, 40, 50]);
    for (let i = 0; i < 8; i++) seedPost(store, { category: 'stablecoin', symbol: `S${i}`, views: null });
    const r = analyze(store, { days: 30 });
    assert.equal(r.totals.posts, 13, 'all thirteen were published');
    assert.equal(r.totals.measured, 5, 'only five have a reading');
    // Measured, not published, is the denominator: 13 posts with 5 readings cannot support a
    // verdict, and treating the corpus as the sample would quietly overstate confidence.
    assert.equal(r.conclusive, false);

    seedMany(store, 'stablecoin', [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    assert.equal(analyze(store, { days: 30 }).conclusive, true, 'crossing MIN_CORPUS on measured posts flips it');
  } finally {
    close();
  }
});

test('neededForFirstRank counts how far off comparability we are', () => {
  const { store, close } = tempStore();
  try {
    seedPost(store, { category: 'dex', views: 10 });
    const r = analyze(store, { days: 30 });
    assert.equal(r.neededForFirstRank, MIN_SAMPLE - 1);
    seedMany(store, 'dex', [10, 20, 30, 40]);
    assert.equal(analyze(store, { days: 30 }).neededForFirstRank, 0);
  } finally {
    close();
  }
});
