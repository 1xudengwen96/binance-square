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

/** 发布 n 条，published_at 落在 [now-window, now-window+n) 的分钟级位置。 */
function seedPublished(store: Store, n: number, at: number): void {
  for (let i = 0; i < n; i++) {
    const id = store.addPost({ materialId: null, templateId: null, text: `t${at}_${i}`, status: 'published', scheduledAt: at });
    store.updatePost(id, { publishedAt: at + i * 60_000 });
  }
}

test('裁定八观察列：每日一样本，同日内重复调用是 no-op', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.UTC(2026, 9, 14, 1, 30); // 北京 10-14 09:30
    seedPublished(store, 2, now - 3 * 3_600_000);

    const first = observeRollingSeam(store, now);
    assert.ok(first, '当日前首个 live tick 必须落一条样本');
    assert.equal(first.day_start, beijingDayStart(now));
    assert.equal(first.count, 2, '读数=过去 24h 实发（posts+studio 同口径）');
    assert.equal(first.over, false, `≤${ROLLING_SEAM_OBS_LIMIT} 不触收紧`);

    // 同日再 tick（哪怕读数已过线）不重复取样——每日一次是裁定原文。
    // 5 条落在 14:30–14:34：同日窗内、跨日首调(10-15 19:30)的滚动窗（自 10-14 19:30 起）外。
    seedPublished(store, 5, now + 5 * 3_600_000);
    assert.equal(observeRollingSeam(store, now + 6 * 3_600_000), null, '同一北京日历日内第二调必 no-op');

    // 跨日后重新开样，且样本是新一日首调时刻的滚动 24h。
    const next = observeRollingSeam(store, now + DAY + 10 * 3_600_000);
    assert.ok(next, '跨日后的首调必须重新落样');
    assert.equal(next.day_start, beijingDayStart(now) + DAY);
    assert.equal(next.count, 0, '滚动 24h 与日历日不是一回事：前一日 09:30 后发的已全部出窗');
    assert.equal(next.over, false);

    const events = store.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'posts_rolling24h'")
      .get() as { n: number };
    assert.equal(events.n, 2, '每样一次落一条 event，第 7 天 a 表读它');
  } finally {
    close();
  }
});

test('裁定八观察列：读数 >4 当日即 over，但观察不碰任何额度', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.UTC(2026, 9, 14, 1, 30);
    seedPublished(store, ROLLING_SEAM_OBS_LIMIT + 1, now - 6 * 3_600_000); // 24h 窗内 5 条
    const obs = observeRollingSeam(store, now);
    assert.equal(obs!.count, 5);
    assert.equal(obs!.over, true, '>4 ⇒ 触发再收紧信号');
    // 观察是只读的：租约表与设置里的额度不因它变动。
    const leases = store.db.prepare('SELECT COUNT(*) AS n FROM lane_leases').get() as { n: number };
    assert.equal(leases.n, 0);
    const settings = store.getSetting<Record<string, unknown>>('settings', {});
    assert.deepEqual(settings, {}, '落观察不写 settings');
  } finally {
    close();
  }
});

test('裁定八观察列：24h 之外的旧帖不计入读数', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.UTC(2026, 9, 14, 1, 30);
    seedPublished(store, 3, now - 30 * 3_600_000); // 全部在 24h 窗外
    const obs = observeRollingSeam(store, now);
    assert.equal(obs!.count, 0);
    assert.equal(obs!.over, false);
  } finally {
    close();
  }
});
