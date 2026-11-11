import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import { beijingDayStart, nextSlotFor, recoveryIntervalMinutes, reflowApproved } from '../src/schedule.ts';
import { retireStaleDrafts } from '../src/lifecycle.ts';
import { publicationDuplicate, isStructuralDuplicate } from '../src/engine/guard.ts';
import { publishDue } from '../src/pipeline.ts';
import { generateColumn } from '../src/column.ts';
import { makeMaterial } from '../src/material/types.ts';

const MINUTE = 60_000;
const START = Date.UTC(2026, 9, 30, 0); // Beijing 08:00
const settings = { ...DEFAULT_SETTINGS, autoPublish: true, postsPerDay: 12, dailyCap: 24 };

function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-recovery-'));
  const store = Store.open(join(dir, 't.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const a = store.accountById(store.createAccount({ label: 'A', enabled: true }))!;
  const b = store.accountById(store.createAccount({ label: 'B', enabled: true }))!;
  const add = (accountId: number, at: number, status = 'approved', templateId: string | null = 'test') =>
    store.addPost({ accountId, materialId: null, templateId, text: '测试内容', status, scheduledAt: at, trace: { account: 'auto' } });
  return { store, a, b, add };
}

test('a future batch on A leaves the earlier free hole available to B', t => {
  const { store, a, b, add } = setup(t);
  add(a.id, START);
  add(a.id, START + 80 * MINUTE);
  assert.equal(nextSlotFor(store, settings, b, START, null, true).at, START + 14 * MINUTE);
});

test('recovery shortens cadence when behind, retaining the minimum interval', () => {
  assert.equal(recoveryIntervalMinutes(settings, 0, START), 80);
  assert.equal(recoveryIntervalMinutes(settings, 3, START + 8 * 60 * MINUTE), 53);
  assert.equal(recoveryIntervalMinutes(settings, 3, START + 14 * 60 * MINUTE), 45);
});

test('reservations rolling beyond today explicitly tell generation to stop', t => {
  const { store, a, add } = setup(t);
  const late = START + 15 * 60 * MINUTE;
  add(a.id, late + 30 * MINUTE);
  const slot = nextSlotFor(store, settings, a, late, null, true);
  assert.ok(slot.at >= beijingDayStart(late) + 86_400_000);
  assert.match(slot.reason, /已顺延/);
});

test('published capacity belongs to the delivery day even when drafted yesterday', t => {
  const { store, a, add } = setup(t);
  const id = add(a.id, START, 'published');
  store.db.prepare('UPDATE posts SET created_at = ?, published_at = ? WHERE id = ?').run(START - 86_400_000, START, id);
  assert.equal(store.laneUsage(a.id, 'short', beijingDayStart(START)), 1);
});

test('column skips the strongest expiring material and writes a fresh alternative', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const { store, a, add } = setup(t);
  store.setLabelPersona(1, { name: '资金观察', tone: '冷静核账' });
  add(a.id, START, 'approved');
  for (const [symbol, age, change] of [['LATE', 150, -50], ['FRESH', 1, -3.42]] as const) {
    store.insertMaterial(makeMaterial({ category: 'funding', subType: 'funding_extreme', title: symbol, symbol,
      source: 'test', at: START - age * MINUTE, sentiment: 'bear', score: 80,
      facts: { cashtag: `$${symbol}`, funding: -0.0125, annualized: -70.2, payer: '空头', intervalHours: 8,
        price: 1.234, longRatio: 0.83, shortRatio: 1.2, chg24h: change, chg1h: -0.41,
        volMultiple: 2.1, oiChangePct: -8.8, quoteVolume24h: 65_000_000 },
    }));
  }
  const r = await generateColumn(store, { ...settings, autoPublish: false, columnPostsPerDay: 12, activeExperiments: [], attachChart: false }, a);
  assert.equal(r.created.length, 1, r.skipped.join(' | '));
  assert.equal(r.created[0]!.symbol, 'FRESH');
});

test('old duplicate drafts release capacity; human drafts and uncertain sends survive', t => {
  const { store, a, add } = setup(t);
  const own = add(a.id, START, 'draft', 'column.recap');
  const cross = add(a.id, START, 'draft', 'column.recap');
  store.updatePost(own, { error: '发布前发现与已发帖子结构重复，已退回草稿' });
  store.updatePost(cross, { error: '与「矩阵1」近期文案句式相同（相似度 63%），已退回草稿' });
  const human = add(a.id, START, 'draft', null);
  const uncertain = add(a.id, START, 'uncertain');
  assert.equal(retireStaleDrafts(store, START), 2);
  assert.equal(store.postById(own)!.status, 'rejected');
  assert.equal(store.postById(cross)!.status, 'rejected');
  assert.equal(store.postById(human)!.status, 'draft');
  assert.equal(store.postById(uncertain)!.status, 'uncertain');
  assert.equal(store.pendingQueueCount(a.id), 1);
});

test('material-less recaps expire without expiring unrelated manual drafts', t => {
  const { store, a, add } = setup(t);
  const recap = add(a.id, START, 'approved', 'column.recap');
  const manual = add(a.id, START, 'draft', null);
  store.db.prepare('UPDATE posts SET created_at = ?').run(START - 2 * 86_400_000);
  retireStaleDrafts(store, START);
  assert.equal(store.postById(recap)!.status, 'rejected');
  assert.equal(store.postById(manual)!.status, 'draft');
});

test('reflow reclaims expired-slot holes but preserves manual and next-day schedules', t => {
  const { store, a, b, add } = setup(t);
  const removed = add(a.id, START + 80 * MINUTE, 'rejected');
  const pending = add(a.id, START + 160 * MINUTE);
  const tomorrow = add(b.id, START + 86_400_000);
  const manual = add(b.id, START + 5 * MINUTE);
  store.db.prepare('UPDATE posts SET trace_json = NULL WHERE id = ?').run(manual);
  assert.equal(reflowApproved(store, settings, START), 1);
  assert.equal(store.postById(pending)!.scheduled_at, START + 19 * MINUTE);
  assert.equal(store.postById(tomorrow)!.scheduled_at, START + 86_400_000);
  assert.equal(store.postById(manual)!.scheduled_at, START + 5 * MINUTE);
  assert.equal(store.postById(removed)!.status, 'rejected');
});

test('two accounts can deliver twelve each with a lost draft, polling delays, and all gaps intact', t => {
  const { store, a, b, add } = setup(t);
  const sent: { account: number; at: number }[] = [];
  let lost = false;
  for (let at = START; at < START + 16 * 60 * MINUTE; at += 15 * MINUTE) {
    reflowApproved(store, settings, at);
    for (const acct of [a, b]) {
      for (let n = store.pendingQueueCount(acct.id); n < 2; n++) {
        if (store.accountPostsToday(acct.id, beijingDayStart(at)) + n >= 12) break;
        const slot = nextSlotFor(store, settings, acct, at, null, true);
        if (!slot.allowed || slot.at >= START + 16 * 60 * MINUTE) break;
        add(acct.id, slot.at);
      }
      const due = store.approvedForAccount(acct.id, 20).find(p => p.scheduled_at! <= at);
      if (!due || !nextSlotFor(store, settings, acct, at, { id: due.id, at: due.scheduled_at! }).allowed) continue;
      const gate = nextSlotFor(store, settings, acct, at, { id: due.id, at: due.scheduled_at! });
      if (gate.at > at) continue;
      if (!lost && sent.length === 4) {
        store.updatePost(due.id, { status: 'rejected', error: '模拟素材失效' });
        lost = true;
        continue;
      }
      store.updatePost(due.id, { status: 'published', publishedAt: at });
      sent.push({ account: acct.id, at });
    }
  }
  assert.ok(lost);
  for (const acct of [a, b]) {
    const own = sent.filter(p => p.account === acct.id);
    assert.equal(own.length, 12);
    own.slice(1).forEach((p, i) => assert.ok(p.at - own[i]!.at >= 45 * MINUTE));
  }
  sent.slice(1).forEach((p, i) => assert.ok(p.at - sent[i]!.at >= 14 * MINUTE));
});

test('column delivery compares content while ordinary template swaps remain blocked', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const { store, a, add } = setup(t);
  const oldText = '$AAA 资金费率 -0.123%，24 小时 +16.27%，持仓 +36.28%。不构成投资建议。';
  const newText = '$BBB 资金费率 +0.891%，24 小时 -43.69%，持仓 -71.54%。不构成投资建议。';
  assert.ok(isStructuralDuplicate(newText, [oldText]));
  assert.equal(publicationDuplicate(newText, [oldText], 'column.anomaly'), null);
  assert.ok(publicationDuplicate(newText, [oldText], 'funding.tech'));
  const old = add(a.id, START - 5 * 3600_000, 'published', 'column.anomaly');
  store.updatePostText(old, oldText);
  store.updatePost(old, { publishedAt: START - 5 * 3600_000 });
  const id = add(a.id, START, 'approved', 'column.anomaly');
  store.updatePostText(id, newText);
  const report = await publishDue(store, settings, { live: false, account: a });
  assert.equal(report.published.length, 1, JSON.stringify(report.failed));
  assert.equal(store.postById(id)!.status, 'approved', 'a drill must leave the live queue intact');
});
