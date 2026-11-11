import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { registry, seedRegistry } from '../src/rank/registry.ts';

test('legacy claims are narrowed to the preregistered measurement without changing experiment history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-wording-'));
  const store = Store.open(join(dir, 'test.db'));
  try {
    seedRegistry(store, 123);
    const originals = [
      ['h_hook_form', '首句先给结论、把数字放到第二句，比直接以数据开头更能留住前三秒'],
      ['h_hour_band', '发帖时刻决定第一小时的推送量'],
    ] as const;
    for (const [id, claim] of originals) store.db.prepare('UPDATE hypotheses SET claim = ? WHERE id = ?').run(claim, id);
    const rows = () => store.db.prepare('SELECT id,metric,min_samples,created_at,status FROM hypotheses ORDER BY id').all();
    const before = rows();
    const revised = registry(store);
    for (const [id] of originals) {
      const h = revised.find(h => h.id === id)!;
      assert.match(h.claim, /24 小时浏览量/);
      assert.equal(h.metric, 'views24h');
    }
    assert.match(revised.find(h => h.id === 'h_hook_form')!.how, /不能验证前三秒留存/);
    assert.match(revised.find(h => h.id === 'h_hour_band')!.how, /不据此判断首小时推送量或因果/);
    assert.deepEqual(rows(), before);
    assert.equal(seedRegistry(store), 0);
    assert.deepEqual(registry(store), revised);
    store.db.prepare("UPDATE hypotheses SET claim = '操作者自定义主张' WHERE id = 'h_hook_form'").run();
    assert.equal(registry(store).find(h => h.id === 'h_hook_form')!.claim, '操作者自定义主张');
    store.db.prepare("UPDATE hypotheses SET claim = ?, metric = 'growth1h' WHERE id = 'h_hour_band'").run(originals[1][1]);
    assert.equal(registry(store).find(h => h.id === 'h_hour_band')!.claim, originals[1][1]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
