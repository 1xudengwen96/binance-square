import { test } from 'node:test';
import assert from 'node:assert/strict';

import { eligibleTemplates, compose, MIXED } from '../src/engine/compose.ts';
import { templates } from '../src/content/templates.ts';
import { wordBank } from '../src/content/wordbank.ts';
import { makeMaterial } from '../src/material/types.ts';
import type { Material } from '../src/material/types.ts';

const now = Date.now();

const spike = makeMaterial({
  category: 'market_move', subType: 'spike', title: 'SOL 15分钟拉升', symbol: 'SOL',
  source: '币安行情异动', at: now, sentiment: 'bull', score: 71,
  facts: { tf: '15分钟', chg: 5.2, price: 186.4, chg24h: 8.6, volMultiple: 3.4 },
});

const dump = makeMaterial({
  category: 'market_move', subType: 'dump', title: 'SOL 5分钟跳水', symbol: 'SOL',
  source: '币安行情异动', at: now, sentiment: 'bear', score: 66,
  facts: { tf: '5分钟', chg: -3.2, price: 171.2, chg24h: -6.4, volMultiple: 1.8 },
});

const samples: Material[] = [
  spike,
  dump,
  makeMaterial({
    category: 'market_move', subType: 'new_high', title: 'BNB 创新高', symbol: 'BNB',
    source: '币安行情异动', at: now, sentiment: 'bull', score: 58,
    facts: { price: 712.4, extreme: 718.9, chg24h: 4.1 },
  }),
  makeMaterial({
    category: 'funding', subType: 'funding_extreme', title: 'ETH 费率走高', symbol: 'ETH',
    source: '币安资金费率', at: now, sentiment: 'neutral', score: 64,
    facts: { funding: 0.00082, annualized: 89.8, payer: '多头', intervalHours: 8, price: 4512.3, chg24h: 3.4 },
  }),
  makeMaterial({
    category: 'leaderboard', subType: 'gainers', title: '涨幅榜', source: '币安行情异动', at: now, sentiment: 'bull', score: 60,
    facts: { scope: '24小时', board: [{ rank: 1, symbol: 'NMR', chg: 39.84 }, { rank: 2, symbol: 'CHZ', chg: 21.5 }] },
  }),
  makeMaterial({
    category: 'sentiment', subType: 'fear_greed', title: '恐惧贪婪指数', source: '恐惧贪婪指数', at: now, sentiment: 'neutral', score: 55,
    facts: { value: 71, label: '贪婪', prev: 66 },
  }),
  makeMaterial({
    category: 'etf_flow', subType: 'daily_flow', title: 'ETF 流出', symbol: 'BTC', source: 'ETF 资金流', at: now, sentiment: 'bear', score: 66,
    facts: { assetName: '比特币', flowUsd: -3_680_000, flowDate: '10月6日', flowDir: '净流出', streak: 2, streakDir: '流出' },
  }),
  makeMaterial({
    category: 'long_short', subType: 'account_ratio', title: '多空比', symbol: 'SOL', source: '币安多空比', at: now, sentiment: 'bull', score: 52,
    facts: { scope: '4小时', ratio: 1.42, longPct: 58.6, shortPct: 41.4 },
  }),
  makeMaterial({
    category: 'liquidation', subType: 'cascade', title: '连环爆仓', symbol: 'DOGE', source: '币安爆仓监控', at: now, sentiment: 'bear', score: 63,
    facts: { amountUsd: 12_400_000, side: '多头', window: '30分钟' },
  }),
];

test('a pump never gets the crash template', () => {
  const ids = eligibleTemplates(spike, templates).map(t => t.id);
  assert.ok(ids.includes('move.spike.emotion'));
  assert.ok(!ids.includes('move.dump'), 'dump template must not be eligible for a spike material');
});

test('a dump never gets the pump template', () => {
  const ids = eligibleTemplates(dump, templates).map(t => t.id);
  assert.ok(ids.includes('move.dump'));
  assert.ok(!ids.some(id => id.startsWith('move.spike')));
});

test('style filter narrows candidates', () => {
  assert.ok(eligibleTemplates(spike, templates, { style: 'emotion' }).every(t => t.style === 'emotion' || t.style === 'any'));
  assert.ok(eligibleTemplates(spike, templates, { style: MIXED }).length >= 2);
});

test('a style with no matching template yields nothing rather than wrong copy', () => {
  // stablecoin/daily_delta only has a `data` template. Asking for `joke` must return
  // an empty list, not silently fall back to a different writing style.
  const stable = makeMaterial({
    category: 'stablecoin', subType: 'daily_delta', title: 'USDT 增发', symbol: 'USDT',
    source: '稳定币增发销毁', at: now, sentiment: 'bull', score: 60,
    facts: { assetName: 'USDT', delta: 500_000_000, direction: '增发', total: 132_000_000_000 },
  });
  assert.ok(eligibleTemplates(stable, templates, { style: 'data' }).length > 0);
  assert.equal(eligibleTemplates(stable, templates, { style: 'joke' }).length, 0);
});

test('every sample material composes to a clean post', () => {
  for (const m of samples) {
    const c = compose(m, templates, { seed: `t:${m.id}`, bank: wordBank });
    assert.ok(!('error' in c), `${m.category}/${m.subType} failed: ${'error' in c ? c.error : ''}`);
    assert.ok(c.text.length > 25);
    assert.doesNotMatch(c.text, /\{\{|\}\}/);
  }
});

test('compose is deterministic for a seed', () => {
  const a = compose(spike, templates, { seed: 'same', bank: wordBank });
  const b = compose(spike, templates, { seed: 'same', bank: wordBank });
  assert.deepEqual(a, b);
});

test('different seeds produce visibly different copy', () => {
  const seen = new Set<string>();
  for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const c = compose(spike, templates, { seed, bank: wordBank });
    assert.ok(!('error' in c));
    if (!('error' in c)) seen.add(c.text);
  }
  assert.ok(seen.size >= 4, `expected variety, got ${seen.size} unique texts`);
});

test('compose rejects a near-duplicate of a recent post', () => {
  const first = compose(spike, templates, { seed: 'x', bank: wordBank });
  assert.ok(!('error' in first));
  if ('error' in first) return;
  const again = compose(spike, templates, { seed: 'x', bank: wordBank, recent: [first.text] });
  // Same seed means the same template wins first, and it is now a duplicate — so either
  // it falls through to a different template or the compose reports rejection.
  if (!('error' in again)) {
    assert.notEqual(again.text, first.text, 'must not re-emit the identical text');
  }
});

test('sensitive words block composition when no candidate can avoid them', () => {
  const c = compose(spike, templates, { seed: 'x', bank: wordBank, sensitiveWords: ['SOL'] });
  assert.ok('error' in c, 'every candidate mentions the symbol, so all must be rejected');
});

test('a sensitive word that no candidate uses leaves composition alone', () => {
  const c = compose(spike, templates, { seed: 'x', bank: wordBank, sensitiveWords: ['稳赚不赔'] });
  assert.ok(!('error' in c));
});
