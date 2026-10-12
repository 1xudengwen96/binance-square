import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { renderKlineSvg } from '../src/chart/kline.ts';
import { makeMaterial } from '../src/material/types.ts';
import type { Kline } from '../src/collectors/binance.ts';

const fresh = () => Store.open(join(mkdtempSync(join(tmpdir(), 'sf-')), 't.db'));

const bars = (n: number): Kline[] =>
  Array.from({ length: n }, (_, i) => {
    const p = 100 + i;
    return [Date.UTC(2026, 9, 1) + i * 3600_000, String(p), String(p + 2), String(p - 2), String(p + 1), '1', 0, '1000000'] as unknown as Kline;
  });

test('the chart header names the span its percentage covers and is drawn in Chinese', () => {
  const svg = renderKlineSvg(bars(72), { title: 'AEROUSDT 永续 · 1H', lastPrice: 1, changePct: 26.47, changeLabel: '近72小时', stats: { chips: ['24 小时涨跌 +15.86%'] } });
  assert.match(svg, /近72小时 \+26\.47%/);
  assert.match(svg, /24 小时涨跌 \+15\.86%/);
  assert.match(svg, /Microsoft YaHei/);
});

test('funding rows are read in full, not squeezed out by other categories scoring higher', () => {
  const store = fresh();
  const now = Date.now();
  // 250 higher-scored onchain rows would fill a top-200 cut entirely.
  for (let i = 0; i < 250; i++) {
    store.insertMaterial(makeMaterial({ category: 'onchain', subType: 'x', title: `o${i}`, symbol: `O${i}`, source: 't', at: now, score: 95, facts: {} }));
  }
  store.insertMaterial(makeMaterial({ category: 'funding', subType: 'funding_extreme', title: 'f', symbol: 'ERA', source: 't', at: now, score: 50, facts: { funding: -0.001 } }));
  assert.equal(store.unusedMaterials(200, now).filter(m => m.category === 'funding').length, 0, 'the old read lost it');
  const got = store.unusedFundingMaterials(now);
  assert.deepEqual(got.map(m => m.symbol), ['ERA']);
});

test('an expired funding row is not offered', () => {
  const store = fresh();
  const now = Date.now();
  store.insertMaterial(makeMaterial({ category: 'funding', subType: 'funding_extreme', title: 'old', symbol: 'OLD', source: 't', at: now - 5 * 3600_000, score: 50, facts: {} }));
  assert.equal(store.unusedFundingMaterials(now).length, 0);
});

test('hasEvent matches on the post id inside the event detail', () => {
  const store = fresh();
  store.log('image_missing', { postId: 7 });
  assert.equal(store.hasEvent('image_missing', 7), true);
  assert.equal(store.hasEvent('image_missing', 8), false);
  assert.equal(store.hasEvent('other', 7), false);
});
