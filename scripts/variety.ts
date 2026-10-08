/**
 * Effective variety, not template count.
 *
 * A template with pools and conditionals yields many distinct posts; seven
 * near-identical templates yield one post seven times. This measures what a reader
 * actually sees, per (category, subType) cell, so effort goes where the feed is
 * genuinely repetitive rather than where a counter looks impressive.
 *
 * Run: npx tsx scripts/variety.ts [seeds]
 */
import { templates } from '../src/content/templates.ts';
import { wordBank } from '../src/content/wordbank.ts';
import { eligibleTemplates, compose } from '../src/engine/compose.ts';
import { makeMaterial, type Material } from '../src/material/types.ts';
import type { Context } from '../src/engine/types.ts';

const SEEDS = Number(process.argv[2] ?? 150);

/** One representative material per cell we can currently feed. */
const CELLS: { category: string; subType: string; facts: Context }[] = [
  { category: 'market_move', subType: 'spike', facts: { tf: '15分钟', chg: 5.2, price: 186.4, chg24h: 8.6, volMultiple: 3.4 } },
  { category: 'market_move', subType: 'dump', facts: { tf: '5分钟', chg: -3.2, price: 0.412, chg24h: -7.4, volMultiple: 2.1 } },
  { category: 'market_move', subType: 'volume_surge', facts: { price: 1.234, chg24h: 4.1, volMultiple: 6.2, quoteVolumeHour: 8_400_000 } },
  { category: 'market_move', subType: 'new_high', facts: { price: 712.4, extreme: 718.9, chg24h: 4.1 } },
  { category: 'market_move', subType: 'new_low', facts: { price: 0.0231, extreme: 0.0228, chg24h: -9.2 } },
  { category: 'market_move', subType: 'ma_golden', facts: { tf: '4 小时', price: 1.0949, maFast: 1.1683, maSlow: 1.1709, fastLen: 20, slowLen: 55, gapPct: -6.29, chg24h: -2.54, dir: '上穿', cross: '金叉', oiChangePct: 4.2, quoteVolume24h: 396_000_000, volMultiple: 1.8, funding: 0.0000832, payer: '多头' } },
  { category: 'market_move', subType: 'ma_death', facts: { tf: '日线', price: 59.31, maFast: 60.68, maSlow: 60.75, fastLen: 20, slowLen: 200, gapPct: -2.26, chg24h: -0.69, dir: '下穿', cross: '死叉', oiChangePct: -5.1, quoteVolume24h: 957_000_000, volMultiple: 1.2, funding: -0.00012, payer: '空头' } },
  { category: 'open_interest', subType: 'oi_shift', facts: { window: '5小时', oiChangePct: -7.6, oiUsd: 289_222_089, price: 4.965, chg24h: -2.65, dir: '减少', shape: '多头止损', gapRatio: 2.87, funding: 0.00000163, annualized: 0.2, payer: '多头', longRatio: 1.51, chg1h: -0.22, quoteVolume24h: 1_212_000_000 } },
  { category: 'funding', subType: 'funding_extreme', facts: { funding: 0.00082, annualized: 89.8, payer: '多头', intervalHours: 8, price: 4512.3, chg24h: 3.4, chg1h: 0.42, longRatio: 2.34, oiChangePct: 4.1, quoteVolume24h: 842_000_000 } },
  { category: 'long_short', subType: 'account_ratio', facts: { scope: '1小时', ratio: 1.62, longPct: 61.8, shortPct: 38.2, prevRatio: 1.44, ratioDiff: 0.18 } },
  { category: 'leaderboard', subType: 'gainers', facts: { scope: '24小时', topChg: 39.84, board: [{ rank: 1, symbol: 'NMR', chg: 39.84 }, { rank: 2, symbol: 'CHZ', chg: 21.5 }, { rank: 3, symbol: 'BR', chg: 15.2 }] } },
  { category: 'leaderboard', subType: 'losers', facts: { scope: '24小时', topChg: -27.07, board: [{ rank: 1, symbol: 'LYN', chg: -27.07 }, { rank: 2, symbol: 'AIN', chg: -18.4 }, { rank: 3, symbol: 'MINA', chg: -12.1 }] } },
  { category: 'sentiment', subType: 'fear_greed', facts: { value: 74, label: '贪婪', prev: 66 } },
  { category: 'stablecoin', subType: 'daily_delta', facts: { assetName: 'USDT', delta: 620_000_000, direction: '增发', total: 132_000_000_000 } },
  { category: 'trending', subType: 'hot_board', facts: { topic: '比特币突破十万美金', heat: 4_820_000, boardName: '头条热榜' } },
  { category: 'dex', subType: 'trending_pool', facts: { chain: 'Solana', poolName: 'PUMP / SOL', volume24h: 48_000_000, chg24h: 12.4, reserveUsd: 2_100_000 } },
  { category: 'onchain', subType: 'hl_funding', facts: { venue: 'Hyperliquid', funding: -0.00042, fundingPct: -0.042, price: 0.412, chg24h: -6.2, volume24h: 91_000_000, openInterest: 18_400_000, oiUsd: 7_580_000, annualized: -92.1, payer: '空头', chg1h: -1.1, longRatio: 0.72, oiChangePct: -4.8, quoteVolume24h: 214_000_000, venueSharePct: 42.5 } },
  { category: 'onchain', subType: 'hl_move', facts: { venue: 'Hyperliquid', funding: 0.00004, price: 2.412, chg24h: 14.8, volume24h: 33_000_000, openInterest: 4_400_000, oiUsd: 10_612_800, chg1h: 2.3, longRatio: 1.62, oiChangePct: 5.4, quoteVolume24h: 198_000_000, venueSharePct: 16.7, payer: '多头', annualized: 8.5 } },
  { category: 'announcement', subType: 'listing', facts: { catalogLabel: '新上线', coinCount: 1, url: '' } },
  { category: 'announcement', subType: 'delisting', facts: { catalogLabel: '下架', coinCount: 1, url: '' } },
  { category: 'announcement', subType: 'campaign', facts: { catalogLabel: '活动', coinCount: 0, url: '' } },
  { category: 'newsflash', subType: 'general', facts: { body: '某机构宣布支持质押', wire: 'wublock', ageMinutes: 12 } },
  { category: 'newsflash', subType: 'regulation', facts: { body: '监管机构发布新规', wire: 'wublock', ageMinutes: 25 } },
  { category: 'newsflash', subType: 'institution', facts: { body: '上市公司增持', wire: 'wublock', ageMinutes: 8 } },
  { category: 'newsflash', subType: 'security', facts: { body: '协议遭攻击损失金额待定', wire: 'wublock', ageMinutes: 41 } },
  { category: 'attention', subType: 'follow', facts: { price: 83877.1, chg24h: -2.38, chg1h: -0.23, volMultiple: 2.1, funding: -0.00005, annualized: -5.5, oiChangePct: -0.9, longRatio: 1.42, squareViews: 1275025, squarePosts: 16, squareDiscuss: 1080, squareRank: 1, sustainedHours: 2.5, sustainedMinutes: 150, samples: 7, scoreStart: 48, scorePeak: 56, agreeing: 3, hashtag: '#bitcoin', attentionScore: 54.4, rank: 1 } },
  { category: 'attention', subType: 'topic', facts: { price: 82150.4, chg24h: -1.51, chg1h: -0.24, volMultiple: 1.9, funding: 0.00002694, annualized: 2.9, payer: '多头', oiChangePct: -0.5, longRatio: 1.82, agreeing: 1, hashtag: '#bitcoin', attentionScore: 52.2, rank: 2, squareRank: 1, squareViews: 749627, squarePosts: 13, squareDiscuss: 797, sustainedMinutes: 35, samples: 4, scoreStart: 44, scorePeak: 52, quoteVolume24h: 1_240_000_000 } },
];

const norm = (s: string) => s.replace(/\s+/g, '');

let totalUnique = 0;
const rows: string[] = [];

for (const cell of CELLS) {
  const material: Material = makeMaterial({
    category: cell.category as Material['category'],
    subType: cell.subType,
    title: `${cell.category} ${cell.subType} 测试素材`,
    symbol: 'BTC',
    source: 'synthetic',
    at: Date.now(),
    facts: cell.facts,
  });

  const eligible = eligibleTemplates(material, templates);
  const bodies = new Set(eligible.map(t => t.id));
  const surfaces = new Set<string>();
  let rendered = 0;

  for (const t of eligible) {
    for (let i = 0; i < SEEDS; i++) {
      const c = compose(material, [t], { seed: `${cell.category}/${cell.subType}:${i}`, bank: wordBank, style: 'mixed' });
      if ('error' in c) continue;
      rendered++;
      surfaces.add(norm(c.text));
    }
  }

  totalUnique += surfaces.size;
  const perBody = bodies.size ? (surfaces.size / bodies.size).toFixed(1) : '0';
  rows.push(
    `${(cell.category + '/' + cell.subType).padEnd(28)} 正文 ${String(bodies.size).padStart(2)}   风格 ${new Set(eligible.map(t => t.style)).size}   ${SEEDS} 次采样产出 ${String(surfaces.size).padStart(4)} 种   每正文 ${perBody} 种`,
  );
}

console.log(`\n每个格子用 ${SEEDS} 个不同 seed 渲染，统计**去重后的正文种类数**：\n`);
for (const r of rows) console.log('  ' + r);
console.log(`\n合计 ${totalUnique} 种不同正文（${templates.length} 条模版产出）`);
console.log('注：「每正文 N 种」= 该格子的分支/随机池展开度。这个数字低说明正文写得死，堆条数也没用。');
