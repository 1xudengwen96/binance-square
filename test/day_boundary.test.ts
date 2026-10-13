import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import type { Settings } from '../src/config.ts';
import { beijingDayStart } from '../src/schedule.ts';
import { generateColumn } from '../src/column.ts';
import { makeMaterial } from '../src/material/types.ts';

function tempStore(): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-dayb-'));
  const store = Store.open(join(dir, 't.db'));
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function fundingMat(store: Store, symbol: string, at: number) {
  const m = makeMaterial({
    category: 'funding', subType: 'funding_extreme', title: `${symbol} 资金费率极端`, symbol,
    source: 'test', at, sentiment: 'bear', score: 80,
    facts: {
      cashtag: `$${symbol}`, funding: -0.0125, annualized: -70.2, payer: '空头', intervalHours: 8, price: 1.234,
      longRatio: 0.83, shortRatio: 1.2, chg24h: -3.42, chg1h: -0.41, volMultiple: 2.1, oiChangePct: -8.8, quoteVolume24h: 65_000_000,
    },
  });
  store.insertMaterial(m);
  return m;
}

const dayStart = beijingDayStart(Date.UTC(2026, 9, 13, 16, 30)); // = 北京 10-14 00:00
const FIXED = dayStart + 30 * 60_000;                              // = 北京 10-14 00:30

// 定稿口径：每号 4 条/北京日历日。v1.6 裁定四查出的两处日界语义不一致——栏目上限原本按**滚动 24h**
// 计数（既不切 08:00 也不切 00:00），而通道租约切北京 00:00——本条把两者钉在同一个日界上：
// 昨 23:30 的帖不挡今 00:30 的额度，租约行的 day_start 等于同一个北京 00:00。
test('栏目额度与通道租约同一个日界：北京日历日 00:00 切，不滚动 24 小时', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED });
  const { store, close } = tempStore();
  try {
    store.setLabelPersona(1, { name: '反常观察', tone: '冷静的核账人' });
    const aid = store.createAccount({ label: 'zhangD', enabled: true });
    const a = store.accountById(aid)!;
    // 窗 [0,2) 让 00:30 在活跃窗内且名义间隔取 minInterval=45，槽不落进 05:30 之外被保质期挡下。
    const s: Settings = { ...DEFAULT_SETTINGS, autoPublish: true, columnPostsPerDay: 1, activeExperiments: [], activeStartHour: 0, activeEndHour: 2 };

    // 昨天 23:30（北京）的一栏帖：滚动 24h 会把它算进"今天还能不能写"，北京日历日不该算。
    const y = store.addPost({ materialId: null, templateId: 'column.question', text: `昨 23:30 的观察 $DAYB。不构成投资建议。`, status: 'approved', scheduledAt: dayStart - 30 * 60_000, accountId: aid });
    store.db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(dayStart - 30 * 60_000, y);
    fundingMat(store, 'DAYB', FIXED - 60_000);

    const r1 = await generateColumn(store, s, a, { now: FIXED });
    assert.equal(r1.skipped.filter(x => /今日（北京日历日）已有/.test(x)).length, 0, `昨 23:30 的帖不能挡今 00:30 的额度：${r1.skipped.join(' | ')}`);
    assert.equal(r1.created.length, 1, `日历日额度今天还是满格，必须出稿：${r1.skipped.join(' | ')}`);

    // 今天 00:30 这一条把 perDay=1 用满，同日的第二次调用必须被上限挡下——挡下的口径也是同一个北京日。
    const r2 = await generateColumn(store, s, a, { now: FIXED + 1 });
    assert.match(r2.skipped.join(' '), /今日（北京日历日）已有 1 条（上限 1）/, '上限消息必须按北京日历日表述，不再出现"近 24 小时"');
    const f = (store.db.prepare("SELECT detail FROM events WHERE kind='column_funnel' ORDER BY id").all() as { detail: string }[])
      .map(x => JSON.parse(x.detail));
    const drop = f.filter(x => x.outcome === 'dropped' && x.drop === 'queued_ceiling').pop();
    assert.ok(drop && drop.queued === 1, `queued_ceiling 落点按日历日计：${JSON.stringify(f.slice(-4))}`);

    // 租约行与额度同一个日界：新帖记的 lane lease 的 day_start 就是同一个北京 00:00。
    const lease = store.db.prepare('SELECT day_start FROM lane_leases WHERE account_id = ? ORDER BY id DESC LIMIT 1').get(aid) as { day_start: number };
    assert.equal(lease.day_start, dayStart, 'recordLaneLease 的 day_start 必须与栏目额度用同一个北京日历日界');
  } finally {
    close();
  }
});
