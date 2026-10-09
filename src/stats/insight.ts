import { STYLE_LABELS } from '../config.ts';
import type { PerformanceRow, Store } from '../db/index.ts';

/**
 * What the numbers actually say, and what they refuse to say.
 *
 * The operator's question is "which content is worth digging into". Answering it badly is
 * worse than not answering: on a platform whose top post gets 797,000 views while its
 * median gets 121, two posts are enough to manufacture a "winner", and the tool would then
 * steer the whole account matrix toward a coin flip. So this file is mostly restraint rules.
 *
 * Three carry the design:
 *
 * 1. **Median, never mean.** Square's view distribution is power-law. One fluke post raises
 *    a template's average by 100x and buries the signal under the noise it just made.
 * 2. **A group needs MIN_SAMPLE before it may be ranked.** Below that it is still displayed —
 *    visible but explicitly not comparable, because hiding it would look like "nothing here"
 *    rather than "not enough data here".
 * 3. **Reach and attraction are separate measurements with separate fixes.** Views is the
 *    feed choosing to show you; likes and comments are readers choosing to respond. A post
 *    with 400 views and 0 reactions is not doing okay, and the fix for it (content) is not
 *    the fix for 40 views (distribution). Folding both into one score would hide that.
 */

/** Groups smaller than this are shown but never ranked or recommended on. */
export const MIN_SAMPLE = 5;
/** Below this many measured posts, nothing about *our* content can be concluded at all. */
export const MIN_CORPUS = 10;

export const CATEGORY_LABELS: Record<string, string> = {
  market_move: '行情异动', funding: '资金费率', long_short: '多空持仓', leaderboard: '涨跌幅榜',
  sentiment: '市场情绪', stablecoin: '稳定币', trending: '热搜话题', onchain: '链上数据',
  dex: 'DEX 热门', attention: '广场热度', announcement: '币安公告', newsflash: '快讯消息',
  liquidation: '爆仓', open_interest: '持仓异动', etf_flow: 'ETF 资金流',
};

/**
 * Chinese display labels for the `category/sub_type` slugs. These reach the screen as "具体信号",
 * and `onchain/hl_funding` makes an operator guess instead of read.
 */
export const SUBTYPE_LABELS: Record<string, string> = {
  'announcement/campaign': '活动', 'announcement/delisting': '下架公告', 'announcement/listing': '上新公告',
  'announcement/maintenance': '系统维护', 'announcement/news': '交易所消息',
  'attention/follow': '关注人数', 'attention/topic': '热议话题',
  'dex/trending_pool': '热门池放量',
  'funding/funding_extreme': '费率极值',
  'leaderboard/gainers': '涨幅榜', 'leaderboard/losers': '跌幅榜',
  'long_short/account_ratio': '账户多空比', 'long_short/position_ratio': '持仓多空比',
  'market_move/dump': '急跌', 'market_move/spike': '急拉', 'market_move/new_high': '创新高',
  'market_move/new_low': '创新低', 'market_move/volume_surge': '放量', 'market_move/ma_golden': '金叉', 'market_move/ma_death': '死叉',
  'newsflash/exchange': '快讯·交易所', 'newsflash/general': '快讯·综合', 'newsflash/institution': '快讯·机构',
  'newsflash/project': '快讯·项目方', 'newsflash/regulation': '快讯·监管', 'newsflash/security': '快讯·安全',
  'onchain/hl_funding': 'HL 费率分歧', 'onchain/hl_move': 'HL 持仓异动',
  'open_interest/oi_shift': '持仓量异动',
  'sentiment/fear_greed': '恐惧贪婪指数',
  'stablecoin/supply_shift': '发行量变化',
  'trending/hot_board': '热搜榜',
};

/** `category/sub_type` → 「链上数据 · HL 费率分歧」. Falls back to whatever is known. */
export function signalLabel(category: string | null, subType: string | null): string {
  const cat = category ? (CATEGORY_LABELS[category] ?? category) : '未分类';
  const sub = category && subType ? (SUBTYPE_LABELS[`${category}/${subType}`] ?? subType) : null;
  return sub ? `${cat} · ${sub}` : cat;
}

export interface GroupStat {
  key: string;
  label: string;
  /** Posts in this group at all, measured or not. */
  n: number;
  /** Posts with a stats reading — the real denominator for every number below. */
  measured: number;
  medianViews: number;
  meanViews: number;
  bestViews: number;
  /** (likes + comments + shares) per 1,000 views. */
  engagementPer1k: number;
  surfaced: number;
  /** Board median for the same value of this dimension, when the pool carries one. */
  benchmarkMedian: number | null;
  /** Our median ÷ board median. 1.0 means we sit at the same waterline as platform content. */
  vsBenchmark: number | null;
  rankable: boolean;
}

export interface Dimension {
  key: string;
  label: string;
  groups: GroupStat[];
  /** Why this dimension cannot support a conclusion yet, when that is the case. */
  note?: string;
}

export interface Insight {
  kind: 'lead' | 'cut' | 'watch' | 'info';
  text: string;
}

export interface AnalysisReport {
  window: { days: number; from: number; to: number };
  totals: {
    posts: number;
    measured: number;
    views: number;
    medianViews: number;
    likes: number;
    comments: number;
    shares: number;
    surfaced: number;
    engagementPer1k: number;
  };
  benchmark: { pool: number; medianViews: number; p90Views: number; trendMedian: number; newsMedian: number };
  dimensions: Dimension[];
  insights: Insight[];
  caveats: string[];
  /** False until enough measured posts exist to compare anything about our own content. */
  conclusive: boolean;
  /** More measured posts needed before the largest group reaches MIN_SAMPLE. */
  neededForFirstRank: number;
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const percentile = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

const isMeasured = (r: PerformanceRow): boolean => r.views != null;
const engagementOf = (r: PerformanceRow): number => (r.likes ?? 0) + (r.comments ?? 0) + (r.shares ?? 0);

/** Word-count bands, because length is a format decision the operator can actually make. */
function lengthBucket(chars: number): string {
  if (chars < 80) return '≤80 字';
  if (chars < 160) return '80–160 字';
  if (chars < 260) return '160–260 字';
  return '260 字以上';
}

function hourBucket(at: number): string {
  const h = new Date(at).getHours();
  if (h < 6) return '凌晨 0–6';
  if (h < 12) return '上午 6–12';
  if (h < 18) return '下午 12–18';
  return '晚间 18–24';
}

/** 1.2 万 / 340 — the scale these numbers live at, readable without counting zeros. */
const fmt = (x: number): string => (x >= 10_000 ? `${(x / 10_000).toFixed(1)} 万` : String(Math.round(x)));

interface DimSpec {
  key: string;
  label: string;
  keyOf: (r: PerformanceRow) => string | null;
  /** A coin key can be matched against the board pool; nothing else can. */
  matchesBoardCoin?: boolean;
}

const DIMS: DimSpec[] = [
  { key: 'category', label: '内容分类', keyOf: r => (r.category ? CATEGORY_LABELS[r.category] ?? r.category : null) },
  { key: 'subType', label: '具体信号', keyOf: r => (r.category && r.sub_type ? signalLabel(r.category, r.sub_type) : null) },
  { key: 'style', label: '写作风格', keyOf: r => (r.style ? STYLE_LABELS[r.style as keyof typeof STYLE_LABELS] ?? r.style : null) },
  { key: 'template', label: '模版', keyOf: r => r.template_name ?? r.template_id },
  { key: 'coin', label: '币种', keyOf: r => r.symbol, matchesBoardCoin: true },
  { key: 'chart', label: '是否带图', keyOf: r => (r.has_chart ? '带 K 线图' : '纯文字') },
  { key: 'length', label: '正文字数', keyOf: r => lengthBucket(r.chars) },
  { key: 'hour', label: '发布时段', keyOf: r => (r.published_at ? hourBucket(r.published_at) : null) },
  { key: 'account', label: '账号', keyOf: r => r.account_label },
];

export function analyze(store: Store, opts: { days?: number } = {}): AnalysisReport {
  const days = Math.max(1, Math.min(90, opts.days ?? 14));
  const now = Date.now();
  const rows = store.performanceRows(days);
  const surfaced = store.surfacedPostIds(rows.map(r => r.square_post_id).filter((x): x is string => Boolean(x)));

  const measured = rows.filter(isMeasured);
  const views = measured.map(r => r.views ?? 0);
  const totalViews = sum(views);
  const totalEngagement = sum(measured.map(engagementOf));

  const pool = store.boardViewPool();
  const trendPool = store.boardViewPool({ board: 'trend' });
  const newsPool = store.boardViewPool({ board: 'news' });

  const dimensions: Dimension[] = DIMS.map(dim => {
    const buckets = new Map<string, PerformanceRow[]>();
    for (const r of rows) {
      const k = dim.keyOf(r);
      if (!k) continue;
      const list = buckets.get(k);
      if (list) list.push(r);
      else buckets.set(k, [r]);
    }

    const groups: GroupStat[] = [...buckets].map(([key, list]) => {
      const gMeasured = list.filter(isMeasured);
      const gViews = gMeasured.map(r => r.views ?? 0);
      const gViewsTotal = sum(gViews);
      const med = median(gViews);
      // Benchmarks only exist per coin: the board sweep records which coin a post is about,
      // not which template wrote it. Anything else would be an invented comparison.
      const bench = dim.matchesBoardCoin ? store.boardViewPool({ coin: key }) : [];
      const benchMedian = bench.length >= MIN_SAMPLE ? median(bench) : null;
      return {
        key,
        label: key,
        n: list.length,
        measured: gMeasured.length,
        medianViews: Math.round(med),
        meanViews: gViews.length ? Math.round(gViewsTotal / gViews.length) : 0,
        bestViews: gViews.length ? Math.max(...gViews) : 0,
        // Per thousand views, not a percentage: at this scale a percentage rounds to 0.00 and
        // reads identical to "nobody responded", which is a different claim.
        engagementPer1k: gViewsTotal > 0 ? Number(((sum(gMeasured.map(engagementOf)) * 1000) / gViewsTotal).toFixed(1)) : 0,
        surfaced: list.filter(r => r.square_post_id && surfaced.has(r.square_post_id)).length,
        benchmarkMedian: benchMedian == null ? null : Math.round(benchMedian),
        vsBenchmark: benchMedian && benchMedian > 0 && med > 0 ? Number((med / benchMedian).toFixed(2)) : null,
        rankable: gMeasured.length >= MIN_SAMPLE,
      };
    });

    // Rankable groups first so a two-post group that got lucky cannot sit on top of the
    // table; within that, by median views.
    groups.sort((a, b) => Number(b.rankable) - Number(a.rankable) || b.medianViews - a.medianViews);

    const best = Math.max(0, ...groups.map(g => g.measured));
    return {
      key: dim.key,
      label: dim.label,
      groups,
      note: groups.length === 0 ? '还没有可归属的已发布帖子。' : best < MIN_SAMPLE ? `最大的一组只有 ${best} 条读数，未到 ${MIN_SAMPLE} 条的可比线。` : undefined,
    };
  });

  const biggestGroup = Math.max(0, ...dimensions.flatMap(d => d.groups.map(g => g.measured)));
  const neededForFirstRank = Math.max(0, MIN_SAMPLE - biggestGroup);

  return {
    window: { days, from: now - days * 86_400_000, to: now },
    totals: {
      posts: rows.length,
      measured: measured.length,
      views: totalViews,
      medianViews: Math.round(median(views)),
      likes: sum(measured.map(r => r.likes ?? 0)),
      comments: sum(measured.map(r => r.comments ?? 0)),
      shares: sum(measured.map(r => r.shares ?? 0)),
      surfaced: surfaced.size,
      engagementPer1k: totalViews > 0 ? Number(((totalEngagement * 1000) / totalViews).toFixed(1)) : 0,
    },
    benchmark: {
      pool: pool.length,
      medianViews: Math.round(median(pool)),
      p90Views: Math.round(percentile(pool, 90)),
      trendMedian: Math.round(median(trendPool)),
      newsMedian: Math.round(median(newsPool)),
    },
    dimensions,
    ...reason(measured, dimensions, {
      poolSize: pool.length,
      trendMedian: median(trendPool),
      newsMedian: median(newsPool),
      totalViews,
      totalEngagement,
      surfaced: surfaced.size,
      ourMedian: median(views),
    }),
    conclusive: measured.length >= MIN_CORPUS,
    neededForFirstRank,
  };
}

interface CompareContext {
  poolSize: number;
  trendMedian: number;
  newsMedian: number;
  totalViews: number;
  totalEngagement: number;
  surfaced: number;
  ourMedian: number;
}

/**
 * Turn the tables into sentences. Every sentence carries its own sample size, because the
 * reader has to be able to discount it — a bare "涨幅榜表现最好" would be read as fact and
 * acted on, and with n=3 it is a guess wearing a table.
 */
function reason(measured: PerformanceRow[], dimensions: Dimension[], ctx: CompareContext): { insights: Insight[]; caveats: string[] } {
  const insights: Insight[] = [];
  const caveats: string[] = [];

  if (ctx.poolSize >= MIN_SAMPLE) {
    if (ctx.ourMedian > 0) {
      // Two bands, not one ratio. "0.2% of the trending median" alone would put every normal
      // post in the same damning light; against the news stream the operator can tell whether
      // the gap is "not on the front page yet" or "below what an ordinary post earns".
      const trendPct = ctx.trendMedian > 0 ? (ctx.ourMedian / ctx.trendMedian) * 100 : 0;
      const where =
        ctx.ourMedian >= ctx.trendMedian ? '已经在热榜的常态水位之上'
          : ctx.ourMedian >= ctx.newsMedian ? `高于快讯流的常态水位（${(ctx.ourMedian / Math.max(1, ctx.newsMedian)).toFixed(1)}×），但离热榜常态还远`
            : `连快讯流的常态水位（${fmt(ctx.newsMedian)}）都还没到`;
      insights.push({
        kind: 'watch',
        text: `我们帖子的中位浏览 ${fmt(ctx.ourMedian)}：热榜同类中位 ${fmt(ctx.trendMedian)}（我们是它的 ${trendPct.toFixed(1)}%）、快讯流中位 ${fmt(ctx.newsMedian)}——${where}（基准样本 ${ctx.poolSize} 条）。` +
          (ctx.surfaced === 0
            ? '而且目前没有一条帖子出现在公开榜上，所以差距先在“能不能被推出去”，不在“写得好不好”。'
            : `已有 ${ctx.surfaced} 条上过公开榜，下一步该比的是上榜与未上榜的差值。`),
      });
    } else {
      insights.push({
        kind: 'info',
        text: `广场基准：热榜中位 ${fmt(ctx.trendMedian)} 浏览，快讯流中位 ${fmt(ctx.newsMedian)}（样本 ${ctx.poolSize} 条）。我们的帖子还没有可对比的读数。`,
      });
    }
    caveats.push('热榜基准有幸存者偏差：能进榜的帖子已经先过了算法筛选，所以这是“上榜之后的水位”，不是“随便发一条能拿到的水位”。');
  } else {
    caveats.push(`广场基准样本只有 ${ctx.poolSize} 条，未到 ${MIN_SAMPLE}，基准对比暂时不成立——多跑几轮自动采集就会积累起来。`);
  }

  if (measured.length < MIN_CORPUS) {
    insights.push({
      kind: 'info',
      text: `目前 ${measured.length} 条帖子拿到读数，还不足以判断哪种内容更吸引人（每组需 ${MIN_SAMPLE} 条才可比）。` +
        `这一段能依靠的只有上面的广场基准；等发布量攒够，下面的分类/风格排名才会开始出结论。`,
    });
  }

  // Nothing responding at all is its own finding, not an absence of one.
  if (measured.length >= MIN_CORPUS && ctx.totalViews > 0 && ctx.totalEngagement === 0) {
    insights.push({
      kind: 'cut',
      text: `${measured.length} 条帖子共 ${fmt(ctx.totalViews)} 浏览，但点赞+评论+转发合计 0。` +
        '浏览是平台给的，互动是读者给的——现在的内容拿到了曝光、没拿到回应，这比浏览量本身更值得先解决。',
    });
  }

  for (const d of dimensions) {
    const ranked = d.groups.filter(g => g.rankable && g.medianViews > 0);
    if (ranked.length < 2) continue;
    const top = ranked[0]!;
    const bottom = ranked[ranked.length - 1]!;
    const gap = top.medianViews / Math.max(1, bottom.medianViews);
    // A 1.5x gap across five posts is noise dressed as a trend. Demand real separation before
    // telling someone to restructure their account around it.
    if (gap < 2) continue;
    insights.push({
      kind: 'lead',
      text: `${d.label}：「${top.label}」中位浏览 ${fmt(top.medianViews)}（n=${top.measured}），` +
        `「${bottom.label}」${fmt(bottom.medianViews)}（n=${bottom.measured}），差 ${gap.toFixed(1)} 倍。` +
        `可以往「${top.label}」多挖，压缩「${bottom.label}」的排期。`,
    });
    if (top.engagementPer1k > 0 && bottom.engagementPer1k > 0 && top.engagementPer1k < bottom.engagementPer1k) {
      insights.push({
        kind: 'watch',
        text: `但同一组的互动率相反：「${top.label}」每千次浏览 ${top.engagementPer1k} 次回应，「${bottom.label}」${bottom.engagementPer1k} 次。` +
          '说明前者是靠选题吃到流量、不是靠内容留住了人，深挖时不能只看浏览量。',
      });
    }
  }

  return { insights, caveats };
}
