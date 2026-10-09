import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import { carriesDisclaimer, tooThin, withHashtags } from '../src/pipeline.ts';
import type { Fact } from '../src/engine/types.ts';
import { makeMaterial } from '../src/material/types.ts';

const num = (field: string, value: number): Fact => ({ field, kind: 'number', surface: String(value), value });

test('a shrug is not a disclaimer', () => {
  // 「数据摆在这儿，决定你自己做」sits in a bank named like a disclaimer, and the old gate asked
  // the bank rather than the text — four published posts shipped with no compliance line.
  assert.equal(carriesDisclaimer('数据摆在这儿，决定你自己做。'), false);
  assert.equal(carriesDisclaimer('个人观点，不构成投资建议。'), true);
  assert.equal(carriesDisclaimer('内容仅供参考，不构成投资建议，DYOR。'), true);
  assert.equal(carriesDisclaimer('$BTC 多空比 1.78，多头 64.0%。'), false);
});

test('the thin-content gate counts distinct numbers, not characters', () => {
  // The measured floor: the 60–88 character funding notes each carried exactly one number.
  assert.ok(tooThin([num('funding', -1.2)], '$BWET 费率 -1.2%，空头正在付费。'));
  assert.equal(tooThin([num('funding', -1.2), num('annualizedFunding', -70), num('longRatio', 0.83)], 'x'), null);
  // Two numbers is enough when the post is actually long — a number count alone would
  // misclassify a written argument as thin.
  assert.equal(tooThin([num('funding', -1.2), num('annualizedFunding', -70)], 'x'.repeat(170)), null);
  assert.ok(tooThin([num('funding', -1.2), num('annualizedFunding', -70)], 'x'.repeat(90)));
  // The same field twice is one claim, not two.
  assert.ok(tooThin([num('funding', -1.2), num('funding', -1.3)], 'x'.repeat(400)));
});

test('a coin signal cannot be restated on the same account within the cooldown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-cooldown-'));
  const store = Store.open(join(dir, 't.db'));
  try {
    const s = { ...DEFAULT_SETTINGS };
    const mat = (sym: string, cat: string) => {
      const ok = store.insertMaterial(makeMaterial({
        category: cat as never, subType: 'x', title: `${sym} ${cat}`, symbol: sym,
        source: 'test', at: Date.now(), facts: {},
      }));
      assert.ok(ok, 'material should insert');
      return (store.db.prepare('SELECT id FROM materials WHERE symbol = ? AND category = ? ORDER BY id DESC LIMIT 1').get(sym, cat) as { id: string }).id;
    };
    const funding = mat('BWET', 'funding');
    const listing = mat('BWET', 'announcement');

    const postId = store.addPost({ materialId: funding, templateId: null, text: '$BWET 费率 -1.2%', status: 'published', scheduledAt: null });
    store.updatePost(postId, { accountId: 1, publishedAt: Date.now() - 3600_000 });

    assert.ok(store.recentCoinSignal(1, 'BWET', 'funding', Date.now() - 720 * 60_000) > 0, 'same coin, same signal, one hour ago');
    assert.equal(store.recentCoinSignal(2, 'BWET', 'funding', Date.now() - 720 * 60_000), 0, 'another account may still say it');
    assert.equal(store.recentCoinSignal(1, 'BWET', 'announcement', Date.now() - 720 * 60_000), 0, 'listing news about the same coin is a different subject');
    assert.equal(store.recentCoinSignal(1, 'ETH', 'funding', Date.now() - 720 * 60_000), 0, 'another coin is unaffected');
    assert.equal(store.recentCoinSignal(1, 'BWET', 'funding', Date.now() - 30 * 60_000), 0, 'once the post falls out of the window it may be said again');
    assert.equal(s.coinSignalCooldownMinutes, 720);
    void listing;
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hashtags still land above the disclaimer when the copy carries its own closing line', () => {
  const out = withHashtags('$MET 拉了 12%。\n数据摆在这儿，决定你自己做。', makeMaterial({
    category: 'market_move', subType: 'spike', title: 't', symbol: 'MET', symbols: ['MET'], source: 'x', at: 1, facts: {},
  }));
  assert.match(out, /#MET #行情异动\n?$/);
});
