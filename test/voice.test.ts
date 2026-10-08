import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templates } from '../src/content/templates.ts';
import { LENSES, countNumbers, referencedFields } from '../src/content/lens.ts';
import { eligibleTemplates } from '../src/engine/compose.ts';
import { makeMaterial } from '../src/material/types.ts';

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
