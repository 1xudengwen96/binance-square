/**
 * The curriculum. A teaching account is not a stream of posts, it is a course with an
 * order, and the order is the product.
 *
 * The source guide's advice for this lane is "一篇只解决一个问题" and "把直播里讲过的步骤
 * 写成可回看的教程" — which only works if the pieces compose. That requires knowing which
 * concept unlocks which, so the ladder is declared here rather than rediscovered by the
 * scheduler each run.
 *
 * Every concept lists the fields it is actually written from. That is the constraint that
 * keeps this honest: a concept with no live field behind it is a blog post about
 * nothing, and the fact ledger would reject its numbers anyway. Concepts we cannot yet
 * populate are recorded in `UNWRITABLE` with the missing source named, so the gap is
 * visible instead of quietly skipped.
 */

export interface Concept {
  id: string;
  title: string;
  /** One sentence on what the reader can do afterwards that they could not before. */
  outcome: string;
  trackId: string;
  /** 0 = no prerequisites. Higher tiers only become writable once their deps are written. */
  tier: number;
  requiresConcepts: string[];
  /** Fields the piece is built from. Missing any of these makes the concept unwritable now. */
  needsFields: string[];
  /** Which material category supplies it, when a live example is required. */
  sourceCategory: string;
  sourceSubTypes?: string[];
  formats: ('article' | 'post' | 'series')[];
  needsChart: boolean;
  /** Why this concept exists — kept next to the definition so future edits stay honest. */
  note?: string;
}

const T = 'trading_literacy';

export const CONCEPTS: Concept[] = [
  /* ---------------------------------------------------------------- tier 0 --- */
  {
    id: 'funding_who_pays',
    title: '资金费率：付钱的从来不是多数派那一侧',
    outcome: '看完能自己判断一个费率读数是在说"多头拥挤"还是"空头拥挤"。',
    trackId: T,
    tier: 0,
    requiresConcepts: [],
    needsFields: ['funding', 'payer', 'intervalHours'],
    sourceCategory: 'funding',
    formats: ['article', 'post'],
    needsChart: false,
    note: '核心澄清：多空张数恒等，所以"占优"只能指谁在付费。这是后面所有费率讨论的地基。',
  },
  {
    id: 'oi_vs_volume',
    title: '持仓量和成交量不是一回事',
    outcome: '能区分"有人在换手"和"有人建立了新仓位"，并知道哪个更能说明意图。',
    trackId: T,
    tier: 0,
    requiresConcepts: [],
    needsFields: ['oiUsd', 'oiChangePct', 'quoteVolume24h'],
    sourceCategory: 'open_interest',
    sourceSubTypes: ['oi_shift'],
    formats: ['article'],
    needsChart: true,
    note: '成交量是流量，持仓量是存量。绝大多数读者把两者混用，混用之后所有盘面解读都会跑偏。',
  },
  {
    id: 'ls_ratio_is_accounts',
    title: '多空比数的是账户个数，不是钱',
    outcome: '看到一个 2.5 的多空比时，知道它并不能说明多头资金更多。',
    trackId: T,
    tier: 0,
    requiresConcepts: [],
    needsFields: ['longRatio', 'longPct', 'shortPct'],
    sourceCategory: 'long_short',
    sourceSubTypes: ['account_ratio'],
    formats: ['article', 'post'],
    needsChart: false,
    note: '一个亿和一个 U 在分子上各算一个。这条是"人数与钱分离"最典型的误读来源。',
  },
  {
    id: 'ma_is_lagging',
    title: '均线交叉确认的是过去，不是接下来',
    outcome: '知道金叉死叉能证明什么、不能证明什么，以及为什么贴线交叉随时会被收回。',
    trackId: T,
    tier: 0,
    requiresConcepts: [],
    needsFields: ['maFast', 'maSlow', 'gapPct', 'cross', 'tf'],
    sourceCategory: 'market_move',
    sourceSubTypes: ['ma_golden', 'ma_death'],
    formats: ['article'],
    needsChart: true,
    note: '这个概念的可写窗口最窄——交叉只在当根 K 线成立时是新闻，所以要能识别它随时可能没素材。',
  },

  /* ---------------------------------------------------------------- tier 1 --- */
  {
    id: 'extreme_funding_not_annualized',
    title: '极端费率不要急着乘 365',
    outcome: '遇到年化上千的费率时，知道该改成"扛得住几天"来算成本。',
    trackId: T,
    tier: 1,
    requiresConcepts: ['funding_who_pays'],
    needsFields: ['funding', 'intervalHours'],
    sourceCategory: 'funding',
    formats: ['article'],
    needsChart: false,
    // Measured, not stylistic: our own annualisedFunding() returns null past ±300%, and the
    // first real article we published hit exactly that guard. The tool's own limit became
    // the lesson, which is the kind of claim only an automated pipeline can keep honest.
    note: '来自实测：CTSI 费率 -0.98%/8h 折年化约 -1075%，超出可读区间被台账拦下。',
  },
  {
    id: 'oi_price_four_shapes',
    title: '持仓和价格的四种组合，含义完全不同',
    outcome: '能把"涨 5%"这种描述升级成"新多头进场推的涨"或"空头撤退造成的涨"。',
    trackId: T,
    tier: 1,
    requiresConcepts: ['oi_vs_volume'],
    needsFields: ['shape', 'oiChangePct', 'chg24h'],
    sourceCategory: 'open_interest',
    sourceSubTypes: ['oi_shift'],
    formats: ['article', 'series'],
    needsChart: true,
    note: '这是我们相对对手最实在的差异点：他们有持仓量数字，但没有把 OI×价格 组合成语义。',
  },
  {
    id: 'squeeze_structure',
    title: '轧空不需要利好，只需要对面扛不住',
    outcome: '能说出轧空成立的三个结构条件，以及它为什么无法预测只能识别。',
    trackId: T,
    tier: 1,
    requiresConcepts: ['funding_who_pays', 'oi_vs_volume'],
    needsFields: ['funding', 'oiChangePct', 'chg24h', 'longRatio'],
    sourceCategory: 'funding',
    formats: ['article'],
    needsChart: true,
  },
  {
    id: 'divergence_reads',
    title: '小时级和日线方向相反时，该信哪个',
    outcome: '看到 1 小时转弱但日线仍红，知道这既不是顶部也不是噪声，而是一个需要观察的组合。',
    trackId: T,
    tier: 1,
    requiresConcepts: ['oi_vs_volume'],
    needsFields: ['chg1h', 'chg24h', 'price'],
    sourceCategory: 'market_move',
    formats: ['post', 'article'],
    needsChart: true,
  },

  /* ---------------------------------------------------------------- tier 2 --- */
  {
    id: 'thin_market_caveat',
    title: '同一个指标在小市值币上说的不是同一件事',
    outcome: '看到极端费率或极端持仓变化时，会先查这个品种今天的成交额再决定信多少。',
    trackId: T,
    tier: 2,
    requiresConcepts: ['extreme_funding_not_annualized', 'oi_vs_volume'],
    needsFields: ['quoteVolume24h', 'funding', 'oiChangePct'],
    sourceCategory: 'funding',
    formats: ['article'],
    needsChart: false,
    // The failure mode is real and recent: a +779% open-interest move came from a contract
    // with 17M of interest off a near-zero base. The arithmetic was right and the signal
    // was nothing. A teaching account that does not say this out loud will be caught out.
    note: '来自实测：某合约持仓量变化 +778.7%，基数只有 1700 万美元，被检测器判为无效。',
  },
  {
    id: 'venue_share',
    title: '另一个交易所的行情，能代表大盘吗',
    outcome: '看到"某所大涨"时，会先比一下那个所的成交额占主流所的比重。',
    trackId: T,
    tier: 2,
    requiresConcepts: ['oi_vs_volume'],
    needsFields: ['venue', 'venueSharePct', 'volume24h', 'quoteVolume24h'],
    sourceCategory: 'onchain',
    sourceSubTypes: ['hl_move', 'hl_funding'],
    formats: ['article'],
    needsChart: false,
  },
  {
    id: 'attention_vs_money',
    title: '讨论变多和钱变多，是两件事',
    outcome: '能把广场热度读成一个独立的、可证伪的维度，而不是行情的先行指标。',
    trackId: T,
    tier: 2,
    requiresConcepts: ['oi_vs_volume'],
    needsFields: ['squareDiscuss', 'squareViews', 'oiChangePct', 'quoteVolume24h'],
    sourceCategory: 'attention',
    sourceSubTypes: ['follow', 'topic'],
    formats: ['article', 'post'],
    needsChart: false,
  },
  {
    id: 'four_step_checklist',
    title: '把上面这些变成每天五分钟的检查表',
    outcome: '有一套固定顺序，能对任何品种在 5 分钟内做完一次结构性阅读。',
    trackId: T,
    tier: 3,
    requiresConcepts: ['funding_who_pays', 'oi_vs_volume', 'ls_ratio_is_accounts'],
    needsFields: ['funding', 'oiChangePct', 'longRatio', 'chg24h'],
    sourceCategory: 'attention',
    formats: ['article', 'series'],
    needsChart: true,
    note: '综述位。前置没写完之前不该发，否则它只是一篇通用清单，没有课程支撑。',
  },
];

/**
 * Concepts that belong in this lane but have no data source yet. Kept as data rather than
 * deleted, because "the curriculum has holes here" is information the operator needs.
 */
export const UNWRITABLE: { title: string; missing: string }[] = [
  { title: '基差与现货合约价差', missing: '没有同时采集现货价与永续价的字段，需要新增一个 basis 检测器' },
  { title: '爆仓地图与连环清算', missing: '清算数据只在 WebSocket 流上，本环境无法验证其可用性（见数据源审计）' },
  { title: '订单簿深度与滑点', missing: '只取过 24 小时聚合量，没有盘口快照' },
  { title: '资金费率历史形态', missing: 'fundingHistory 已可取，但还没有把"连续 N 期同向"做成素材' },
];

export function conceptById(id: string): Concept | undefined {
  return CONCEPTS.find(c => c.id === id);
}

/** Concepts unlocked once `written` is complete — the scheduler's forward view. */
export function unlockedBy(written: Set<string>): Concept[] {
  return CONCEPTS.filter(c => !written.has(c.id) && c.requiresConcepts.every(r => written.has(r)));
}

/** Concepts that must not be attempted yet, with the specific missing prerequisite. */
export function blockedConcepts(written: Set<string>): { concept: Concept; waitingOn: string[] }[] {
  return CONCEPTS.filter(c => !written.has(c.id) && !c.requiresConcepts.every(r => written.has(r)))
    .map(c => ({ concept: c, waitingOn: c.requiresConcepts.filter(r => !written.has(r)) }));
}

/** Which concepts cite a given concept, so "被引用次数" can be counted without a graph walk. */
export function citingConcepts(id: string): Concept[] {
  return CONCEPTS.filter(c => c.requiresConcepts.includes(id));
}
