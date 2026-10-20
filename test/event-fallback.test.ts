import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import { allocateEventFallback } from '../src/lanes.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-event-fallback-'));
  const store = Store.open(join(dir, 'db.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const a = store.createAccount({ label: 'A', enabled: true, postsPerDay: 12 });
  const b = store.createAccount({ label: 'B', enabled: true, postsPerDay: 12 });
  const add = (accountId: number, status = 'published') => store.addPost({
    accountId, materialId: null, templateId: null, text: '测试稿', status, scheduledAt: null,
  });
  return { store, a, b, add };
}

test('quiet-market fallback reaches the second account after the first account has a post', t => {
  const { store, a, b, add } = setup(t);
  add(a);
  const shares = allocateEventFallback(store, DEFAULT_SETTINGS, store.activeAccounts(), 1);
  assert.deepEqual([...shares], [[b, 1]]);
});

test('equal-load accounts rotate even when the previous account produced no draft', t => {
  const { store, a, b } = setup(t);
  const picked = Array.from({ length: 4 }, () => [...allocateEventFallback(store, DEFAULT_SETTINGS, store.activeAccounts(), 1).keys()][0]);
  assert.deepEqual(picked, [a, b, a, b]);
  assert.equal(store.pendingQueueCount(), 0, 'allocation itself must not create or approve posts');
});

test('fallback balances completion relative to each account target', t => {
  const { store, a, b, add } = setup(t);
  store.updateAccount(a, { postsPerDay: 4 });
  store.updateAccount(b, { postsPerDay: 8 });
  add(a); add(a); add(b); add(b);
  const shares = allocateEventFallback(store, DEFAULT_SETTINGS, store.activeAccounts(), 3);
  assert.equal(shares.get(b), 2);
  assert.equal(shares.get(a), 1);
});

test('fallback never assigns beyond daily or pending queue capacity', t => {
  const { store, a, b, add } = setup(t);
  store.updateAccount(a, { postsPerDay: 1 });
  store.updateAccount(b, { postsPerDay: 2 });
  add(a);
  add(b, 'approved');
  const shares = allocateEventFallback(store, DEFAULT_SETTINGS, store.activeAccounts(), 20);
  assert.deepEqual([...shares], [[b, 1]]);
});

test('pending posts from an earlier day still occupy the queue', t => {
  const { store, a, b, add } = setup(t);
  store.updateAccount(a, { postsPerDay: 1 });
  const pending = add(a, 'approved');
  store.db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(Date.now() - 2 * 86_400_000, pending);
  assert.deepEqual([...allocateEventFallback(store, DEFAULT_SETTINGS, store.activeAccounts(), 1)], [[b, 1]]);
});
