import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import { makeMaterial, type MaterialCategory } from '../src/material/types.ts';
import { retire, ttlFor } from '../src/lifecycle.ts';

const HOUR = 3_600_000;
const S = { ...DEFAULT_SETTINGS, dataRetentionDays: 14, chartRetentionHours: 72 };

function mat(category: MaterialCategory, subType: string, symbol: string, at: number) {
  return makeMaterial({ category, subType, title: `${symbol} 测试素材`, symbol, source: 'test', at, facts: { chg24h: 5 } });
}

function temp(): { store: Store; dir: string; charts: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-life-'));
  const charts = join(dir, 'charts');
  mkdirSync(charts, { recursive: true });
  return { store: Store.open(join(dir, 't.db')), dir, charts };
}
const live = (store: Store) => (store.db.prepare('SELECT COUNT(*) n FROM materials WHERE discarded = 0').get() as { n: number }).n;

test('each category expires on its own clock, and unknown ones fall back', () => {
  assert.equal(ttlFor('market_move'), 90);
  assert.equal(ttlFor('announcement'), 720);
  assert.equal(ttlFor('something_new'), 180);

  const { store, dir, charts } = temp();
  try {
    const now = Date.now();
    store.insertMaterial(mat('market_move', 'spike', 'FRESH', now - 60 * 60_000)); // inside 90m
    store.insertMaterial(mat('market_move', 'spike', 'STALE', now - 3 * HOUR)); // past 90m
    store.insertMaterial(mat('announcement', 'listing', 'OLDNEWS', now - 3 * HOUR)); // inside 720m

    assert.equal(retire(store, S, charts, now).discarded, 1);
    assert.equal(live(store), 2);
    const survivors = store.db.prepare('SELECT symbol FROM materials WHERE discarded = 0').all() as { symbol: string }[];
    assert.deepEqual(survivors.map(s => s.symbol).sort(), ['FRESH', 'OLDNEWS']);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('material already turned into a post is not expired out from under its provenance', () => {
  const { store, dir, charts } = temp();
  try {
    const now = Date.now();
    const m = mat('long_short', 'account_ratio', 'USED', now - 5 * HOUR);
    store.insertMaterial(m);
    store.db.prepare('UPDATE materials SET used_count = 1 WHERE id = ?').run(m.id);

    assert.equal(retire(store, S, charts, now).discarded, 0);
    assert.equal(live(store), 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rows past the retention horizon are deleted, not just flagged', () => {
  const { store, dir, charts } = temp();
  try {
    const now = Date.now();
    store.insertMaterial(mat('funding', 'funding_extreme', 'ANCIENT', now - 3 * HOUR));
    store.db.prepare('UPDATE materials SET collected_at = ?').run(now - 40 * 24 * 3_600_000);
    store.recordSample({ symbol: 'BTC', ts: now - 40 * 24 * 3_600_000, score: 50, price: 1, parts: {} });

    const r = retire(store, S, charts, now);
    assert.equal(r.deletedMaterials, 1);
    assert.equal(r.deletedSamples, 1);
    assert.equal((store.db.prepare('SELECT COUNT(*) n FROM materials').get() as { n: number }).n, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function touch(file: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  utimesSync(file, t, t);
}

test('orphan charts go, but a chart a live draft still points at stays', () => {
  const { store, dir, charts } = temp();
  try {
    const orphan = join(charts, 'ORPHAN-1h-1.png');
    const claimed = join(charts, 'CLAIMED-1h-2.png');
    const recent = join(charts, 'RECENT-1h-3.png');
    for (const f of [orphan, claimed, recent]) writeFileSync(f, 'x');
    touch(orphan, 100 * HOUR);
    touch(claimed, 100 * HOUR);
    // `recent` keeps a fresh mtime.

    const id = store.addPost({ materialId: null, templateId: null, text: 't', status: 'draft', scheduledAt: null, images: [claimed] });
    assert.ok(store.postById(id)!.images_json?.includes('CLAIMED'));

    const r = retire(store, S, charts);
    assert.equal(r.deletedCharts, 1, 'only the orphan that aged out is removed');
    assert.ok(!existsSync(orphan));
    assert.ok(existsSync(claimed), 'a referenced chart must survive');
    assert.ok(existsSync(recent), 'a chart inside the grace window must survive');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a draft older than its material is rejected automatically', () => {
  const { store, dir, charts } = temp();
  try {
    const now = Date.now();
    const fresh = mat('long_short', 'account_ratio', 'FRESH', now - 30 * 60_000); // inside 2h
    const stale = mat('long_short', 'account_ratio', 'STALE', now - 5 * HOUR); // past 2h
    store.insertMaterial(fresh);
    store.insertMaterial(stale);
    for (const m of [fresh, stale]) {
      const id = store.addPost({ materialId: m.id, templateId: null, text: 't', status: 'draft', scheduledAt: null });
      void id;
    }
    const before = (store.db.prepare("SELECT COUNT(*) n FROM posts WHERE status='draft'").get() as { n: number }).n;
    assert.equal(before, 2);

    const r = retire(store, S, charts, now);
    assert.equal(r.staleDrafts, 1);
    const left = store.db.prepare("SELECT m.symbol, p.status FROM posts p JOIN materials m ON m.id=p.material_id").all() as { symbol: string; status: string }[];
    assert.deepEqual(left.find(x => x.symbol === 'STALE')!.status, 'rejected');
    assert.deepEqual(left.find(x => x.symbol === 'FRESH')!.status, 'draft', 'a live draft must not be swept');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a draft with no material is left alone', () => {
  const { store, dir, charts } = temp();
  try {
    store.addPost({ materialId: null, templateId: null, text: '手写的一条', status: 'draft', scheduledAt: null });
    assert.equal(retire(store, S, charts).staleDrafts, 0);
    assert.equal((store.db.prepare("SELECT COUNT(*) n FROM posts WHERE status='draft'").get() as { n: number }).n, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an approved post is expired too, not just a draft', () => {
  // The hole this pins: with autoPublish on, a draft is created already `approved` and never
  // sits in `draft` long enough to be swept. Expiring drafts only therefore left the stale
  // backlog alive on exactly the path that matters — 120 hours-old market claims sat
  // queued to publish over the following four days.
  const { store, dir, charts } = temp();
  try {
    const now = Date.now();
    const stale = mat('funding', 'funding_extreme', 'STALEAPPROVED', now - 6 * HOUR); // past 3h
    store.insertMaterial(stale);
    store.addPost({ materialId: stale.id, templateId: null, text: 't', status: 'approved', scheduledAt: now });

    const r = retire(store, S, charts, now);
    assert.equal(r.staleDrafts, 1, 'an approved post on expired material must be reaped');
    const row = store.db.prepare("SELECT status FROM posts WHERE material_id = ?").get(stale.id) as { status: string };
    assert.equal(row.status, 'rejected');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
