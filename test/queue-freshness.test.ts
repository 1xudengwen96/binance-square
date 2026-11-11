import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { Store } from '../src/db/index.ts';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import { shouldWaitToDraft, publishSafetyMarginMs } from '../src/lifecycle.ts';
import { generate, generateFromPool } from '../src/pipeline.ts';
import { generateColumn } from '../src/column.ts';
import { makeMaterial } from '../src/material/types.ts';
import { automaticDraftBlockReason } from '../src/drafting.ts';
import { ALERT_KINDS, raise } from '../src/alerts/bus.ts';
import { queueSummary } from '../src/stats/queue.ts';

const NOW = Date.UTC(2026, 10, 11, 2);
const MINUTE = 60_000;
const settings = { ...DEFAULT_SETTINGS, autoPublish: true, attachChart: false, activeExperiments: [], postsPerDay: 12 };

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-queue-'));
  const store = Store.open(join(dir, 'test.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.setLabelPersona(1, { name: '测试', tone: '冷静' });
  const account = store.accountById(store.createAccount({ label: 'A', enabled: true }))!;
  return { store, account };
}

test('automatic drafting waits until one polling cycle before delivery, review mode is unchanged', () => {
  const margin = publishSafetyMarginMs(settings);
  assert.equal(shouldWaitToDraft(settings, NOW + margin, NOW), false);
  assert.equal(shouldWaitToDraft(settings, NOW + margin + 1, NOW), true);
  assert.equal(shouldWaitToDraft({ ...settings, autoPublish: false }, NOW + 3_600_000, NOW), false);
});

test('column, event and pool generation wait without consuming a fresh material or reserving samples', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { store, account } = fixture(t);
  const material = makeMaterial({ category: 'funding', subType: 'funding_extreme', title: 'FRESH 资金费率', symbol: 'FRESH',
    source: 'test', at: NOW, sentiment: 'bear', score: 80,
    facts: { cashtag: '$FRESH', funding: -0.0125, annualized: -70.2, payer: '空头', intervalHours: 8,
      price: 1.234, longRatio: 0.83, shortRatio: 1.2, chg24h: -3.42, chg1h: -0.41,
      volMultiple: 2.1, oiChangePct: -8.8, quoteVolume24h: 65_000_000 },
  });
  store.insertMaterial(material);
  const old = store.addPost({ materialId: null, templateId: null, text: '历史已发布', status: 'published', scheduledAt: NOW, accountId: account.id });
  store.updatePost(old, { publishedAt: NOW });
  const column = await generateColumn(store, settings, account);
  assert.equal(column.created.length, 0);
  assert.match(column.skipped.join(' '), /尚未临近/);
  const event = await generate(store, settings, 2, { account });
  assert.equal(event.created.length, 0);
  assert.match(event.skipped.join(' '), /尚未临近/);
  // The injected pool is only used to reach the scheduling gate; no collector or renderer runs.
  const pool = await generateFromPool(store, settings, { account, poolEntries: [{ mature: true, symbol: 'FRESH' } as any] });
  assert.equal(pool.created.length, 0);
  assert.match(pool.skipped.map(x => x.why).join(' '), /尚未临近/);
  assert.equal((store.db.prepare('SELECT used_count FROM materials WHERE id = ?').get(material.id) as { used_count: number }).used_count, 0);
  assert.equal(store.pendingQueueCount(account.id), 0);
  assert.equal((store.db.prepare('SELECT COUNT(*) n FROM post_arms').get() as { n: number }).n, 0);
});

test('summary counts the full database and separates expired, duplicate, market and compliance outcomes', t => {
  const { store, account } = fixture(t);
  const add = (status: string, error: string | null, at = NOW, accountId: number | null = account.id) => {
    const id = store.addPost({ materialId: null, templateId: null, text: '测试', status, scheduledAt: null, accountId });
    store.db.prepare('UPDATE posts SET created_at = ?, error = ? WHERE id = ?').run(at, error, id);
    return id;
  };
  const pending = add('approved', null);
  for (let n = 0; n < 160; n++) add('published', null);
  add('rejected', '素材过期，草稿自动作废（funding 类保质期已过）');
  add('rejected', '发布前发现与已发帖子重复，已作废并释放排期');
  add('rejected', '发布前复核：行情前提已经不成立');
  add('rejected', '发布前合规检查拦下：事实台账外数字');
  add('rejected', null);
  add('failed', '网络失败');
  add('uncertain', '待人工确认');
  add('rejected', '素材过期，草稿自动作废', NOW - 8 * 86_400_000);
  add('draft', null, NOW, null);
  add('rejected', null, NOW + 1);
  const s = queueSummary(store, account.id, NOW);
  assert.equal(s.counts.rejected, 6);
  assert.equal(s.counts.approved, 1);
  assert.deepEqual(s.recent, { total: 168, published: 160, expired: 1, duplicate: 1, marketChanged: 1, compliance: 1, otherRejected: 1, failed: 1, uncertain: 1, pending: 1, other: 0 });
  assert.equal(queueSummary(store, undefined, NOW).recent.pending, 2, 'unowned drafts count in all accounts');
  const rows = store.postsForList({ statuses: ['draft', 'approved'], accountId: account.id });
  assert.deepEqual(rows.map(p => p.id), [pending], 'filter in SQL before LIMIT, not after truncating another account’s rows');
});

test('queue opens on pending posts while history and generation waste remain visible', async () => {
  const source = readFileSync(join(import.meta.dirname, '../src/server/public/app.js'), 'utf8');
  const boot = source.indexOf("document.documentElement.dataset.theme = localStorage.getItem('sf-theme') || 'dark';");
  assert.ok(boot > 0);
  const urls: string[] = [];
  const ctx: any = { document: {}, localStorage: { getItem: () => null }, console, location: { hash: '' },
    fetch: async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => url.includes('/summary')
        ? { counts: { published: 335, rejected: 469, failed: 1 }, recent: { total: 10, published: 6, pending: 0, expired: 1, duplicate: 1, marketChanged: 2, compliance: 0, otherRejected: 0, failed: 0, uncertain: 0, other: 0 } }
        : url === '/api/studio' ? { articles: [] } : [] };
    } };
  runInNewContext(source.slice(0, boot) + '\nSTATE = {accounts: []}; globalThis.view = queueView;', ctx);
  const html: string = await ctx.view();
  assert.ok(urls.some(u => u.includes('status=pending')));
  assert.match(html, /当前没有待发布稿件/);
  assert.match(html, /全部记录/);
  assert.match(html, /469/);
  assert.match(html, /近 7 天生成的 10 条短帖/);
  assert.match(html, /过期 1/);
  assert.match(html, /行情前提失效 2/);
});


test('both breaker surfaces stop all automatic short-post generators but preserve review work', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { store, account } = fixture(t);
  store.setSetting('breaker', { since: NOW - 86_400_000, trippedAt: NOW });
  const run = async () => {
    const event = await generate(store, settings, 2, { account });
    assert.match(event.skipped.join(' '), /熔断中/);
    const column = await generateColumn(store, settings, account);
    assert.match(column.skipped.join(' '), /熔断中/);
    const pool = await generateFromPool(store, settings, { account, poolEntries: [] });
    assert.match(pool.skipped.map(x => x.why).join(' '), /熔断中/);
    assert.equal(store.pendingQueueCount(account.id), 0);
  };
  await run();
  store.setSetting('breaker', { since: NOW, trippedAt: null });
  raise(store, { kind: ALERT_KINDS.breakerTripped, severity: 'breach', key: 'test', subreason: 'stall_gt_2h' });
  await run();
  assert.equal(automaticDraftBlockReason(store, settings, { ...settings, autoPublish: false }, NOW), null);
  assert.match(automaticDraftBlockReason(store, { ...settings, autoPublish: false }, settings, NOW)!, /总开关已关闭/);
});
