import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templates } from '../src/content/templates.ts';
import { LENSES, countNumbers, referencedFields } from '../src/content/lens.ts';
import { eligibleTemplates } from '../src/engine/compose.ts';
import { makeMaterial } from '../src/material/types.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { applyVoice, generate } from '../src/pipeline.ts';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import { followCta, stanceLine, tensionLine } from '../src/content/voice.ts';
import { DIMENSIONS, HYPOTHESES, type Dimension } from '../src/rank/hypotheses.ts';
import { playbook } from '../src/rank/playbook.ts';
import { preFlight } from '../src/engine/preflight.ts';
import { wordBank } from '../src/content/wordbank.ts';
import type { Context } from '../src/engine/types.ts';
/**
 * A template that claims `style: 'data'` but never reads a data-lens field is a label, not
 * a voice — and a reader scanning the feed can tell. This is the check that keeps the seven
 * styles from collapsing back into one sentence.
 */
test('every style-specific template actually uses its own lens', () => {
  const offenders: string[] = [];
  for (const t of templates) {
    if (t.style === 'any' || !LENSES[t.style]) continue;
    const used = referencedFields(t.body);
    const hit = LENSES[t.style]!.fields.some(f => used.has(f));
    if (!hit) offenders.push(`${t.id} [${t.style}] — 正文没引用该风格镜头里的任何字段（可用：${LENSES[t.style]!.fields.slice(0, 5).join('/')}…）`);
  }
  assert.deepEqual(offenders, [], `\n${offenders.length} 条模版挂名风格但没用该风格的镜头:\n  ${offenders.join('\n  ')}`);
});

test('the joke style stays light on numbers', async () => {
  const { renderTemplate } = await import('../src/engine/render.ts');
  const { wordBank } = await import('../src/content/wordbank.ts');
  const { toContext } = await import('../src/material/types.ts');
  const cap = LENSES.joke!.maxNumbers!;
  // Rendered output, not the source: every {{expr}} is a number the reader actually sees.
  const m = makeMaterial({
    category: 'market_move', subType: 'spike', title: 'SOL 拉升', symbol: 'SOL', source: '币安行情异动', at: 1,
    facts: { tf: '5分钟', chg: 5.2, price: 171.2, chg24h: 8.6, volMultiple: 3.1, funding: 0.00082, annualized: 89.8, payer: '多头', ratio: 2.1, longPct: 67.9, shortPct: 32.1 },
  });
  const ctx = toContext(m);
  const heavy: string[] = [];
  for (const t of templates.filter(x => x.style === 'joke')) {
    const r = renderTemplate(t, ctx, { seed: 'j', bank: wordBank });
    if (r.ok && countNumbers(r.text) > cap) heavy.push(`${t.id} 渲染出 ${countNumbers(r.text)} 个数字`);
  }
  assert.deepEqual(heavy, [], `段子手被数字压垮了:\n  ${heavy.join('\n  ')}`);
});

test('no two styles share an identical candidate set on a cell they both claim', () => {
  // The collapse this guards is measurable: before lenses existed, news/data/capital/chat all
  // saw the same two `any` templates for a dump, so they printed byte-identical posts.
  const styles = Object.keys(LENSES);
  const cells = new Set(templates.map(t => `${t.category}/${t.subType ?? '*'}`));
  const offenders: string[] = [];
  for (const cell of cells) {
    const [category = '', subType = '*'] = cell.split('/');
    const m = makeMaterial({ category: category as any, subType, title: 't', symbol: 'BTC', source: 'x', at: 1, facts: {} });
    const seen = new Map<string, string>();
    for (const s of styles) {
      const own = eligibleTemplates(m, templates, { style: s }).filter(t => t.style === s).map(t => t.id).sort().join(',');
      if (!own) continue;
      if (seen.has(own)) offenders.push(`${cell}: ${s} 与 ${seen.get(own)} 的自有模版完全相同（${own}）`);
      else seen.set(own, s);
    }
  }
  assert.deepEqual(offenders, [], `\n风格之间没有区分度:\n  ${offenders.join('\n  ')}`);
});

test('report which style x cell combinations are unwritable, and why', () => {
  const styles = Object.keys(LENSES);
  const cells = [...new Set(templates.map(t => `${t.category}/${t.subType ?? '*'}`))];
  const thin: string[] = [];
  for (const cell of cells) {
    const [category = '', subType = '*'] = cell.split('/');
    const m = makeMaterial({ category: category as any, subType, title: 't', symbol: 'BTC', source: 'x', at: 1, facts: {} });
    const covered = styles.filter(s => eligibleTemplates(m, templates, { style: s }).some(t => t.style === s));
    if (covered.length < 3) thin.push(`${cell.padEnd(28)} 只有 ${covered.length} 个风格有自有模版：${covered.join(', ') || '无'}`);
  }
  // Not an assertion — a standing inventory of what still cannot be written per style.
  if (thin.length) console.log(`\n风格覆盖不足（<3 个风格有自有模版）的格子 ${thin.length} 个：\n  ${thin.join('\n  ')}\n`);
  assert.ok(true);
});
/* ------------------------------------------------------------------ 声音 --- */

// The lines below cover the three voice knobs added from Binance's creator guidance
// (hook / stance / follow ask). The style-lens guards above cover something unrelated and
// equally load-bearing: that each of the seven styles actually reads its own lens fields.
const FUNDING_SHORT_PAYS: Context = { cashtag: '$STRK', funding: -0.0125, annualized: -70.2, payer: '空头', intervalHours: 8, price: 0.42, longRatio: 0.36, chg24h: -6.1 };
const FUNDING_LONG_PAYS: Context = { cashtag: '$STRK', funding: 0.0125, annualized: 70.2, payer: '多头', intervalHours: 8 };
const SKEW: Context = { cashtag: '$A', longRatio: 0.82, chg24h: 3 };
const VOL_UP: Context = { cashtag: '$A', chg24h: 9.4, volMultiple: 3.1 };
const QUIET: Context = { cashtag: '$A', chg24h: 0.4, price: 1.2 };

const ALL_CONTEXTS = [FUNDING_SHORT_PAYS, FUNDING_LONG_PAYS, SKEW, VOL_UP, QUIET];

test('the hook restates the paying side and adds nothing', () => {
  const short = tensionLine(FUNDING_SHORT_PAYS, 'seed-1');
  const long = tensionLine(FUNDING_LONG_PAYS, 'seed-1');
  assert.ok(short && long, 'a funding signal with a payer must always produce a hook');
  assert.match(short!, /空头/);
  assert.match(long!, /多头/);
  assert.notEqual(short, long, 'the hook must follow the direction, not be a fixed opener');
});

test('a hook or stance never contains a digit, so it cannot invent a number', () => {
  // The fact ledger is what keeps the copy honest, and every added sentence is one more chance to
  // slip past it. Making the sentences digit-free is cheaper than auditing them after the fact.
  for (const f of ALL_CONTEXTS) {
    for (const line of [tensionLine(f, 'x'), stanceLine(f, 'x'), followCta('x')]) {
      if (line === null) continue;
      assert.equal(/\d/.test(line), false, `digit in derived line: ${line}`);
      assert.equal(line.includes('$'), false, `cashtag in derived line: ${line}`);
    }
  }
});

test('no supporting fact means no line, rather than a sentence with nothing behind it', () => {
  // A missing arm is a lost sample. An invented line is a false measurement *and* a credibility
  // risk on a channel that says plainly it verifies what you claim.
  assert.equal(tensionLine({}, 'x'), null);
  assert.equal(stanceLine({}, 'x'), null);
  assert.equal(stanceLine(QUIET, 'x'), null, 'a 0.4% move is not a shape worth interpreting');
});

test('the stance is tied to the shape that produced it', () => {
  const extreme = stanceLine(FUNDING_SHORT_PAYS, 'x');
  const skewed = stanceLine(SKEW, 'x');
  assert.ok(extreme && skewed);
  assert.notEqual(extreme, skewed, 'a funding extreme and a positioning skew must not read the same');
});

test('the writer never claims a position, and the gate catches it if anything else does', () => {
  // The account does not trade. The platform lists mismatched positions and fake screenshots among
  // the things that quietly destroy account weight, so a fabricated "我建仓了" is a false trade
  // claim on a channel that checks — not a stylistic slip.
  for (const claim of ['$BTC 我刚建了多单。', '$BTC 我的仓位已经不小了。', '$BTC 本人已上车。', '$BTC 我这个空单赚了 20%。', '$BTC 晒一下我的持仓。']) {
    const r = preFlight({ text: `${claim} 不构成投资建议。`, facts: null, disclaimerRequired: true, sensitiveWords: [], maxChars: 2000 });
    assert.equal(r.ok, false, `should have blocked: ${claim}`);
    assert.match((r as { reason: string }).reason, /不做真实交易/);
  }

  // The curated pools must all survive the same gate, or the feature would be self-defeating.
  for (const f of ALL_CONTEXTS) {
    for (const line of [tensionLine(f, 's'), stanceLine(f, 's'), followCta('s')]) {
      if (!line) continue;
      const r = preFlight({ text: `$BTC 费率 -1.25%。${line} 不构成投资建议。`, facts: null, disclaimerRequired: true, sensitiveWords: [], maxChars: 2000 });
      assert.equal(r.ok, true, `curated line blocked: ${line} -> ${(r as { reason: string }).reason}`);
    }
  }
});

test('a hook the body already states is suppressed, so the arm means "has a hook" not "is longer"', () => {
  // The template for this cell says 「付费的一方是空头」in its first line. Leading with
  // 「空头在给多头付钱。」would say it twice, and the comparison would then measure word count —
  // which the registry already tests on its own as h_length_band. The arm has to differ from the
  // control in exactly one way, so a redundant hook is dropped instead of emitted anyway.
  const bodySaysPayer = '$STRK 费率 -1.250%，每 8 小时结算，付费的一方是空头；现价 $0.4215。';
  assert.equal(tensionLine(FUNDING_SHORT_PAYS, 'seed-1', bodySaysPayer), null, 'payer already stated: no hook');
  const skewBody = '多空比 1.77，多头明显占优。';
  assert.equal(tensionLine(SKEW, 'seed-1', skewBody), null, 'skew already stated, and no other fact supports a hook');

  // With nothing in the body covering it, the hook is available.
  const bodySaysPriceOnly = '$STRK 现价 $0.4215，成交 1.2 亿。';
  assert.ok(tensionLine(FUNDING_SHORT_PAYS, 'seed-1', bodySaysPriceOnly), 'an unstated fact still earns a hook');

  // And a body that uses up the top fact falls through to the next one rather than giving up.
  const volFacts: Context = { cashtag: '$A', funding: -0.001, payer: '空头', chg24h: 9.4, volMultiple: 3.1 };
  const next = tensionLine(volFacts, 'seed-2', '付费的一方是空头。');
  assert.ok(next, 'falls through to the volume fact rather than emitting a paraphrase');
  assert.match(next!, /量能|放量/);
});

test('a post gets one reading: a stance is dropped when the template already interpreted the data', () => {
  // What #318 actually shipped: the template concluded 「并不是没量的空涨」 and the stance pool
  // added 「量没跟上，这样的拉升我更想再看一眼」. Two thresholds, opposite answers, same post.
  // That is not a noisy sample, it is a broken one — the arm stopped meaning "has a reading".
  const contradicting = '$STRK 在 Hyperliquid 上 24 小时上涨 42.84%。并不是没量的空涨。';
  assert.equal(stanceLine({ cashtag: '$STRK', chg24h: 42.84, volMultiple: 1.2 } as Context, 's', contradicting), null);
  assert.equal(stanceLine(SKEW, 's', '仓位偏向一边，对波动会更敏感。'), null, 'a copy of the same opinion must not be doubled');

  // With no reading present, the stance is available.
  assert.ok(stanceLine(SKEW, 's', '$A 多空比 0.24，现价 1.2。'), 'an uninterpreted body still earns a reading');
});

test('every voice line lands above the disclaimer, which stays last', () => {
  // The property `withHashtags` exists to protect. Voice lines used to be appended to the raw end,
  // so a template carrying its own mid-body 「不构成建议」ended up with a reader question and a
  // 求关注 *below* the legal line.
  const body = '$GRIFFAIN 24 小时下跌 15.84%，目前报 0.0175。\n以上仅为信息整理，不构成建议。';
  const pb = {
    hashtagTotal: 2, attachChart: true, opening: 'question' as const, hook: 'tension' as const,
    stance: 'read' as const, cta: 'follow' as const, acting: [], verdicts: [],
  };
  const out = applyVoice(body, FUNDING_LONG_PAYS, pb, 'seed-order');
  const lines = out.split('\n').filter(l => l.trim());
  const at = lines.findIndex(l => /不构成/.test(l));
  assert.ok(at > 0, 'the disclaimer is present');
  assert.equal(at, lines.length - 1, `nothing may follow the compliance line, got: ${lines.slice(at + 1).join(' | ')}`);
  assert.ok(lines[0] !== undefined && /付钱|付费/.test(lines[0]), 'the hook still leads');
});

test('the voice knobs are off by default, so an unearned belief changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-voice-'));
  const store = Store.open(join(dir, 't.db'));
  try {
    const pb = playbook(store, { verdicts: [] });
    assert.equal(pb.hook, 'data');
    assert.equal(pb.stance, 'none');
    assert.equal(pb.cta, 'none');
    assert.equal(pb.acting.length, 0, 'nothing is acting on the post yet');

    const armed = playbook(store, { verdicts: [], arms: { h_hook_form: 'tension', h_stance: 'read', h_follow_cta: 'follow' } });
    assert.equal(armed.hook, 'tension');
    assert.equal(armed.stance, 'read');
    assert.equal(armed.cta, 'follow');
    assert.ok(armed.acting.every(a => a.source === 'experiment'), 'an assigned arm is an experiment, not a rule');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every experiment hypothesis names a knob the writer can actually turn', () => {
  // The invariant `propose()` enforces for database rows must hold for the built-ins too, or the
  // curated set would be exempt from the rule that stops an unmeasurable arm from taking traffic.
  for (const h of HYPOTHESES) {
    const spec = DIMENSIONS[h.dimension];
    assert.ok(spec, `${h.id} names an unknown dimension ${h.dimension}`);
    assert.deepEqual(h.arms, spec.arms, `${h.id} arms must match its dimension exactly`);
    if (h.mode === 'experiment') assert.equal(spec.kind, 'knob', `${h.id} randomises a dimension nobody can assign`);
  }
});

test('the official formula is registered as testable claims, not applied as rules', () => {
  // Binance's own creator guidance is a strong prior, and a strong prior is exactly what produced
  // the first false rule this system ever wrote. So it enters through the same door as everything
  // else: a claim, an arm, a metric, and a sample floor.
  const ids = ['h_hook_form', 'h_stance', 'h_follow_cta'];
  for (const id of ids) {
    const h = HYPOTHESES.find(x => x.id === id);
    assert.ok(h, `${id} missing`);
    assert.equal(h.mode, 'experiment');
    assert.ok(h.minSamples >= 10, `${id} needs a real floor before it can say anything`);
    assert.ok(h.risk.length > 10, `${id} must state what running it costs`);
  }
  // 晒单 is the one ingredient the guidance asks for that this account cannot honestly supply.
  assert.equal(HYPOTHESES.some(h => h.dimension === ('trade_receipt' as Dimension)), false);
});

test('the follow ask is decided only by the knob, never by a template rolling its own dice', () => {
  // Six templates used to append {{@cta.follow}} at `{{#maybe 35}}`. That put a follow line into
  // the control arm of h_follow_cta roughly a third of the time, which does not measure the CTA —
  // it measures nothing. The pool still exists; only the playbook may use it now.
  const bodies = Object.entries(wordBank).filter(([k]) => k.startsWith('cta.follow'));
  assert.equal(bodies.length, 1, 'one pool, referenced from one place');
  const src = JSON.stringify(Object.keys(wordBank));
  assert.ok(!src.includes('maybe'), 'no bank entry rolls its own randomness');
});

test('one coin cannot be posted eight times a day under different headings', async () => {
  // `coinSignalCooldownMinutes` compares like with like, so funding -> onchain -> market_move about
  // the same symbol each looked novel on its own. The live log caught one account queueing eight
  // STRK posts an evening that way, and Binance's creator guidance names 一味蹭热门币 as an
  // account-health penalty rather than a style choice. The three earlier posts are planted rather
  // than generated because each category needs its own fact shape to compose at all, and this test
  // is about the cap, not about template eligibility.
  const dir = mkdtempSync(join(tmpdir(), 'sf-cap-'));
  const store = Store.open(join(dir, 't.db'));
  try {
    const at = Date.now();
    for (const [i, cat] of ['onchain', 'market_move', 'long_short'].entries()) {
      const title = `STRK 旧信号 ${i}`;
      store.insertMaterial(makeMaterial({ category: cat as never, subType: 'spike', title, symbol: 'STRK', source: 'test', at: at - (i + 1) * 3600_000, score: 80, facts: {} }));
      const m = store.db.prepare('SELECT id FROM materials WHERE title = ?').get(title) as { id: string };
      const id = store.addPost({ materialId: m.id, templateId: null, text: `$STRK 这条旧信号已经发过了。不构成投资建议。`, status: 'published', scheduledAt: null });
      store.db.prepare('UPDATE posts SET published_at = ? WHERE id = ?').run(at - (i + 1) * 3600_000, id);
    }
    assert.equal(store.coinPostsSince(null, 'STRK', at - 86_400_000), 3, 'the cap can see all three categories');

    store.insertMaterial(makeMaterial({
      category: 'funding', subType: 'funding_extreme', title: 'STRK 资金费率极端', symbol: 'STRK', source: 'test', at: at - 60_000, score: 82,
      facts: {
        cashtag: '$STRK', funding: -0.0125, annualized: -70.2, payer: '空头', intervalHours: 8, price: 1.234,
        longRatio: 0.83, shortRatio: 1.2, chg24h: -3.42, chg1h: -0.41, volMultiple: 2.1, oiChangePct: -8.8,
      },
    }));
    const s = { ...DEFAULT_SETTINGS, autoPublish: true, dailyCap: 30, postsPerDay: 20, symbolDailyCap: 3, activeStartHour: 0, activeEndHour: 24 };
    const r = await generate(store, s, 1);
    assert.equal(r.created.length, 0, `the cap should have blocked a fourth: ${r.skipped.join(' | ')}`);
    assert.match(r.skipped.join(' '), /一味蹭热门币/);

    // Widen the cap and the coin-related rejection disappears, which attributes the block to the
    // cap rather than to some other guard that happened to fire first. Deliberately not asserting
    // that a draft is produced: whether one composes depends on which template the seed picks and
    // on the information floor, and neither is what this test is about.
    const roomier = await generate(store, { ...s, symbolDailyCap: 6 }, 1);
    assert.doesNotMatch(roomier.skipped.join(' '), /一味蹭热门币/, 'the cap must be the only thing that stopped it');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
