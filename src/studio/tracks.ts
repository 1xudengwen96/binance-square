/**
 * A 赛道 is a promise about what will never appear on this account.
 *
 * The source material for this whole module is a Binance Square guide on starting an
 * account, and its one non-obvious rule is that mixing personas is fatal: "今天严肃喊单，
 * 明天整活，后天又变老师。读者不知道该信哪一个你。" A feed algorithm cannot summarise an
 * account that keeps changing what it is, and neither can a reader.
 *
 * So a track is defined mostly by what it refuses. The refusal list is machine-checkable
 * rather than prose for exactly that reason — a rule nobody enforces at publish time is a
 * comment, and the whole value of picking a lane is that the lane holds even when a
 * tempting post is one keystroke away.
 *
 * This directory is deliberately isolated from the main pipeline. That pipeline optimises
 * for variety across seven voices on one event; a 赛道 optimises for the opposite — one
 * voice, recognisable in three seconds. A flag switching between two contradictory
 * objectives would let each one quietly corrupt the other.
 */

export type TrackFormat = 'article' | 'post' | 'series';

export interface TrackCadence {
  /** Articles are worked on, not generated hourly. Two a day is already aggressive. */
  articlesPerDay: number;
  /** Hours of silence after a piece before the next is scheduled, so the feed breathes. */
  minGapHours: number;
}

export interface Track {
  id: string;
  label: string;
  /** Shown in the UI so the operator picks with the trade-offs visible, not the pitch. */
  summary: string;
  /** What the account must be recognisable as within three seconds, per the source guide. */
  identity: { nameHint: string; bioTemplate: string; tone: string };
  /**
   * Patterns that must never reach a published article. Checked at compose time and again
   * at publish time, because the LLM polish layer can introduce a conclusion the template
   * never contained.
   */
  refusals: { pattern: RegExp; why: string }[];
  /** Categories this track is allowed to draw material from. Anything else is off-persona. */
  allowedCategories: string[];
  formats: TrackFormat[];
  cadence: TrackCadence;
  /** Honest cost of this lane, surfaced in the UI before it is chosen. */
  tradeoffs: string[];
}

/**
 * 交易教学: explain the mechanism, use live numbers as the worked example, never tell
 * anyone what to do with them.
 *
 * Chosen first because it is the only one of the five tracks our data can carry without
 * new sources: every instrument we already measure — funding, open interest, account
 * ratios, MA structure, cross-venue divergence — is a teachable concept with a live
 * example attached. It is also the track the source guide says compounds hardest
 * ("过半年还有人搜到") and the one where Square's article type actually matters, since a
 * mechanism explanation does not fit in a feed post.
 */
const TRADING_LITERACY: Track = {
  id: 'trading_literacy',
  label: '交易教学',
  summary: '讲清楚一个指标怎么运作、为什么会骗人，用当天真实数据当例题。不开单、不给点位、不预测。',
  identity: {
    nameHint: '名字里带「读/解/拆解」这类词，不要带「带单/老师/神器」',
    bioTemplate: '把合约指标讲回它能证明的范围。只读数据，不给方向。',
    tone: '耐心、精确、愿意承认一个指标看不到什么；不用感叹号推销结论',
  },
  refusals: [
    { pattern: /建议(买入|卖出|做多|做空|开仓|加仓|减仓|平仓|上车|抄底)/, why: '教学号给出买卖建议，人设当场失效' },
    { pattern: /(目标价|看到|将会|必然会|即将)(上涨|下跌|突破|跌破|拉到|砸到)/, why: '预测方向不是读数据' },
    { pattern: /(点位|止损位|止盈位)打在?\s?\d/, why: '具体点位是喊单，不是教学' },
    { pattern: /(稳赚|必涨|必跌|无风险|保底|躺赚|跟单|带单)/, why: '广场敏感词，且与教学立场矛盾' },
    { pattern: /(所以|因此|结论是?)应该(多|空|买|卖)/, why: '从数据跳到操作指令' },
    { pattern: /\d+(\.\d+)?\s*(倍|x)\s*(收益|回报|利润)/, why: '收益承诺' },
  ],
  allowedCategories: ['funding', 'long_short', 'open_interest', 'market_move', 'onchain', 'leaderboard', 'attention', 'stablecoin', 'sentiment'],
  formats: ['article', 'series', 'post'],
  cadence: { articlesPerDay: 2, minGapHours: 5 },
  tradeoffs: [
    '起量慢：一篇讲清一个指标，不如一条喊单帖容易蹭到互动。',
    '不能靠观点换评论——而评论正是我们目前 0 的指标，短期数据会更难看。',
    '要求长期不换调性；连续 30 天做不到就不要开这条赛道。',
  ],
};

/**
 * Declared but not implemented, so the UI can show why they are waiting rather than
 * pretending the module does all five.
 */
const NOT_IMPLEMENTED: { id: string; label: string; reason: string }[] = [
  {
    id: 'knowledge_base',
    label: '新手知识科普',
    reason: '可做，但选题不来自行情数据（注册、钱包、骗局），需要先补一套与信号无关的静态题库。',
  },
  {
    id: 'campaigns',
    label: '撸毛 / 活动 / Alpha',
    reason: '我们已在采集 announcement 的 campaign/listing，但活动会过期；必须先有时效归档，否则会把人按旧规则引导去操作。',
  },
  {
    id: 'deep_research',
    label: '市场深度投研',
    reason: '缺基本面数据源（代币经济、团队、TVL、路线图），现在做只能复述行情，正是文章说的「一周七篇行情复述」。',
  },
  {
    id: 'trader_live',
    label: '职业交易员（实盘）',
    reason: '需要持仓与成交数据，也就是交易所 API Key。本项目明确拒绝接触能动钱的凭据，此赛道不可实现。',
  },
  {
    id: 'general_traffic',
    label: '泛流量 / 商单',
    reason: '靠持续互动和人际曝光，不是可自动化的内容生产。',
  },
];

export const TRACKS: Track[] = [TRADING_LITERACY];
export const TRACK_LABELS: Record<string, string> = Object.fromEntries(TRACKS.map(t => [t.id, t.label]));
export const UNIMPLEMENTED_TRACKS = NOT_IMPLEMENTED;

export function trackById(id: string | null | undefined): Track | undefined {
  return TRACKS.find(t => t.id === id);
}

/**
 * The refusal check runs twice: on the composed draft, and again on the polished text.
 * The second pass exists because the LLM layer is allowed to reword freely within a
 * register, and "reword" is exactly how a description quietly becomes advice.
 */
export function findRefusals(text: string, track: Track): string[] {
  const hits: string[] = [];
  for (const r of track.refusals) {
    const m = text.match(r.pattern);
    if (m) hits.push(`${r.why}（命中「${m[0]}」）`);
  }
  return hits;
}
