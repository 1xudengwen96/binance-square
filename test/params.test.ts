import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { settingsFrom } from '../src/schedule.ts';
import {
  EVAL_WINDOW_DAYS, MAX_STEP, MIN_SAMPLES_TO_JUDGE, applyPendingChanges, changeLedger,
  evaluateChanges, knobByKey, proposeChange,
} from '../src/rank/params.ts';

const DAY = 86_400_000;

function tempStore(): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-param-'));
  const store = Store.open(join(dir, 't.db'));
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A published post with a settled 24h reading, which is all the judging path needs. */
function publish(store: Store, views: number, at: number): number {
  const id = store.addPost({
    materialId: null, templateId: null, text: '$TOK 费率 -1.2%，多头占 64.0%。不构成投资建议。',
    status: 'published', scheduledAt: null,
  });
  store.db.prepare('UPDATE posts SET published_at = ? WHERE id = ?').run(at, id);
  store.db
    .prepare(`INSERT INTO post_distribution (post_id, first_read, v1h, v3h, v8h, v24h, growth_1h, late_share, surfaced, board_kind, hours_to_board, computed_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, views, views, views, views, views, 1, 0, 0, null, null, at);
  return id;
}

const COOL = 'coinSignalCooldownMinutes';

test('cadence and volume knobs are outside what the system may change about itself', () => {
  // These set how much of the account's quota gets spent and what the posting shape looks like
  // to platform abuse detection. That is not a quantity to be tuned by gradient, so it is not
  // merely unproposed — it is not in the list.
  assert.equal(knobByKey('postsPerDay'), undefined);
  assert.equal(knobByKey('dailyCap'), undefined);
  assert.equal(knobByKey('minIntervalMinutes'), undefined);

  const { store, close } = tempStore();
  try {
    const r = proposeChange(store, { key: 'postsPerDay', to: 40, reason: '多发一点', origin: 'brain' });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /不交给机器决定/);
  } finally {
    close();
  }
});

test('a proposal is bounded, and the bound is stated as a range the model can act on', () => {
  const { store, close } = tempStore();
  try {
    const current = settingsFrom(store).coinSignalCooldownMinutes;
    const tooFar = proposeChange(store, { key: COOL, to: current * 3, reason: '冷却太长了', origin: 'brain' });
    assert.equal(tooFar.ok, false);
    assert.match((tooFar as { reason: string }).reason, new RegExp(`±${MAX_STEP * 100}%`));

    const ok = proposeChange(store, { key: COOL, to: current * 1.2, reason: '重复信号压制减弱', origin: 'brain' });
    assert.ok(ok.ok);
  } finally {
    close();
  }
});

test('only one change may be in flight, because two cannot be attributed to either', () => {
  const { store, close } = tempStore();
  try {
    const current = settingsFrom(store).coinSignalCooldownMinutes;
    assert.ok(proposeChange(store, { key: COOL, to: current * 1.2, reason: 'A', origin: 'brain' }).ok);
    const second = proposeChange(store, { key: 'categoryWeights:funding', to: 1.3, reason: 'B', origin: 'brain' });
    assert.equal(second.ok, false);
    assert.match((second as { reason: string }).reason, /在途/);
  } finally {
    close();
  }
});

test('a change is applied, judged on its own window, and kept only if the number moved', () => {
  const { store, close } = tempStore();
  try {
    const t0 = Date.now();
    for (let i = 0; i < 8; i++) publish(store, 100, t0 - (i + 1) * DAY);
    const current = settingsFrom(store).coinSignalCooldownMinutes;
    assert.ok(proposeChange(store, { key: COOL, to: current * 1.2, reason: '同类信号压制在减弱', origin: 'brain' }).ok);

    const applied = applyPendingChanges(store, t0);
    assert.equal(applied.length, 1);
    assert.equal(settingsFrom(store).coinSignalCooldownMinutes, Math.round(current * 1.2 * 100) / 100);
    const row = changeLedger(store)[0]!;
    assert.equal(row.status, 'applied');
    assert.equal(row.before_median, 100, 'the number it has to beat is recorded at apply time');

    for (let i = 0; i < 8; i++) publish(store, 260, t0 + (i + 1) * DAY);
    const decided = evaluateChanges(store, t0 + (EVAL_WINDOW_DAYS + 1) * DAY);
    assert.deepEqual(decided.improved, [COOL]);
    assert.equal(changeLedger(store)[0]!.status, 'improved');
    assert.equal(settingsFrom(store).coinSignalCooldownMinutes, Math.round(current * 1.2 * 100) / 100, 'the gain is kept');
  } finally {
    close();
  }
});

test('no improvement means the knob goes back on its own, and the failure is remembered', () => {
  // The half that matters. A self-tuning system that only ever applies and never reverts is not
  // optimising, it is drifting, and the drift is invisible because each step looked reasonable.
  const { store, close } = tempStore();
  try {
    const t0 = Date.now();
    for (let i = 0; i < 8; i++) publish(store, 100, t0 - (i + 1) * DAY);
    const current = settingsFrom(store).coinSignalCooldownMinutes;
    proposeChange(store, { key: COOL, to: current * 0.8, reason: '冷却太紧，白白少发', origin: 'operator' });
    applyPendingChanges(store, t0);
    assert.notEqual(settingsFrom(store).coinSignalCooldownMinutes, current);

    for (let i = 0; i < 8; i++) publish(store, 102, t0 + (i + 1) * DAY);
    const decided = evaluateChanges(store, t0 + (EVAL_WINDOW_DAYS + 1) * DAY);
    assert.deepEqual(decided.rolledBack, [COOL]);

    const row = changeLedger(store)[0]!;
    assert.equal(row.status, 'rolled_back');
    assert.equal(settingsFrom(store).coinSignalCooldownMinutes, current, 'the operator is back to where they started');
    assert.match(row.reject_reason ?? '', /没有改善/);

    const lesson = store.db.prepare("SELECT text FROM brain_memory WHERE kind = 'audience-fact'").get() as { text: string };
    assert.match(lesson.text, /别再提同一个值/, 'so the same idea is not re-proposed next week');

    // And the refused repeat is refused with the evidence attached.
    const again = proposeChange(store, { key: COOL, to: current * 0.8, reason: '还是觉得太长', origin: 'brain' });
    assert.equal(again.ok, false);
    assert.match((again as { reason: string }).reason, /刚试过/);
  } finally {
    close();
  }
});

test('an unjudgeable change is postponed, then reverted rather than left in place', () => {
  const { store, close } = tempStore();
  try {
    const t0 = Date.now();
    for (let i = 0; i < 8; i++) publish(store, 100, t0 - (i + 1) * DAY);
    const current = settingsFrom(store).coinSignalCooldownMinutes;
    proposeChange(store, { key: COOL, to: current * 1.1, reason: '再试松一点', origin: 'operator' });
    applyPendingChanges(store, t0);
    // Far fewer posts than the window needs to decide anything.
    for (let i = 0; i < MIN_SAMPLES_TO_JUDGE - 2; i++) publish(store, 400, t0 + (i + 1) * DAY);

    const early = evaluateChanges(store, t0 + (EVAL_WINDOW_DAYS + 1) * DAY);
    assert.deepEqual(early.deferred, [COOL], 'not enough evidence yet, and it does not pretend otherwise');
    assert.equal(changeLedger(store)[0]!.status, 'applied');

    const late = evaluateChanges(store, t0 + (2 * EVAL_WINDOW_DAYS + 1) * DAY);
    assert.deepEqual(late.rolledBack, [COOL], 'a change that cannot be shown to help is not kept');
    assert.equal(settingsFrom(store).coinSignalCooldownMinutes, current);
    assert.match(changeLedger(store)[0]!.reject_reason ?? '', /样本不足/);
  } finally {
    close();
  }
});

test('a hand edit made after the proposal is never overwritten', () => {
  // The proposal recorded a baseline, but the operator may have moved the knob in the panel in
  // the meantime. Applying the queued change on top would silently undo their edit, which is the
  // fastest way to make a person stop trusting an automation.
  const { store, close } = tempStore();
  try {
    const t0 = Date.now();
    for (let i = 0; i < 8; i++) publish(store, 100, t0 - (i + 1) * DAY);
    const current = settingsFrom(store).coinSignalCooldownMinutes;
    proposeChange(store, { key: COOL, to: current * 1.2, reason: '松一点', origin: 'brain' });

    const s = settingsFrom(store);
    store.setSetting('settings', { ...s, coinSignalCooldownMinutes: 180 });
    assert.equal(applyPendingChanges(store, t0).length, 0);
    const row = changeLedger(store)[0]!;
    assert.equal(row.status, 'rejected');
    assert.match(row.reject_reason ?? '', /操作者已手动改为/);
    assert.equal(settingsFrom(store).coinSignalCooldownMinutes, 180, 'their value stands');
  } finally {
    close();
  }
});

test('a change with no comparable history is refused rather than applied and hoped about', () => {
  const { store, close } = tempStore();
  try {
    const t0 = Date.now();
    const current = settingsFrom(store).coinSignalCooldownMinutes;
    proposeChange(store, { key: COOL, to: current * 1.2, reason: '试试看', origin: 'operator' });
    assert.equal(applyPendingChanges(store, t0).length, 0, 'nothing was measured before, so nothing could be measured after');
    assert.match(changeLedger(store)[0]!.reject_reason ?? '', /没有可比的历史样本/);
    assert.equal(settingsFrom(store).coinSignalCooldownMinutes, current);
  } finally {
    close();
  }
});
