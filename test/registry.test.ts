import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { HYPOTHESES, DIMENSIONS } from '../src/rank/hypotheses.ts';
import { MAX_PROPOSED, propose, proposals, registry, resolveProposal, retireStalled, STALL_DAYS } from '../src/rank/registry.ts';
import { scoreAll } from '../src/rank/score.ts';

function tempStore(): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-reg-'));
  const store = Store.open(join(dir, 't.db'));
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A combination the seven built-ins do not already occupy: same dimension, different metric. */
const FRESH = {
  claim: '上过公开榜的帖子，24 小时浏览量明显高于没上过的',
  mode: 'observed',
  dimension: 'surfacing_shape',
  metric: 'views24h',
} as const;

test('the registry is the built-in set plus whatever has been registered and approved', () => {
  const { store, close } = tempStore();
  try {
    assert.deepEqual(registry(store).map(h => h.id), HYPOTHESES.map(h => h.id));
    const r = propose(store, { ...FRESH, origin: 'operator' });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(registry(store).length, HYPOTHESES.length + 1);
    // Arms come from the dimension, never from the caller, so a row cannot drift from what the
    // scorer actually produces.
    assert.deepEqual(registry(store).at(-1)!.arms, DIMENSIONS.surfacing_shape.arms);
  } finally {
    close();
  }
});

test('a registered hypothesis is scored without touching any source file', () => {
  // This is the whole point of the table. Before it, "what should we try next" had no destination
  // and the only way to act on an answer was to edit hypotheses.ts and restart.
  const { store, close } = tempStore();
  try {
    propose(store, { ...FRESH, origin: 'operator' });
    const v = scoreAll(store, { writeMemory: false }).find(x => x.id.startsWith('bh:'));
    assert.ok(v, 'the new hypothesis appears in the verdict list');
    assert.equal(v.metric, 'views24h');
    assert.equal(v.mode, 'observed');
    assert.equal(v.arms.length, DIMENSIONS.surfacing_shape.arms.length);
  } finally {
    close();
  }
});

test('a proposal that restates a comparison already running is rejected, with a reason the model can read', () => {
  // Measured, not hypothetical: the live brain's three daily suggestions were verbatim
  // restatements of h_chart, h_hashtag_count and h_opening, because restating them was the only
  // move available. The rejection text is fed back into the next reflection on purpose.
  const { store, close } = tempStore();
  try {
    const r = propose(store, {
      claim: '带自绘 K 线图的帖子比纯文字拿到更多 24 小时浏览量',
      mode: 'experiment',
      dimension: 'chart',
      metric: 'views24h',
      origin: 'operator',
    });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /已经在测/);
  } finally {
    close();
  }
});

test('an invented dimension or metric is refused because it could not be measured', () => {
  const { store, close } = tempStore();
  try {
    const badDim = propose(store, { ...FRESH, origin: 'operator', dimension: 'emoji_count' });
    assert.equal(badDim.ok, false);
    assert.match((badDim as { reason: string }).reason, /不是系统能分组的维度/);

    const badMetric = propose(store, { ...FRESH, origin: 'operator', metric: 'vibes' });
    assert.equal(badMetric.ok, false);
    assert.match((badMetric as { reason: string }).reason, /不是系统能测量的指标/);
  } finally {
    close();
  }
});

test('an experiment may only be registered on a knob the writer can actually turn', () => {
  // The trap this closes: a proposal that records arms, gets a share of exploration traffic, and
  // changes nothing about the post — so it produces a confident null. Worse than not measuring.
  const { store, close } = tempStore();
  try {
    const r = propose(store, {
      claim: '发帖时段带决定 24 小时浏览量能否破千',
      mode: 'experiment',
      dimension: 'hour_band',
      metric: 'views24h',
      origin: 'operator',
    });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /写作层没法主动改变/);
    assert.match((r as { reason: string }).reason, /只能作为观察假设/);

    // Same dimension as an observation is fine.
    assert.ok(propose(store, {
      claim: '发帖时段带决定 24 小时浏览量能否破千',
      mode: 'observed', dimension: 'hour_band', metric: 'engagementPer1k', origin: 'operator',
    }).ok);
  } finally {
    close();
  }
});

test('a model cannot spend real traffic on its own idea; it can only register a free observation', () => {
  const { store, close } = tempStore();
  try {
    const obs = propose(store, { ...FRESH, origin: 'brain', proposedFrom: 'brain:next:0' });
    assert.ok(obs.ok);
    assert.equal(obs.status, 'active', 'an observed hypothesis costs no traffic, so it may enter directly');

    const exp = propose(store, {
      claim: '同一格子内标题带数字的帖子分发更好，值得随机试',
      mode: 'experiment', dimension: 'hashtag_total', metric: 'growth1h', origin: 'brain',
    });
    assert.ok(exp.ok);
    assert.equal(exp.status, 'proposed', 'an experiment needs the operator before it takes traffic');
    assert.ok(!registry(store).some(h => h.id === exp.id), 'unapproved means genuinely not running');

    const p = proposals(store);
    assert.equal(p.length, 1);
    assert.equal(p[0]!.source_text, null);
    assert.equal(resolveProposal(store, exp.id, true, ''), true);
    assert.ok(registry(store).some(h => h.id === exp.id), 'approval is what puts it into the loop');
  } finally {
    close();
  }
});

test('the registry refuses to fill up with ideas that cannot be sampled', () => {
  // Each live hypothesis takes a share of the exploration budget, so an unbounded registry slows
  // down every hypothesis that could actually have been measured.
  const { store, close } = tempStore();
  try {
    const granted = propose(store, { ...FRESH, origin: 'brain' });
    assert.ok(granted.ok);
    const second = propose(store, {
      claim: '字数带对每千次浏览的回应数有影响，值得单独看',
      mode: 'observed', dimension: 'length_band', metric: 'engagementPer1k', origin: 'brain',
    });
    assert.ok(second.ok);
    const third = propose(store, {
      claim: '重发间隔对每千次浏览回应数的影响还没人看过',
      mode: 'observed', dimension: 'repeat_interval', metric: 'engagementPer1k', origin: 'brain',
    });
    assert.equal(third.ok, false);
    assert.match((third as { reason: string }).reason, new RegExp(`上限 ${MAX_PROPOSED}`));
  } finally {
    close();
  }
});

test('a hypothesis that cannot get off the ground is retired and remembered as untestable', () => {
  const { store, close } = tempStore();
  try {
    const now = Date.now();
    const r = propose(store, { ...FRESH, origin: 'operator', now: now - (STALL_DAYS + 2) * 86_400_000 });
    assert.ok(r.ok);
    const id = (r as { id: string }).id;

    // Back-dated so it is unmistakably stalled; a fresh proposal must never be culled.
    store.db.prepare('UPDATE hypotheses SET created_at = ? WHERE id = ?').run(now - (STALL_DAYS + 2) * 86_400_000, id);
    const fresh = propose(store, {
      claim: '刚登记的假设不应该马上被砍掉', mode: 'observed', dimension: 'chart', metric: 'engagementPer1k', origin: 'operator',
    });
    assert.ok(fresh.ok);

    const verdicts = scoreAll(store, { writeMemory: false });
    assert.deepEqual(retireStalled(store, verdicts, now), [id]);
    assert.equal(registry(store).some(h => h.id === id), false, 'retired means it stops taking budget');
    assert.ok(registry(store).some(h => h.id === (fresh as { id: string }).id), 'the new one survives');

    const lesson = store.db.prepare("SELECT text FROM brain_memory WHERE key = ?").get(`rank:stalled:${id}`) as { text: string };
    assert.match(lesson.text, /测不了/);
    assert.match(lesson.text, /别再提这条/, 'so the same idea is not proposed again next month');
  } finally {
    close();
  }
});
