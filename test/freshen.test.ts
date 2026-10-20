import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import { makeMaterial } from '../src/material/types.ts';
import { seedVariants } from '../src/content/columns.ts';
import { registerCall } from '../src/calls.ts';
import { applyFreshen, describeDrift, freshFacts, freshenForPublish, type LiveQuote } from '../src/freshen.ts';
import { publishDue } from '../src/pipeline.ts';

const HOUR = 3600_000;
const ALWAYS_OPEN = { ...DEFAULT_SETTINGS, activeStartHour: 0, activeEndHour: 24 };

function tempStore(): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-fresh-'));
  const store = Store.open(join(dir, 't.db'));
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const quote = (over: Partial<LiveQuote> = {}): LiveQuote => ({
  price: 1.2, chg24h: 25, chg1h: 1.1, volMultiple: 1.4, funding: -0.002, longRatio: 1.05, oiChangePct: 9, quoteVolume24h: 6e7, ...over,
});

/** A 今日反常 draft written two hours ago: shorts paying into a +20% day. */
function anomalyDraft(store: Store, now: number): number {
  seedVariants(store);
  const m = makeMaterial({
    category: 'funding', subType: 'funding_extreme', title: 'GTC 资金费率', symbol: 'GTC', source: 't', at: now - 2 * HOUR,
    facts: { funding: -0.0035, annualized: -191.6, payer: '空头', intervalHours: 8, price: 1, chg24h: 20.4, oiChangePct: 12, quoteVolume24h: 5e7 },
  });
  store.insertMaterial(m);
  const id = store.addPost({
    materialId: m.id, templateId: 'column.anomaly',
    text: '$GTC 价格在涨，空头却还在交钱。\n一天涨了 20%，费率 0.35% 由空头付，持仓多了 12%。\n个人观察记录，不构成任何建议。',
    status: 'approved', scheduledAt: now - 60_000,
    trace: { lane: 'column', kind: 'anomaly', seed: 4242, variants: [] },
  });
  store.db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(now - 2 * HOUR, id);
  registerCall(store, { postId: id, symbol: 'GTC', reading: 'anomaly', payer: '空头', rate: -0.0035, annualized: -191.6, intervalHours: 8, price: 1, now: now - 2 * HOUR });
  return id;
}

test('live fields are swapped in; venue-native and event-window fields are not', () => {
  const funding = freshFacts({ category: 'funding', facts: { funding: -0.0035, annualized: -191.6, payer: '空头', intervalHours: 8, chg24h: 20, streakPeriods: 4, streakCostPct: 1.2 } }, quote({ funding: 0.002 }));
  assert.equal(funding.facts.funding, 0.002);
  assert.equal(funding.facts.payer, '多头', 'payer follows the live rate');
  assert.equal(funding.facts.streakPeriods, undefined, 'a streak of shorts paying ends when longs pay');
  assert.ok(funding.drift.some(d => d.field === 'funding' && d.big));

  const hl = freshFacts({ category: 'onchain', facts: { venue: 'Hyperliquid', funding: 0.0001, price: 3.1, chg24h: 4, longRatio: 1.2, volume24h: 1e6, quoteVolume24h: 2e7, venueSharePct: 5 } }, quote());
  assert.equal(hl.facts.funding, 0.0001, 'a Hyperliquid rate is not replaced by a Binance one');
  assert.equal(hl.facts.price, 3.1);
  assert.equal(hl.facts.longRatio, 1.05, 'Binance-side context still refreshes');
  assert.equal(hl.facts.venueSharePct, Number(((1e6 / 6e7) * 100).toFixed(1)));

  const move = freshFacts({ category: 'market_move', facts: { tf: '1h', volMultiple: 7.2, price: 1381.5, chg24h: 9.7 } }, quote({ price: 1300, chg24h: 3.1 }));
  assert.equal(move.facts.volMultiple, 7.2, 'the burst it describes is its own hour');
  assert.equal(move.facts.price, 1300);
  assert.match(describeDrift(move.drift), /24h 涨跌 \+9\.7% → \+3\.1%/);
});

test('a column draft is re-rendered with the market at its minute, and its call restated', async () => {
  const { store, close } = tempStore();
  try {
    const now = Date.now();
    const id = anomalyDraft(store, now);
    const post = store.postById(id)!;
    const fr = await freshenForPublish(store, ALWAYS_OPEN, post, null, { quote: async () => quote(), now });
    assert.equal(fr.kind, 'update', JSON.stringify(fr));
    if (fr.kind !== 'update') return;
    assert.match(fr.text, /涨了 25%/);
    assert.match(fr.text, /0\.20%/);
    assert.doesNotMatch(fr.text, /涨了 20%|0\.35%/);
    assert.match(fr.drift, /费率 -0\.350% → -0\.200%/);
    applyFreshen(store, post, fr, now);
    const after = store.postById(id)!;
    assert.equal(after.text, fr.text);
    const trace = JSON.parse(after.trace_json!) as Record<string, unknown>;
    assert.equal(trace.kind, 'anomaly', 'the original trace survives');
    assert.ok(trace.refreshed, 'and records what moved');
    const call = store.db.prepare('SELECT rate_at, check_at FROM column_calls WHERE post_id = ?').get(id) as { rate_at: number; check_at: number };
    assert.equal(call.rate_at, -0.002, 'the recap will judge the rate the post actually quoted');
    assert.ok(call.check_at >= now + 23 * HOUR);
  } finally { close(); }
});

test('a column draft whose reading stopped being true is dropped, not sent', async () => {
  const { store, close } = tempStore();
  try {
    const now = Date.now();
    const id = anomalyDraft(store, now);
    // Longs pay now, into a rising price: «空头还在交钱» would be false.
    const fr = await freshenForPublish(store, ALWAYS_OPEN, store.postById(id)!, null, { quote: async () => quote({ funding: 0.002 }), now });
    assert.equal(fr.kind, 'drop');
    if (fr.kind === 'drop') assert.match(fr.why, /今日反常的前提已经不成立：现在是多头在付、价格也在往上走/);
  } finally { close(); }
});

test('nothing is touched when there is nothing to check or the quote is unavailable', async () => {
  const { store, close } = tempStore();
  try {
    const now = Date.now();
    const id = anomalyDraft(store, now);
    const post = store.postById(id)!;
    assert.equal((await freshenForPublish(store, ALWAYS_OPEN, post, null, { quote: async () => null, now })).kind, 'keep', 'a failed quote never blocks a send');
    assert.equal((await freshenForPublish(store, ALWAYS_OPEN, { ...post, created_at: now - 60_000 }, null, { quote: async () => quote(), now })).kind, 'keep', 'a fresh draft is left alone');
    assert.equal((await freshenForPublish(store, ALWAYS_OPEN, { ...post, material_id: null }, null, { quote: async () => quote(), now })).kind, 'keep');
  } finally { close(); }
});

test('an event post past its window is dropped before the quote is even read', async () => {
  const { store, close } = tempStore();
  try {
    const now = Date.now();
    const m = makeMaterial({ category: 'market_move', subType: 'volume_surge', title: 'x', symbol: 'SNDKB', source: 't', at: now - 3 * HOUR, facts: { volMultiple: 7.2, price: 1381.51, chg24h: 9.7 } });
    store.insertMaterial(m);
    const id = store.addPost({ materialId: m.id, templateId: 'move.volume', text: '$SNDKB 1 小时成交额放到 7.2 倍。不构成投资建议。', status: 'approved', scheduledAt: now - 60_000, trace: { seed: 1 } });
    store.db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(now - 3 * HOUR, id);
    let asked = false;
    const fr = await freshenForPublish(store, ALWAYS_OPEN, store.postById(id)!, null, { quote: async () => { asked = true; return quote(); }, now });
    assert.equal(fr.kind, 'drop');
    assert.equal(asked, false);
  } finally { close(); }
});

test('the publish gate rejects a stale draft, reports it as dropped, and frees the slot', async () => {
  const { store, close } = tempStore();
  try {
    const now = Date.now();
    const id = anomalyDraft(store, now);
    const r = await publishDue(store, ALWAYS_OPEN, { live: false, quote: async () => quote({ funding: 0.002 }) });
    assert.equal(r.dropped.length, 1);
    assert.equal(r.failed.filter(f => f.id === id).length, 0, 'a dropped draft is not a failed send');
    const row = store.postById(id)!;
    assert.equal(row.status, 'rejected');
    assert.match(row.error ?? '', /^发布前复核：/);
  } finally { close(); }
});

test('a drill without an injected quote never reaches for market data', async () => {
  const { store, close } = tempStore();
  try {
    const id = anomalyDraft(store, Date.now());
    const before = store.postById(id)!.text;
    const r = await publishDue(store, ALWAYS_OPEN, { live: false });
    assert.equal(r.dropped.length, 0);
    assert.equal(store.postById(id)!.text, before);
  } finally { close(); }
});
