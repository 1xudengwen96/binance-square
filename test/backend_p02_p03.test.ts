import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import { beijingDayStart } from '../src/schedule.ts';
import { laneCap, laneRoom, tryAcquireLaneLease, poolEmptyReason } from '../src/lanes.ts';
import { ALERT_KINDS, activeAlerts, dayGapReason, findActive, noteGapReason, raise, clear, ack } from '../src/alerts/bus.ts';
import { platformFlags } from '../src/stats/backfill.ts';
import { reconcileGapDay } from '../src/daemon.ts';
import { generate } from '../src/pipeline.ts';
import { generateColumn } from '../src/column.ts';
import { classifySkips, reportZeroPublish } from '../src/alerts/bus.ts';
import { makeMaterial } from '../src/material/types.ts';

function tempStore(): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-p023-'));
  const store = Store.open(join(dir, 't.db'));
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/* ------------------------------------------------------------------ labels --- */

test('labels: primary label is seeded, drafts take it by default, no active label refuses the draft', () => {
  const { store, close } = tempStore();
  try {
    const lid = store.activePrimaryLabelId();
    assert.ok(lid, '定稿主标签「盘面反常观察员」在 migrate 里播种');
    assert.equal(store.labelById(lid!)!.name, '盘面反常观察员');
    assert.equal(store.labelById(lid!)!.kind, 'primary');

    const pid = store.addPost({ materialId: null, templateId: null, text: 't', status: 'draft', scheduledAt: null });
    const row = store.postById(pid)!;
    assert.equal(row.label_id, lid, 'label_id 必填：没点名就落主标签');

    store.db.prepare("UPDATE labels SET status = 'retired' WHERE id = ?").run(lid!);
    assert.equal(store.activePrimaryLabelId(), null);
    assert.throws(
      () => store.addPost({ materialId: null, templateId: null, text: 't2', status: 'draft', scheduledAt: null }),
      /label_id 必填/,
      '主标签退役后忘了补位 ⇒ 拒写记不了账的草稿，而不是静默发无标签帖',
    );
  } finally {
    close();
  }
});

test('labels: 草稿必须挂账号 — addArticle refuses a draft without an owner', () => {
  const { store, close } = tempStore();
  try {
    assert.throws(
      () => store.addArticle({ trackId: 'trading_literacy', conceptId: 'oi_vs_volume', accountId: null, title: 't', body: 'b' }),
      /草稿必须挂账号/,
    );
  } finally {
    close();
  }
});

/* ------------------------------------------------------------------- lanes --- */

test('lanes: 长文 ≤2 硬上限压过配置漂移；租约满后拒批；草稿本身即占用', () => {
  const { store, close } = tempStore();
  try {
    const aid = store.createAccount({ label: 'zhang', enabled: true });
    store.bindStudioTrack(aid, 'trading_literacy');
    store.db.prepare('UPDATE studio_accounts SET articles_per_day = 5 WHERE account_id = ?').run(aid);
    const s = { ...DEFAULT_SETTINGS, postsPerDay: 4 };
    assert.equal(laneCap(store, s, aid, 'long'), 2, '定稿 §2：长文 ≤2/日，绑定配到 5 也不放开');

    const g1 = tryAcquireLaneLease(store, s, aid, 'long', 'studio', null, Date.now());
    assert.ok(g1.ok && g1.cap === 2);
    assert.equal(store.laneLeasesToday(aid, 'long', beijingDayStart(Date.now())).length, 1, '租约行是审计，占用由草稿自己数');

    store.addArticle({ trackId: 'trading_literacy', conceptId: 'oi_vs_volume', accountId: aid, symbol: 'X', title: 't1', body: 'b' });
    assert.equal(laneRoom(store, s, aid, 'long'), 1, '一篇草稿占用一个额度，与租约审计无关');
    store.addArticle({ trackId: 'trading_literacy', conceptId: 'oi_vs_volume', accountId: aid, symbol: 'X', title: 't2', body: 'b' });
    const g3 = tryAcquireLaneLease(store, s, aid, 'long', 'studio', null, Date.now());
    assert.ok(!g3.ok && /额度 2\/2 已满/.test(g3.reason!), `第三篇必须被拒：${g3.reason}`);
  } finally {
    close();
  }
});

test('lanes: 未绑定长文的账号 laneCap(long)=0，短帖额度随账号覆盖', () => {
  const { store, close } = tempStore();
  try {
    const aid = store.createAccount({ label: '短帖号', enabled: true, postsPerDay: 3 });
    const s = { ...DEFAULT_SETTINGS, postsPerDay: 8 };
    assert.equal(laneCap(store, s, aid, 'long'), 0, '没绑工作室就没有长文通道');
    assert.equal(laneCap(store, s, aid, 'short'), 3, 'posts_per_day 账号覆盖优先于全局');
  } finally {
    close();
  }
});

/* --------------------------------------------------------------------- bus --- */

test('bus: kind+key 去重合并、severity 单调升档、升档才重发', () => {
  const { store, close } = tempStore();
  try {
    const t0 = Date.UTC(2026, 9, 12, 0, 0, 0);
    const a = raise(store, { kind: ALERT_KINDS.stallWarning, severity: 'warning', key: 'matrix', now: t0 });
    assert.equal(a.fired, 'raised');
    const b = raise(store, { kind: ALERT_KINDS.stallWarning, severity: 'warning', key: 'matrix', now: t0 + 3_600_000 });
    assert.equal(b.fired, null, '同级重报只推进 lastAt/count，不重发事件');
    assert.equal(b.envelope.count, 2);
    assert.equal(b.envelope.firstAt, t0, 'firstAt 保首现');
    const c = raise(store, { kind: ALERT_KINDS.stallWarning, severity: 'breach', key: 'matrix', now: t0 + 20 * 3_600_000 });
    assert.equal(c.fired, 'escalated');
    assert.equal(c.envelope.severity, 'breach');
    assert.equal(activeAlerts(store).length, 1, '一条活动告警，不是三条');
    assert.equal(activeAlerts(store, t0 + 20 * 3_600_000)[0]!.ageHours, 20);
  } finally {
    close();
  }
});

test('bus: 降档被拒（只升不降）；ack 后同类同键静默 24h；clear 落 <kind>_clear 事件', () => {
  const { store, close } = tempStore();
  try {
    const t0 = Date.UTC(2026, 9, 12, 0, 0, 0);
    raise(store, { kind: ALERT_KINDS.collectGap, severity: 'fault', key: '7', now: t0 });
    const down = raise(store, { kind: ALERT_KINDS.collectGap, severity: 'warning', key: '7', now: t0 + 1000 });
    assert.equal(down.envelope.severity, 'fault', 'severity 单调：warning 压不动 fault');

    assert.ok(ack(store, ALERT_KINDS.collectGap, '7', 'operator', t0 + 2000));
    const muted = raise(store, { kind: ALERT_KINDS.collectGap, severity: 'fault', key: '7', now: t0 + 3600_000 });
    assert.equal(muted.fired, null, 'ack 后 24h 内静默');

    const cleared = clear(store, ALERT_KINDS.collectGap, '7', t0 + 4000);
    assert.ok(cleared);
    assert.equal(findActive(store, ALERT_KINDS.collectGap, '7'), null);
    const evs = store.db.prepare('SELECT kind FROM events ORDER BY id').all() as { kind: string }[];
    assert.ok(evs.some(e => e.kind === 'collect_gap_clear'), '关档要留事件，面板才知道灯为什么灭的');
  } finally {
    close();
  }
});

test('bus: loop_stalled 折叠四态——一条全局 key="loop"，subreason 集合在合并后保留', () => {
  const { store, close } = tempStore();
  try {
    raise(store, { kind: ALERT_KINDS.loopStalled, severity: 'fault', key: 'loop', subreason: 'tick_stale' });
    raise(store, { kind: ALERT_KINDS.loopStalled, severity: 'fault', key: 'loop', subreason: 'tick_reports_failure' });
    const acts = activeAlerts(store);
    assert.equal(acts.length, 1);
    assert.equal(acts[0]!.subreason, 'tick_reports_failure');
    assert.deepEqual(
      [...(acts[0]!.extra!.subreasons as string[])].sort(),
      ['tick_reports_failure', 'tick_stale'],
      '分态可还原（契约 §3 v1.1）',
    );
  } finally {
    close();
  }
});

test('bus: credential_missing 成对读——账号级缺键带 accountId 键，全局缺键用 global', () => {
  const { store, close } = tempStore();
  try {
    raise(store, { kind: ALERT_KINDS.credentialMissing, severity: 'fault', key: '8', subreason: 'square_key_missing' });
    raise(store, { kind: ALERT_KINDS.credentialMissing, severity: 'fault', key: 'global', subreason: 'square_key_missing' });
    assert.equal(activeAlerts(store).length, 2, '两个缺键面不合并成一条');
  } finally {
    close();
  }
});

/* --------------------------------------------------------- gap 对账与因由码 --- */

test('gap: 计划内空档有码不判故障；无码的应发缺口升 expected_gap', () => {
  const { store, close } = tempStore();
  try {
    const aid = store.createAccount({ label: 'zhang', enabled: true });
    const s = { ...DEFAULT_SETTINGS, postsPerDay: 4 };
    const dayStart = beijingDayStart(Date.UTC(2026, 9, 11, 16, 0, 0)); // 北京 2026-10-12 00:00
    const notes: string[] = [];
    // 应发 4（短帖）+ 0（无长文绑定），实发 0，无码 ⇒ expected_gap。
    reconcileGapDay(store, s, dayStart, notes);
    const eg = findActive(store, ALERT_KINDS.expectedGap, String(dayStart));
    assert.ok(eg && eg.severity === 'fault', '无码的「没发」本身就是故障');
    clear(store, ALERT_KINDS.expectedGap, String(dayStart));

    noteGapReason(store, dayStart, 'no_material', 3);
    reconcileGapDay(store, s, dayStart, notes);
    assert.equal(findActive(store, ALERT_KINDS.expectedGap, String(dayStart)), null, '有码有样本的空档不判故障');
    const rec = dayGapReason(store, dayStart);
    assert.equal(rec!.code, 'no_material');
    assert.equal(rec!.samples, 3, '窗内样本数随码落账');
    void aid;
  } finally {
    close();
  }
});

test('gap: poolEmptyReason 分两形态——一个启用号都没有 ≠ 有号但全被额度关住', () => {
  const { store, close } = tempStore();
  try {
    const s = { ...DEFAULT_SETTINGS, postsPerDay: 1 };
    assert.equal(poolEmptyReason(store, s), 'human_pause', 'enabled=0 只有 PATCH 审计路径写得出，算人为停用');
    const aid = store.createAccount({ label: 'zhang', enabled: true });
    store.addPost({ materialId: null, templateId: null, text: 't', status: 'draft', scheduledAt: null, accountId: aid });
    assert.equal(poolEmptyReason(store, s), 'quota_spent');
  } finally {
    close();
  }
});

/* ------------------------------------------------------------ 旗标三件套 --- */

test('flags: missing ≠ pass——键不在就是 NULL，绝不默认成 0/未旗标', () => {
  const { store, close } = tempStore();
  try {
    assert.deepEqual(platformFlags({} as never), { createdByAi: null, factCheckStatus: null, blockType: null, rejectReason: null });
    assert.equal(platformFlags({ isCreatedByAI: true } as never).createdByAi, 1);
    assert.equal(platformFlags({ isCreatedByAI: false } as never).createdByAi, 0);
    assert.equal(platformFlags({ blockType: 'RESTRICT' } as never).blockType, 'RESTRICT');

    // 写读闭环：一条只有 views 的回抓不能把旗标列写成 0。
    const pid = store.addPost({ materialId: null, templateId: null, text: 't', status: 'published', scheduledAt: null });
    store.recordPostStats(pid, 1, { views: 10, likes: 0, comments: 0, flags: platformFlags({} as never) });
    const row = store.db.prepare('SELECT created_by_ai, fact_check_status, block_type FROM post_stats WHERE post_id = ?').get(pid) as
      { created_by_ai: number | null; fact_check_status: string | null; block_type: string | null };
    assert.equal(row.created_by_ai, null);
    assert.equal(row.block_type, null);
  } finally {
    close();
  }
});

/* -------------------------------------------------- symbol 上限的总线半边 --- */

test('surge_blocked: 命中 24h symbolDailyCap 的 skip 路径同步上总线（v1.5 §7.9 同一闸门）', async () => {
  const { store, close } = tempStore();
  try {
    store.setLabelPersona(1, { name: '测试人设', tone: '测试口径' }); // 闸门放行，才能测到 symbol 上限那一格
    const aid = store.createAccount({ label: 'cap号', enabled: true });
    const acct = store.accountById(aid)!;
    const at = Date.now();
    const funding = (symbol: string, occurredAt: number) => {
      const m = makeMaterial({
        category: 'funding', subType: 'funding_extreme', title: `${symbol} 资金费率极端`, symbol,
        source: 'test', at: occurredAt, sentiment: 'bear', score: 80,
        facts: {
          cashtag: `$${symbol}`, funding: -0.0125, annualized: -70.2, payer: '空头', intervalHours: 8, price: 1.234,
          longRatio: 0.83, shortRatio: 1.2, chg24h: -3.42, chg1h: -0.41, volMultiple: 2.1, oiChangePct: -8.8,
        },
      });
      store.insertMaterial(m);
      return m;
    };
    // 两条旧稿用 onchain 类目：同币同类 12h 冷却只比同类，避开它才能命中跨类合计上限
    // （v1.5 §7.9 的主护栏就是 symbolDailyCap 这一格，测试要钉的就是它）。
    for (let i = 0; i < 2; i++) {
      const mm = makeMaterial({
        category: 'onchain', subType: 'oi_move', title: `CAPSYM 持仓变动 ${i}`, symbol: 'CAPSYM',
        source: 'test', at: at - (i + 1) * 3_600_000, score: 70,
        facts: { cashtag: '$CAPSYM', oiChangePct: -8.8, chg24h: -3.42, volMultiple: 2.1 },
      });
      store.insertMaterial(mm);
      const pid = store.addPost({ materialId: mm.id, templateId: null, text: `$CAPSYM 旧稿 ${i}。不构成投资建议。`, status: 'published', scheduledAt: null, accountId: aid });
      store.db.prepare('UPDATE posts SET published_at = ? WHERE id = ?').run(at - (i + 1) * 3_600_000, pid);
      store.markMaterialUsed(mm.id);
    }
    funding('CAPSYM', at - 60_000);
    const s = { ...DEFAULT_SETTINGS, autoPublish: true, dailyCap: 30, postsPerDay: 20, symbolDailyCap: 2, activeStartHour: 0, activeEndHour: 24 };
    await generate(store, s, 1, { account: acct });
    const a = findActive(store, ALERT_KINDS.surgeBlocked, `${aid}:CAPSYM`);
    assert.ok(a, '第 3 篇被 symbolDailyCap=2 拦下时必须能在灯里看见');
    assert.equal(a!.reasonCode, 'blocked_by_symbol_cap');
  } finally {
    close();
  }
});

/* ------------------------------------------------- persona 渲染闸门（P0-7） --- */

function fundingMat(store: Store, symbol: string, at: number) {
  const m = makeMaterial({
    category: 'funding', subType: 'funding_extreme', title: `${symbol} 资金费率极端`, symbol,
    source: 'test', at, sentiment: 'bear', score: 80,
    facts: {
      cashtag: `$${symbol}`, funding: -0.0125, annualized: -70.2, payer: '空头', intervalHours: 8, price: 1.234,
      longRatio: 0.83, shortRatio: 1.2, chg24h: -3.42, chg1h: -0.41, volMultiple: 2.1, oiChangePct: -8.8,
    },
  });
  store.insertMaterial(m);
  return m;
}

test('persona 空 → generate/column 直接 fail 并亮 label_gate_refusal；灌入后恢复出稿', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 12, 2, 0, 0) }); // QA-FLAKY-001 同款：钉死时钟，抽签是夹具不是彩票
  const { store, close } = tempStore();
  try {
    const s = { ...DEFAULT_SETTINGS, autoPublish: true, dailyCap: 30, postsPerDay: 20, activeStartHour: 0, activeEndHour: 24 };
    const acct = store.accountById(store.createAccount({ label: 'zhang2', enabled: true }))!;
    fundingMat(store, 'GATET', Date.now() - 60_000);
    const r = await generate(store, s, 3, { account: acct });
    assert.equal(r.created.length, 0, 'persona_json=null 时必须一稿不出——首帖漏网就是这个闸门没接线的代价');
    assert.match(r.skipped.join(' '), /渲染直接 fail（P0-7 闸门）/);
    assert.ok(findActive(store, ALERT_KINDS.labelGateRefusal, 'short'), '拒稿必须在灯上可读');

    const c = await generateColumn(store, s, acct);
    assert.equal(c.created.length, 0);
    assert.match(c.skipped.join(' '), /P0-7/);

    store.setLabelPersona(1, { name: '反常观察', tone: '冷静的核账人：先给方向判断，再给数', allowed_verbs: ['观察', '核对'], forbidden_claims: ['第一人称持仓'] });
    const r2 = await generate(store, s, 3, { account: acct });
    assert.ok(r2.created.length > 0, `手册灌入即恢复产出：${r2.skipped.join(' | ')}`);
    assert.equal(r2.created[0]!.text.length > 0, true);
  } finally {
    close();
  }
});

test('闸门键名校验：name/tone 非空字符串之外不设卡（其余键由内容层校验）', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 12, 2, 0, 0) }); // QA-FLAKY-001 同款：钉死时钟，抽签是夹具不是彩票
  const { store, close } = tempStore();
  try {
    store.setLabelPersona(1, { name: '反常观察', tone: '核账人' });
    const s = { ...DEFAULT_SETTINGS, autoPublish: true, dailyCap: 30, postsPerDay: 20, activeStartHour: 0, activeEndHour: 24 };
    const acct = store.accountById(store.createAccount({ label: 'zhang3', enabled: true }))!;
    fundingMat(store, 'GATEY', Date.now() - 60_000);
    const r = await generate(store, s, 3, { account: acct });
    assert.ok(r.created.length > 0, `仅 name+tone 就应过闸：${r.skipped.join(' | ')}`);
  } finally {
    close();
  }
});

/* -------------------------------------------------- 0 发轮的落码覆盖（缺陷①） --- */

test('classifySkips: 四类计划内理由各归各码，归不上的返回 null', () => {
  assert.equal(classifySkips(['STRK: 下一个可用时段已超出它的保质期（2 小时），不写注定作废的草稿']), 'no_material');
  assert.equal(classifySkips(['zhang：今日 4 篇额度已用完']), 'quota_spent');
  assert.equal(classifySkips(['熔断：最近 20 条浏览中位数 90 < 150']), 'breaker_on');
  assert.equal(classifySkips(['forwhat 账号已停用']), 'human_pause');
  assert.equal(classifySkips(['zhang：标签人设为空：persona_json 缺失，渲染直接 fail（P0-7 闸门）']), null, '闸门拒稿不许被折成 no_material——那是把红牌伪装成安静');
  assert.equal(classifySkips(['标签人设为空：渲染直接 fail（P0-7 闸门）', '42 条素材的保质期已过']), null, '同屏出现过期噪声时红牌仍是大声的那个');
  assert.equal(classifySkips(['某条没见过的新故障签名']), null);
});

test('reportZeroPublish: 没码的没发就地升预警；有码落账不升警；顺延轮沉默', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.UTC(2026, 9, 13, 1, 0, 0);
    const out = reportZeroPublish(store, ['完全无法归因的一轮'], 0, now);
    assert.equal(out, 'unmapped');
    const w = findActive(store, ALERT_KINDS.stallWarning, 'matrix', now);
    assert.ok(w && w.reasonCode === null, '没码=故障：不等 5h 就地亮，且带原始理由可读');
    assert.ok((w!.extra!.notes as string[]).includes('完全无法归因的一轮'));

    reportZeroPublish(store, ['zhang：素材全在保质期外，没有可写的概念'], 0, now + 60_000);
    assert.equal(findActive(store, ALERT_KINDS.expectedGap, 'x'), null); // 落码不等于升 expected_gap（那是日终的事）
    const rec = (store.getSetting<Record<string, { code: string }>>('gapReasons', {}))[String(Math.floor((now + 60_000 + 8 * 3600e3) / 86400e3) * 86400e3 - 8 * 3600e3)];
    assert.equal(rec!.code, 'no_material');

    const before = activeAlerts(store, now).length;
    const out3 = reportZeroPublish(store, ['未到发布时刻，顺延到 16:00'], 3, now + 120_000);
    assert.equal(out3, 'deferred');
    assert.equal(activeAlerts(store, now + 120_000).length, before, '健康队列等分钟不落码不升警');
  } finally {
    close();
  }
});
