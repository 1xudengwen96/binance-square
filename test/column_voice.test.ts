import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { ANOMALY_HEADLINES, columnContext, columnTemplates, readFunding } from '../src/content/column.ts';
import { BUILTIN_VARIANTS, isSafeVariant, shapeContext, shapeTemplates } from '../src/content/columns.ts';
import { renderTemplate } from '../src/engine/render.ts';
import { auditAgainstFacts } from '../src/engine/verify.ts';
import { preFlight } from '../src/engine/preflight.ts';
import { wordBank } from '../src/content/wordbank.ts';
import { judgeCalls, memoryLineFor, registerCall } from '../src/calls.ts';

const DAY = 86_400_000;
const CELLS = [
  { payer: '多头', chg24h: 6, funding: 0.0012, annualized: 130 },
  { payer: '多头', chg24h: -6, funding: 0.0012, annualized: 130 },
  { payer: '空头', chg24h: 6, funding: -0.0012, annualized: -130 },
  { payer: '空头', chg24h: -6, funding: -0.0012, annualized: -130 },
] as const;
const SEEDS = Array.from({ length: 60 }, (_, i) => i * 37 + 5);

const phrases = (): string[] => [
  ...Object.values(ANOMALY_HEADLINES).flat(),
  ...CELLS.flatMap(c => SEEDS.flatMap(s => { const r = readFunding({ ...c }, s); return r ? [r.verdict, r.watch] : []; })),
];

test('every wording variant stays free of digits, first person and trade language', () => {
  for (const p of new Set(phrases())) assert.doesNotMatch(p, /[0-9]|\$|#/, p);
  // 做多/做空 are left out on purpose: the original wording describes the crowd ("做空的人多到…"),
  // it never tells the reader to do anything.
  for (const p of new Set(phrases())) assert.doesNotMatch(p, /我(?!们)|建议|买入|卖出|加仓|抄底|上车|必涨|必跌/, p);
  for (const v of BUILTIN_VARIANTS) assert.deepEqual(isSafeVariant(v.text), { ok: true }, v.text);
});

test('each reading has several wordings, and the seed picks between them', () => {
  for (const c of CELLS) {
    const verdicts = new Set(SEEDS.map(s => readFunding({ ...c }, s)!.verdict));
    const watches = new Set(SEEDS.map(s => readFunding({ ...c }, s)!.watch));
    assert.ok(verdicts.size >= 3, `${c.payer}/${c.chg24h} verdicts: ${verdicts.size}`);
    assert.ok(watches.size >= 3, `${c.payer}/${c.chg24h} watches: ${watches.size}`);
    assert.equal(readFunding({ ...c }, 5)!.verdict, readFunding({ ...c }, 5)!.verdict, 'same seed, same wording');
  }
  assert.equal(new Set(BUILTIN_VARIANTS.map(v => `${v.kind}|${v.slot}|${v.text}`)).size, BUILTIN_VARIANTS.length, 'no duplicate variants');
});

test('费率账 varies in opening and layout, and every rendering clears the audit and preflight', () => {
  const openings = new Set<string>();
  const layouts = new Set<string>();
  for (const c of CELLS) {
    for (const s of SEEDS) {
      const base = { cashtag: '$ERA', symbol: 'ERA', ...c, streakPeriods: 5, streakCostPct: 3.2 };
      const r = renderTemplate(columnTemplates[0]!, columnContext(base, s)!, { seed: s, bank: wordBank });
      assert.ok(r.ok, r.ok ? '' : r.reason);
      if (!r.ok) continue;
      assert.ok(auditAgainstFacts(r.text, r.facts).ok, r.text);
      assert.ok(preFlight({ text: r.text, facts: r.facts, disclaimerRequired: true, sensitiveWords: [], maxChars: 2000 }).ok, r.text);
      openings.add(r.text.split('\n')[0]!.slice(0, 14));
      layouts.add(/^【费率账】\$ERA 费率/.test(r.text) ? 'figures-first' : 'reading-first');
    }
  }
  assert.equal(layouts.size, 2, 'both layouts occur');
  assert.ok(openings.size >= 4, `distinct openings: ${openings.size}`);
});

test('今日反常 renders in all three layouts, for both funding and open-interest anomalies', () => {
  const funding = { cashtag: '$CKB', symbol: 'CKB', payer: '空头', chg24h: 46.26, funding: -0.00131, annualized: -143, oiChangePct: 46.2, quoteVolume24h: 5e7 };
  const oi = { cashtag: '$WAL', symbol: 'WAL', payer: '', chg24h: 5, oiChangePct: -12, quoteVolume24h: 5e7 };
  const tpl = shapeTemplates.find(t => t.id === 'column.anomaly')!;
  const openings = new Set<string>();
  for (const f of [funding, oi]) {
    for (const s of SEEDS) {
      const ctx = shapeContext('anomaly', { ...f }, { watch: '往后看哪个先让步', close: '留言说说你的读法' }, s);
      assert.ok(ctx, 'anomaly applies');
      const r = renderTemplate(tpl, ctx!, { seed: s, bank: wordBank });
      assert.ok(r.ok, r.ok ? '' : r.reason);
      if (!r.ok) continue;
      assert.ok(auditAgainstFacts(r.text, r.facts).ok, r.text);
      // No bracket heading, no +/− figure dump: the move is said in words, the numbers rounded.
      assert.doesNotMatch(r.text, /^【/);
      assert.doesNotMatch(r.text, /（空头付）|\+46\.26%|-0\.131%/);
      assert.match(r.text, /涨了 46%|涨了 5%/);
      assert.match(r.text, /留言说说你的读法。$/, 'a close without punctuation gets one');
      openings.add(r.text.slice(0, 4));
    }
  }
  assert.ok(openings.size >= 3, `openings seen: ${[...openings]}`);
});

test('盘中一问 says the split in words and rotates its skeleton', () => {
  const f = { cashtag: '$RSR', symbol: 'RSR', payer: '空头', chg24h: 2.72, funding: -0.00268, annualized: -290, longRatio: 1.31, quoteVolume24h: 5e7 };
  const tpl = shapeTemplates.find(t => t.id === 'column.question')!;
  const firstLines = new Set<string>();
  for (const s of SEEDS) {
    const ctx = shapeContext('question', { ...f }, { ask: '你更信价格，还是更信费率？' }, s);
    assert.ok(ctx);
    const r = renderTemplate(tpl, ctx!, { seed: s, bank: wordBank });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    if (!r.ok) continue;
    assert.ok(auditAgainstFacts(r.text, r.facts).ok, r.text);
    assert.match(r.text, /涨了 2\.7%/);
    assert.match(r.text, /0\.27%/);
    assert.match(r.text, /做多的账户略多/);
    firstLines.add(r.text.split('\n')[0]!.replace(/\$RSR.*/, ''));
  }
  assert.ok(firstLines.size >= 3, `skeletons: ${[...firstLines]}`);
});

test('first person may describe watching, never a position', () => {
  for (const ok of ['我更在意费率，你呢？', '我会先盯下一次结算的费率', '评论区聊聊，我在看大家怎么想。']) {
    assert.deepEqual(isSafeVariant(ok), { ok: true }, ok);
  }
  for (const bad of ['我已经上车了', '我的仓位还在', '我更在意我的空单', '我刚开了多单', '我买了一点']) {
    assert.equal(isSafeVariant(bad).ok, false, bad);
  }
});

test('the memory line cites only ledger rows, and says nothing when there is nothing to cite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-voice-'));
  const store = Store.open(join(dir, 't.db'));
  try {
    assert.equal(memoryLineFor(store, 'ERA', 1), '', 'empty ledger: no line');

    const t0 = Date.now() - 3 * DAY;
    registerCall(store, { postId: 1, symbol: 'ERA', reading: 'ledger', payer: '空头', rate: -0.0012, annualized: -130, intervalHours: 8, price: 1, now: t0 });
    assert.equal(memoryLineFor(store, 'ERA', 1), '', 'open call is not a ruling');

    const book = async () => ({ get: () => ({ rate: -0.0011, price: 1 }) });
    const rep = await judgeCalls(store, { now: t0 + DAY + 1000, book });
    assert.equal(rep.held, 1);
    const line = memoryLineFor(store, 'ERA', 1, t0 + DAY + 2000);
    assert.match(line, /^\d+ 天前也聊过它，那时就是空头在付；第二天还是空头在付。$/);
    assert.equal(memoryLineFor(store, 'OTHER', 1), '', 'a coin with no ruling gets no personal history');
    assert.doesNotMatch(line, /我|\$|成立/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
