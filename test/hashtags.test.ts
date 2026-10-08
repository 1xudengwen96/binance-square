import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withHashtags } from '../src/pipeline.ts';
import { makeMaterial } from '../src/material/types.ts';

const m = (symbol: string | null, symbols: string[] = []) =>
  makeMaterial({ category: 'market_move', subType: 'spike', title: 't', symbol, symbols, source: 'test', at: 1, facts: {} });

const DISC = '内容仅供参考，不构成投资建议，DYOR。';

test('the tag goes above the disclaimer so the legal line stays last', () => {
  const out = withHashtags(`$MET 拉了 12%。\n${DISC}`, m('MET'));
  assert.equal(out, `$MET 拉了 12%。\n\n#MET\n${DISC}`);
});

test('with no disclaimer the tag lands at the end', () => {
  assert.equal(withHashtags('$MET 拉了 12%。', m('MET')), '$MET 拉了 12%。\n\n#MET');
});

test('an existing tag is not duplicated', () => {
  assert.equal(withHashtags('正文 #MET 已带标签', m('MET')), '正文 #MET 已带标签');
  assert.equal(withHashtags('正文 #met', m('MET')), '正文 #met');
});

test('a longer tag is not mistaken for this one', () => {
  // #METX does not put this post on the #MET page, so the tag is still needed.
  assert.equal(withHashtags('正文 #METX', m('MET')), '正文 #METX\n\n#MET');
});

test('an existing blank line before the disclaimer is reused, not stacked', () => {
  assert.equal(withHashtags(`$MET 拉了。\n\n${DISC}`, m('MET')), `$MET 拉了。\n\n#MET\n${DISC}`);
});

test('only one coin per post, and the headline symbol wins', () => {
  const out = withHashtags('榜前三', m('龙虾', ['龙虾', 'GRIFFAIN', 'CAP']));
  assert.equal(out.match(/#\S+/g)?.length, 1);
  assert.match(out, /#龙虾$/m);
});

test('names Square cannot parse as a hashtag are skipped', () => {
  for (const bad of [null, '', 'A', 'BTC-USDT', 'BTC 币', 'B.T.C']) {
    const text = '正文内容';
    assert.equal(withHashtags(text, m(bad)), text, `should not tag ${String(bad)}`);
  }
});
