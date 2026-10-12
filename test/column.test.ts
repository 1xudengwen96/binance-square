import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnContext, columnFit, columnTemplates, pickColumnMaterial, readFunding } from '../src/content/column.ts';
import { renderTemplate } from '../src/engine/render.ts';
import { preFlight } from '../src/engine/preflight.ts';
import { wordBank } from '../src/content/wordbank.ts';
import { fundingIsBaseline, fundingPayer } from '../src/material/derive.ts';
import { fundingStreak } from '../src/collectors/detectors.ts';
import { makeMaterial } from '../src/material/types.ts';

const funding = (over: Record<string, unknown> = {}) =>
  makeMaterial({
    category: 'funding', subType: 'funding_extreme', title: 'x', symbol: 'ERA', source: 't', at: Date.now(),
    facts: { funding: -0.0012, annualized: -130, payer: '空头', chg24h: -5, quoteVolume24h: 50_000_000, ...over },
  });

test('the exchange default rate has no payer, so no post can claim a crowd from it', () => {
  // 0.01% per 8h and 0.00125% per hour are the same 10.95% a year: nobody chose it.
  assert.equal(fundingIsBaseline(10.95), true);
  assert.equal(fundingIsBaseline(11), true);
  assert.equal(fundingIsBaseline(-130), false);
  assert.equal(fundingPayer(0.0001, 10.95), '');
  assert.equal(fundingPayer(0.0012, 130), '多头');
  assert.equal(fundingPayer(-0.0012, -130), '空头');
  assert.equal(fundingPayer(0, 0), '');
});

test('funding streak counts consecutive same-sign settlements and what they cost', () => {
  const s = fundingStreak([0.0001, -0.002, -0.003, -0.001]);
  assert.deepEqual(s, { periods: 3, costPct: 0.6 });
  assert.equal(fundingStreak([-0.001, 0.002])?.periods, 1);
  assert.equal(fundingStreak([0.001, 0]), null);
  assert.equal(fundingStreak([]), null);
});

test('the column reads who pays against which way price went, in all four cells', () => {
  const cell = (payer: string, chg24h: number) => readFunding({ payer, chg24h, annualized: payer === '多头' ? 130 : -130 })?.reading;
  assert.equal(cell('多头', 6), 'longs_paying_into_strength');
  assert.equal(cell('多头', -6), 'longs_paying_into_weakness');
  assert.equal(cell('空头', 6), 'shorts_paying_into_strength');
  assert.equal(cell('空头', -6), 'shorts_paying_into_weakness');
});

test('the column refuses what it cannot say something true about', () => {
  assert.equal(readFunding({ payer: '', chg24h: 8, annualized: 11 }), null, 'default rate: nobody is paying');
  assert.equal(readFunding({ payer: '多头', chg24h: 0.5, annualized: 130 }), null, 'flat tape: no agreement to read');
  assert.equal(readFunding({ payer: '多头', chg24h: 8, annualized: 12 }), null, 'cost too small to be a position');
  assert.equal(columnFit(funding({ quoteVolume24h: 1_000_000 })).ok, false, 'thin book');
  assert.equal(columnFit(funding({ chg24h: undefined })).ok, false, 'no price context');
  assert.equal(columnFit(funding()).ok, true);
});

test('the column picks the most expensive rate, not the collector score', () => {
  const a = funding({ annualized: -60, funding: -0.0006 });
  const b = funding({ annualized: -300, funding: -0.003 });
  assert.equal(pickColumnMaterial([a, b]), b);
  assert.equal(pickColumnMaterial([funding({ chg24h: 0.1 })]), null);
});

test('every cell of the column renders, passes preflight, and never speaks as the trader', () => {
  const problems: string[] = [];
  for (const payer of ['多头', '空头'] as const) {
    for (const chg24h of [6, -6]) {
      const f = {
        cashtag: '$ERA', symbol: 'ERA', payer, chg24h,
        funding: payer === '多头' ? 0.0012 : -0.0012, annualized: payer === '多头' ? 130 : -130,
        streakPeriods: 5, streakCostPct: 3.2,
      };
      const r = renderTemplate(columnTemplates[0]!, columnContext(f)!, { seed: 's', bank: wordBank });
      if (!r.ok) { problems.push(`${payer}/${chg24h}: ${r.reason}`); continue; }
      assert.match(r.text, /^【费率账】/);
      const pf = preFlight({ text: r.text, facts: r.facts, disclaimerRequired: true, sensitiveWords: [], maxChars: 2000 });
      if (!pf.ok) problems.push(`${payer}/${chg24h}: ${pf.reason}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('a streak line appears only when the streak is long enough to mean something', () => {
  const base = { cashtag: '$ERA', symbol: 'ERA', payer: '空头', chg24h: -6, funding: -0.0012, annualized: -130 };
  const short = renderTemplate(columnTemplates[0]!, columnContext({ ...base, streakPeriods: 2, streakCostPct: 0.4 })!, { seed: 's', bank: wordBank });
  const long = renderTemplate(columnTemplates[0]!, columnContext({ ...base, streakPeriods: 7, streakCostPct: 3.2 })!, { seed: 's', bank: wordBank });
  assert.ok(short.ok && long.ok);
  if (short.ok && long.ok) {
    assert.doesNotMatch(short.text, /连续/);
    assert.match(long.text, /连续 7 次结算同向/);
  }
});
