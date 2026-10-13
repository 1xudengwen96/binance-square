import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { beijingDayStart } from '../src/schedule.ts';
import { observeRollingSeam, ROLLING_SEAM_OBS_LIMIT } from '../src/obs/rolling.ts';

function tempStore(): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-seam-'));
  const store = Store.open(join(dir, 't.db'));
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const DAY = 24 * 3_600_000;
const HOUR = 3_600_000;

function seedPublished(store: Store, accountId: number, n: number, at: number): void {
  for (let i = 0; i < n; i++) {
    const id = store.addPost({ materialId: null, templateId: null, text: `t${accountId}_${at}_${i}`, status: 'published', scheduledAt: at });
    store.updatePost(id, { accountId, publishedAt: at + i * 60_000 });
  }
}

/* 北京 10-14 09:30 = UTC 10-14 01:30；日界 = 北京 10-14 00:00 = UTC 10-13 16:00。 */
const NOW = Date.UTC(2026, 9, 14, 1, 30);

test('裁定八观察列：逐号一行，rolling24h 与 calendar_day 两口径同落', () => {
  const { store, close } = tempStore();
  try {
    const a1 = store.createAccount({ label: 'a1', enabled: true });
    const a2 = store.createAccount({ label: 'a2', enabled: true });
    // a1：3 条在本北京日内（滚动窗与日历日都算），2 条落在昨日 20:30（只有滚动窗算得着）。
    seedPublished(store, a1, 3, NOW - 2 * HOUR);
    seedPublished(store, a1, 2, NOW - 13 * HOUR);
    // a2：1 条当日。
    seedPublished(store, a2, 1, NOW - HOUR);

    const obs = observeRollingSeam(store, NOW);
    assert.ok(obs, '当日前首个 live tick 必须落一条样本');
    assert.equal(obs.day_start, beijingDayStart(NOW));
    assert.equal(obs.rows.length, 2, '每号一行，不是全库一行');

    const r1 = obs.rows.find(r => r.account_id === a1)!;
    assert.equal(r1.rolling24h, 5, '滚动 24h 把昨日 20:30 那 2 条也算进来');
    assert.equal(r1.calendar_day, 3, '北京日历日只数 00:00 之后的');
    assert.equal(r1.over, true, `单号 rolling24h 5 > ${ROLLING_SEAM_OBS_LIMIT} ⇒ 过线`);

    const r2 = obs.rows.find(r => r.account_id === a2)!;
    assert.equal(r2.rolling24h, 1);
    assert.equal(r2.over, false);
    assert.equal(obs.over_count, 1);

    // 同日再 tick 不重复取样——每日一次是裁定原文。
    assert.equal(observeRollingSeam(store, NOW + HOUR), null, '同一北京日历日内第二调必 no-op');

    // 跨日重新开样。
    const next = observeRollingSeam(store, NOW + DAY + HOUR);
    assert.ok(next);
    assert.equal(next.day_start, beijingDayStart(NOW) + DAY);
    assert.equal(next.rows.find(r => r.account_id === a1)!.calendar_day, 0, '新日历日内 a1 还没发');
  } finally {
    close();
  }
});

test('观察列按号算触发线：全库 6 条（>4）但每号 ≤4 ⇒ 不过线（假信号回归）', () => {
  const { store, close } = tempStore();
  try {
    const a1 = store.createAccount({ label: 'a1', enabled: true });
    const a2 = store.createAccount({ label: 'a2', enabled: true });
    const a3 = store.createAccount({ label: 'a3', enabled: true });
    seedPublished(store, a1, 2, NOW - 2 * HOUR);
    seedPublished(store, a2, 2, NOW - 2 * HOUR);
    seedPublished(store, a3, 2, NOW - 2 * HOUR);

    const obs = observeRollingSeam(store, NOW)!;
    const total = obs.rows.reduce((s, r) => s + r.rolling24h, 0);
    assert.equal(total, 6, '全库合计已经越过 4');
    assert.equal(obs.over_count, 0, '但触发线来自「每号 4 条/日」，按号算一条都没过——健康日不得报收紧');
  } finally {
    close();
  }
});

test('观察列只读数，不碰额度；读数带 running_commit 供版本反推', () => {
  const { store, close } = tempStore();
  try {
    const a1 = store.createAccount({ label: 'a1', enabled: true });
    seedPublished(store, a1, ROLLING_SEAM_OBS_LIMIT + 1, NOW - 6 * HOUR);

    const obs = observeRollingSeam(store, NOW)!;
    assert.equal(obs.over_count, 1);
    assert.match(obs.running_commit, /^([0-9a-f]{7,40}|unknown)$/, '版本读数必须在样里，读不出写 unknown 不写空');

    const leases = store.db.prepare('SELECT COUNT(*) AS n FROM lane_leases').get() as { n: number };
    assert.equal(leases.n, 0, '观察不占租约');
    const s = store.getSetting<Record<string, unknown>>('settings', {});
    assert.deepEqual(s, {}, '观察不改任何已存设置（额度/间隔一个字节都不动）');

    const ev = store.db
      .prepare("SELECT detail FROM events WHERE kind = 'posts_rolling24h' ORDER BY id DESC LIMIT 1")
      .get() as { detail: string };
    assert.deepEqual(JSON.parse(ev.detail).rows.length, 1, 'event 落的就是那一行的数组，第 7 天 a 表直读');
  } finally {
    close();
  }
});
