import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import Database from 'better-sqlite3';
import { CONCEPTS, unlockedBy } from '../src/studio/concepts.ts';
import { trackById } from '../src/studio/tracks.ts';
import { assertCategoryAllowed, assertConceptInTrack, assertTextOnTrack, matrixEligibleAccounts, studioAccountIds } from '../src/studio/lock.ts';
import { MIN_SAMPLES, checkClaims, conceptPerformance, nextTopics, summarize } from '../src/studio/evidence.ts';
import { composeArticle } from '../src/studio/compose.ts';
import { ARTICLE_LIBRARY, specFor } from '../src/studio/library.ts';
import { wordBank } from '../src/content/wordbank.ts';
import { toContext } from '../src/material/types.ts';
import type { Material } from '../src/material/types.ts';
import { nextArticleSlot } from '../src/studio/runner.ts';

const TRACK = 'trading_literacy';
const ALL_CONCEPT_IDS = CONCEPTS.filter(c => c.trackId === TRACK).map(c => c.id);

function tempStore(): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-studio-'));
  const file = join(dir, 't.db');
  const store = Store.open(file);
  store.ensureConceptRows(TRACK, ALL_CONCEPT_IDS);
  return { store, close: () => { store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function makeAccount(store: Store, label = '号'): number {
  return Number(store.db
    .prepare('INSERT INTO accounts (label, enabled, created_at, updated_at) VALUES (?,1,?,?)')
    .run(label, Date.now(), Date.now()).lastInsertRowid);
}

function material(over: Partial<Material> & { facts: Record<string, unknown> }): Material {
  return {
    id: over.id ?? `m:${Math.random()}`,
    category: over.category ?? 'funding',
    subType: over.subType ?? 'funding_extreme',
    title: over.title ?? '测试素材',
    symbol: over.symbol ?? 'BTC',
    symbols: [over.symbol ?? 'BTC'],
    sentiment: 'neutral',
    score: 70,
    source: 'test',
    at: Date.now(),
    collectedAt: Date.now(),
    fingerprint: 'fp',
    facts: over.facts,
  };
}

/* ------------------------------------------------------------------ 赛道 --- */

test('the refusal list blocks real advice, not just obvious words', () => {
  const track = trackById(TRACK)!;
  const blocked = [
    '建议做多，目标价看到 85000',
    '止损位打在 81200，别乱动',
    '这个位置稳赚不赔',
    '数据摆在这里，因此应该空',
    '3 倍收益等着你',
  ];
  for (const text of blocked) {
    const v = assertTextOnTrack(track, text, 'compose');
    assert.equal(v.ok, false, `should have blocked: ${text}`);
    assert.ok((v.reasons[0] ?? '').includes('命中'), 'the reason should quote what matched');
  }
  // Neutral analysis must pass, or the guard is just a ban on talking about trading.
  for (const ok of ['费率说明空头在付代价，不能告诉你明天涨跌', '持仓增加而价格滞涨，两者要一起看']) {
    assert.equal(assertTextOnTrack(track, ok, 'compose').ok, true, ok);
  }
});

test('the polish pass is re-checked, because rewording is how description becomes advice', () => {
  const track = trackById(TRACK)!;
  const composed = '空头正在付出代价，这个结构能维持的时间往往比直觉长';
  const polished = '空头正在付出代价，所以应该空';
  assert.equal(assertTextOnTrack(track, composed, 'compose').ok, true);
  assert.equal(assertTextOnTrack(track, polished, 'polish').ok, false);
});

test('an account bound to a track leaves the mixed-style matrix', () => {
  const { store, close } = tempStore();
  try {
    const a = makeAccount(store, '教学号');
    const b = makeAccount(store, '普通号');
    assert.deepEqual(matrixEligibleAccounts(store).map(x => x.id).sort(), [a, b].sort());
    store.bindStudioTrack(a, TRACK);
    assert.deepEqual(matrixEligibleAccounts(store).map(x => x.id), [b], 'the bound account must not be drawn by the matrix');
    assert.ok(studioAccountIds(store).has(a));
    store.unbindStudioTrack(a);
    assert.equal(matrixEligibleAccounts(store).length, 2, 'unbinding returns it');
  } finally {
    close();
  }
});

test('off-track categories and concepts are refused', () => {
  const track = trackById(TRACK)!;
  const news = material({ category: 'newsflash', facts: {} });
  assert.equal(assertCategoryAllowed(track, news).ok, false);
  assert.equal(assertCategoryAllowed(track, material({ category: 'funding', facts: {} })).ok, true);
  assert.equal(assertConceptInTrack(track, 'nope_not_real').ok, false);
  assert.equal(assertConceptInTrack(track, 'oi_vs_volume').ok, true);
});

/* -------------------------------------------------------------- 课程结构 --- */

test('a concept stays unoffered until its prerequisites are written', () => {
  const { store, close } = tempStore();
  try {
    const cold = nextTopics(store, TRACK, { limit: 10 }).map(t => t.conceptId);
    assert.ok(cold.includes('oi_vs_volume'), 'tier 0 is available immediately');
    assert.ok(!cold.includes('squeeze_structure'), 'a tier-1 concept must not be offered yet');
    assert.ok(!cold.includes('four_step_checklist'), 'the synthesis piece needs three prerequisites');

    for (const id of ['funding_who_pays', 'oi_vs_volume', 'ls_ratio_is_accounts']) {
      store.recordConceptWritten(id, TRACK, 100, 1);
    }
    const later = nextTopics(store, TRACK, { limit: 20 }).map(t => t.conceptId);
    assert.ok(later.includes('four_step_checklist'), 'unlocked once all three prerequisites exist');
    assert.ok(unlockedBy(new Set(['oi_vs_volume'])).some(c => c.id === 'thin_market_caveat') === false, 'needs two prerequisites, not one');
  } finally {
    close();
  }
});

test('the keystone concept outranks everything on a cold start', () => {
  const { store, close } = tempStore();
  try {
    const picks = nextTopics(store, TRACK, { limit: 3 });
    assert.equal(picks[0]?.conceptId, 'oi_vs_volume', 'it unlocks the most downstream concepts');
    assert.ok((picks[0]?.unlocks ?? 0) >= 5, `expected a high unlock count, got ${picks[0]?.unlocks}`);
    assert.ok((picks[0]?.why ?? []).some(w => w.includes('解锁')), 'the reason must be stated, not just scored');
  } finally {
    close();
  }
});

test('selection scores by unlock value, not by a popularity guess', () => {
  const { store, close } = tempStore();
  try {
    // ls_ratio_is_accounts unlocks one; oi_vs_volume unlocks seven. Order must follow.
    const picks = nextTopics(store, TRACK, { limit: 4 });
    const rank = (id: string) => picks.findIndex(p => p.conceptId === id);
    assert.ok(rank('oi_vs_volume') < rank('ls_ratio_is_accounts'));
  } finally {
    close();
  }
});

test('an exploration slot survives even when something is winning', () => {
  const { store, close } = tempStore();
  try {
    store.bindStudioTrack(makeAccount(store), TRACK);
    // Enough candidates that the greedy head would otherwise fill every slot.
    const picks = nextTopics(store, TRACK, { limit: 3, rand: () => 0.99 });
    assert.ok(picks.some(p => p.forcedByExploration), 'a pure exploiter converges after two posts and then only confirms its own noise');
  } finally {
    close();
  }
});

/* ------------------------------------------------------------ 样本量纪律 --- */

test('nothing is ranked, and nothing is claimed, below the sample floor', () => {
  const { store, close } = tempStore();
  try {
    const acct = makeAccount(store);
    store.bindStudioTrack(acct, TRACK);
    for (let i = 0; i < MIN_SAMPLES - 1; i++) {
      const id = store.addArticle({ trackId: TRACK, conceptId: 'oi_vs_volume', accountId: acct, symbol: `X${i}`, title: `t${i}`, body: 'b' });
      store.updateStudioArticle(id, { status: 'published' });
      store.recordStudioObservation(id, 1, { views: 500 + i, likes: 0, comments: 0, shares: 0, reactions: 0, subscribers: 0, onBoard: false });
    }
    const p = conceptPerformance(store, TRACK).find(x => x.conceptId === 'oi_vs_volume')!;
    assert.equal(p.rankable, false, `${MIN_SAMPLES - 1} readings is not a basis`);
    assert.ok(summarize(store, TRACK).some(s => s.includes('还差')), 'it should say how far off it is');

    for (let i = 0; i < 3; i++) {
      const id = store.addArticle({ trackId: TRACK, conceptId: 'oi_vs_volume', accountId: acct, symbol: `Y${i}`, title: `y${i}`, body: 'b' });
      store.updateStudioArticle(id, { status: 'published' });
      store.recordStudioObservation(id, 1, { views: 500 + i, likes: 0, comments: 0, shares: 0, reactions: 0, subscribers: 0, onBoard: false });
    }
    assert.equal(conceptPerformance(store, TRACK).find(x => x.conceptId === 'oi_vs_volume')!.rankable, true);
  } finally {
    close();
  }
});

test('median, not mean, so one viral article cannot carry a concept', () => {
  const { store, close } = tempStore();
  try {
    const acct = makeAccount(store);
    const views = [10, 12, 11, 10, 50_000];
    for (const v of views) {
      const id = store.addArticle({ trackId: TRACK, conceptId: 'oi_vs_volume', accountId: acct, symbol: 'Z', title: 't', body: 'b' });
      store.updateStudioArticle(id, { status: 'published' });
      store.recordStudioObservation(id, 1, { views: v, likes: 0, comments: 0, shares: 0, reactions: 0, subscribers: 0, onBoard: false });
    }
    const p = conceptPerformance(store, TRACK).find(x => x.conceptId === 'oi_vs_volume')!;
    assert.equal(p.medianViews, 11);
    assert.equal(p.bestViews, 50_000, 'the outlier stays visible rather than being hidden');
  } finally {
    close();
  }
});

test('zero engagement is reported, not scored as a low number', () => {
  const { store, close } = tempStore();
  try {
    const acct = makeAccount(store);
    for (let i = 0; i < 5; i++) {
      const id = store.addArticle({ trackId: TRACK, conceptId: 'oi_vs_volume', accountId: acct, symbol: `Q${i}`, title: 't', body: 'b' });
      store.updateStudioArticle(id, { status: 'published' });
      store.recordStudioObservation(id, 1, { views: 300, likes: 0, comments: 0, shares: 0, reactions: 0, subscribers: 0, onBoard: false });
    }
    const p = conceptPerformance(store, TRACK).find(x => x.conceptId === 'oi_vs_volume')!;
    assert.equal(p.engagementPer1k, 0);
    assert.ok(p.medianViews > 0, 'reach and attraction are separate numbers with separate fixes');
  } finally {
    close();
  }
});

/* ------------------------------------------------------------------ 合成 --- */

test('a missing mandatory section refuses the article instead of shipping half of it', () => {
  const { store, close } = tempStore();
  try {
    void store;
    const spec = specFor('oi_vs_volume')!;
    // Deliberately incomplete: no open-interest figures at all.
    const thin = material({ category: 'open_interest', subType: 'oi_shift', facts: { chg24h: 5, price: 1 } });
    const r = composeArticle(spec, toContext(thin), { seed: 'x', bank: wordBank, track: trackById(TRACK)! });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /缺少支撑段落/);
    assert.ok(r.sections.some(s => !s.rendered && s.skipped), 'the reason for each skipped section is kept');
  } finally {
    close();
  }
});

test('every library article composes from its own material and carries no markup', () => {
  const { store, close } = tempStore();
  try {
    void store;
    const fixtures: Record<string, Material> = {
      funding_who_pays: material({ facts: { funding: -0.0098, payer: '空头', intervalHours: 8, quoteVolume24h: 65_000_000, chg24h: 15.3, oiChangePct: 36.1, price: 0.082 } }),
      oi_vs_volume: material({ category: 'open_interest', subType: 'oi_shift', symbol: 'NEAR', facts: { oiUsd: 289_000_000, oiChangePct: -7.6, quoteVolume24h: 1_212_000_000, chg24h: -2.65, dir: '减少', shape: '多头止损', price: 4.96 } }),
      ls_ratio_is_accounts: material({ category: 'long_short', subType: 'account_ratio', symbol: 'XRP', facts: { scope: '1小时', longRatio: 2.41, longPct: 70.7, shortPct: 29.3, ratio: 2.41, funding: 0.00012, payer: '多头', quoteVolume24h: 400_000_000 } }),
      extreme_funding_not_annualized: material({ symbol: 'MINA', facts: { funding: -0.0025, intervalHours: 4, quoteVolume24h: 105_000_000, price: 0.4 } }),
      ma_is_lagging: material({ category: 'market_move', subType: 'ma_death', symbol: 'SUI', facts: { tf: '4 小时', price: 1.09, maFast: 1.168, maSlow: 1.171, fastLen: 20, slowLen: 55, gapPct: -6.29, chg24h: -2.54, dir: '下穿', cross: '死叉', quoteVolume24h: 397_000_000 } }),
    };
    assert.equal(Object.keys(fixtures).length, ARTICLE_LIBRARY.length, 'every library piece needs a fixture to be tested against');
    for (const spec of ARTICLE_LIBRARY) {
      const r = composeArticle(spec, toContext(fixtures[spec.conceptId]!), { seed: spec.conceptId, bank: wordBank, track: trackById(TRACK)! });
      assert.ok(r.ok, `${spec.conceptId} failed: ${r.reason}`);
      assert.ok(!/\*\*/.test(r.body), `${spec.conceptId} still carries markdown Square will not parse`);
      assert.ok(!/\{\{|\}\}/.test(r.body + r.title), `${spec.conceptId} left an unrendered tag`);
      assert.ok(r.chars > 500, `${spec.conceptId} is ${r.chars} chars, too short to be a lesson`);
      assert.ok(r.facts.length > 3, `${spec.conceptId} has no fact trail behind its numbers`);
    }
  } finally {
    close();
  }
});

test('a hardcoded market number in an article is caught before rendering', () => {
  const { store, close } = tempStore();
  try {
    void store;
    // The fact ledger cannot catch this one: the renderer records a template's own literal
    // digits as facts, so an invented 91234 passes auditAgainstFacts by construction. The
    // source-level literal guard is what closes that hole, and this test is the proof it does.
    const fake = specFor('funding_who_pays')!;
    const leaking: typeof fake = {
      ...fake,
      sections: [
        ...fake.sections.slice(0, -1),
        { id: 'leak', label: '伪造', mandatory: true, body: '目标价看到 91234 美元，年化 4812%。' },
      ],
    };
    const m = material({ facts: { funding: -0.0098, payer: '空头', intervalHours: 8, quoteVolume24h: 65_000_000, chg24h: 15.3, price: 0.082 } });
    const r = composeArticle(leaking, toContext(m), { seed: 'x', bank: wordBank, track: trackById(TRACK)! });
    assert.equal(r.ok, false, 'an unbacked literal must stop the article');
    assert.match(r.reason ?? '', /写死了本应来自数据字段的数字/);
    assert.match(r.reason ?? '', /91234/);

    // Declaring a structural number is the escape hatch, and it has to be explicit.
    const declared: typeof fake = {
      ...fake,
      sections: [
        ...fake.sections.slice(0, -1),
        { id: 'leak', label: '声明过的', mandatory: true, literals: ['91234', '4812'], body: '目标价看到 91234 美元，年化 4812%。' },
      ],
    };
    assert.equal(composeArticle(declared, toContext(m), { seed: 'x', bank: wordBank, track: trackById(TRACK)! }).ok, true);
  } finally {
    close();
  }
});

test('the compliance line is not mistaken for investment advice', () => {
  const track = trackById(TRACK)!;
  // Every article ends with 不构成任何投资建议. Were the refusal pattern to match that, the
  // guard would block its own compliance text and the track could never publish at all.
  assert.equal(assertTextOnTrack(track, '内容仅为数据梳理与方法说明，不构成任何投资建议。合约有强平风险。', 'compose').ok, true);
});

/* ---------------------------------------------------------- 自我纠错机制 --- */

test('a claim the later data contradicts becomes a lesson and marks the concept stale', async () => {
  const { store, close } = tempStore();
  try {
    const acct = makeAccount(store);
    const id = store.addArticle({
      trackId: TRACK, conceptId: 'oi_price_four_shapes', accountId: acct, symbol: 'FOO',
      title: '持仓还在增加', body: 'b',
      windowClaims: [{ field: 'oiChangePct', assertion: 'increasing', value: 12.4, phrase: 'FOO 持仓量增加 12.4%' }],
    });
    store.updateStudioArticle(id, { status: 'published', publishedAt: Date.now() });

    // Still true: recorded as held, nothing marked stale.
    assert.equal((await checkClaims(store, () => 22)).contradicted, 0);
    assert.equal(store.conceptStates(TRACK).find(c => c.concept_id === 'oi_price_four_shapes')!.needs_update, 0);

    // Now false.
    const res = await checkClaims(store, () => -8.2);
    assert.equal(res.contradicted, 1);
    const lessons = store.lessons();
    assert.equal(lessons.length, 1);
    assert.equal(lessons[0]?.kind, 'contradicted');
    assert.match(lessons[0].detail, /已不成立/);
    assert.equal(store.conceptStates(TRACK).find(c => c.concept_id === 'oi_price_four_shapes')!.needs_update, 1);
    assert.ok(summarize(store, TRACK).some(s => s.includes('推翻')));
  } finally {
    close();
  }
});

test('articles with no claims do not crash the checker', async () => {
  const { store, close } = tempStore();
  try {
    const acct = makeAccount(store);
    const id = store.addArticle({ trackId: TRACK, conceptId: 'oi_vs_volume', accountId: acct, symbol: 'X', title: 't', body: 'b' });
    store.updateStudioArticle(id, { status: 'published' });
    assert.deepEqual(await checkClaims(store, () => 1), { checked: 0, contradicted: 0, held: 0, expired: 0 });
  } finally {
    close();
  }
});

/* ------------------------------------------------------------------ 隔离 --- */

/** Row count for a table, typed once so the assertions below read as facts, not casts. */
function count(store: Store, sql: string): number {
  return (store.db.prepare(sql).get() as { c: number }).c;
}

test('studio writes never touch the main post table', () => {
  const { store, close } = tempStore();
  try {
    const acct = makeAccount(store);
    const before = count(store, 'SELECT COUNT(*) c FROM posts');
    store.bindStudioTrack(acct, TRACK);
    const id = store.addArticle({ trackId: TRACK, conceptId: 'oi_vs_volume', accountId: acct, symbol: 'X', title: 't', body: 'b' });
    store.recordStudioObservation(id, 0, { views: 10, likes: 0, comments: 0, shares: 0, reactions: 0, subscribers: 0, onBoard: false });
    assert.equal(count(store, 'SELECT COUNT(*) c FROM posts'), before);
    assert.equal(count(store, 'SELECT COUNT(*) c FROM post_stats'), 0);
    assert.equal(count(store, 'SELECT COUNT(*) c FROM studio_articles'), 1);
  } finally {
    close();
  }
});

test('the article tables are created on an existing database', () => {
  // CREATE TABLE IF NOT EXISTS never evolves a table that is already there, which already
  // bit this project once on post_stats. The studio tables shipped without `symbol` first,
  // so the migration path is the only thing standing between an upgrade and a crash.
  const dir = mkdtempSync(join(tmpdir(), 'sf-studio-mig-'));
  const file = join(dir, 't.db');
  const raw = new Database(file);
  raw.exec(`CREATE TABLE studio_articles (id INTEGER PRIMARY KEY AUTOINCREMENT, track_id TEXT NOT NULL, concept_id TEXT NOT NULL, account_id INTEGER, title TEXT NOT NULL, body TEXT NOT NULL, sections_json TEXT, facts_json TEXT, cover_path TEXT, cover_url TEXT, status TEXT NOT NULL DEFAULT 'draft', created_at INTEGER NOT NULL, scheduled_at INTEGER, published_at INTEGER, square_post_id TEXT, url TEXT, error TEXT);`);
  raw.close();

  const store = Store.open(file);
  try {
    const cols = (store.db.prepare('PRAGMA table_info(studio_articles)').all() as { name: string }[]).map(c => c.name);
    for (const need of ['symbol', 'refusal_hits', 'expires_at', 'window_claims_json']) {
      assert.ok(cols.includes(need), `studio_articles gained ${need}`);
    }
    const acct = Number(store.db.prepare('INSERT INTO accounts (label,enabled,created_at,updated_at) VALUES (?,1,?,?)').run('x', Date.now(), Date.now()).lastInsertRowid);
    const id = store.addArticle({ trackId: TRACK, conceptId: 'oi_vs_volume', accountId: acct, symbol: 'OLD', title: 't', body: 'b' });
    assert.ok(id > 0, 'inserting into a migrated table works');
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('two articles drafted in one tick are a track-gap apart, not in the same minute', () => {
  // Measured on the first live day: both long posts went out at 11:54 because `minGapHours`
  // was declared on the track and read by nobody. A long post published two minutes after
  // another one spends reach it cannot get back.
  const { store, close } = tempStore();
  try {
    const acct = makeAccount(store);
    const track = trackById(TRACK)!;
    const now = Date.now();
    const first = nextArticleSlot(store, acct, track, now);
    assert.equal(first, now, 'a fresh account has nothing queued, so it may post now');
    store.addArticle({ trackId: TRACK, conceptId: 'oi_vs_volume', accountId: acct, symbol: 'X', title: 't', body: 'b', scheduledAt: first });
    const second = nextArticleSlot(store, acct, track, now);
    assert.equal(second - first, track.cadence.minGapHours * 3_600_000);
    assert.equal(nextArticleSlot(store, makeAccount(store), track, now), now, 'the gap belongs to the account, not to the track');
  } finally {
    close();
  }
});
