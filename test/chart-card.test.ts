import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardAnnotation } from '../src/chart/forSymbol.ts';
import { renderCardSvg } from '../src/chart/kline.ts';
import type { Kline } from '../src/collectors/binance.ts';

function candles(n: number, start = 100): Kline[] {
  const out: Kline[] = [];
  for (let i = 0; i < n; i++) {
    const c = start + Math.sin(i / 3) * 4 + i * 0.3;
    const o = c - 0.8;
    const t = 1792400000000 + i * 3600_000;
    out.push([t, o.toFixed(4), (c + 1).toFixed(4), (o - 1).toFixed(4), c.toFixed(4), '120', t + 3599_999, '480000', 300]);
  }
  return out;
}

test('the card sentence is the post\'s first real sentence, never a tag line or an emoji', () => {
  // Emoji have no glyph in the rasteriser and print as tofu, and a cashtag line is a tag,
  // not a claim — the first line that survives both is the one the cover may print large.
  assert.equal(cardAnnotation('🚨 GTC 1小时持仓量增加 5.1%。'), 'GTC 1小时持仓量增加 5.1%。');
  assert.equal(cardAnnotation('📊 $GTC 费率 -0.3%。\n数据摆在这儿，决定你自己做。'), '数据摆在这儿，决定你自己做。');
  assert.equal(cardAnnotation('#GTC\n#资金费率\n持仓量一小时增加 5.1%，多头在付钱。'), '持仓量一小时增加 5.1%，多头在付钱。');
  assert.equal(cardAnnotation('   \n\n'), null);
});

test('the card prints the audited sentence, the source and the account, in a CJK-first stack', () => {
  const svg = renderCardSvg(candles(30), {
    column: '今日反常',
    title: 'GTC',
    market: '永续',
    lastPrice: 108.4,
    changePct: 5.1,
    annotation: 'GTC 最近 1 小时成交额为 24 小时均值的 2.3 倍',
    source: '币安合约行情',
    watermark: '@ forwhat',
  });
  assert.match(svg, /GTC 最近 1 小时成交额为 24 小时均值的 2\.3 倍/);
  assert.match(svg, /数据来源：币安合约行情/);
  assert.match(svg, /@ forwhat/);
  assert.match(svg, /24h 最高/);
  assert.match(svg, /24h 成交额/);
  // A Consolas-first stack is what stretched every CJK glyph into a monospace cell on the
  // first pass; the card leads with the CJK face.
  assert.ok(!svg.includes('font-family="Consolas'));
  assert.match(svg, /font-family="Microsoft YaHei/);
});

test('the 24h figures come from the full day even when the sparkline shows a shorter span', () => {
  // bars: 18 crops the sparkline; the footer turnover must still sum the whole day (24 candles),
  // not the cropped window — 24 × 480000 = 1152万, the 18-candle sum would read 864万.
  const svg = renderCardSvg(candles(30), {
    column: '行情异动', title: 'GTC', lastPrice: 110, changePct: 2, annotation: 'x'.repeat(10), source: '币安合约行情', bars: 18,
  });
  assert.ok(svg.includes('1152万'), 'the footer must sum 24 candles');
  assert.ok(!svg.includes('864万'), 'the cropped window must not leak into the 24h column');
});
