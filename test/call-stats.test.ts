import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import Fastify from 'fastify';
import { Store } from '../src/db/index.ts';
import { CHECK_AFTER_MS, FUNDING_PERSISTS, PAYER_PERSISTS, callStats, tally } from '../src/calls.ts';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import { buildSnapshot, snapshotText } from '../src/brain/snapshot.ts';
import { detectAlarms } from '../src/brain/sentinel.ts';
import { registerBrainRoutes } from '../src/server/brainRoutes.ts';

const NOW = Date.UTC(2026, 9, 22, 6);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sf-call-stats-'));
  const store = Store.open(join(dir, 'test.db'));
  const insert = store.db.prepare(`INSERT INTO column_calls
    (post_id, symbol, kind, reading, payer, rate_at, check_at, status, outcome)
    VALUES (1, 'AAA', ?, 'ledger', '空头', -0.002, ?, ?, ?)`);
  const add = (kind: string, outcome: 'held' | 'faded' | 'flipped' | 'open' | 'void', at = NOW) => {
    const status = outcome === 'held' ? 'held' : outcome === 'open' || outcome === 'void' ? outcome : 'failed';
    insert.run(kind, at + CHECK_AFTER_MS, status, outcome === 'open' ? null : outcome);
  };
  return { store, add, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('call cohorts reproduce #8: old 4/25 and current 3/6 remain separate from the mixed 7/31', () => {
  const { store, add, close } = fixture();
  try {
    for (let i = 0; i < 25; i++) add(FUNDING_PERSISTS, i < 4 ? 'held' : i < 20 ? 'faded' : 'flipped', NOW - 3 * CHECK_AFTER_MS);
    for (let i = 0; i < 6; i++) add(PAYER_PERSISTS, i < 3 ? 'held' : 'flipped');
    add(PAYER_PERSISTS, 'open', NOW + 1000);
    add(PAYER_PERSISTS, 'void');
    const before = store.db.prepare('SELECT * FROM column_calls ORDER BY id').all();
    const s = buildSnapshot(store, DEFAULT_SETTINGS, NOW);
    assert.equal(s.calls.currentKind, PAYER_PERSISTS);
    assert.deepEqual(tally(store), { total: 31, held: 7, faded: 16, flipped: 8, open: 1 });
    assert.equal(s.calls.total, 31);
    assert.deepEqual(s.calls.byKind[FUNDING_PERSISTS], {
      total: 25, held: 4, faded: 16, flipped: 5, open: 0, void: 0, heldRate: 4 / 25,
      firstRegisteredAt: NOW - 3 * CHECK_AFTER_MS, lastRegisteredAt: NOW - 3 * CHECK_AFTER_MS,
    });
    assert.deepEqual(s.calls.byKind[PAYER_PERSISTS], {
      total: 6, held: 3, faded: 0, flipped: 3, open: 1, void: 1, heldRate: 0.5,
      firstRegisteredAt: NOW, lastRegisteredAt: NOW + 1000,
    });
    assert.equal(detectAlarms(s, { ...DEFAULT_SETTINGS, llmEnabled: true }).some(a => a.code === 'calls_failing'), false);
    assert.equal(JSON.parse(snapshotText(s)).calls.byKind[PAYER_PERSISTS].heldRate, 0.5);
    assert.ok(s.definitions.some(d => d.includes('历史合计') && d.includes('currentKind')));
    assert.deepEqual(store.db.prepare('SELECT * FROM column_calls ORDER BY id').all(), before, 'reporting must not rewrite the original rule or outcome');
  } finally { close(); }
});

test('empty, pending and void cohorts have no success rate; unknown rules stay separate', () => {
  const { store, add, close } = fixture();
  try {
    let s = callStats(store);
    for (const kind of [FUNDING_PERSISTS, PAYER_PERSISTS]) {
      assert.equal(s.byKind[kind]!.total, 0);
      assert.equal(s.byKind[kind]!.heldRate, null);
      assert.equal(s.byKind[kind]!.firstRegisteredAt, null);
    }
    add(PAYER_PERSISTS, 'open');
    add(PAYER_PERSISTS, 'void');
    add('future_rule', 'held');
    s = callStats(store);
    assert.equal(s.total, 1);
    assert.equal(s.byKind[PAYER_PERSISTS]!.total, 0);
    assert.equal(s.byKind[PAYER_PERSISTS]!.heldRate, null);
    assert.equal(s.byKind.future_rule!.heldRate, 1);
  } finally { close(); }
});

test('call alarm requires five current rulings, ignores old outcomes, and uses the current rate boundary', () => {
  const { store, add, close } = fixture();
  try {
    const settings = { ...DEFAULT_SETTINGS, llmEnabled: true };
    const alarms = () => detectAlarms(buildSnapshot(store, settings, NOW), settings).filter(a => a.code === 'calls_failing');
    for (let i = 0; i < 25; i++) add(FUNDING_PERSISTS, 'faded');
    assert.equal(alarms().length, 0, 'old failures alone do not evaluate the new rule');
    for (let i = 0; i < 4; i++) add(PAYER_PERSISTS, 'flipped');
    assert.equal(alarms().length, 0, 'four current rulings are insufficient');
    add(PAYER_PERSISTS, 'flipped');
    assert.match(alarms()[0]!.detail, /payer_persists.*已裁决 5 条判断，只有 0 条成立/);
    // Healthy old outcomes cannot hide a failure of the current rule.
    for (let i = 0; i < 30; i++) add(FUNDING_PERSISTS, 'held');
    assert.equal(alarms().length, 1);
    for (let i = 0; i < 3; i++) add(PAYER_PERSISTS, 'held');
    for (let i = 0; i < 2; i++) add(PAYER_PERSISTS, 'flipped');
    assert.equal(alarms().length, 0, 'exactly 30% does not alarm');
  } finally { close(); }
});

test('brain API and card expose both cohort rates and each recent call rule', async () => {
  const { store, add, close } = fixture();
  const app = Fastify();
  try {
    add(FUNDING_PERSISTS, 'faded');
    add(PAYER_PERSISTS, 'held');
    registerBrainRoutes(app, store);
    const response = await app.inject({ method: 'GET', url: '/api/brain' });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.calls_ledger.tally.byKind[PAYER_PERSISTS].heldRate, 1);
    assert.equal(data.calls_ledger.tally.byKind[FUNDING_PERSISTS].heldRate, 0);
    assert.deepEqual(data.calls_ledger.recent.map((c: { kind: string }) => c.kind), [PAYER_PERSISTS, FUNDING_PERSISTS]);
    const source = readFileSync(new URL('../src/server/public/brain.js', import.meta.url), 'utf8');
    const card = source.slice(source.indexOf('function brainCallsCard('), source.indexOf('function brainBenchmarkCard('));
    const html = runInNewContext(`${card}\nbrainCallsCard(data)`, {
      data, esc: (s: unknown) => String(s), fmtTs: (t: number) => String(t), PURPOSE_CN: {},
    });
    assert.match(html, /旧口径：费率至少保留一半/);
    assert.match(html, /新口径：同一边仍在付费（当前）/);
    assert.match(html, /100\.0%/);
    assert.match(html, /0\.0%/);
    assert.match(html, /历史合计（混合口径）/);
    assert.match(html, /登记时间范围/);
  } finally { await app.close(); close(); }
});
