import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { noteCollectMiss, subscribeSample, type CollectMissLedger } from '../src/studio/runner.ts';

function tempStore(): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-stats-'));
  const file = join(dir, 't.db');
  const store = Store.open(file);
  return { store, close: () => { store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function makePublishedArticle(store: Store): number {
  return Number(store.db
    .prepare(`INSERT INTO studio_articles (track_id, concept_id, title, body, status, created_at, published_at, square_post_id)
              VALUES ('trading_literacy','funding_who_pays','t','b','published',?,?,?)`)
    .run(Date.now() - 4 * 3600_000, Date.now() - 4 * 3600_000, '375000000000001').lastInsertRowid);
}

test('①a migration: studio_observations carries subscribers_reason on fresh opens', () => {
  const { store, close } = tempStore();
  try {
    const cols = (store.db.prepare('PRAGMA table_info(studio_observations)').all() as { name: string }[]).map(c => c.name);
    assert.ok(cols.includes('subscribers_reason'), 'subscribers_reason column must exist');
  } finally { close(); }
});

test('①a writer: NULL subscribers is stored as NULL with a reason, real 0 stays 0', () => {
  const { store, close } = tempStore();
  try {
    const id = makePublishedArticle(store);
    store.recordStudioObservation(id, 0, { views: 10, likes: 0, comments: 0, shares: 0, reactions: 0, subscribers: null, subscribersReason: 'field_missing' });
    store.recordStudioObservation(id, 1, { views: 12, likes: 0, comments: 0, shares: 0, reactions: 0, subscribers: 0 });
    const rows = store.studioObservations(id);
    const missing = rows.find(r => r.checkpoint === 0)!;
    assert.equal(missing.subscribers, null, 'missing field must not become a real zero');
    assert.equal(missing.subscribersReason, 'field_missing');
    const realZero = rows.find(r => r.checkpoint === 1)!;
    assert.equal(realZero.subscribers, 0);
    assert.equal(realZero.subscribersReason, null);
  } finally { close(); }
});

test('①a mapping: subscribeSample distinguishes absent / real zero / unparseable', () => {
  assert.deepEqual(subscribeSample({}), { value: null, reason: 'field_missing' });
  assert.deepEqual(subscribeSample({ subscribeCount: null }), { value: null, reason: 'field_missing' });
  assert.deepEqual(subscribeSample({ subscribeCount: 0 }), { value: 0, reason: null });
  assert.deepEqual(subscribeSample({ subscribeCount: '7' }), { value: 7, reason: null });
  assert.deepEqual(subscribeSample({ subscribeCount: 'abc' }), { value: null, reason: 'parse_fail' });
});

test('①b streaks: two failed reads open a warning, escalation reuses 12h/24h tiers, success clears', () => {
  const ledger: CollectMissLedger = {};
  const t0 = 1_790_000_000_000;
  // First miss: no alert yet — one hole in a 15-minute loop is a hiccup.
  let r = noteCollectMiss(ledger, 7, false, t0);
  assert.equal(r.changed, true);
  assert.equal(r.events.length, 0);
  // Second consecutive miss: warning opens, once.
  r = noteCollectMiss(ledger, 7, false, t0 + 900_000);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0]!.severity, 'warning');
  // Third miss within the same tier: no duplicate spam.
  r = noteCollectMiss(ledger, 7, false, t0 + 1_800_000);
  assert.equal(r.events.length, 0);
  assert.equal(ledger['7']!.misses, 3);
  // Crossing 12h since the first miss escalates to fault (single event again).
  r = noteCollectMiss(ledger, 7, false, t0 + 13 * 3600_000);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0]!.severity, 'fault');
  // Crossing 24h escalates to breach.
  r = noteCollectMiss(ledger, 7, false, t0 + 25 * 3600_000);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0]!.severity, 'breach');
  // A successful read closes the streak and reports that an alert had been raised.
  r = noteCollectMiss(ledger, 7, true, t0 + 26 * 3600_000);
  assert.ok(r.cleared, 'cleared must carry the closed streak');
  assert.equal(r.cleared!.misses, 5);
  assert.equal(ledger['7'], undefined);
  // Success with no open streak changes nothing.
  r = noteCollectMiss(ledger, 8, true, t0);
  assert.equal(r.changed, false);
});
