import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { sampleSquareBoards } from '../src/stats/benchmarks.ts';

/**
 * The board routes are fetched through global fetch, so the seam is global fetch itself.
 * Stubbing it keeps these tests about parsing and storage rather than about the network.
 */
function stubBoards(pages: Record<string, unknown[]>, failUrl?: (url: string) => boolean) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (failUrl?.(u)) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    const key = u.includes('article/list') ? 'trend' : u.includes('news/list') ? 'news' : null;
    if (!key) return { ok: true, status: 200, json: async () => ({ data: { vos: [] } }) } as unknown as Response;
    // Only page 1 is answered; anything deeper comes back empty so the loop stops.
    const vos = u.includes('pageIndex=1') ? (pages[key] ?? []) : [];
    return { ok: true, status: 200, json: async () => ({ data: { vos } }) } as unknown as Response;
  }) as typeof fetch;
  return {
    calls,
    setTrend: (vos: unknown[]) => {
      pages.trend = vos;
    },
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function tempStore(): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-bench-'));
  const file = join(dir, 't.db');
  const store = Store.open(file);
  return { store, close: () => { store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const POST = {
  id: 375000000000001,
  title: 'BTC 突破 8.2 万 #BTC 你怎么看',
  content: '全文在这里 #Bitcoin',
  authorName: '某人',
  cardType: 'BUZZ_SHORT',
  contentType: 1,
  viewCount: 41234,
  likeCount: 88,
  commentCount: 12,
  shareCount: 3,
  totalReactionCount: 90,
  date: 1791400000, // seconds, as Square actually sends it
  detectedLanguage: 'zh',
  images: [{ url: 'x' }],
  tradingPairs: [{ code: 'btc' }],
  hashtagList: [],
};

test('board fields land in the shape the analysis expects', async () => {
  const { store, close } = tempStore();
  const s = stubBoards({ trend: [POST], news: [] });
  try {
    const r = await sampleSquareBoards(store, { pages: 1 });
    assert.equal(r.stored, 1);
    assert.deepEqual(r.errors, []);
    const row = store.boardRows(5)[0]!;
    assert.equal(row.board, 'trend');
    assert.equal(row.views, 41234);
    assert.equal(row.coin, 'BTC', 'ticker case is normalised');
    assert.equal(row.has_image, 1);
    // `date` is seconds. Storing it raw puts every sampled post half a lifetime in the past.
    assert.ok(row.posted_at > 1e12, `posted_at must be milliseconds, got ${row.posted_at}`);
    // hashtagList is empty on the list routes; the tags only exist inline in the text.
    const tags = JSON.parse(row.hashtags_json) as string[];
    assert.deepEqual(tags.sort(), ['#BITCOIN', '#BTC']);
  } finally {
    s.restore();
    close();
  }
});

test('re-sampling a post updates the row instead of adding a second one', async () => {
  const { store, close } = tempStore();
  // The stub reads `pages` per call, so mutating the row between sweeps is a later poll.
  const s = stubBoards({ trend: [{ ...POST, viewCount: 100 }], news: [] });
  try {
    await sampleSquareBoards(store, { pages: 1 });
    s.setTrend([{ ...POST, viewCount: 500 }]);
    await sampleSquareBoards(store, { pages: 1 });

    const rows = store.db.prepare('SELECT views, seen_count FROM square_board_samples').all() as { views: number; seen_count: number }[];
    assert.equal(rows.length, 1, 'the pool counts posts, not polls');
    assert.equal(rows[0]!.views, 500, 'the newer reading wins');
    assert.equal(rows[0]!.seen_count, 2);
  } finally {
    s.restore();
    close();
  }
});

test('our own posts are flagged and stay out of the comparison pool', async () => {
  const { store, close } = tempStore();
  store.db
    .prepare("INSERT INTO posts (material_id, template_id, text, status, created_at, square_post_id) VALUES (NULL,NULL,'t','published',?,?)")
    .run(Date.now(), String(POST.id));
  const s = stubBoards({ trend: [POST], news: [] });
  try {
    const r = await sampleSquareBoards(store, { pages: 1 });
    assert.equal(r.oursOnBoard, 1);
    assert.equal(store.boardViewPool().length, 0, 'the pool must not be graded against ourselves');
    assert.ok(store.surfacedPostIds([String(POST.id)]).has(String(POST.id)), 'appearing on a board is what 上榜 means');
  } finally {
    s.restore();
    close();
  }
});

test('a failing board page degrades to an error entry, never a throw', async () => {
  const { store, close } = tempStore();
  const s = stubBoards({ trend: [POST], news: [] }, u => u.includes('news/list'));
  try {
    const r = await sampleSquareBoards(store, { pages: 2 });
    assert.ok(r.errors.length >= 1, 'the failure must be reported');
    assert.equal(r.perBoard.trend, 1, 'the healthy board still contributes');
  } finally {
    s.restore();
    close();
  }
});

test('rows without a usable id are dropped', async () => {
  const { store, close } = tempStore();
  const s = stubBoards({ trend: [{ ...POST, id: undefined }, { ...POST, id: 'dry-run' }, { ...POST, id: 123456, title: '', content: '' }], news: [] });
  try {
    const r = await sampleSquareBoards(store, { pages: 1 });
    assert.equal(r.stored, 0, 'a drill id or a blank post is not a benchmark row');
  } finally {
    s.restore();
    close();
  }
});
