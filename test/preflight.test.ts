import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preFlight } from '../src/engine/preflight.ts';
import type { Fact } from '../src/engine/types.ts';

const facts: Fact[] = [
  { field: 'cashtag', kind: 'symbol', surface: '$BTC', value: null },
  // `value` is the figure as displayed, which is how the renderer records it — the ledger
  // compares what a reader sees against what a reader sees.
  { field: 'funding', kind: 'number', surface: '-1.250%', value: -1.25 },
  { field: 'longRatio', kind: 'number', surface: '0.83', value: 0.83 },
];
const base = { facts, disclaimerRequired: true, sensitiveWords: ['带单', '稳赚'], maxChars: 2000 };

test('the publisher guarantees the disclaimer, whoever forgot it', () => {
  const r = preFlight({ ...base, text: '$BTC 费率 -1.250%，多空比 0.83。' });
  assert.ok(r.ok);
  assert.match(r.text, /不构成投资建议/);
  assert.equal(r.note, '发布前补上免责声明');
});

test('an existing disclaimer of any wording is left alone', () => {
  const r = preFlight({ ...base, text: '$BTC 费率 -1.250%。个人观点，不构成投资建议。' });
  assert.ok(r.ok);
  assert.equal(r.note, undefined);
  assert.equal((r as { text: string }).text.match(/不构成/g)?.length, 1, 'not doubled up');
});

test('a shrug is not accepted as a disclaimer', () => {
  // The exact sentence that let four posts ship without a compliance line.
  const r = preFlight({ ...base, text: '$BTC 费率 -1.250%。数据摆在这儿，决定你自己做。' });
  assert.ok(r.ok);
  assert.match(r.text, /内容仅供参考/);
});

test('directive language is blocked rather than patched', () => {
  for (const t of ['$BTC 费率 -1.250%，建议立即做多。', '$BTC 目标价 120000。', '$BTC 稳赚的一波。', '$BTC 详情带单']) {
    const r = preFlight({ ...base, text: t });
    assert.equal(r.ok, false, `should have blocked: ${t}`);
  }
});

/** Whether the gate read this text as a price target, as opposed to blocking it for some other reason. */
const asPriceTarget = (t: string): boolean => {
  const r = preFlight({ ...base, text: t });
  return !r.ok && (r as { reason: string }).reason.includes('价格目标');
};

test('a price level is still caught in the phrasings that actually show up', () => {
  for (const t of ['$BTC 看到 120000。', '$BTC 上看3万。', '$BTC 下看 95000 美元。', '$BTC 目标位 0.83。', '$BTC 第一目标 0.83。']) {
    assert.ok(asPriceTarget(t), `should read as a price target: ${t}`);
  }
});

test('a count after a looking-verb is not mistaken for a price target', () => {
  // `看到\d+` blocked all of these. A compliance gate that fires on clean copy teaches the
  // operator to stop reading its verdicts, which costs more than the phrasing it was added for.
  for (const t of ['$BTC 费率 -1.250%，可以看到2个信号。', '$BTC 费率 -1.250%，上看3条线索。', '$BTC 费率 -1.250%，看到10%的回落。', '$BTC 费率 -1.250%，看到2小时内的放量。']) {
    assert.ok(!asPriceTarget(t), `should not read as a price target: ${t}`);
  }
});

test('a number that appeared after drafting is blocked', () => {
  // This is the whole reason the check runs at the last mile: the ledger was clean when the
  // draft was written, and something between then and sending introduced a figure.
  const r = preFlight({ ...base, text: '$BTC 费率 -1.250%，多空比 0.83，持仓 4.2 亿美元。' });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /台账外/);
});

test('an edit that breaks the ledger is caught even after the panel approved it', () => {
  const ok = preFlight({ ...base, text: '$BTC 费率 -1.250%。' });
  assert.ok(ok.ok);
  const edited = preFlight({ ...base, text: '$BTC 费率 -1.9%。' });
  assert.equal(edited.ok, false);
});

test('over-long copy is refused, never truncated', () => {
  const r = preFlight({ ...base, maxChars: 40, text: `${'$BTC 费率 -1.250%，多空比 0.83。'.repeat(5)}` });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /不做截断/);
});

test('a post with no ledger is still checked for the rest', () => {
  const r = preFlight({ ...base, facts: null, text: '$BTC 涨了 12%。' });
  assert.ok(r.ok, 'no facts means no ledger to violate, not a free pass on everything else');
  const bad = preFlight({ ...base, facts: null, text: '$BTC 建议抄底。' });
  assert.equal(bad.ok, false);
});
