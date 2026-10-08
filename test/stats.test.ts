import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import Database from 'better-sqlite3';
import { CHECK_OFFSETS_MS, nextCheckDue } from '../src/stats/backfill.ts';

const HOUR = 3_600_000;

test('nothing is due before the first checkpoint', () => {
  assert.equal(nextCheckDue(0, [], CHECK_OFFSETS_MS[0]! - 1), -1);
  assert.equal(nextCheckDue(0, [], CHECK_OFFSETS_MS[0]!), 0);
});

test('a post nobody measured for a day samples the checkpoint it is actually in', () => {
  // 30h old → the 24h slot. Recording this as "20m" would fabricate a curve.
  assert.equal(nextCheckDue(0, [], 30 * HOUR), 4);
  assert.equal(nextCheckDue(0, [], 80 * HOUR), 5);
});

test('each checkpoint is recorded once, and never out of order', () => {
  assert.equal(nextCheckDue(0, [4], 30 * HOUR), -1);
  assert.equal(nextCheckDue(0, [4], 80 * HOUR), 5);
  assert.equal(nextCheckDue(0, [1], 20 * HOUR), 3); // stalled loop: must not revisit 0
  assert.equal(nextCheckDue(0, [0, 1, 2, 3, 4, 5], 999 * HOUR), -1);
});

test('checkpoints are ordered and the last one is the farthest out', () => {
  const sorted = CHECK_OFFSETS_MS.every((v, i) => i === 0 || v > CHECK_OFFSETS_MS[i - 1]!);
  assert.ok(sorted);
  assert.equal(CHECK_OFFSETS_MS[CHECK_OFFSETS_MS.length - 1], 72 * HOUR);
});

test('an existing database gains the columns the queries expect', async () => {
  // CREATE TABLE IF NOT EXISTS never evolves a table that is already there, so a DB
  // built before `shares`/`reactions` existed would make every stats read throw.
  const dir = mkdtempSync(join(tmpdir(), 'sf-migrate-'));
  const file = join(dir, 't.db');
  const raw = new Database(file);
  raw.exec(`
    CREATE TABLE post_stats (post_id INTEGER PRIMARY KEY, checked_at INTEGER NOT NULL, views INTEGER, likes INTEGER, comments INTEGER, raw_json TEXT);
    CREATE TABLE post_stat_checks (post_id INTEGER NOT NULL, checkpoint INTEGER NOT NULL, at INTEGER NOT NULL, views INTEGER, likes INTEGER, comments INTEGER, PRIMARY KEY (post_id, checkpoint));
  `);
  raw.close();

  const store = Store.open(file);
  try {
    const cols = (t: string) => (store.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name);
    assert.ok(cols('post_stats').includes('shares'), 'post_stats gained shares');
    assert.ok(cols('post_stat_checks').includes('reactions'), 'post_stat_checks gained reactions');

    const id = store.addPost({ materialId: null, templateId: null, text: '旧库测试', status: 'published', scheduledAt: null });
    store.recordPostStats(id, 2, { views: 300, likes: 12, comments: 3, shares: 4, reactions: 7 });
    const curve = store.statCurve(id);
    assert.equal(curve[0]!.shares, 4);
    assert.equal(curve[0]!.reactions, 7);
    assert.equal(store.statsByPost([id]).get(id)!.shares, 4);
    // Reopening must be a no-op, not a second ALTER that errors out.
    store.close();
    const again = Store.open(file);
    assert.ok(again.statsByPost([id]).get(id)!.views === 300);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stat checkpoints round-trip through the database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-stats-'));
  const store = Store.open(join(dir, 't.db'));
  try {
    const postedAt = Date.now() - 25 * HOUR;
    const id = store.addPost({ materialId: null, templateId: null, text: '测试帖', status: 'published', scheduledAt: null });
    store.updatePost(id, { status: 'published', squarePostId: '9001', publishedAt: postedAt });

    const row = store.publishedWithSquareId(10).find(p => p.id === id);
    assert.ok(row);
    assert.equal(row.square_post_id, '9001');
    // The sweep anchors on publish time, not draft-creation time.
    assert.equal(row.posted_at, postedAt);
    assert.deepEqual(store.statCheckpoints(id), []);
    assert.equal(nextCheckDue(row.posted_at, store.statCheckpoints(id)), 4);

    store.recordPostStats(id, 4, { views: 120, likes: 7, comments: 2 });
    assert.deepEqual(store.statCheckpoints(id), [4]);
    // Same checkpoint twice must not duplicate a curve point.
    store.recordPostStats(id, 4, { views: 133, likes: 8, comments: 2 });
    assert.deepEqual(store.statCheckpoints(id), [4]);

    store.recordPostStats(id, 5, { views: 200, likes: 11, comments: 4 });
    const curve = store.statCurve(id);
    assert.deepEqual(curve.map(c => c.checkpoint), [4, 5]);
    assert.equal(curve[0]!.views, 133);
    assert.equal(curve[1]!.views, 200);
    // post_stats keeps the newest read for cheap display.
    assert.equal((store.db.prepare('SELECT views FROM post_stats WHERE post_id = ?').get(id) as { views: number }).views, 200);
    assert.equal(nextCheckDue(row.posted_at, store.statCheckpoints(id)), -1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
