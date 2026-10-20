import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/config.ts';
import { setSecret } from '../src/secrets.ts';
import { buildSnapshot } from '../src/brain/snapshot.ts';
import { runWeekly } from '../src/brain/weekly.ts';
import {
  MAX_OPEN, fileFromReply, fileUpgrade, listUpgrades, parseUpgrades, resolveUpgrade, similarity, stripUpgrades, upgradesForSnapshot, upgradesMarkdown,
} from '../src/brain/upgrades.ts';

function tempStore(): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-upg-'));
  const store = Store.open(join(dir, 't.db'));
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const HEAT = { area: 'data', title: '浏览数据按币种热度分层', why: 'chart 127/19 对 text 111/19，未分层无法判断方向' };

test('UPGRADE lines are parsed wherever they sit, capped, and stripped from the report body', () => {
  const reply = [
    '## 5 本周唯一建议', '还不知道。',
    'UPGRADE|data|浏览数据按币种热度分层|chart 与 text 差距 127 对 111，未分层',
    '- ACTION|UPGRADE|experiment|评论恒为零导致互动实验无法比较|14 天 9937 次浏览 0 评论',
    'UPGRADE|nonsense|快照里三处计数口径对不上|栏目表 7 条，臂里 5 条',
    'UPGRADE|data|短|太短会被丢弃',
    'UPGRADE|data|第四条超出单次上限的需求|只收三条',
  ].join('\n');
  const u = parseUpgrades(reply);
  assert.equal(u.length, 3);
  assert.equal(u[1]!.area, 'experiment', 'the ACTION| prefix a model reaches for is accepted');
  assert.equal(u[2]!.area, 'other', 'an unknown area is kept, not dropped');
  assert.doesNotMatch(stripUpgrades(reply), /UPGRADE\|/);
  assert.match(stripUpgrades(reply), /还不知道/);
});

test('the same request in other words bumps a count instead of adding a row', () => {
  const { store, close } = tempStore();
  try {
    const a = fileUpgrade(store, HEAT, { source: 'weekly', reportId: 9 });
    assert.equal(a.kind, 'new');
    assert.ok(similarity('浏览数据按币种热度分层', '把浏览数据按币种和热度做分层') >= 0.5);
    const b = fileUpgrade(store, { area: 'data', title: '把浏览数据按币种和热度做分层', why: '新证据' }, { source: 'reflect' });
    assert.equal(b.kind, 'repeat');
    const rows = listUpgrades(store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.times, 2);
    assert.equal(rows[0]!.why, '新证据', 'the latest evidence replaces the old');
    assert.equal(fileUpgrade(store, { area: 'publish', title: '发布前复核行情的耗时太长', why: '单条 23 秒' }, { source: 'sentinel' }).kind, 'new', 'a different request is a new row');
  } finally { close(); }
});

test('done and refused need a sentence, and a repeat does not reopen either', () => {
  const { store, close } = tempStore();
  try {
    const r = fileUpgrade(store, HEAT, { source: 'weekly' });
    assert.equal(r.kind, 'new');
    const id = (r as { id: number }).id;
    assert.equal(resolveUpgrade(store, id, 'done', '').ok, false);
    assert.equal(resolveUpgrade(store, id, 'wontfix', '  ').ok, false);
    assert.equal(resolveUpgrade(store, id, 'doing').ok, true);
    assert.equal(resolveUpgrade(store, id, 'done', '快照加了按成交额分档的浏览中位数').ok, true);
    const again = fileUpgrade(store, HEAT, { source: 'weekly' });
    assert.deepEqual(again, { kind: 'repeat', id, status: 'done' });
    const row = listUpgrades(store)[0]!;
    assert.equal(row.status, 'done');
    assert.equal(row.resolution, '快照加了按成交额分档的浏览中位数');
    assert.equal(resolveUpgrade(store, 999, 'doing').ok, false);
  } finally { close(); }
});

test('the open list is capped, so a chatty model cannot bury the operator', () => {
  const { store, close } = tempStore();
  try {
    const titles = [
      '浏览数据按币种热度分层', '快照计数口径统一', '评论采集链路核实', '发布前复核提速', '图表配色切换开关', '长文模板增加结论段',
      '素材保质期分类调整', '代理断线自动告警', '回抓失败重试策略', '面板显示实验进度条', '对账帖增加涨跌幅', '热榜样本按语言过滤',
      '变体效果单独统计', '冷启动账号降低频率', '周报自动推送飞书', '多账号撞句检测加严',
    ];
    const results = titles.map(t => fileUpgrade(store, { area: 'other', title: t, why: '证据证据' }, { source: 'reflect' }));
    assert.equal(results.filter(r => r.kind === 'new').length, MAX_OPEN);
    assert.equal(results.at(-1)!.kind, 'refused');
  } finally { close(); }
});

test('the snapshot hands the backlog back, and the markdown brief carries the evidence', () => {
  const { store, close } = tempStore();
  try {
    fileUpgrade(store, HEAT, { source: 'weekly', reportId: 9 });
    const done = fileUpgrade(store, { area: 'experiment', title: '栏目判断口径太严导致成立率失真', why: '22 条成立 3 条' }, { source: 'weekly' });
    resolveUpgrade(store, (done as { id: number }).id, 'done', '新判断改为同一边仍在付费即成立');
    const snap = buildSnapshot(store, DEFAULT_SETTINGS, Date.now());
    assert.equal(snap.upgrades.open.length, 1);
    assert.equal(snap.upgrades.resolved[0]!.resolution, '新判断改为同一边仍在付费即成立');
    const md = upgradesMarkdown(store);
    assert.match(md, /## #\d+ 浏览数据按币种热度分层/);
    assert.match(md, /chart 127\/19/);
    assert.match(md, /报告 #9/);
    assert.doesNotMatch(md, /栏目判断口径/, 'done items are not in the brief');
    assert.equal(upgradesForSnapshot(store).open[0]!.times, 1);
  } finally { close(); }
});

test('a weekly review files its UPGRADE lines and keeps them out of the report body', async () => {
  const { store, close } = tempStore();
  const realFetch = globalThis.fetch;
  try {
    setSecret(store, 'openaiApiKey', 'sk-test');
    const s: Settings = { ...DEFAULT_SETTINGS, llmEnabled: true, llmProvider: 'openai', llmBaseUrl: 'https://relay.test/v1', llmModel: 'm', brainWeekly: true };
    const body = [
      '## 1 关卡状态', 'A 未过。', '## 2 假设账本', '无变化。', '## 3 失败账本', '本周没有', '## 4 对照重测', '无', '## 5 本周唯一建议', '还不知道。', '## 6 自检', '无',
      'UPGRADE|data|浏览数据按币种热度分层|未分层无法判断方向',
    ].join('\n');
    globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: body } }] }) })) as unknown as typeof fetch;
    const r = await runWeekly(store, s, Date.now(), true);
    assert.equal(r.ok, true, r.note);
    assert.match(r.note, /登记了 1 条/);
    const rep = store.db.prepare('SELECT body FROM brain_reports WHERE id = ?').get(r.reportId) as { body: string };
    assert.doesNotMatch(rep.body, /UPGRADE\|/);
    const rows = listUpgrades(store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.source, 'weekly');
    assert.equal(rows[0]!.report_id, r.reportId);
    assert.deepEqual(fileFromReply(store, '没有需求', { source: 'reflect' }), []);
  } finally {
    globalThis.fetch = realFetch;
    close();
  }
});
