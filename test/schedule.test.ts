import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import { beijingDayStart, nextSlot } from '../src/schedule.ts';
import { generate } from '../src/pipeline.ts';

const GAP = DEFAULT_SETTINGS.minIntervalMinutes * 60_000;

function tempStore(): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-sched-'));
  const store = Store.open(join(dir, 't.db'));
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function approve(store: Store, at: number, i: number): void {
  store.addPost({
    materialId: null,
    templateId: null,
    text: `$TOK 1小时多空比 ${2 + i}.10，多头占 6${i}.9%。测试正文，不构成投资建议。`,
    status: 'approved',
    scheduledAt: at,
  });
}

test('drafts reserved one at a time never share a minute', () => {
  // The failure this pins: the two generation loops each started spacing from `now`, so every
  // draft in a busy tick landed on the same minute (measured: 5 posts at 00:14). Reserving
  // against the queue instead of against the clock is what separates them — and it has to work
  // across separate calls, because that is how the loop actually runs.
  const { store, close } = tempStore();
  try {
    const taken: number[] = [];
    for (let i = 0; i < 3; i++) {
      const slot = nextSlot(store, DEFAULT_SETTINGS, Date.now(), null, true);
      assert.ok(slot.allowed, slot.reason);
      taken.push(slot.at);
      approve(store, slot.at, i);
    }
    assert.equal(new Set(taken).size, 3, `three drafts took ${taken.length} distinct minutes`);
    for (let i = 1; i < taken.length; i++) assert.ok(taken[i]! - taken[i - 1]! >= GAP, 'spacing must be at least the nominal gap');
  } finally {
    close();
  }
});

test('the publish gate still ignores drafts scheduled for later', () => {
  // The mirror-image regression: the same queue-aware clock, applied to the gate, makes a post
  // that is due now wait behind posts that have not happened yet. That is how a queue of
  // approved work produced seven hours of dead air.
  const { store, close } = tempStore();
  try {
    const due = Date.now() - 60_000;
    approve(store, due, 0);
    for (let i = 1; i < 4; i++) approve(store, due + i * GAP, i);
    const gate = nextSlot(store, DEFAULT_SETTINGS, Date.now(), { id: 1, at: due }, false);
    assert.ok(gate.allowed, gate.reason);
    assert.ok(gate.at <= Date.now(), 'a due post with history must not be pushed behind its own queue');
  } finally {
    close();
  }
});

test('generation stops once the queue already covers the day', async () => {
  // Without this ceiling, queue-aware scheduling is just a slower version of the same problem:
  // drafts keep coming, each one lands further out, and the material expires before its minute.
  const { store, close } = tempStore();
  try {
    const s = { ...DEFAULT_SETTINGS, postsPerDay: 2, autoPublish: true };
    for (let i = 0; i < 2; i++) approve(store, Date.now() + i * GAP, i);
    const r = await generate(store, s, 3);
    assert.equal(r.created.length, 0, 'a full queue must not add more drafts');
    assert.match(r.skipped.join(' '), /待发布/);
  } finally {
    close();
  }
});

test('the queue count sees articles as well as posts', () => {
  const { store, close } = tempStore();
  try {
    approve(store, Date.now(), 0);
    store.addArticle({ trackId: 'trading_literacy', conceptId: 'oi_vs_volume', accountId: null, symbol: 'X', title: 't', body: 'b' });
    assert.equal(store.pendingQueueCount(), 2);
    assert.equal(store.pendingQueueCount(99), 0, 'scoping to an account must not count another account\'s work');
  } finally {
    close();
  }
});

test('an article spends the same daily ceiling as a post', () => {
  // The 100/day limit is per key. A counter that only read `posts` let one account send its
  // full quota of short posts *plus* articles, and reported a number that was simply false.
  const { store, close } = tempStore();
  try {
    const now = Date.now();
    const articleId = store.addArticle({ trackId: 'trading_literacy', conceptId: 'oi_vs_volume', accountId: null, symbol: 'X', title: 't', body: 'b' });
    store.db.prepare("UPDATE studio_articles SET status = 'published', published_at = ? WHERE id = ?").run(now, articleId);
    approve(store, now, 0);
    store.db.prepare("UPDATE posts SET status = 'published', published_at = ? WHERE id = (SELECT MAX(id) FROM posts)").run(now);
    assert.equal(store.publishedToday(now - 3600_000), 2, 'one article and one post must both count');
  } finally {
    close();
  }
});

test('a queue that fills the day rolls into tomorrow, which is the signal to stop', () => {
  // The window check is what keeps the queue-aware clock from becoming an excuse to draft
  // without limit: once today's window is full every further slot lands tomorrow morning, and
  // a market claim written for tomorrow morning is wrong by the time it publishes.
  const { store, close } = tempStore();
  try {
    const s = { ...DEFAULT_SETTINGS, activeStartHour: 8, activeEndHour: 9, minIntervalMinutes: 45, postsPerDay: 20 };
    const now = beijingDayStart(Date.now()) + 8 * 3600_000 + 10 * 60_000;
    const a = nextSlot(store, s, now, null, true);
    approve(store, a.at, 0);
    const b = nextSlot(store, s, now, null, true);
    assert.ok(!/顺延/.test(b.reason), `second slot should still fit today: ${b.reason}`);
    approve(store, b.at, 1);
    const c = nextSlot(store, s, now, null, true);
    assert.match(c.reason, /顺延/);
    assert.ok(c.at > now + 3600_000, 'the rolled slot must be past the end of today\'s window');
  } finally {
    close();
  }
});
