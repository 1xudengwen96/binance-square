import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import { publishDue } from '../src/pipeline.ts';
import { beijingDayStart } from '../src/schedule.ts';

function approvedPost(store: Store): number {
  return store.addPost({
    materialId: null,
    templateId: null,
    text: '$TOK 1小时多空比 2.10，多头占 67.9%。测试正文，不构成投资建议。',
    status: 'approved',
    scheduledAt: Date.now() - 60_000,
  });
}

test('a drill reports what it would send but commits nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-drill-'));
  const store = Store.open(join(dir, 't.db'));
  try {
    const id = approvedPost(store);
    const r = await publishDue(store, { ...DEFAULT_SETTINGS }, { live: false });

    assert.equal(r.published.length, 1, 'the drill should still walk the queue');
    const post = store.postById(id)!;
    assert.equal(post.status, 'approved', 'a drill must not mark a post as published');
    assert.equal(post.square_post_id, null);
    assert.equal(post.published_at, null);
    assert.equal(store.publishedToday(beijingDayStart()), 0, 'a drill must not eat the daily cap');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a batch sharing one scheduled minute publishes once, not five times', async () => {
  // The real failure this pins: `allowed` only means the daily cap is not hit, and the slot
  // it returns is routinely in the future. Reading `allowed` as "post now" sent five drafts
  // to Square inside one minute — the exact burst that makes an account read as a bot.
  const dir = mkdtempSync(join(tmpdir(), 'sf-burst-'));
  const store = Store.open(join(dir, 't.db'));
  try {
    const slot = Date.now() - 60_000;
    for (let i = 0; i < 5; i++) {
      store.db
        .prepare(
          `INSERT INTO posts (material_id, template_id, text, status, created_at, scheduled_at)
           VALUES (NULL, NULL, ?, 'approved', ?, ?)`,
        )
        .run(`$TOK 多空比 ${2 + i}.10，多头占 6${i}.9%。测试正文，不构成投资建议。`, slot, slot);
    }
    const r = await publishDue(store, { ...DEFAULT_SETTINGS }, { live: false });
    assert.equal(r.attempted, 1, `one tick must release at most one post, attempted ${r.attempted}`);
    assert.ok(r.failed.some(f => /未到发布时刻/.test(f.label)), 'the rest must be explicitly deferred, not silently dropped');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a single due post is not blocked by its own queue entry', async () => {
  // The mirror-image regression: the spacing clock sees scheduled drafts, so without
  // excluding the candidate a post due right now would treat its own slot as a prior claim
  // and defer itself forever.
  const dir = mkdtempSync(join(tmpdir(), 'sf-selfblock-'));
  const store = Store.open(join(dir, 't.db'));
  try {
    approvedPost(store);
    const r = await publishDue(store, { ...DEFAULT_SETTINGS }, { live: false });
    assert.equal(r.attempted, 1, 'one due post with no history must be attempted');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the dedup source stays clean after a drill', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-drill2-'));
  const store = Store.open(join(dir, 't.db'));
  try {
    const id = approvedPost(store);
    await publishDue(store, { ...DEFAULT_SETTINGS }, { live: false });
    // recentPostTexts(['published','uncertain']) is what blocks near-duplicates at the
    // real publish gate — a drilled text appearing there would suppress the real one.
    assert.deepEqual(store.recentPostTexts(30, ['published', 'uncertain']), []);
    assert.ok(store.postById(id)!.status === 'approved');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
