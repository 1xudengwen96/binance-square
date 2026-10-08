import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMaterial } from '../src/material/types.ts';
import { mergeSameStory } from '../src/material/merge.ts';

const item = (title: string, symbol: string | null, at: number, source = '吴说区块链') =>
  makeMaterial({
    category: 'newsflash', subType: 'general', title, symbol, source, at,
    facts: { body: title, wire: 'w', source_name: source, source_count: 1 },
  });

test('the same headline from one wire collapses to one material', () => {
  const now = Date.now();
  const r = mergeSameStory([
    item('STRK强势突破0.06美元，24小时上涨18.1%', 'STRK', now),
    item('STRK 强势突破 0.06 美元，24 小时上涨 18.1%', 'STRK', now - 60_000),
  ]);
  assert.equal(r.kept.length, 1);
  assert.equal(r.merged, 1);
});

test('two wires carrying one story become one material that says so', () => {
  const now = Date.now();
  const r = mergeSameStory([
    item('Chainlink 推出 CCIP Vault Adapters 支持跨链存入', 'LINK', now, '律动BlockBeats'),
    item('Chainlink 推出 CCIP Vault Adapters 支持跨链存入', 'LINK', now - 30_000, 'PANews'),
  ]);
  assert.equal(r.kept.length, 1);
  const f = r.kept[0]!.facts as Record<string, unknown>;
  assert.equal(f.source_count, 2, 'the number of outlets is itself a signal');
  assert.match(String(f.source_names), /律动BlockBeats/);
  assert.match(String(f.source_names), /PANews/);
});

test('different stories about the same coin are not merged', () => {
  const now = Date.now();
  const r = mergeSameStory([
    item('SOL 价格突破 200 美元创周新高', 'SOL', now),
    item('Solana 基金会宣布与三星电子达成合作', 'SOL', now - 10_000),
  ]);
  assert.equal(r.kept.length, 2);
  assert.equal(r.merged, 0);
});

test('the same words about a different coin stay separate', () => {
  const now = Date.now();
  const r = mergeSameStory([
    item('某交易所宣布上线该代币', 'AAA', now),
    item('某交易所宣布上线该代币', 'BBB', now - 10_000),
  ]);
  assert.equal(r.kept.length, 2);
});

test('coinless items still merge on their headline', () => {
  const now = Date.now();
  const r = mergeSameStory([
    item('美联储会议纪要显示内部对加息节奏存在分歧', null, now),
    item('美联储会议纪要显示，内部对加息节奏存在分歧', null, now - 5_000),
  ]);
  assert.equal(r.kept.length, 1);
});
