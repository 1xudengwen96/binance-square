import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import { accountStyles, allocate, collidesWithMatrix, materialAllowedForAccount, personaSeed } from '../src/matrix.ts';
import { makeMaterial } from '../src/material/types.ts';

function temp(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-matrix-'));
  return { store: Store.open(join(dir, 't.db')), dir };
}
const S = { ...DEFAULT_SETTINGS, crossAccountCoinExclusionMinutes: 360, postsPerDay: 3 };
const cand = (symbol: string, score: number) => ({ symbol, score });

test('no two accounts are handed the same coin in one pass', () => {
  const { store, dir } = temp();
  try {
    const a = store.createAccount({ label: 'A', enabled: true, postsPerDay: 3 });
    const b = store.createAccount({ label: 'B', enabled: true, postsPerDay: 3 });
    const acc = store.allAccounts().filter(x => x.enabled);
    const candidates = [cand('BTC', 90), cand('ETH', 80), cand('SOL', 70), cand('XRP', 60)];
    const out = allocate(candidates, acc, store, S);

    const all = [...out.values()].flat().map(c => c.symbol);
    assert.equal(new Set(all).size, all.length, `coins were duplicated: ${all.join(',')}`);
    // Four coins, two accounts, alternating: everything goes out exactly once.
    assert.equal(all.length, candidates.length);
    assert.deepEqual(out.get(a)!.map(c => c.symbol), ['BTC', 'SOL']);
    assert.deepEqual(out.get(b)!.map(c => c.symbol), ['ETH', 'XRP']);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allocation spreads coins round-robin instead of the first account hoarding them', () => {
  const { store, dir } = temp();
  try {
    const a = store.createAccount({ label: 'A', enabled: true, postsPerDay: 2 });
    const b = store.createAccount({ label: 'B', enabled: true, postsPerDay: 2 });
    const acc = store.allAccounts().filter(x => x.enabled);
    const out = allocate([cand('BTC', 90), cand('ETH', 80), cand('SOL', 70)], acc, store, S);
    // A must not take the top two; each account gets one strong and one weaker coin.
    assert.deepEqual(out.get(a)!.map(c => c.symbol), ['BTC', 'SOL']);
    assert.deepEqual(out.get(b)!.map(c => c.symbol), ['ETH']);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a coin claimed by one account is off-limits to the others until the window passes', () => {
  const { store, dir } = temp();
  try {
    const a = store.createAccount({ label: 'A', enabled: true, postsPerDay: 2 });
    const b = store.createAccount({ label: 'B', enabled: true, postsPerDay: 2 });
    store.claim('BTC', 1, 90, a);
    const acc = store.allAccounts().filter(x => x.enabled);

    const now = Date.now();
    const out = allocate([cand('BTC', 90), cand('ETH', 80)], acc, store, S, now);
    assert.deepEqual(out.get(b)!.map(c => c.symbol), ['ETH'], 'B must not be handed a coin A holds');

    // Once the exclusion window lapses, B may cover it.
    const later = now + S.crossAccountCoinExclusionMinutes * 60_000 + 1;
    const out2 = allocate([cand('BTC', 90)], [acc.find(x => x.id === b)!], store, S, later);
    assert.deepEqual(out2.get(b)!.map(c => c.symbol), ['BTC']);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an account with pinned coins only ever receives those', () => {
  const { store, dir } = temp();
  try {
    store.createAccount({ label: 'BTC-only', enabled: true, postsPerDay: 3, symbols: ['btc', 'ETH'] });
    const acc = store.allAccounts().filter(x => x.enabled);
    const out = allocate([cand('BTC', 90), cand('ETH', 80), cand('SOL', 70), cand('DOGE', 60)], acc, store, S);
    assert.deepEqual(out.get(acc[0]!.id)!.map(c => c.symbol).sort(), ['BTC', 'ETH']);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const SAME_SENTENCE_OTHER_COIN = {
  a: '📊 $BTC 1小时多空比 2.14，多头占 68.2%。\n几乎没动，情绪不等于方向，但情绪决定波动。\n数据摆在这儿，决定你自己做。',
  b: '📊 $ETH 1小时多空比 1.87，多头占 64.0%。\n几乎没动，情绪不等于方向，但情绪决定波动。\n数据摆在这儿，决定你自己做。',
  different: '🚨 美国司法部起诉某创始人涉嫌 900 万美元 Rug Pull 欺诈。\n消息面的一天，先看资金怎么反应。\n个人观点，不构成投资建议。',
};

function seedPost(store: Store, accountId: number, text: string): void {
  const id = store.addPost({ materialId: null, templateId: null, text, status: 'published', scheduledAt: null });
  store.updatePost(id, { accountId, publishedAt: Date.now(), squarePostId: String(900000 + id) });
}

test('a pinned account is not starved by an unpinned one picking first', () => {
  const { store, dir } = temp();
  try {
    // Created first so it sorts ahead in allAccounts() — the order a bug would exploit.
    store.createAccount({ label: '泛号', enabled: true, postsPerDay: 2 });
    const pinned = store.createAccount({ label: '盯盘号', enabled: true, postsPerDay: 1, symbols: ['BTC'] });
    const acc = store.allAccounts().filter(x => x.enabled);
    assert.equal(acc[0]!.label, '泛号', 'the unpinned account really is evaluated first by id order');

    const out = allocate([cand('BTC', 90), cand('ETH', 80)], acc, store, S);
    assert.deepEqual(out.get(pinned)!.map(c => c.symbol), ['BTC'], 'the pinned account must get its coin');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same template on a different coin is caught across accounts', () => {
  const { store, dir } = temp();
  try {
    const a = store.createAccount({ label: '甲号' });
    const b = store.createAccount({ label: '乙号' });
    seedPost(store, a, SAME_SENTENCE_OTHER_COIN.a);

    const hit = collidesWithMatrix(store, S, b, SAME_SENTENCE_OTHER_COIN.b);
    assert.ok(hit, 'swapping the coin but keeping the sentence must not clear the gate');
    assert.equal(hit!.ownerLabel, '甲号');
    assert.ok(hit!.signature >= 0.62);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('genuinely different copy clears the gate, and an account never collides with itself', () => {
  const { store, dir } = temp();
  try {
    const a = store.createAccount({ label: '甲号' });
    const b = store.createAccount({ label: '乙号' });
    seedPost(store, a, SAME_SENTENCE_OTHER_COIN.a);

    assert.equal(collidesWithMatrix(store, S, b, SAME_SENTENCE_OTHER_COIN.different), null);
    // Its own earlier post is governed by the per-account cooldown, not this gate.
    assert.equal(collidesWithMatrix(store, S, a, SAME_SENTENCE_OTHER_COIN.a), null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rows with no account do not block the whole matrix', () => {
  const { store, dir } = temp();
  try {
    const a = store.createAccount({ label: '甲' });
    const b = store.createAccount({ label: '乙' });
    // A pre-matrix or CLI-created post: nobody owns it, so it must not silence every
    // account on an entire template — several subtypes only have one template.
    const legacy = store.addPost({ materialId: null, templateId: null, text: SAME_SENTENCE_OTHER_COIN.a, status: 'draft', scheduledAt: null });
    assert.equal(store.postById(legacy)!.account_id, null);

    assert.equal(collidesWithMatrix(store, S, b, SAME_SENTENCE_OTHER_COIN.b), null);
    // But once another account owns it, the gate applies.
    store.updatePost(legacy, { accountId: a });
    assert.ok(collidesWithMatrix(store, S, b, SAME_SENTENCE_OTHER_COIN.b));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the persona seed varies by account so synonym pools diverge', () => {
  const a = personaSeed('mat:1', 1, 1000);
  const b = personaSeed('mat:1', 2, 1000);
  assert.notEqual(a, b);
  assert.equal(personaSeed('mat:1', 1, 1000), a, 'same inputs must stay reproducible');
});

/* ------------------------------------------------------- account levers --- */

test('a style list widens the eligible templates instead of locking to one', async () => {
  const { eligibleTemplates } = await import('../src/engine/compose.ts');
  const { templates } = await import('../src/content/templates.ts');
  const m = makeMaterial({ category: 'long_short', subType: 'account_ratio', title: 'X 多空比', symbol: 'X', source: 't', at: 1, facts: {} });

  const one = eligibleTemplates(m, templates, { style: ['data'] });
  const three = eligibleTemplates(m, templates, { style: ['data', 'emotion', 'chat'] });
  assert.ok(three.length >= one.length, 'more voices must not narrow the pool');
  assert.ok(new Set(three.map(t => t.style)).size > 1, 'the union really spans several styles');
  assert.ok(one.every(t => t.style === 'data' || t.style === 'any'));
});

test('mixed in the style list means no style restriction at all', async () => {
  const { eligibleTemplates } = await import('../src/engine/compose.ts');
  const { templates } = await import('../src/content/templates.ts');
  const m = makeMaterial({ category: 'long_short', subType: 'account_ratio', title: 'X 多空比', symbol: 'X', source: 't', at: 1, facts: {} });
  assert.equal(
    eligibleTemplates(m, templates, { style: ['mixed', 'data'] }).length,
    eligibleTemplates(m, templates, {}).length,
  );
});

test('accountStyles falls back to the single style, and mixed overrides the list', () => {
  const { store, dir } = temp();
  try {
    const plain = store.createAccount({ label: 'P', style: 'tech' });
    assert.deepEqual(accountStyles(store.accountById(plain)!), ['tech']);

    const many = store.createAccount({ label: 'M', style: 'tech', styles: ['tech', 'data', 'joke'] });
    assert.deepEqual(accountStyles(store.accountById(many)!), ['tech', 'data', 'joke']);

    const mixedIn = store.createAccount({ label: 'X', style: 'tech', styles: ['mixed', 'data'] });
    assert.deepEqual(accountStyles(store.accountById(mixedIn)!), ['mixed']);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a blocked coin is never allocated to that account, but its peers may still take it', () => {
  const { store, dir } = temp();
  try {
    store.createAccount({ label: '不碰DOGE', enabled: true, postsPerDay: 2, blockedSymbols: ['DOGE'] });
    store.createAccount({ label: '随便', enabled: true, postsPerDay: 2 });
    const acc = store.allAccounts().filter(x => x.enabled);
    const out = allocate([cand('DOGE', 90), cand('BTC', 80), cand('ETH', 70)], acc, store, S);

    const deny = acc.find(a => a.label === '不碰DOGE')!;
    const ok = acc.find(a => a.label === '随便')!;
    assert.ok(!out.get(deny.id)!.some(c => c.symbol === 'DOGE'), 'the blocked coin must not be handed out');
    assert.ok(out.get(ok.id)!.some(c => c.symbol === 'DOGE'), 'the other account can still cover it');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('category scope and the coin blocklist both gate material eligibility', () => {
  const { store, dir } = temp();
  try {
    const only = store.createAccount({ label: '只看费率', categories: ['funding'] });
    assert.equal(materialAllowedForAccount({ category: 'funding', symbol: 'X' }, store.accountById(only)!), true);
    assert.equal(materialAllowedForAccount({ category: 'newsflash', symbol: 'X' }, store.accountById(only)!), false);

    const banned = store.createAccount({ label: '拉黑名单', blockedSymbols: ['scam'] });
    const b = store.accountById(banned)!;
    assert.equal(materialAllowedForAccount({ category: 'funding', symbol: 'SCAM' }, b), false, 'blocklist is case-insensitive');
    assert.equal(materialAllowedForAccount({ category: 'funding', symbol: 'BTC' }, b), true);
    assert.equal(materialAllowedForAccount({ category: 'funding', symbol: null }, b), true, 'no symbol is not a block');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
