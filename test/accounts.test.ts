import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { accountSecretView, getAccountSecret, setAccountSecret } from '../src/secrets.ts';
import { hasProxy, normalizeProxy, proxiedFetch } from '../src/net.ts';

function tempStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-acct-'));
  return { store: Store.open(join(dir, 't.db')), dir };
}

test('accounts carry persona and cadence, and default to inheriting the global schedule', () => {
  const { store, dir } = tempStore();
  try {
    const id = store.createAccount({ label: '小号 A', owner: '张三', style: 'data', phaseMinutes: 37 });
    const a = store.accountById(id)!;
    assert.equal(a.label, '小号 A');
    assert.equal(a.owner, '张三');
    assert.equal(a.enabled, 0, 'a new account must not start posting by itself');
    assert.equal(a.style, 'data');
    assert.equal(a.phase_minutes, 37);
    assert.equal(a.posts_per_day, null, 'NULL means inherit, not zero');
    assert.equal(a.categories_json, null);

    store.updateAccount(id, { postsPerDay: 4, categoriesJson: JSON.stringify(['funding']) });
    assert.equal(store.accountById(id)!.posts_per_day, 4);

    // Phase is clamped into a day rather than trusted from the caller.
    store.createAccount({ label: 'B', phaseMinutes: 99_999 });
    assert.equal(store.allAccounts().find(x => x.label === 'B')!.phase_minutes, 1439);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only enabled, unpaused accounts are driven', () => {
  const { store, dir } = tempStore();
  try {
    const on = store.createAccount({ label: 'on', enabled: true });
    const off = store.createAccount({ label: 'off', enabled: false });
    const halted = store.createAccount({ label: 'halted', enabled: true });
    store.updateAccount(halted, { pausedUntil: Date.now() + 600_000 });

    assert.deepEqual(store.activeAccounts().map(a => a.id), [on]);
    assert.notDeepEqual(store.activeAccounts().map(a => a.id), [on, off]);
    // A pause expires on its own.
    store.updateAccount(halted, { pausedUntil: Date.now() - 1 });
    assert.deepEqual(store.activeAccounts().map(a => a.id).sort(), [on, halted].sort());
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('account keys are stored per account, masked, and never read back in plaintext by the view', () => {
  const { store, dir } = tempStore();
  try {
    const a = store.createAccount({ label: 'A' });
    const b = store.createAccount({ label: 'B' });
    setAccountSecret(store, a, 'sk_account_alpha_key_000123456789');
    setAccountSecret(store, b, 'sk_account_beta_key_9876543210000');

    assert.equal(getAccountSecret(store, a), 'sk_account_alpha_key_000123456789');
    const view = accountSecretView(store, a);
    assert.equal(view.set, true);
    assert.ok(!view.masked.includes('alpha'), 'the mask must not contain the middle of the key');
    assert.match(view.masked, /^sk_/);
    assert.match(view.masked, /89$/);

    // Blank clears it rather than storing an empty string.
    setAccountSecret(store, a, '   ');
    assert.equal(getAccountSecret(store, a), '');
    assert.equal(accountSecretView(store, a).set, false);
    assert.equal(accountSecretView(store, b).set, true, 'the other account is untouched');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting an account releases its coins and detaches its posts', () => {
  const { store, dir } = tempStore();
  try {
    const id = store.createAccount({ label: 'gone', enabled: true });
    const keep = store.createAccount({ label: 'keep', enabled: true });
    const postId = store.addPost({ materialId: null, templateId: null, text: 'x', status: 'published', scheduledAt: null });
    store.updatePost(postId, { accountId: id });
    store.claim('BTC', postId, 90, id);
    setAccountSecret(store, id, 'sk_secret_value_123456789');

    store.deleteAccount(id);
    assert.equal(store.accountById(id), undefined);
    assert.equal(store.getClaim('BTC'), undefined, 'its coin lock must be released');
    assert.equal(store.postById(postId)!.account_id, null);
    assert.deepEqual(store.activeAccounts().map(a => a.id), [keep]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a claim records which account holds the coin', () => {
  const { store, dir } = tempStore();
  try {
    const a = store.createAccount({ label: 'A' });
    const b = store.createAccount({ label: 'B' });
    store.claim('ETH', 1, 80, a);
    assert.equal(store.getClaim('ETH')!.account_id, a);
    store.claim('ETH', 2, 85, b);
    assert.equal(store.getClaim('ETH')!.account_id, b, 'the lock moves to whoever re-claimed it');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('proxy URLs are validated before anything dials them', () => {
  assert.equal(normalizeProxy(''), '');
  assert.equal(normalizeProxy('   '), '');
  assert.equal(hasProxy(''), false);
  assert.equal(hasProxy('  '), false);
  assert.equal(hasProxy('http://user:pass@1.2.3.4:8080'), true);
  assert.throws(() => normalizeProxy('not a url'), /无法解析/);
  assert.throws(() => normalizeProxy('socks5://1.2.3.4:1080'), /只支持 http\/https/);
  assert.equal(normalizeProxy('  http://1.2.3.4:8080  '), 'http://1.2.3.4:8080');
});

test('proxiedFetch returns a usable fetch and reuses one agent per proxy', () => {
  const f = proxiedFetch('http://127.0.0.1:9/');
  assert.equal(typeof f, 'function');
  // Same proxy must not build a second connection pool.
  assert.equal(proxiedFetch('http://127.0.0.1:9/'), f);
  assert.notEqual(proxiedFetch('http://127.0.0.1:10/'), f);
});
