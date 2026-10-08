/**
 * Render every template against synthetic materials so copy can be reviewed
 * without a database or network. Run: npx tsx scripts/demo-render.ts
 */
import { renderTemplate } from '../src/engine/render.ts';
import { auditAgainstFacts } from '../src/engine/verify.ts';
import { templates } from '../src/content/templates.ts';
import { wordBank } from '../src/content/wordbank.ts';
import { makeMaterial, toContext } from '../src/material/types.ts';
import type { Material } from '../src/material/types.ts';

const now = Date.now();

const samples: Material[] = [
  makeMaterial({
    category: 'funding', subType: 'funding_extreme', title: 'ETH 资金费率走高',
    symbol: 'ETH', source: '币安资金费率', at: now, sentiment: 'neutral', score: 64,
    facts: { funding: 0.00082, annualized: 89.8, payer: '多头', intervalHours: 8, price: 4512.3, chg24h: 3.4 },
  }),
  makeMaterial({
    category: 'market_move', subType: 'spike', title: 'SOL 15分钟拉升',
    symbol: 'SOL', source: '币安行情异动', at: now, sentiment: 'bull', score: 71,
    facts: { tf: '15分钟', chg: 5.2, price: 186.4, chg24h: 8.6, volMultiple: 3.4 },
  }),
  makeMaterial({
    category: 'market_move', subType: 'new_high', title: 'BNB 创 24 小时新高',
    symbol: 'BNB', source: '币安行情异动', at: now, sentiment: 'bull', score: 58,
    facts: { price: 712.4, extreme: 718.9, chg24h: 4.1 },
  }),
  makeMaterial({
    category: 'leaderboard', subType: 'gainers', title: '24小时涨幅榜',
    source: '币安行情异动', at: now, sentiment: 'bull', score: 60,
    facts: {
      scope: '24小时',
      board: [
        { rank: 1, symbol: 'NMR', chg: 39.84 },
        { rank: 2, symbol: 'CHZ', chg: 21.5 },
        { rank: 3, symbol: 'BR', chg: 17.5 },
      ],
    },
  }),
  makeMaterial({
    category: 'etf_flow', subType: 'daily_flow', title: '比特币现货 ETF 净流出',
    symbol: 'BTC', source: 'ETF 资金流', at: now, sentiment: 'bear', score: 66,
    facts: { assetName: '比特币', flowUsd: -3_680_000, flowDate: '10月6日', flowDir: '净流出', streak: 2, streakDir: '流出' },
  }),
  makeMaterial({
    category: 'long_short', subType: 'account_ratio', title: 'SOL 多空比走高',
    symbol: 'SOL', source: '币安多空比', at: now, sentiment: 'bull', score: 52,
    facts: { scope: '4小时', ratio: 1.42, longPct: 58.6, shortPct: 41.4 },
  }),
  makeMaterial({
    category: 'sentiment', subType: 'fear_greed', title: '恐惧贪婪指数 71',
    source: '恐惧贪婪指数', at: now, sentiment: 'neutral', score: 55,
    facts: { value: 71, label: '贪婪', prev: 66 },
  }),
  makeMaterial({
    category: 'liquidation', subType: 'cascade', title: 'DOGE 连环爆仓',
    symbol: 'DOGE', source: '币安爆仓监控', at: now, sentiment: 'bear', score: 63,
    facts: { amountUsd: 12_400_000, side: '多头', window: '30分钟' },
  }),
];

const seeds = [11, 202, 3003];
let failures = 0;

for (const m of samples) {
  const ctx = toContext(m);
  console.log(`\n${'='.repeat(72)}\n素材 [${m.category}/${m.subType}] ${m.title}  score=${m.score}`);
  const matching = templates.filter(t => t.category === m.category);
  if (!matching.length) console.log('  (没有该类目的模版)');

  for (const t of matching) {
    for (const seed of seeds) {
      const r = renderTemplate(t, ctx, { seed, bank: wordBank });
      if (!r.ok) {
        console.log(`\n-- ${t.name} · seed ${seed} → 跳过：${r.reason}`);
        continue;
      }
      const audit = auditAgainstFacts(r.text, r.facts);
      if (!audit.ok) failures++;
      console.log(`\n-- ${t.name} · ${t.style} · seed ${seed} · ${r.text.length}字 · 事实校验 ${audit.ok ? 'PASS' : `FAIL ${JSON.stringify(audit)}`}`);
      console.log(r.text);
    }
  }
}

console.log(`\n${'='.repeat(72)}\n事实校验失败：${failures} 条`);
process.exit(failures ? 1 : 0);
