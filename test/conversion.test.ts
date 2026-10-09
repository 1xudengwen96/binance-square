import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { attributeConversions, MIN_VIEWS_FOR_CREDIT } from '../src/money/conversion.ts';
import { scoreAll } from '../src/rank/score.ts';
import { observeDistribution } from '../src/rank/observations.ts';

const BJ = 8 * 3600_000;
const dayKey = (ms: number) => new Date(ms + BJ).toISOString().slice(0, 10);

function tempStore(): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-conv-'));
  const store = Store.open(join(dir, 't.db'));
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A published post with one reading at `views`, `hoursAgo` hours before now. */
function postWithViews(store: Store, views: number, hoursAgo: number, arms?: Record<string, string>): number {
  const at = Date.now() - hoursAgo * 3600_000;
  const id = store.addPost({ materialId: null, templateId: null, text: `$TOK 多空比 2.10，多头 64.0%，费率 -1.2%。不构成投资建议。`, status: 'published', scheduledAt: null });
  store.db.prepare('UPDATE posts SET published_at = ?, square_post_id = ? WHERE id = ?').run(at, `c${id}`, id);
  store.db.prepare('INSERT INTO post_stat_checks (post_id, checkpoint, at, views, likes, comments, shares, reactions) VALUES (?,?,?,?,0,0,0,0)').run(id, 0, at + 20 * 60_000, views);
  if (arms) store.db.prepare('INSERT INTO post_arms (post_id, experiment, arm, assigned_at) VALUES (?,?,?,?)').run(id, 'h_hashtag_count', Object.values(arms)[0]!, Date.now());
  return id;
}

test('a day of rebate is split by the views each post had accumulated by then', () => {
  const { store, close } = tempStore();
  try {
    const big = postWithViews(store, 800, 6);
    const small = postWithViews(store, 200, 6);
    store.putConversion(dayKey(Date.now()), { rebateUsd: 10 });
    const r = attributeConversions(store, {});
    assert.equal(r.posts, 2);
    assert.equal(r.unattributed, 0);
    const credit = (id: number) => (store.db.prepare('SELECT rebate_usd FROM post_conversion WHERE post_id = ?').get(id) as { rebate_usd: number }).rebate_usd;
    assert.ok(Math.abs(credit(big) - 8) < 0.01, `800/1000 of 10 should be 8, got ${credit(big)}`);
    assert.ok(Math.abs(credit(small) - 2) < 0.01);
    assert.ok(credit(big) + credit(small) - 10 < 0.001, 'the whole day is accounted for');
  } finally {
    close();
  }
});

test('a post with almost no traffic cannot absorb a tenth of the day\'s money', () => {
  // Without this floor the per-thousand figure is dominated by a division on a tiny denominator,
  // and the experiment would "discover" that the arm assigned to that post is extremely profitable.
  const { store, close } = tempStore();
  try {
    const tiny = postWithViews(store, 3, 6);
    const real = postWithViews(store, 600, 6);
    store.putConversion(dayKey(Date.now()), { rebateUsd: 10 });
    const r = attributeConversions(store, {});
    assert.equal(r.posts, 1, 'only the post above the views floor receives credit');
    const credited = store.db.prepare('SELECT post_id FROM post_conversion').all() as { post_id: number }[];
    assert.deepEqual(credited.map(c => c.post_id), [real]);
    assert.equal((store.db.prepare('SELECT COUNT(*) n FROM post_conversion WHERE post_id = ?').get(tiny) as { n: number }).n, 0);
    assert.ok(MIN_VIEWS_FOR_CREDIT >= 20);
  } finally {
    close();
  }
});

test('earnings are not pushed onto posts that were not live', () => {
  const { store, close } = tempStore();
  try {
    postWithViews(store, 500, 80); // three days ago, outside the window
    store.putConversion(dayKey(Date.now()), { rebateUsd: 6 });
    const r = attributeConversions(store, {});
    assert.equal(r.posts, 0);
    assert.equal(r.unattributed, 6, 'it says so rather than inventing a recipient');
  } finally {
    close();
  }
});

test('the money target changes what the experiment is optimising, and only when data exists', () => {
  const { store, close } = tempStore();
  try {
    for (let i = 0; i < 8; i++) postWithViews(store, 100 + i, 8, { h_hashtag_count: 'one' });
    for (let i = 0; i < 8; i++) postWithViews(store, 900 - i, 8, { h_hashtag_count: 'two' });
    observeDistribution(store);
    const before = scoreAll(store, { writeMemory: false, target: 'money' }).find(v => v.id === 'h_hashtag_count')!;
    assert.equal(before.metric, 'views24h', 'no conversion rows means no money metric');

    store.putConversion(dayKey(Date.now()), { rebateUsd: 20 });
    attributeConversions(store, {});
    observeDistribution(store);
    const after = scoreAll(store, { writeMemory: false, target: 'money' }).find(v => v.id === 'h_hashtag_count')!;
    assert.equal(after.metric, 'rebatePer1k');
    const viewsRun = scoreAll(store, { writeMemory: false, target: 'views' }).find(v => v.id === 'h_hashtag_count')!;
    assert.equal(viewsRun.metric, 'views24h', 'the switch is per-run, not a global mutation');
    // Observed hypotheses keep their own metric: apportioned money on non-randomised arms is a
    // guess stacked on a guess.
    const hour = scoreAll(store, { writeMemory: false, target: 'money' }).find(v => v.id === 'h_hour_band')!;
    assert.equal(hour.metric, 'views24h');
  } finally {
    close();
  }
});
