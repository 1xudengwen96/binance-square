/**
 * Coverage report: which (category, subType) cells can we actually feed, and
 * which have templates. A cell with data but no template is lost output; a cell
 * with a template but no data is fake breadth, which is worse.
 *
 * Run: npx tsx scripts/coverage.ts
 */
import { templates } from '../src/content/templates.ts';
import { ALL_CATEGORIES } from '../src/config.ts';

/** Sub-types our collectors emit, kept here so the report is honest about feed status. */
const FEEDABLE: Record<string, string[]> = {
  market_move: ['spike', 'dump', 'volume_surge', 'new_high', 'new_low', 'ma_golden', 'ma_death'],
  open_interest: ['oi_shift'],
  funding: ['funding_extreme'],
  long_short: ['account_ratio'],
  leaderboard: ['gainers', 'losers'],
  sentiment: ['fear_greed'],
  stablecoin: ['daily_delta'],
  // liquidation deliberately absent: the template exists but its only free source is
  // the futures liquidation WebSocket, which could not be verified in this environment
  // — every stream including the always-busy !ticker@arr opened and delivered 0 frames.
  trending: ['hot_board'],
  dex: ['trending_pool'],
  onchain: ['hl_funding', 'hl_move'],
  attention: ['follow', 'topic'],
  announcement: ['listing', 'delisting', 'campaign', 'maintenance'],
  newsflash: ['general', 'regulation', 'institution', 'project', 'exchange', 'security'],
};

const STYLE_ORDER = ['any', 'tech', 'news', 'data', 'capital', 'emotion', 'chat', 'joke'];

const cells = new Map<string, { templates: number; styles: Set<string>; angles: Set<string> }>();
for (const t of templates) {
  const key = `${t.category}/${t.subType ?? '*'}`;
  const c = cells.get(key) ?? { templates: 0, styles: new Set(), angles: new Set() };
  c.templates++;
  c.styles.add(t.style);
  if (t.angle) c.angles.add(t.angle);
  cells.set(key, c);
}

let rows = 0;
let fed = 0;
console.log('\n分类/子类型                     模版  风格                        角度');
console.log('-'.repeat(78));

for (const cat of ALL_CATEGORIES) {
  const subs = FEEDABLE[cat] ?? [];
  const seen = new Set<string>();
  for (const sub of subs) {
    seen.add(sub);
    rows++;
    const exact = cells.get(`${cat}/${sub}`);
    const generic = cells.get(`${cat}/*`);
    const n = (exact?.templates ?? 0) + (generic?.templates ?? 0);
    if (n > 0) fed++;
    const styles = new Set([...(exact?.styles ?? []), ...(generic?.styles ?? [])]);
    const angles = [...(exact?.angles ?? []), ...(generic?.angles ?? [])];
    console.log(
      `${(cat + '/' + sub).padEnd(34)} ${String(n).padStart(3)}  ${[...styles].sort().join(',').padEnd(27)} ${angles.join('、') || '—'}`,
    );
  }
  // Templates whose subType we never feed — dead weight or a missing collector.
  for (const [key, c] of cells) {
    if (key.startsWith(`${cat}/`) && !seen.has(key.split('/')[1]!) && key.split('/')[1] !== '*') {
      console.log(`  ! ${key.padEnd(32)} ${String(c.templates).padStart(3)}  ← 有模版但没有这个数据源`);
    }
  }
}

console.log('-'.repeat(78));
console.log(`可产出的格子 ${rows} 个，有模版覆盖 ${fed} 个（${((fed / rows) * 100).toFixed(0)}%），模版总数 ${templates.length} 条`);
console.log(`风格分布：${STYLE_ORDER.map(s => `${s}=${templates.filter(t => t.style === s).length}`).join(' ')}`);
