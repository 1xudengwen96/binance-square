import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../src/engine/parser.ts';
import { renderNodesToString, renderTemplate, truthy } from '../src/engine/render.ts';
import { auditAgainstFacts } from '../src/engine/verify.ts';
import { annualizedFunding } from '../src/material/derive.ts';
import { guardPost, isDuplicate, similarity, isStructuralDuplicate, structuralSignature } from '../src/engine/guard.ts';
import { formatPrice, formatUsd, formatRate, toCashtag } from '../src/engine/filters.ts';
import { templates } from '../src/content/templates.ts';
import { wordBank } from '../src/content/wordbank.ts';
import type { Context } from '../src/engine/types.ts';

const r = (src: string, ctx: Context = {}, seed = 1) => renderNodesToString(parse(src), ctx, { seed, bank: wordBank });

/* ---------------------------------------------------------------- parser */

test('plain text passes through', () => {
  assert.equal(r('hello world').text, 'hello world');
});

test('interpolation with filter', () => {
  assert.equal(r('{{price|price}}', { price: 68432.1 }).text, '68,432.10');
});

test('pool picks deterministically for a seed', () => {
  const a = r('{aa|bb|cc}', {}, 42).text;
  const b = r('{aa|bb|cc}', {}, 42).text;
  assert.equal(a, b);
  assert.ok(['aa', 'bb', 'cc'].includes(a));
});

test('single-option braces are not treated as a pool', () => {
  assert.equal(r('增长 {30} 单位').text, '增长 {30} 单位');
});

test('conditionals: if / elif / else', () => {
  const t = '{{#if n > 10}}big{{#elif n > 5}}mid{{#else}}small{{/if}}';
  assert.equal(r(t, { n: 20 }).text, 'big');
  assert.equal(r(t, { n: 7 }).text, 'mid');
  assert.equal(r(t, { n: 1 }).text, 'small');
});

test('string equality with quotes', () => {
  assert.equal(r("{{#if payer == '多头'}}L{{#else}}S{{/if}}", { payer: '多头' }).text, 'L');
  assert.equal(r("{{#if payer == '多头'}}L{{#else}}S{{/if}}", { payer: '空头' }).text, 'S');
});

test('logical or inside a condition does not become a filter', () => {
  assert.equal(r("{{#if a == 'x' || a == 'y'}}hit{{/if}}", { a: 'y' }).text, 'hit');
});

test('nested pools inside conditionals', () => {
  const out = r('{{#if ok}}{p|q}{{/if}}', { ok: true }, 3);
  assert.ok(['p', 'q'].includes(out.text));
});

test('each iterates with index and separator', () => {
  const out = r('{{#each rows as row max=3 sep=", "}}[{{row.v}}]{{/each}}', { rows: [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }] });
  assert.equal(out.text, '[1], [2], [3]');
});

test('maybe is seed-stable', () => {
  assert.equal(r('{{#maybe 50}}X{{/maybe}}', {}, 7).text, r('{{#maybe 50}}X{{/maybe}}', {}, 7).text);
});

test('word bank resolves and may contain pools', () => {
  assert.match(r('{{@word.watch}}').text, /值得盯一下|可以多留意|先加个自选|建议关注/);
});

test('unknown bank key throws', () => {
  assert.throws(() => r('{{@nope.nope}}'), /no entry "@nope.nope"/);
});

test('require aborts the render instead of printing a hole', () => {
  const res = r('{{#require coin price}}price is {{price}}', { price: 1 });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? '', /coin/);
});

test('unterminated if throws', () => {
  assert.throws(() => parse('{{#if a}}oops'), /Unterminated/);
});

test('unknown filter throws', () => {
  assert.throws(() => r('{{a|nonsense}}', { a: 1 }), /Unknown filter/);
});

/* --------------------------------------------------------------- filters */

test('price precision scales with magnitude', () => {
  assert.equal(formatPrice(68432.1), '68,432.10');
  assert.equal(formatPrice(3.4567), '3.4567');
  assert.equal(formatPrice(0.0821), '0.0821');
});

test('usd formatting uses 亿 and 万', () => {
  assert.equal(formatUsd(1_200_000_000), '12.00 亿美元');
  assert.equal(formatUsd(3_680_000), '368 万美元');
});

test('rate multiplies a raw funding decimal into a percent', () => {
  assert.equal(formatRate(0.00082), '0.082%');
});

test('cash filter is idempotent on an already-prefixed symbol', () => {
  assert.equal(toCashtag('$BTC'), '$BTC');
  assert.equal(toCashtag('BTC'), '$BTC');
});

/* ------------------------------------------------------------ fact audit */

test('renderer records every number it emits', () => {
  const res = r('{{cashtag}} 涨 {{chg|pcta}}', { cashtag: '$SOL', chg: 5.2 });
  const values = res.facts.filter(f => f.kind === 'number').map(f => f.value);
  assert.deepEqual(values, [5.2]);
});

test('audit accepts engine output verbatim', () => {
  const res = r('{{cashtag}} 涨 {{chg|pcta}}', { cashtag: '$SOL', chg: 5.2 });
  assert.equal(auditAgainstFacts(res.text, res.facts).ok, true);
});

test('audit rejects a number the model invented', () => {
  const res = r('{{cashtag}} 涨 {{chg|pcta}}', { cashtag: '$SOL', chg: 5.2 });
  const report = auditAgainstFacts('$SOL 涨了 12.7%，成交量翻倍', res.facts);
  assert.equal(report.ok, false);
  assert.deepEqual(report.inventedNumbers, ['12.7']);
});

test('audit rejects a ticker the model invented', () => {
  const res = r('{{cashtag}} 拉升', { cashtag: '$SOL' });
  const report = auditAgainstFacts('$SOL 拉升，$DOGE 也跟了', res.facts);
  assert.equal(report.ok, false);
  assert.deepEqual(report.inventedSymbols, ['$DOGE']);
});

test('audit tolerates comma-grouped rewrites of the same value', () => {
  const res = r('成交额 {{v|comma}}', { v: 1234567 });
  assert.equal(auditAgainstFacts('成交额 1,234,567.00', res.facts).ok, true);
});

/* ----------------------------------------------------------------- guard */

test('similarity separates distinct copy from near-duplicates', () => {
  assert.ok(similarity('今天天气不错', '今天天气不错啊') > 0.6);
  assert.ok(similarity('资金费率走高', '涨幅榜出现新币') < 0.2);
});

test('duplicate detector flags a reworded repeat', () => {
  const recent = ['SOL 15分钟拉升 5.2%，现价 186.4'];
  assert.ok(isDuplicate('SOL 15分钟拉升 5.2%，现价 186.4！', recent) !== null);
  assert.equal(isDuplicate('ETH 资金费率转负，空头开始付费', recent), null);
});

test('structural dedup is stricter than raw-text dedup', () => {
  const a = '说实话，$XRP 的1小时多空比 2.67，多头占 72.8%。\n这已经挤到一起了。方向我说不准，但人多的位置我不太敢加仓。';
  const b = '刚刷到，$BNB 的1小时多空比 2.54，多头占 71.8%。\n这已经挤到一起了。方向我说不准，但人多的位置我不太敢加仓。';
  // Raw text sits just over the line; masking tickers and numbers widens the gap so
  // the threshold no longer has to be balanced on how different two coin names are.
  assert.ok(similarity(a, b) < similarity(structuralSignature(a), structuralSignature(b)));
  assert.ok(isStructuralDuplicate(b, [a]), 'masked structure must catch it');
});

test('structural dedup leaves genuinely different copy alone', () => {
  const a = '$ETH 资金费率 0.082%，年化 89.8%，多头在付费。';
  const b = '24小时涨幅前列：NMR +39.84%，CHZ +21.50%。';
  assert.equal(isStructuralDuplicate(b, [a]), null);
});

test('guard blocks sensitive words and short text', () => {
  const v = guardPost('保证收益 稳赚不赔', { sensitiveWords: ['稳赚不赔'], recent: [] });
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some(x => x.includes('sensitive')));
  assert.ok(!guardPost('太短了', { sensitiveWords: [], recent: [] }).ok);
});

/* ------------------------------------------------------------- templates */

const ATTENTION_CTX: Context = {
    cashtag: '$SOL',
    symbol: 'SOL',
    subType: 'new_high',
    scope: '24小时',
    price: 186.4,
    chg: 5.2,
    chg24h: 12.3,
    chg1h: -1.4,
    tf: '15分钟',
    volMultiple: 3.4,
    extreme: 191.2,
    funding: 0.00082,
    annualized: 89.8,
    payer: '多头',
    intervalHours: 8,
    ratio: 1.42,
    ratioDiff: -0.01,
    longPct: 58.6,
    shortPct: 41.4,
    value: 71,
    label: '贪婪',
    prev: 66,
    assetName: '比特币',
    flowUsd: -3_680_000,
    flowDate: '10月6日',
    flowDir: '净流出',
    streak: 2,
    streakDir: '流出',
    amountUsd: 12_400_000,
    side: '多头',
    window: '30分钟',
    board: [
      { rank: 1, symbol: 'NMR', chg: 39.84 },
      { rank: 2, symbol: 'CHZ', chg: 21.5 },
    ],
    topChg: 39.84,
    // attention-pool dossier fields
    squareViews: 1_269_529,
    squarePosts: 16,
    squareDiscuss: 1080,
    squareRank: 1,
    hashtag: '#bitcoin',
    sustainedHours: 2.5,
    oiChangePct: -6.4,
    longRatio: 1.42,
    quoteVolume24h: 842_000_000,
    agreeing: 3,
    dir: '跌',
    // announcement / newswire / dex / stablecoin / trending fields
    catalogLabel: '新上线',
    coinCount: 2,
    ageMinutes: 12,
    body: '某机构公告调整抵押率',
    title: '关于调整某交易对杠杆的公告',
    topic: '比特币相关话题',
    boardName: '头条热榜',
    heat: 1_234_567,
    chain: 'Solana',
    volume24h: 45_000_000,
    reserveUsd: 820_000,
    delta: -420_000_000,
    direction: '销毁',
    total: 120_000_000_000,
    // Hyperliquid fields
    venue: 'Hyperliquid',
    fundingPct: -0.021,
    openInterest: 41412.74,
    // What the collector now derives: coins × mark, so templates never print a coin count.
    oiUsd: 3_437_257_000,
    // open_interest detector facts. `shape` names the OI × price combination, which is the
    // only reason the detector exists; `gapRatio` pre-computes the comparison because the
    // template language has no arithmetic.
    shape: '多头开仓',
    gapRatio: 2.4,
    // Moving-average detector facts. `tf` is already supplied above.
    cross: '金叉',
    maFast: 61.24,
    maSlow: 60.18,
    fastLen: 20,
    slowLen: 55,
    gapPct: 2.31,
    // Enrichment: HL's turnover expressed as a share of Binance's for the same coin.
    venueSharePct: 0.6,
    // DEX trending pool.
    poolName: 'DARK / wNEAR',
  };

test('every shipped template renders against a synthetic context without throwing', () => {
  const ctx = ATTENTION_CTX;
  for (const t of templates) {
    const res = renderTemplate(t, ctx, { seed: t.id, bank: wordBank });
    assert.ok(res.ok, `${t.id} should render: ${res.reason}`);
    assert.ok(res.text.length > 20, `${t.id} produced suspiciously little text`);
    assert.equal(
      auditAgainstFacts(res.text, res.facts).ok,
      true,
      `${t.id} emitted a number it cannot attribute`,
    );
    assert.ok(!/\{\{|\}\}/.test(res.text), `${t.id} left unrendered tags`);
  }
});

test('templates are skipped, not broken, when their contract is unmet', () => {
  const res = renderTemplate(templates[0]!, { cashtag: '', funding: 0.001 }, { seed: 1, bank: wordBank });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? '', /cashtag|missing/);
});

/**
 * A branch that emits a sentence without its own terminator glues onto whatever
 * follows it ("几个方向互相印证等等再说"). Catch that at the template source
 * instead of by reading every rendered variant.
 */
test('absurd funding annualisation is dropped, not printed', () => {
  assert.equal(annualizedFunding(0.00082, 8), 89.8);
  // -0.53% per 8h annualises to about -1160%: arithmetically right, meaningless.
  assert.equal(annualizedFunding(-0.0053, 8), null);
  assert.equal(annualizedFunding(0.01, 8), null);
  assert.equal(annualizedFunding(null, 8), null);
  assert.equal(annualizedFunding(0.0002, 0), null);
});

test('a template with a null annualised rate omits the clause instead of printing a hole', () => {
  const t = templates.find(x => x.id === 'funding.ledger')!;
  const ctx: Context = { cashtag: '$NMR', funding: -0.0053, annualized: null, payer: '空头', intervalHours: 8 };
  const r = renderTemplate(t, ctx, { seed: 1, bank: wordBank });
  assert.equal(r.ok, true);
  assert.ok(!/年化约?\s*%/.test(r.text), `left a blank annualisation: ${r.text}`);
  assert.match(r.text, /-0\.530%/);
});

test('word bank has no duplicate keys', async () => {
  // A repeated literal key silently overrides the earlier one, so a cleanup pass can
  // be undone without any error. Catch it in the source text instead.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/content/wordbank.ts', import.meta.url), 'utf8');
  const keys = [...src.matchAll(/^\s*'([a-z][\w.]*)':\s*'/gm)].map(m => m[1] as string);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual([...new Set(dupes)], [], '重复的词库键会后写覆盖前写');
});

test('every take.* usage site carries its own punctuation', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/content/templates.ts', import.meta.url), 'utf8');
  // A following control tag ({{#else}}, {{/if}}) is fine. Everything else must be
  // explicit punctuation — including a bare newline, which is what left
  // "…但情绪决定波动" running into the next line without a stop.
  const bad = [...src.matchAll(/\{\{@take\.[a-z.]+\}\}(?!。|；|，|、|：|！|？|{{#|{{\/)/g)];
  assert.equal(bad.length, 0, `缺标点风险：${bad.map(b => b[0]).join(', ')}`);
});

test('phrase.* usage sites never add a second terminator', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/content/templates.ts', import.meta.url), 'utf8');
  // phrase.* entries carry their own full stop, so a trailing one here produced "。。".
  const bad = [...src.matchAll(/\{\{@phrase\.[a-z]+\}\}[。，、；：]/g)];
  assert.equal(bad.length, 0, `双标点：${bad.map(b => b[0]).join(', ')}`);
});

test('truthy treats zero and empty collections as absent', () => {
  assert.equal(truthy(0), false);
  assert.equal(truthy(''), false);
  assert.equal(truthy([]), false);
  assert.equal(truthy(-1), true);
});

test('comma never ships a large count with decimal noise', async () => {
  const { filters } = await import('../src/engine/filters.ts');
  const comma = filters.comma!;
  assert.equal(comma(557079890.2), '557,079,890');
  assert.equal(comma(44564044), '44,564,044');
  assert.equal(comma(231730), '231,730');
  // Below the rounding threshold the old behaviour stands: 2dp for a non-integer.
  // Both real callers (open interest, board views) are far above 1000.
  assert.equal(comma(2.5), '2.50');
  assert.equal(comma(999), '999');
});
