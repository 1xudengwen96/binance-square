import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withHashtags } from '../src/pipeline.ts';
import { makeMaterial } from '../src/material/types.ts';

const m = (symbol: string | null, symbols: string[] = [], category = 'market_move') =>
  makeMaterial({ category: category as never, subType: 'spike', title: 't', symbol, symbols, source: 'test', at: 1, facts: {} });

const DISC = '内容仅供参考，不构成投资建议，DYOR。';
const TAGS = '#MET #行情异动';

test('the tag line goes above the disclaimer so the legal line stays last', () => {
  const out = withHashtags(`$MET 拉了 12%。\n${DISC}`, m('MET'));
  assert.equal(out, `$MET 拉了 12%。\n\n${TAGS}\n${DISC}`);
});

test('with no disclaimer the tag line lands at the end', () => {
  assert.equal(withHashtags('$MET 拉了 12%。', m('MET')), `$MET 拉了 12%。\n\n${TAGS}`);
});

test('a coin tag already in the text is not duplicated, but the topic tag still goes in', () => {
  const out = withHashtags(`正文 #MET 已带标签`, m('MET'));
  assert.equal(out.match(/#MET(?![\p{L}\p{N}_])/gu)?.length, 1, 'exactly one coin tag');
  assert.ok(out.includes('#行情异动'), 'the topic feed still gets the post');
});

test('a longer tag is not mistaken for this one', () => {
  // #METX does not put this post on the #MET page, so the coin tag is still needed.
  const out = withHashtags('正文 #METX', m('MET'));
  assert.ok(out.includes(TAGS), out);
});

test('an existing blank line before the disclaimer is reused, not stacked', () => {
  assert.equal(withHashtags(`$MET 拉了。\n\n${DISC}`, m('MET')), `$MET 拉了。\n\n${TAGS}\n${DISC}`);
});

test('an existing tag line is extended rather than a second one stacked under it', () => {
  const out = withHashtags(`正文\n\n#MET\n${DISC}`, m('MET'));
  assert.equal(out.match(/^#/gm)?.length, 1, out);
  assert.equal(out, `正文\n\n${TAGS}\n${DISC}`);
});

test('one coin per post: the headline symbol wins, other symbols stay out', () => {
  const out = withHashtags('榜前三', m('龙虾', ['龙虾', 'GRIFFAIN', 'CAP']));
  assert.equal(out.match(/#\S+/g)?.length, 2, out);
  assert.match(out, /#龙虾 #行情异动/);
});

test('topics can be dialled down to the coin tag alone', () => {
  assert.equal(withHashtags('$MET 拉了 12%。', m('MET'), 0), `$MET 拉了 12%。\n\n#MET`);
});

test('the topic follows the material category, not a fixed label', () => {
  assert.ok(withHashtags('费率极端', m('BWET', [], 'funding')).includes('#资金费率'));
  assert.ok(withHashtags('上新了', m('ABC', [], 'announcement')).includes('#币安公告'));
});

test('names Square cannot parse as a hashtag are skipped', () => {
  for (const bad of [null, '', 'A', 'BTC-USDT', 'BTC 币', 'B.T.C']) {
    const text = '正文内容';
    assert.equal(withHashtags(text, m(bad)), text, `should not tag ${String(bad)}`);
  }
});
