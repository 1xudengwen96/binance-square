import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { observeDistribution } from '../src/rank/observations.ts';
import { scoreAll } from '../src/rank/score.ts';
import { planArms, recordArms } from '../src/rank/experiments.ts';
import { playbook } from '../src/rank/playbook.ts';
import { HYPOTHESES } from '../src/rank/hypotheses.ts';
import { recall, expireMemories, remember } from '../src/brain/memory.ts';
import { makeMaterial } from '../src/material/types.ts';
import { reflect } from '../src/brain/author.ts';

function tempStore(): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-rank-'));
  const store = Store.open(join(dir, 't.db'));
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A published post with a full checkpoint curve, which is the only way the engine can be probed. */
let seq = 0;
function post(store: Store, opts: { views: (number | null)[]; arms?: Record<string, string>; at: number; chart?: boolean; text?: string; heat?: number; category?: string; eng?: { likes: number; comments: number; shares: number } }): number {
  // Each fixture material must be unique: `insertMaterial` dedupes by fingerprint, and a
  // collision would silently attach the post to some other row's category and heat band.
  const symbol = `TOK${seq++}`;
  store.insertMaterial(makeMaterial({
    category: (opts.category ?? 'funding') as never, subType: 'funding_extreme', title: `${symbol} 费率极端`, symbol,
    source: 'test', at: opts.at, score: opts.heat ?? 60, facts: {},
  }));
  const row = store.db.prepare('SELECT id FROM materials WHERE symbol = ?').get(symbol) as { id: string };
  const id = store.addPost({
    materialId: row.id, templateId: null, text: opts.text ?? `$${symbol} 费率 -1.2%，年化 -70%，多头占 64.0%。不构成投资建议。`,
    status: 'published', scheduledAt: null, images: opts.chart === false ? [] : ['data/charts/x.png'],
  });
  store.db.prepare('UPDATE posts SET published_at = ?, square_post_id = ? WHERE id = ?').run(opts.at, `c${id}`, id);
  const e = opts.eng ?? { likes: 0, comments: 0, shares: 0 };
  opts.views.forEach((v, i) => {
    if (v == null) return;
    store.db.prepare('INSERT OR REPLACE INTO post_stat_checks (post_id, checkpoint, at, views, likes, comments, shares, reactions) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, i, opts.at + i * 3600_000, v, e.likes, e.comments, e.shares, 0);
    store.db.prepare('INSERT OR REPLACE INTO post_stats (post_id, checked_at, views, likes, comments, shares, reactions) VALUES (?,?,?,?,?,?,?)')
      .run(id, opts.at + i * 3600_000, v, e.likes, e.comments, e.shares, 0);
  });
  if (opts.arms) recordArms(store, id, opts.arms);
  return id;
}

test('the checkpoint curve becomes distribution facts', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.now();
    post(store, { views: [100, 250, 300, 320], at: now - 10 * 3600_000 });
    assert.equal(observeDistribution(store), 1);
    const d = store.db.prepare('SELECT * FROM post_distribution').get() as Record<string, number>;
    assert.equal(d.first_read, 100);
    assert.equal(d.v1h, 250);
    assert.equal(Number(d.growth_1h), 2.5, 'the 20m→1h ratio is the push signal');
    assert.equal(d.surfaced, 0);
  } finally {
    close();
  }
});

test('a post that stopped growing looks different from one that kept going', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.now();
    const flat = post(store, { views: [200, 202, 205, 210], at: now - 10 * 3600_000 });
    const rising = post(store, { views: [40, 240, 500, 900], at: now - 10 * 3600_000 });
    observeDistribution(store);
    const g = (id: number) => (store.db.prepare('SELECT growth_1h FROM post_distribution WHERE post_id = ?').get(id) as { growth_1h: number }).growth_1h;
    assert.ok(g(rising) / g(flat) > 4, 'shape separates them even though the flat one started bigger');
  } finally {
    close();
  }
});

test('the scorer refuses to conclude before the sample floor', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.now();
    for (let i = 0; i < 3; i++) post(store, { views: [100, 200, 300], at: now - 10 * 3600_000 - i * 1000, arms: { h_hashtag_count: i % 2 ? 'one' : 'two' } });
    observeDistribution(store);
    const v = scoreAll(store, { writeMemory: false }).find(x => x.id === 'h_hashtag_count')!;
    assert.equal(v.status, 'observing');
    assert.equal(v.confidence, 0.5);
    assert.ok(v.missing > 0, 'it says how much more it needs');
    assert.equal(store.activeMemory('rank-rule').length, 0, 'nothing is written to memory while it is guessing');
  } finally {
    close();
  }
});

test('a gap that clears every floor becomes a rule and is remembered', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.now();
    const n = HYPOTHESES.find(h => h.id === 'h_hashtag_count')!.minSamples;
    // Interleaved in time on purpose. The arms must be present in both halves of the sample, or
    // "which arm won" is just "when did you post it" — and the next test asserts exactly that.
    // Heat alternates too, so the verdict is earned across more than one stratum.
    for (let i = 0; i < n * 2; i++) {
      const arm = i % 2 ? 'two' : 'one';
      post(store, {
        views: arm === 'two' ? [500, 800, 1000] : [50, 80, 100],
        at: now - 10 * 3600_000 - i * 1000,
        arms: { h_hashtag_count: arm },
        heat: i % 4 < 2 ? 92 : 60,
      });
    }
    observeDistribution(store);
    const v = scoreAll(store, { writeMemory: true }).find(x => x.id === 'h_hashtag_count')!;
    assert.equal(v.replicated, true, 'both halves must agree');
    assert.equal(v.status, 'rule', `${v.status}: ${v.note ?? ''}`);
    assert.equal(v.stratified.winner, 'two');
    const rules = store.activeMemory('rank-rule');
    assert.equal(rules.length, 1);
    assert.match(rules[0]!.text, /主题标签/);
    assert.ok(rules[0]!.evidence_n >= 2 * n);
  } finally {
    close();
  }
});

test('an arm that only exists in one half of the sample cannot become a rule', () => {
  // The confounding this guards: the "effect" of a wording change that was only ever tried on
  // Tuesday. It looks decisive in the pooled numbers and evaporates under replication.
  const { store, close } = tempStore();
  try {
    const now = Date.now();
    const n = HYPOTHESES.find(h => h.id === 'h_hashtag_count')!.minSamples;
    for (let i = 0; i < n; i++) post(store, { views: [50, 80, 100], at: now - 20 * 3600_000 - i * 1000, arms: { h_hashtag_count: 'one' } });
    for (let i = 0; i < n; i++) post(store, { views: [500, 800, 1000], at: now - 10 * 3600_000 - i * 1000, arms: { h_hashtag_count: 'two' } });
    observeDistribution(store);
    const v = scoreAll(store, { writeMemory: true }).find(x => x.id === 'h_hashtag_count')!;
    assert.notEqual(v.status, 'rule', 'pooled medians differ hugely here, and it still means nothing');
    assert.equal(v.replicated, null);
    assert.equal(store.activeMemory('rank-rule').length, 0);
  } finally {
    close();
  }
});

test('a gap that is really the coin\'s heat disappears once strata hold heat constant', () => {
  // Same shape, opposite cause: both arms appear in both halves, but one arm happens to have
  // drawn the hot coins. Stratifying by (category × heat band) is what separates the two.
  const { store, close } = tempStore();
  try {
    const now = Date.now();
    for (let i = 0; i < 4; i++) post(store, { views: [900, 900, 900], at: now - 10 * 3600_000 - i * 1000, arms: { h_hashtag_count: 'two' }, heat: 92 });
    for (let i = 0; i < 4; i++) post(store, { views: [90, 90, 90], at: now - 10 * 3600_000 - (i + 4) * 1000, arms: { h_hashtag_count: 'one' }, heat: 20 });
    observeDistribution(store);
    const v = scoreAll(store, { writeMemory: false }).find(x => x.id === 'h_hashtag_count')!;
    assert.ok(v.effect > 0.5, `the pooled comparison should look dramatic, got ${v.effect}`);
    assert.equal(v.stratified.strata, 0, 'no stratum contains both arms, so there is nothing to compare');
    assert.notEqual(v.status, 'rule');
  } finally {
    close();
  }
});

test('an observed hypothesis can lean but never rule', () => {
  // Caught on the first live run: the pooled comparison said "posting late at night gets 2× the
  // views", which was really "the posts that went out at midnight happened to be about hot coins
  // on a busy night". Observed arms are chosen by history, not randomized, so no amount of
  // apparent effect makes one a rule.
  const { store, close } = tempStore();
  try {
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      // Two categories, so the stratifier has more than one slice to work with.
      post(store, { views: [400, 600, 800], at: now - 26 * 3600_000 - i * 1000, category: i % 2 ? 'funding' : 'onchain', heat: 70 });
      post(store, { views: [40, 60, 80], at: now - 12 * 3600_000 - i * 1000, category: i % 2 ? 'funding' : 'onchain', heat: 70 });
    }
    observeDistribution(store);
    const v = scoreAll(store, { writeMemory: true }).find(x => x.id === 'h_hour_band')!;
    assert.equal(v.mode, 'observed');
    assert.notEqual(v.status, 'rule', 'an observed difference must never be promoted');
    assert.equal(store.activeMemory('rank-rule').filter(m => m.key === 'rank:h_hour_band').length, 0);
  } finally {
    close();
  }
});

test('a single lucky stratum cannot decide a rule', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.now();
    const n = HYPOTHESES.find(h => h.id === 'h_chart')!.minSamples;
    // Both arms, every arm above its floor, but all inside one identical stratum.
    for (let i = 0; i < n; i++) post(store, { views: [900, 900, 900], at: now - 10 * 3600_000 - i * 1000, arms: { h_chart: 'chart' }, heat: 70 });
    for (let i = 0; i < n; i++) post(store, { views: [90, 90, 90], at: now - 10 * 3600_000 - (i + n) * 1000, arms: { h_chart: 'text' }, heat: 70 });
    observeDistribution(store);
    const v = scoreAll(store, { writeMemory: true }).find(x => x.id === 'h_chart')!;
    assert.equal(v.stratified.strata, 1, 'one slice');
    assert.notEqual(v.status, 'rule');
    assert.match(v.note ?? '', /一层定输赢/);
  } finally {
    close();
  }
});

test('a reversed measurement retires the old rule instead of deleting it', () => {
  const { store, close } = tempStore();
  try {
    remember(store, { kind: 'rank-rule', key: 'rank:h_chart', text: '带自绘 K 线图的帖子比纯文字拿到更多分发 —— 成立：chart 更好。', source: 'rank-score', confidence: 0.8, evidenceN: 10 });
    remember(store, { kind: 'rank-rule', key: 'rank:h_chart', text: '带自绘 K 线图的帖子比纯文字拿到更多分发 —— 测过了，差别不大：两边一样。', source: 'rank-score', confidence: 0.6, evidenceN: 24 });
    const active = store.activeMemory('rank-rule');
    assert.equal(active.length, 1);
    assert.match(active[0]!.text, /差别不大/);
    // 「我们曾经以为」 has to survive, or the system re-learns the same lesson every week.
    const history = store.db.prepare("SELECT status, text FROM brain_memory WHERE key = 'rank:h_chart' ORDER BY id").all() as { status: string; text: string }[];
    assert.equal(history.length, 2);
    assert.equal(history[0]!.status, 'superseded');
    assert.ok(history[0]!.text.includes('成立'));
  } finally {
    close();
  }
});

test('arm assignment is reproducible and exploits a rule once it exists', () => {
  const { store, close } = tempStore();
  try {
    const verdicts = [{
      id: 'h_hashtag_count', claim: 'x', metric: 'views24h' as const, mode: 'experiment' as const,
      how: '', risk: '', arms: [{ arm: 'one', n: 9, median: 100, best: 120 }, { arm: 'two', n: 9, median: 900, best: 1000 }],
      winner: 'two', loser: 'one', effect: 0.9, confidence: 0.9, status: 'rule' as const, action: null, missing: 0,
      stratified: { gap: 800, rel: 0.9, strata: 3, dropped: 0, winner: 'two' }, replicated: true, note: null,
    }];
    const a = planArms({ seed: 12345, verdicts });
    const b = planArms({ seed: 12345, verdicts });
    assert.deepEqual(a, b, 'the same draft must get the same arm, or a preview is a lie');
    const many = Array.from({ length: 60 }, (_, i) => planArms({ seed: i * 7919, verdicts }).h_hashtag_count!);
    assert.ok(many.filter(x => x === 'two').length > many.length / 2, 'mostly exploit the winner');
    assert.ok(many.some(x => x !== 'two'), 'but never stops re-checking — an algorithm that changed must be noticed');
    void store;
  } finally {
    close();
  }
});

test('the playbook behaves like an editor before it has evidence, and the arm outranks it after', () => {
  const { store, close } = tempStore();
  try {
    const empty = playbook(store, { verdicts: [] });
    assert.equal(empty.hashtagTotal, 2);
    assert.equal(empty.attachChart, true, 'no evidence yet means keep the chart, not coin-flip it away');
    assert.deepEqual(empty.acting, [], 'it does not claim to be following rules it has not earned');

    const pb = playbook(store, { verdicts: [], arms: { h_hashtag_count: 'three', h_chart: 'text' } });
    assert.equal(pb.hashtagTotal, 3);
    assert.equal(pb.attachChart, false, 'this post is the one assigned to the no-chart arm');
    assert.ok(pb.acting.some(a => a.source === 'experiment'));
  } finally {
    close();
  }
});

test('recall ranks by what applies, and expiry is real', () => {
  const { store, close } = tempStore();
  try {
    remember(store, { kind: 'rank-rule', key: 'rank:h_hashtag_count', text: '主题标签两个比一个好', source: 'rank-score', confidence: 0.8, evidenceN: 20 });
    remember(store, { kind: 'audience-fact', key: 'aud:hours', text: '晚上十点以后几乎没有新读者进场', source: 'rank-score', confidence: 0.6 });
    const hit = recall(store, { about: '资金费率 · 主题标签 数量' });
    assert.equal(hit[0]!.key, 'rank:h_hashtag_count', 'the memory that speaks to this post comes first');
    const used = store.db.prepare("SELECT use_count FROM brain_memory WHERE key = 'rank:h_hashtag_count'").get() as { use_count: number };
    assert.ok(used.use_count >= 1, 'reading a memory is recorded, so useless beliefs can be noticed');
    assert.equal(recall(store, { kinds: ['rank-rule'] }).length, 1);

    remember(store, { kind: 'engine-model', key: 'brain:next:0', text: '试试把币种放在第二句', source: 'brain', ttlMinutes: 1 });
    assert.ok(recall(store, { kinds: ['engine-model'] }).length === 1);
    assert.equal(expireMemories(store, Date.now() + 60_001), 1);
    assert.equal(recall(store, { kinds: ['engine-model'] }).length, 0);
  } finally {
    close();
  }
});

test('reflection works with no brain configured and says so', async () => {
  const { store, close } = tempStore();
  try {
    const r = await reflect(store, null, {});
    assert.ok(r.notes.some(n => n.includes('未启用 AI 大脑')));
    assert.ok(Array.isArray(r.stored));
  } finally {
    close();
  }
});

test('posts younger than the maturity floor cannot vote in any comparison', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.now();
    for (let i = 0; i < 10; i++) post(store, { views: [900, null, null], at: now - 10 * 60_000, arms: { h_hashtag_count: 'one' } });
    for (let i = 0; i < 10; i++) post(store, { views: [10, null, null], at: now - 10 * 60_000, arms: { h_hashtag_count: 'two' } });
    observeDistribution(store);
    const v = scoreAll(store, { writeMemory: false }).find(x => x.id === 'h_hashtag_count')!;
    assert.equal(v.status, 'observing', 'a set of 20-minute readings is not evidence about anything');
    assert.equal(v.arms.reduce((s, a) => s + a.n, 0), 0);
  } finally {
    close();
  }
});

test('reflection does not overwrite the rule scoreAll just wrote with a dumber sentence', async () => {
  // reflect() used to restate every rule/flat verdict into the same key, superseding the entry
  // that carried the stratification and replication detail. Since the daemon now reflects daily,
  // that would have degraded the ledger once a day, every day, from the richest sentence to the
  // shortest one.
  const { store, close } = tempStore();
  try {
    const now = Date.now();
    const n = HYPOTHESES.find(h => h.id === 'h_hashtag_count')!.minSamples;
    for (let i = 0; i < n * 2; i++) {
      const arm = i % 2 ? 'two' : 'one';
      post(store, {
        views: arm === 'two' ? [500, 800, 1000] : [50, 80, 100],
        at: now - 10 * 3600_000 - i * 1000,
        arms: { h_hashtag_count: arm },
        heat: i % 4 < 2 ? 92 : 60,
      });
    }
    observeDistribution(store);
    const r = await reflect(store, null, {});
    assert.ok(r.stored.includes('h_hashtag_count'), 'the verdict it acted on is still reported');
    const rules = store.activeMemory('rank-rule');
    assert.equal(rules.length, 1);
    assert.match(rules[0]!.text, /层内复现/, 'the entry must keep the evidence that earned it');
    const hist = store.db.prepare("SELECT COUNT(*) AS n FROM brain_memory WHERE key = 'rank:h_hashtag_count'").get() as { n: number };
    assert.equal(hist.n, 1, 'reflect must not supersede the row scoreAll just wrote');
  } finally {
    close();
  }
});

test('the engagement metric reads real counters, not columns that were never selected', () => {
  // h_opening is judged on engagement per thousand views. If the query behind the scorer forgets
  // to join the counters, every arm reads a median of zero and the hypothesis is retired as
  // "差别不大" — a false negative that quietly teaches the writer to stop asking questions.
  const { store, close } = tempStore();
  try {
    const now = Date.now();
    const n = HYPOTHESES.find(h => h.id === 'h_opening')!.minSamples;
    for (let i = 0; i < n * 2; i++) {
      const arm = i % 2 ? 'question' : 'statement';
      post(store, {
        views: [500, 800, 1000],
        at: now - 10 * 3600_000 - i * 1000,
        arms: { h_opening: arm },
        heat: i % 4 < 2 ? 92 : 60,
        eng: arm === 'question' ? { likes: 30, comments: 20, shares: 0 } : { likes: 2, comments: 0, shares: 0 },
      });
    }
    observeDistribution(store);
    const v = scoreAll(store, { writeMemory: false }).find(x => x.id === 'h_opening')!;
    assert.equal(v.metric, 'engagementPer1k');
    const q = v.arms.find(a => a.arm === 'question')!;
    const s = v.arms.find(a => a.arm === 'statement')!;
    assert.equal(q.n, n, 'the rows are eligible, so a zero median would mean the counters were missing');
    assert.ok((q.median ?? 0) > 40, `question arm should carry its 50 responses per 1k views, got ${q.median}`);
    assert.ok((s.median ?? 0) > 0 && (s.median ?? 0) < 5, `statement arm should read its 2 likes, got ${s.median}`);
    assert.equal(v.stratified.winner, 'question');
  } finally {
    close();
  }
});

test('a post the stats sweep has not read yet does not vote as zero engagement', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.now();
    post(store, { views: [500, 800, 1000], at: now - 10 * 3600_000, arms: { h_opening: 'question' } });
    store.db.prepare('DELETE FROM post_stats').run();
    observeDistribution(store);
    const v = scoreAll(store, { writeMemory: false }).find(x => x.id === 'h_opening')!;
    assert.equal(v.arms.find(a => a.arm === 'question')!.n, 0, 'no counters means no measurement, not a bad one');
  } finally {
    close();
  }
});
