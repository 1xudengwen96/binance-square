/**
 * 运行台状态层（app.js 末尾那一段）的单元测试。
 *
 * 它把「面板能看见的事实」翻译成后端契约（shared/告警总线契约v1.md，v1.1）的信封，并决定
 * 标题灯 / 图标 / 系统通知。规则错一条，要么停摆没人知道，要么素材荒被当故障天天报警、
 * 最后没人看通知 —— 两边都是上一轮真发生过的形态，所以这些断言不是形式。
 *
 * 面板脚本是浏览器全局脚本。这里不模拟 DOM：只截到启动代码之前，把逻辑取出来跑。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';

const HOUR = 3600_000;
const NOW = 1_760_000_000_000;

type Panel = Record<string, unknown>;

function loadPanel(permission = 'granted'): { panel: Panel; document: { title: string }; made: unknown[][] } {
  const src = readFileSync(join(import.meta.dirname, '../src/server/public/app.js'), 'utf8');
  // 启动行要找准：toggleTheme 里也写 documentElement.dataset.theme，短前缀会切在函数中间。
  const boot = src.indexOf("document.documentElement.dataset.theme = localStorage.getItem('sf-theme') || 'dark';");
  assert.ok(boot > 0, 'boot line not found in app.js');
  const made: unknown[][] = [];
  const storage = new Map<string, string>();
  const document = { title: '' };
  const NotificationStub = new Proxy(function () {}, {
    get: (_t, p) => (p === 'permission' ? permission : undefined),
    construct: (_t, args) => { made.push(args); return {}; },
  });
  const ctx: Record<string, unknown> = {
    document,
    Notification: NotificationStub,
    location: { hash: '' },
    localStorage: { getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null), setItem: (k: string, v: string) => { storage.set(k, String(v)); } },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
    console,
  };
  // 顶层 const/let 不会挂到 global 上，取出来得靠一段显式导出。
  const EXPORTS = '\nglobalThis.__panel = { opsState, mergeAlerts, envelope, opsNotify, paintOpsTitle, CONTRACT_KINDS, NOT_WIRED_YET, PLANNED_CODES, sevRank };\n';
  runInNewContext(src.slice(0, boot) + EXPORTS, ctx, { filename: 'app.js' });
  return { panel: ctx.__panel as Panel, document, made };
}

type Api = {
  opsState: (s: object, now?: number) => any;
  mergeAlerts: (a: any[]) => any[];
  envelope: (k: string, s: string, key: string, d: string, o?: object) => any;
  opsNotify: (r: any, now?: number) => any[];
  paintOpsTitle: (r: any) => void;
  CONTRACT_KINDS: Set<string>;
  NOT_WIRED_YET: string[];
};
const P = (p: Panel) => p as unknown as Api;

const state = (over: Record<string, unknown> = {}) => ({
  settings: { dailyCap: 4, autoRun: true, autoPublish: true },
  accounts: [{ id: 8, enabled: true, trackId: null }],
  hasKey: true, pause: { paused: false }, publishedToday: 1, pending: 0, orphanPending: 0,
  unused: 12, loop: { lastTick: { at: NOW - 5 * 60_000, failed: 0 } }, ...over,
});

test('an account pool with nothing publishable is a fault, not a planned gap', () => {
  const { panel } = loadPanel(); const api = P(panel);
  // 启用中的号全被长文工作室占用：上一轮「启用了 zhang，短帖还是发不出去」的真实形态。
  const r = api.opsState(state({ accounts: [{ id: 8, enabled: true, trackId: 'trading_literacy' }] }), NOW);
  assert.equal(r.worst, 'fault');
  assert.equal(r.live[0].kind, 'account_pool_empty');
  assert.equal(r.live[0].key, 'matrix');
  assert.equal(r.live[0].reasonCode, null, '一个说不清的停摆不许借用计划内的因由码');

  const off = api.opsState(state({ accounts: [{ id: 8, enabled: false, trackId: null }] }), NOW);
  assert.equal(off.worst, 'fault');
  assert.equal(off.live[0].kind, 'account_pool_empty');
});

test('planned gaps carry a code and never reach the live list', () => {
  const { panel } = loadPanel(); const api = P(panel);
  const noMaterial = api.opsState(state({ unused: 0 }), NOW);
  assert.equal(noMaterial.live.length, 0);
  assert.equal(noMaterial.worst, 'info', '素材荒不该让灯变红');
  assert.equal(noMaterial.planned[0].reasonCode, 'no_material');

  const spent = api.opsState(state({ publishedToday: 4 }), NOW);
  assert.equal(spent.planned.find((a: any) => a.reasonCode === 'quota_spent').severity, 'info');
  assert.equal(spent.live.length, 0);

  const paused = api.opsState(state({ pause: { paused: true, reason: '人为暂停', at: NOW - HOUR } }), NOW);
  assert.equal(paused.planned[0].reasonCode, 'human_pause');
  assert.equal(paused.live.length, 0, '有暂停记录就不算账号池故障');
});

test('the four loop states collapse into one contract kind, per 契约 v1.1', () => {
  const { panel } = loadPanel(); const api = P(panel);
  const stale = api.opsState(state({ loop: { lastTick: { at: NOW - 3 * HOUR, failed: 0 } } }), NOW);
  assert.equal(stale.live[0].kind, 'loop_stalled');
  assert.equal(stale.live[0].key, 'loop', '全局只许一条活动停摆告警，不许四态各开一条');
  assert.equal(stale.live[0].subreason, 'tick_stale');
  assert.equal(stale.worst, 'fault');

  const failing = api.opsState(state({ loop: { lastTick: { at: NOW - 60_000, failed: 1 } } }), NOW);
  assert.equal(failing.live.length, 1);
  assert.equal(failing.live[0].kind, 'loop_stalled');
  assert.equal(failing.live[0].subreason, 'tick_reports_failure');

  const never = api.opsState(state({ loop: {} }), NOW);
  assert.equal(never.live[0].subreason, 'tick_never_ran');

  // auto_run_off 单独出现：降 warning（契约 v1.1），且仍不另开 kind。
  const off = api.opsState(state({ settings: { dailyCap: 4, autoRun: false } }), NOW);
  assert.equal(off.live.length, 1);
  assert.equal(off.live[0].kind, 'loop_stalled');
  assert.equal(off.live[0].severity, 'warning');
  assert.equal(off.worst, 'warning', '只是关了自动，不该按故障弹通知');

  // 关自动 + tick 也陈旧：合成一条，等级取高的那个。
  const both = api.opsState(state({ settings: { dailyCap: 4, autoRun: false }, loop: { lastTick: { at: NOW - 5 * HOUR, failed: 0 } } }), NOW);
  assert.equal(both.live.length, 1);
  assert.equal(both.live[0].severity, 'fault');
  assert.equal(both.live[0].subreasons.sort().join(','), 'auto_run_off,tick_stale');
});

test('a missing square key is credential_missing at fault level (契约 v1.1)', () => {
  const { panel } = loadPanel(); const api = P(panel);
  const noKey = api.opsState(state({ hasKey: false }), NOW);
  const cred = noKey.live.find((a: any) => a.kind === 'credential_missing');
  assert.ok(cred, '缺 Key 必须进总线口径，不能留在面板自造的名目里');
  assert.equal(cred.severity, 'fault');
  assert.equal(cred.subreason, 'square_key_missing');
});

test('orphan posts display but never drive the light', () => {
  const { panel } = loadPanel(); const api = P(panel);
  const r = api.opsState(state({ orphanPending: 3 }), NOW);
  assert.equal(r.live.some((a: any) => a.kind === 'orphan_posts'), false, '后端从源头消灭的那类，面板不替它报警');
  assert.equal(r.shown.length, 1);
  assert.equal(r.shown[0].kind, 'orphan_posts');
  assert.equal(r.worst, 'info');
});

test('alerts merge on kind+key and only ever escalate', () => {
  const { panel } = loadPanel(); const api = P(panel);
  const merged = api.mergeAlerts([
    api.envelope('collect_gap', 'warning', 'a7', 'first'),
    api.envelope('collect_gap', 'info', 'a7', 'lower arrives later'),
    api.envelope('collect_gap', 'breach', 'a7', 'escalated'),
    api.envelope('collect_gap', 'warning', 'a9', 'other article stays separate'),
  ]);
  assert.equal(merged.length, 2);
  const a7 = merged.find((a: any) => a.key === 'a7');
  assert.equal(a7.severity, 'breach', '降级的后续读数不许把已升上去的等级拉回来');
  assert.equal(a7.count, 3);
  assert.equal(merged.find((a: any) => a.key === 'a9').severity, 'warning');
});

test('bus alerts keep their source and acknowledgements only mute, never erase', () => {
  const { panel } = loadPanel(); const api = P(panel);
  const r = api.opsState(state({
    alerts: [
      { kind: 'publish_stall_fault', severity: 'fault', key: 'matrix', detail: '12h 未确认', acked: false },
      { kind: 'image_missing', severity: 'fault', key: '334', detail: '声明 required 但广场无图', acked: true },
    ],
  }), NOW);
  assert.equal(r.worst, 'fault');
  assert.equal(r.live.map((a: any) => a.kind).join(','), 'publish_stall_fault');
  assert.equal(r.live[0].source, 'bus');
  assert.ok(r.all.some((a: any) => a.kind === 'image_missing' && a.acked), '已确认的仍在表里，只是不再报警');
});

test('notifications fire at fault level once, then throttle for 20 hours', () => {
  const { panel, made } = loadPanel(); const api = P(panel);
  const res = api.opsState(state({ accounts: [], loop: { lastTick: { at: NOW - 3 * HOUR, failed: 0 } } }), NOW);
  const fired = api.opsNotify(res, NOW);
  // account_pool_empty 与 loop_stalled 都是 fault，warning 级不许弹 —— 洪水会让人直接关掉权限。
  assert.equal(fired.map((a: any) => a.kind).sort().join(','), 'account_pool_empty,loop_stalled');
  assert.equal(api.opsNotify(res, NOW + HOUR).length, 0);
  assert.equal(api.opsNotify(res, NOW + 21 * HOUR).length, 2);
  assert.equal(made.length, 4);
});

test('notifications stay silent until the operator grants permission', () => {
  const { panel } = loadPanel('denied'); const api = P(panel);
  const res = api.opsState(state({ accounts: [] }), NOW);
  assert.equal(res.worst, 'fault');
  assert.equal(api.opsNotify(res, NOW).length, 0);
});

test('the title light follows the worst unacked level', () => {
  const { panel, document } = loadPanel(); const api = P(panel);
  api.paintOpsTitle(api.opsState(state({ accounts: [] }), NOW));
  assert.match(document.title, /^■ /);
  assert.match(document.title, /可发布账号集合为空/);
  api.paintOpsTitle(api.opsState(state({ unused: 0 }), NOW));
  assert.match(document.title, /^● 正常/);
});

test('the panel never claims it cannot see something it does compute', () => {
  const { panel } = loadPanel(); const api = P(panel);
  for (const k of api.NOT_WIRED_YET) assert.ok(api.CONTRACT_KINDS.has(k), `${k} 不是契约里的 kind`);
  const computed: string[] = api.opsState(state({ hasKey: false, orphanPending: 2, loop: {} }), NOW)
    .all.map((a: any) => String(a.kind));
  for (const k of new Set(computed)) {
    assert.ok(!api.NOT_WIRED_YET.includes(k), `${k} 面板自己算得出来，却列进了「还没接上」`);
  }
  // 面板现在能算的契约 kind，必须都在契约表里 —— 自造名目驱动灯是本项目要消灭的东西。
  for (const k of new Set(computed)) {
    if (k === 'orphan_posts') continue;
    assert.ok(api.CONTRACT_KINDS.has(k), `${k} 不在契约 15 个 kind 内，却在驱动标题灯`);
  }
});
