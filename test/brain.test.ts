import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import { saveSettings, settingsFrom } from '../src/schedule.ts';
import { breaker, evaluateBreaker, gateReport, resetBreaker, effectiveTarget, GATE_LINES } from '../src/rank/gates.ts';
import { buildSnapshot, snapshotText } from '../src/brain/snapshot.ts';
import { detectAlarms, detectStalls, runSentinel } from '../src/brain/sentinel.ts';
import { tuneTemplateWeights } from '../src/stats/backfill.ts';
import { applyAction, approveReport, missingSections, parseActions, recommendationComplete, runWeekly, stripActions } from '../src/brain/weekly.ts';
import { activeVariants, BUILTIN_VARIANTS, isSafeVariant, seedVariants } from '../src/content/columns.ts';
import { judgeCalls, recapLineFor, registerCall, ruling, rulingFor, tally, unrecapped } from '../src/calls.ts';
import { sanitizeBrainSettings, brainReadiness } from '../src/server/brainRoutes.ts';
import { planArms } from '../src/rank/experiments.ts';
import { scoreAll } from '../src/rank/score.ts';
import { makeMaterial } from '../src/material/types.ts';
import { setSecret } from '../src/secrets.ts';

const DAY = 86_400_000;

function tempStore(): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-brain-'));
  const store = Store.open(join(dir, 't.db'));
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

let n = 0;
/** A published post with a 3h and a 24h reading. */
function post(store: Store, at: number, v24h: number, opts: { v3h?: number; comments?: number; template?: string } = {}): number {
  const sym = `T${n++}`;
  store.insertMaterial(makeMaterial({ category: 'funding', subType: 'funding_extreme', title: `${sym} x`, symbol: sym, source: 't', at, facts: {} }));
  const m = store.db.prepare('SELECT id FROM materials WHERE symbol = ?').get(sym) as { id: string };
  const id = store.addPost({ materialId: m.id, templateId: opts.template ?? 'column.ledger', text: `$${sym} t`, status: 'published', scheduledAt: null, images: [] });
  store.db.prepare('UPDATE posts SET published_at = ?, square_post_id = ? WHERE id = ?').run(at, `s${id}`, id);
  store.db.prepare('INSERT INTO post_stats (post_id, checked_at, views, likes, comments, shares, reactions) VALUES (?,?,?,?,?,?,?)').run(id, at, v24h, 0, opts.comments ?? 0, 0, 0);
  store.db.prepare('INSERT INTO post_distribution (post_id, first_read, v1h, v3h, v8h, v24h, growth_1h, late_share, surfaced, computed_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, 10, 20, opts.v3h ?? 30, 40, v24h, 1, 0, 0, at);
  return id;
}

/* ------------------------------------------------------------------ gates */

test('gate A needs a run of days, each with enough mature posts at the line', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.UTC(2026, 9, 20, 6, 0);
    // Seven prior days, three posts each at 1,500 views.
    for (let d = 1; d <= 7; d++) for (let i = 0; i < 3; i++) post(store, now - d * DAY + i * 3600_000, 1500);
    const g = gateReport(store, now);
    assert.equal(g.A.streakDays, 7);
    assert.equal(g.A.passed, true);
    assert.equal(g.target, 'engagement');
  } finally { close(); }
});

test('one lucky post, or a thin day, does not pass gate A', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.UTC(2026, 9, 20, 6, 0);
    for (let d = 1; d <= 7; d++) post(store, now - d * DAY, 50_000); // one huge post a day
    const g = gateReport(store, now);
    assert.equal(g.A.passed, false, `minimum ${GATE_LINES.minPostsPerDay} mature posts a day`);
    assert.equal(g.A.streakDays, 0);
    assert.equal(g.target, 'views');
  } finally { close(); }
});

test('gate B pools comments over views instead of taking a median that is always zero', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.UTC(2026, 9, 20, 6, 0);
    for (let i = 0; i < 9; i++) post(store, now - (i + 1) * 3600_000 * 6, 1000, { comments: 0 });
    post(store, now - 7 * 3600_000, 1000, { comments: 2 });
    const g = gateReport(store, now);
    assert.equal(g.B.views, 10_000);
    assert.equal(g.B.comments, 2);
    assert.equal(g.B.commentsPer1k, 0.2);
    assert.equal(g.B.passed, false);
  } finally { close(); }
});

test('gate C counts posts whose views kept doubling after hour three', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.UTC(2026, 9, 20, 6, 0);
    for (let i = 0; i < 5; i++) post(store, now - (i + 2) * DAY, 3000, { v3h: 1000 });
    post(store, now - 9 * DAY, 3000, { v3h: 2900 }); // flat after hour three: not second-round
    const g = gateReport(store, now);
    assert.equal(g.C.secondRound, 5);
    assert.equal(g.C.passed, true);
  } finally { close(); }
});

test('manual mode keeps the operator\'s target; auto follows the gates', () => {
  const { store, close } = tempStore();
  try {
    const g = gateReport(store, Date.now());
    assert.equal(effectiveTarget({ ...DEFAULT_SETTINGS, targetMode: 'manual', targetMetric: 'money' }, g), 'money');
    assert.equal(effectiveTarget({ ...DEFAULT_SETTINGS, targetMode: 'auto', targetMetric: 'money' }, g), 'views');
    assert.equal(DEFAULT_SETTINGS.targetMode, 'manual', 'an existing install must not flip target under its operator');
  } finally { close(); }
});

/* ---------------------------------------------------------------- breaker */

test('the breaker ignores history from before its window, then latches until the operator resets it', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.UTC(2026, 9, 20, 6, 0);
    // 20 old posts at 100 exist before the breaker has ever looked; they set the baseline (floor 50).
    for (let i = 0; i < 20; i++) post(store, now - 10 * DAY + i * 3600_000, 100);
    const first = evaluateBreaker(store, DEFAULT_SETTINGS, now - 9 * DAY);
    assert.equal(first.tripped, false, 'the first look starts the window; the past is not held against the change');

    for (let i = 0; i < 20; i++) post(store, now - 8 * DAY + i * 3600_000, 10);
    const tripped = evaluateBreaker(store, DEFAULT_SETTINGS, now);
    assert.equal(tripped.tripped, true);
    assert.ok(tripped.trippedAt);
    // Still latched a moment later, with nothing new to read.
    assert.equal(evaluateBreaker(store, DEFAULT_SETTINGS, now + 1000).tripped, true);
    const r = resetBreaker(store, now + 2000);
    assert.ok(r.frozenMs >= 0);
    assert.equal(evaluateBreaker(store, DEFAULT_SETTINGS, now + 3000).tripped, false);
    assert.equal(breaker(store, now + 2000, now + 3000).tripped, false);
  } finally { close(); }
});

test('the breaker floor follows the account\'s own baseline, not a fixed 150', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.UTC(2026, 9, 20, 6, 0);
    // Baseline ~100 views: a fixed 150 floor would trip on ordinary posts.
    for (let i = 0; i < 20; i++) post(store, now - 20 * DAY + i * 3600_000, 100);
    evaluateBreaker(store, DEFAULT_SETTINGS, now - 10 * DAY);
    for (let i = 0; i < 20; i++) post(store, now - 9 * DAY + i * 3600_000, 90);
    const s = evaluateBreaker(store, DEFAULT_SETTINGS, now);
    assert.equal(s.floor, 50);
    assert.equal(s.tripped, false, '90 is ordinary for this account, not a collapse');
  } finally { close(); }
});

test('a tripped breaker clears itself on healthy posts or after the cool-off', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.UTC(2026, 9, 20, 6, 0);
    evaluateBreaker(store, DEFAULT_SETTINGS, now - 10 * DAY);
    for (let i = 0; i < 20; i++) post(store, now - 9 * DAY + i * 3600_000, 10);
    const t = now - 8 * DAY;
    assert.equal(evaluateBreaker(store, DEFAULT_SETTINGS, t).tripped, true);
    // Six hand-published posts reading above the floor clear it before the cool-off.
    for (let i = 0; i < 6; i++) post(store, t + 3600_000 + i * 600_000, 500);
    assert.equal(evaluateBreaker(store, DEFAULT_SETTINGS, t + 12 * 3600_000).tripped, false);

    // With nothing published at all, the cool-off releases it.
    store.setSetting('breaker', { since: now - 30 * DAY, trippedAt: now - 3 * DAY });
    assert.equal(evaluateBreaker(store, DEFAULT_SETTINGS, now).tripped, false);
  } finally { close(); }
});

test('a disabled breaker never reports tripped', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.UTC(2026, 9, 20, 6, 0);
    evaluateBreaker(store, { ...DEFAULT_SETTINGS, breakerEnabled: false }, now - 9 * DAY);
    for (let i = 0; i < 20; i++) post(store, now - 8 * DAY + i * 3600_000, 10);
    assert.equal(evaluateBreaker(store, { ...DEFAULT_SETTINGS, breakerEnabled: false }, now).tripped, false);
  } finally { close(); }
});

test('resetting shifts open parameter windows by the time they were frozen', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.UTC(2026, 9, 20, 6, 0);
    store.setSetting('breaker', { since: now - 5 * DAY, trippedAt: now - 2 * DAY });
    store.db.prepare("INSERT INTO param_changes (key, from_value, to_value, reason, metric, status, created_at, applied_at, evaluate_at) VALUES ('coinSignalCooldownMinutes', 720, 800, 'x', 'views24h', 'applied', ?, ?, ?)")
      .run(now - 4 * DAY, now - 4 * DAY, now + DAY);
    const r = resetBreaker(store, now);
    assert.equal(r.frozenMs, 2 * DAY);
    assert.equal(r.shifted, 1);
    const row = store.db.prepare('SELECT evaluate_at FROM param_changes').get() as { evaluate_at: number };
    assert.equal(row.evaluate_at, now + 3 * DAY);
  } finally { close(); }
});

/* --------------------------------------------------------------- snapshot */

test('the snapshot has the same fields every time, null for what cannot be read', () => {
  const { store, close } = tempStore();
  try {
    const snap = buildSnapshot(store, DEFAULT_SETTINGS, Date.now());
    for (const k of ['asOf', 'mission', 'gates', 'breaker', 'account', 'columns', 'hypotheses', 'paramChanges', 'knobs', 'failures', 'benchmark', 'calls', 'alerts', 'unknowns']) {
      assert.ok(k in snap, `missing ${k}`);
    }
    assert.equal(snap.account.w7.medianViews, null, 'no posts means unknown, not zero');
    assert.equal(snap.gates.A.median7d, null);
    assert.ok(snap.unknowns.some(u => u.includes('粉丝')), 'the model is told followers are unreadable');
    const text = snapshotText(snap);
    assert.doesNotThrow(() => JSON.parse(text));
    assert.ok(!/sk-|api[_-]?key|secret:/i.test(text), 'a snapshot must never carry a credential');
  } finally { close(); }
});

/* --------------------------------------------------------------- sentinel */

test('alarms are derived from the snapshot alone, and a repeat is quiet', async () => {
  const { store, close } = tempStore();
  try {
    const now = Date.UTC(2026, 9, 20, 6, 0);
    store.setSetting('breaker', { since: now - 9 * DAY, trippedAt: now - DAY });
    const snap = buildSnapshot(store, DEFAULT_SETTINGS, now);
    const codes = detectAlarms(snap, DEFAULT_SETTINGS).map(a => a.code);
    assert.ok(codes.includes('breaker'));

    const first = await runSentinel(store, DEFAULT_SETTINGS, now);
    assert.deepEqual(first.raised.map(a => a.code), ['breaker']);
    assert.equal(first.woke, false, 'no model is configured, so nothing is called');
    const again = await runSentinel(store, DEFAULT_SETTINGS, now + 3600_000);
    assert.equal(again.raised.length, 0, 'the same alarm is not raised twice inside the quiet window');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM brain_alarms').get() as { n: number }).n, 1);
  } finally { close(); }
});

test('a loop that has stopped posting or reading stats raises its own alarm', async () => {
  const { store, close } = tempStore();
  try {
    const now = Date.UTC(2026, 9, 20, 6, 0);
    store.db.prepare("INSERT INTO events (at, kind, detail) VALUES (?, 'tick', '{}')").run(now - 5 * DAY);
    post(store, now - 2 * DAY, 100); // last post 48h ago, last stats read at publish time
    const s = { ...DEFAULT_SETTINGS, autoPublish: true };
    const codes = detectStalls(store, s, now).map(a => a.code);
    assert.ok(codes.includes('no_posts'));
    assert.ok(codes.includes('stats_stalled'));
    // A fresh install is not a stall.
    store.db.prepare('DELETE FROM events').run();
    store.db.prepare("INSERT INTO events (at, kind, detail) VALUES (?, 'tick', '{}')").run(now - 3600_000);
    assert.deepEqual(detectStalls(store, s, now), []);
  } finally { close(); }
});

/* ------------------------------------------------------------ template tune */

test('template weights converge on the evidence instead of compounding to the ceiling', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.UTC(2026, 9, 20, 6, 0);
    store.syncTemplates([
      { id: 'tpl.a', name: 'a', category: 'funding', style: 'data', body: 'x' },
      { id: 'tpl.b', name: 'b', category: 'funding', style: 'data', body: 'x' },
    ] as never);
    for (let i = 0; i < 10; i++) post(store, now - i * 3600_000, 200, { template: 'tpl.a' });
    for (let i = 0; i < 10; i++) post(store, now - i * 3600_000, 100, { template: 'tpl.b' });
    const w = (id: string) => (store.db.prepare('SELECT weight FROM templates WHERE id = ?').get(id) as { weight: number }).weight;
    for (let k = 0; k < 50; k++) tuneTemplateWeights(store, {});
    // Ratio 1.33 and 0.67, shrunk by 10/(10+10): weights settle at 1.17 and 0.83, not 3.0 and 0.3.
    assert.equal(w('tpl.a'), 1.17);
    assert.equal(w('tpl.b'), 0.83);
    const again = tuneTemplateWeights(store, {});
    assert.equal(again.adjusted.length, 0, 'same evidence, same weights: a second run changes nothing');
  } finally { close(); }
});

/* ----------------------------------------------------------------- weekly */

const WEEKLY_OK = `## 1 关卡状态
A 差 7 天。
## 2 假设账本
无变化。
## 3 失败账本
本周没有。
## 4 对照重测
提问占比未变。
## 5 本周唯一建议
把栏目条数从 4 调到 3。证据：近 14 天 12 条浏览中位数 104。反例：若下周中位数高于 300 则撤回。到期日：下周日。
## 6 自检
上周无建议。
ACTION|PARAM|columnPostsPerDay|3|减少稀释`;

test('actions are parsed from ACTION lines only, one per report, and stripped from the body', () => {
  const a = parseActions(WEEKLY_OK);
  assert.equal(a.length, 1);
  assert.deepEqual(a[0], { type: 'PARAM', key: 'columnPostsPerDay', to: 3, reason: '减少稀释' });
  assert.ok(!stripActions(WEEKLY_OK).includes('ACTION|'));
  const many = `${WEEKLY_OK}\nACTION|VARIANT_OFF|3|太长\nACTION|VARIANT_OFF|4|太长`;
  assert.equal(parseActions(many).length, 1, 'two recommendations cannot be told apart when the window closes');
  assert.deepEqual(parseActions('ACTION|PARAM|x|notanumber|y'), []);
  assert.deepEqual(parseActions('说明文字，没有动作'), []);
});

test('a recommendation without evidence, counter-example and date is a feeling, not a finding', () => {
  assert.equal(recommendationComplete(WEEKLY_OK), true);
  assert.equal(recommendationComplete('## 5 本周唯一建议\n多发点就好了。\n## 6 自检\n'), false);
  assert.equal(recommendationComplete('## 5 本周唯一建议\n还不知道，差 10 条样本。\n## 6 自检\n'), true);
  assert.deepEqual(missingSections(WEEKLY_OK), []);
  assert.ok(missingSections('## 1 关卡状态\nx').length >= 4);
});

test('approving a report runs each action through the gate that owns it, and refusals are recorded', () => {
  const { store, close } = tempStore();
  try {
    const id = Number(store.db.prepare("INSERT INTO brain_reports (kind, created_at, title, body, actions_json, status) VALUES ('weekly', ?, 't', 'b', ?, 'pending')")
      .run(Date.now(), JSON.stringify([{ type: 'PARAM', key: 'postsPerDay', to: 99, reason: '想多发' }])).lastInsertRowid);
    const r = approveReport(store, id);
    assert.equal(r.ok, true);
    assert.equal(r.results[0]!.ok, false, 'the cadence knob is not on the whitelist, so the gate refuses it');
    const row = store.db.prepare('SELECT status FROM brain_reports WHERE id = ?').get(id) as { status: string };
    assert.equal(row.status, 'failed');
    assert.equal(approveReport(store, id).ok, false, 'a resolved report cannot be applied twice');
  } finally { close(); }
});

test('variant actions go through the safety gate; digits and first person are refused', () => {
  const { store, close } = tempStore();
  try {
    seedVariants(store);
    const bad = applyAction(store, { type: 'VARIANT_ADD', kind: 'question', slot: 'ask', text: '我觉得会涨到 100' });
    assert.equal(bad.ok, false);
    const good = applyAction(store, { type: 'VARIANT_ADD', kind: 'question', slot: 'ask', text: '谁在为这个价格买单？' });
    assert.equal(good.ok, true);
    assert.ok(activeVariants(store, 'question', 'ask').some(v => v.text === '谁在为这个价格买单？'));
    const id = activeVariants(store, 'question', 'ask')[0]!.id;
    assert.equal(applyAction(store, { type: 'VARIANT_OFF', id, reason: '没有回应' }).ok, true);
    assert.ok(!activeVariants(store, 'question', 'ask').some(v => v.id === id));
    assert.equal(applyAction(store, { type: 'VARIANT_OFF', id: 99999, reason: 'x' }).ok, false);
  } finally { close(); }
});

test('the weekly job refuses to run without a usable brain, and says why', async () => {
  const { store, close } = tempStore();
  try {
    const r = await runWeekly(store, DEFAULT_SETTINGS);
    assert.equal(r.ok, false);
    assert.match(r.note, /大脑没有配置好/);
  } finally { close(); }
});

/* ------------------------------------------------------------- variants */

test('every built-in variant passes the gate that guards operator input', () => {
  for (const v of BUILTIN_VARIANTS) assert.deepEqual(isSafeVariant(v.text), { ok: true }, v.text);
  for (const t of ['涨到 100', '我今天做多', '$BTC 会涨', '#热门', '建议买入', '太短', 'x'.repeat(41), '两行\n文字']) {
    assert.equal(isSafeVariant(t).ok, false, t);
  }
});

test('seeding is idempotent and never revives a variant the operator switched off', () => {
  const { store, close } = tempStore();
  try {
    assert.ok(seedVariants(store) > 0);
    assert.equal(seedVariants(store), 0);
    const v = activeVariants(store, 'question', 'ask')[0]!;
    store.db.prepare("UPDATE column_variants SET status = 'off' WHERE id = ?").run(v.id);
    seedVariants(store);
    assert.ok(!activeVariants(store, 'question', 'ask').some(x => x.id === v.id));
  } finally { close(); }
});

/* ----------------------------------------------------------------- calls */

test('a call is ruled on by code: held, faded or flipped', () => {
  assert.equal(ruling(-0.001, -0.0009), 'held');
  assert.equal(ruling(-0.001, -0.0005), 'held', 'exactly half still counts');
  assert.equal(ruling(-0.001, -0.0004), 'faded');
  assert.equal(ruling(-0.001, 0.0002), 'flipped');
  assert.equal(ruling(0.001, 0), 'flipped');
  // New calls are judged on what the post said — «this side is paying» — not on the rate's size.
  assert.equal(rulingFor('payer_persists', -0.001, -0.0004), 'held');
  assert.equal(rulingFor('payer_persists', -0.001, 0.0002), 'flipped');
  assert.equal(rulingFor('funding_persists', -0.001, -0.0004), 'faded', 'old rows keep the rule they were registered under');
});

test('open calls are judged once their time comes; a missing symbol is void, a failed fetch changes nothing', async () => {
  const { store, close } = tempStore();
  try {
    const now = Date.UTC(2026, 9, 20, 6, 0);
    const mk = (symbol: string, rate: number) =>
      registerCall(store, { postId: 1, symbol, reading: 'ledger', payer: rate < 0 ? '空头' : '多头', rate, annualized: rate * 1000, intervalHours: 8, price: 1, now: now - 25 * 3600_000 });
    mk('AAA', -0.002); mk('BBB', -0.002); mk('CCC', -0.002);
    const book = async () => ({ get: (s: string) => (s === 'AAA' ? { rate: -0.0019, price: 1 } : s === 'BBB' ? { rate: 0.0001, price: 1 } : undefined) });
    const r = await judgeCalls(store, { now, book });
    assert.deepEqual({ held: r.held, flipped: r.flipped, voided: r.voided }, { held: 1, flipped: 1, voided: 1 });
    assert.deepEqual(tally(store), { total: 2, held: 1, faded: 0, flipped: 1, open: 0 });

    registerCall(store, { postId: 2, symbol: 'DDD', reading: 'ledger', payer: '空头', rate: -0.002, annualized: -2, intervalHours: 8, price: 1, now: now - 25 * 3600_000 });
    await judgeCalls(store, { now, book: async () => { throw new Error('network'); } });
    assert.equal(tally(store).open, 1, 'no measurement is not a verdict');
  } finally { close(); }
});

test('the recap line carries only numbers from the ledger row and no first person', async () => {
  const { store, close } = tempStore();
  try {
    const now = Date.UTC(2026, 9, 20, 6, 0);
    registerCall(store, { postId: 1, symbol: 'AAA', reading: 'ledger', payer: '空头', rate: -0.002, annualized: -2, intervalHours: 8, price: 1, now: now - 25 * 3600_000 });
    await judgeCalls(store, { now, book: async () => ({ get: () => ({ rate: -0.0015, price: 1 }) }) });
    const rows = unrecapped(store);
    assert.equal(rows.length, 1);
    const line = recapLineFor(rows[0]!);
    assert.match(line, /\$AAA/);
    assert.match(line, /空头在付 0\.20%/);
    assert.match(line, /0\.15%/);
    assert.ok(!/我|成立/.test(line));
  } finally { close(); }
});

/* ---------------------------------------------------------- config route */

test('posted brain settings are validated and clamped; unknown keys are dropped', () => {
  const cur = { ...DEFAULT_SETTINGS };
  const { next, changed, errors } = sanitizeBrainSettings({
    llmBaseUrl: 'https://api.anthropic.com/v1/', llmProvider: 'anthropic', brainTemperature: 9, brainWakeCapPerDay: -4,
    columnPostsPerDay: 500, dailyCap: 9999, postsPerDay: 500, autoPublish: true, brainMaxTokensWeekly: 100,
  }, cur);
  assert.deepEqual(errors, []);
  assert.equal(next.llmBaseUrl, 'https://api.anthropic.com/v1', 'trailing slash trimmed');
  assert.equal(next.brainTemperature, 1);
  assert.equal(next.brainWakeCapPerDay, 0);
  assert.equal(next.columnPostsPerDay, 6);
  assert.equal(next.brainMaxTokensWeekly, 500);
  assert.equal(next.dailyCap, cur.dailyCap, 'cadence and caps are not reachable from the brain page');
  assert.equal(next.postsPerDay, cur.postsPerDay);
  assert.equal(next.autoPublish, cur.autoPublish);
  assert.ok(changed.includes('llmProvider') && !changed.includes('dailyCap' as never));

  const bad = sanitizeBrainSettings({ llmBaseUrl: 'javascript:alert(1)', llmProvider: 'gemini' }, cur);
  assert.equal(bad.errors.length, 2);
});

test('readiness names what is missing', () => {
  const { store, close } = tempStore();
  try {
    assert.match(brainReadiness(store, { ...DEFAULT_SETTINGS })!, /启用/);
    assert.match(brainReadiness(store, { ...DEFAULT_SETTINGS, llmEnabled: true })!, /Key/);
    setSecret(store, 'openaiApiKey', 'sk-test');
    assert.match(brainReadiness(store, { ...DEFAULT_SETTINGS, llmEnabled: true })!, /模型/);
    assert.equal(brainReadiness(store, { ...DEFAULT_SETTINGS, llmEnabled: true, brainModel: 'm' }), null);
  } finally { close(); }
});

/* ------------------------------------------------------------ experiments */

test('only the active experiments get arms, and a hypothesis keeps its arm when others are added or removed', () => {
  const { store, close } = tempStore();
  try {
    const verdicts = scoreAll(store, { writeMemory: false });
    const all = planArms({ seed: 777, verdicts });
    const some = planArms({ seed: 777, verdicts, only: ['h_chart', 'h_column'] });
    assert.deepEqual(Object.keys(some).sort(), ['h_chart', 'h_column']);
    assert.equal(some.h_chart, all.h_chart, 'narrowing the set must not reshuffle who gets which arm');
    assert.deepEqual(Object.keys(planArms({ seed: 777, verdicts, exclude: ['h_column'] })).includes('h_column'), false);
    // The default must name only hypotheses the sampler can draw, in a lane that draws them:
    // `h_hour_band` sat here for a while and produced no arm, because it is registered `observed`,
    // and `h_column_polish` is drawn by `column.ts` but excluded by both pipeline lanes. The
    // invariant test in rank.test.ts is what stops the list and the registry drifting apart.
    assert.deepEqual(settingsFrom(store).activeExperiments, ['h_column', 'h_column_polish', 'h_chart']);
  } finally { close(); }
});
