import { test } from 'node:test';
import assert from 'node:assert/strict';
import { polish, polishAcceptable, sameTags } from '../src/llm/polish.ts';
import { renderTemplate } from '../src/engine/render.ts';
import { templates } from '../src/content/templates.ts';
import { wordBank } from '../src/content/wordbank.ts';
import type { LlmConfig } from '../src/llm/providers.ts';
import type { Fact } from '../src/engine/types.ts';

const cfg: LlmConfig = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-t' };

/** Render a real template so the fact ledger is the one the copy was built from. */
function sample(seed = 5) {
  const t = templates.find(x => x.id === 'attention.follow')!;
  const ctx = {
    cashtag: '$BTC', price: 83877.1, chg24h: -2.38, chg1h: -0.23, volMultiple: 2.1,
    funding: -0.00005, annualized: -5.5, oiChangePct: -0.9, squareViews: 1275025,
    squarePosts: 16, squareRank: 1, sustainedHours: 2.5, agreeing: 2,
  };
  const r = renderTemplate(t, ctx, { seed, bank: wordBank });
  assert.ok(r.ok, 'sample template should render');
  return r;
}

function replyWith(text: string) {
  const prev = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  return () => { globalThis.fetch = prev; };
}

test('a faithful rewrite is accepted', () => {
  const r = sample();
  const out = r.text.replace('把数据摆在一起看：', '数据是这样的：');
  assert.equal(polishAcceptable(r.text, out, r.facts).ok, true);
});

test('an invented number is rejected', () => {
  const r = sample();
  const v = polishAcceptable(r.text, `${r.text}\n预计还有 15% 的空间`, r.facts);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? '', /15/);
});

test('an invented cashtag is rejected', () => {
  const r = sample();
  const v = polishAcceptable(r.text, r.text.replace('$BTC', '$BTC 和 $ETH'), r.facts);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? '', /币种/);
});

test('a dropped cashtag is rejected too', () => {
  const r = sample();
  assert.equal(polishAcceptable(r.text, r.text.replace(/\$BTC/g, '比特币'), r.facts).ok, false);
  assert.equal(sameTags('$BTC 涨', '$BTC 和 $ETH 涨'), false);
});

test('structural drift is rejected', () => {
  const r = sample();
  const flattened = r.text.split('\n').join(' ');
  assert.equal(polishAcceptable(r.text, flattened, r.facts).ok, false);
});

test('length blowout is rejected', () => {
  const r = sample();
  assert.equal(polishAcceptable(r.text, r.text + '。'.repeat(400), r.facts).ok, false);
  assert.equal(polishAcceptable(r.text, '嗯。', r.facts).ok, false);
});

test('polish keeps the template text when AI is off or unconfigured', async () => {
  const r = sample();
  assert.deepEqual(await polish(null, r.text, r.facts), { text: r.text, changed: false, reason: 'AI 未启用或未配置' });
  assert.equal((await polish({ ...cfg, apiKey: '' }, r.text, r.facts)).changed, false);
  assert.equal((await polish({ ...cfg, model: '' }, r.text, r.facts)).changed, false);
});

test('polish swaps in a good rewrite', async () => {
  const r = sample();
  const restore = replyWith(r.text.replace('把数据摆在一起看：', '数据是这样的：'));
  try {
    const out = await polish(cfg, r.text, r.facts);
    assert.equal(out.changed, true);
    assert.match(out.text, /数据是这样的/);
  } finally {
    restore();
  }
});

test('polish strips a code fence the model added anyway', async () => {
  const r = sample();
  const restore = replyWith('```markdown\n' + r.text + '\n```');
  try {
    const out = await polish(cfg, r.text, r.facts);
    assert.equal(out.changed, true);
    assert.ok(!out.text.includes('```'));
  } finally {
    restore();
  }
});

test('polish falls back to the template when the model invents data', async () => {
  const r = sample();
  const restore = replyWith(`${r.text}\n目标价看到 120,000 美元`);
  try {
    const out = await polish(cfg, r.text, r.facts);
    assert.equal(out.changed, false);
    assert.equal(out.text, r.text);
    assert.match(out.reason ?? '', /数字/);
  } finally {
    restore();
  }
});

test('polish falls back when the provider call fails', async () => {
  const r = sample();
  const prev = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429 })) as unknown as typeof fetch;
  try {
    const out = await polish(cfg, r.text, r.facts);
    assert.equal(out.changed, false);
    assert.equal(out.text, r.text);
    assert.match(out.reason ?? '', /调用失败/);
  } finally {
    globalThis.fetch = prev;
  }
});

test('facts ledger is what makes the gate work, not string matching', () => {
  const facts: Fact[] = [
    { surface: '83877.1', value: 83877.1, field: 'price', kind: 'number' },
    { surface: '$BTC', value: null, field: 'cashtag', kind: 'symbol' },
  ];
  assert.equal(polishAcceptable('$BTC 现价 83877.1', '$BTC 现在 83877.1', facts).ok, true);
  assert.equal(polishAcceptable('$BTC 现价 83877.1', '$BTC 现在 83877.2', facts).ok, false);
});
