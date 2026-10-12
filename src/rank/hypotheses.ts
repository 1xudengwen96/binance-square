/**
 * What we think the Square distribution engine does, written so that each one can be wrong.
 *
 * We cannot read the algorithm. What we can do is decide in advance which observable would look
 * different if a claim were true, refuse to conclude before the sample supports it, and let a
 * later measurement retire an earlier rule. A registry exists to make that the only way the
 * system is allowed to form an opinion about reach.
 */

export type Metric = 'views24h' | 'growth1h' | 'engagementPer1k' | 'qualityPer1k' | 'rebatePer1k';

/**
 * The complete set of things a post can be sorted by.
 *
 * This exists so the arm a post belongs to is derived from *data*, not from a `switch` on the
 * hypothesis id. Under the old shape, registering a new hypothesis with a new id was a three-file
 * edit, and forgetting the third file produced a hypothesis that silently never received an arm —
 * which reads exactly like a measurement that found nothing.
 *
 * `knob` dimensions are ones the writer can actually be told to change, so an experiment may be
 * run on them. `observed` dimensions can only be read off what already happened, so they may
 * inform a hunch and may never become a rule. A proposal that names a dimension outside this
 * table is not a hypothesis, it is a wish, and `propose()` rejects it for that reason.
 */
export type Dimension =
  | 'chart'
  | 'hashtag_total'
  | 'opening'
  | 'hook_form'
  | 'stance'
  | 'follow_cta'
  | 'column'
  | 'polish'
  | 'length_band'
  | 'hour_band'
  | 'repeat_interval'
  | 'surfacing_shape';

export interface DimensionSpec {
  kind: 'knob' | 'observed';
  label: string;
  arms: string[];
}

export const DIMENSIONS: Record<Dimension, DimensionSpec> = {
  chart: { kind: 'knob', label: '带不带自绘图', arms: ['chart', 'text'] },
  hashtag_total: { kind: 'knob', label: '全篇标签总数', arms: ['one', 'two', 'three'] },
  opening: { kind: 'knob', label: '收尾句式', arms: ['statement', 'question'] },
  hook_form: { kind: 'knob', label: '首句形态', arms: ['data', 'tension'] },
  stance: { kind: 'knob', label: '有无观点句', arms: ['none', 'read'] },
  follow_cta: { kind: 'knob', label: '结尾是否求关注', arms: ['none', 'follow'] },
  column: { kind: 'knob', label: '栏目形态', arms: ['ledger', 'question', 'anomaly', 'recap'] },
  polish: { kind: 'knob', label: '栏目是否经 AI 改写措辞', arms: ['raw', 'polished'] },
  length_band: { kind: 'observed', label: '正文字数带', arms: ['short', 'mid', 'long'] },
  hour_band: { kind: 'observed', label: '发帖时段带', arms: ['morning', 'midday', 'afternoon', 'evening', 'late'] },
  repeat_interval: { kind: 'observed', label: '同币同类重发间隔', arms: ['within6h', '6to24h', 'over24h'] },
  surfacing_shape: { kind: 'observed', label: '是否上过公开榜', arms: ['surfaced', 'unsurfaced'] },
};

export const DIMENSION_NAMES = Object.keys(DIMENSIONS) as Dimension[];

export interface Hypothesis {
  id: string;
  claim: string;
  /** How the arm is decided: `experiment` means the robot assigns it, `observed` means it is read off what already happened. */
  mode: 'experiment' | 'observed';
  /** Which dimension this hypothesis sorts posts by. The arms must be exactly that dimension's arms. */
  dimension: Dimension;
  arms: string[];
  metric: Metric;
  /** Per-arm sample floor. Below this the verdict is 'observing', never a rule. */
  minSamples: number;
  how: string;
  /** What running it costs, stated plainly, because an experiment that costs nothing teaches nothing. */
  risk: string;
}

export const HYPOTHESES: Hypothesis[] = [
  {
    id: 'h_column',
    claim: '不同的固定栏目（费率账 / 盘中一问 / 今日反常 / 昨日对账）换来的回应不一样',
    mode: 'experiment',
    dimension: 'column',
    arms: ['ledger', 'question', 'anomaly', 'recap'],
    metric: 'views24h',
    minSamples: 10,
    how: '栏目形态在当次可用的形态里随机抽取，抽签先于发帖并落库；比较各形态的 24 小时浏览，达标后改比互动质量。',
    risk: '被抽到的形态可能比其余的差；这是回答「读者要什么」的唯一办法。',
  },
  {
    id: 'h_column_polish',
    claim: '栏目帖经 AI 改写措辞后，读起来不那么机械，换来更多浏览',
    mode: 'experiment',
    dimension: 'polish',
    arms: ['raw', 'polished'],
    metric: 'views24h',
    minSamples: 8,
    how: '栏目帖随机一半交给 AI 改写措辞（数字、标签、栏目标题不得改动，改不过校验就用原文），比较 24 小时浏览。',
    risk: '改写版可能更像通稿；改写失败的帖子按实际跑的臂记为 raw，不污染比较。',
  },
  {
    id: 'h_chart',
    claim: '带自绘 K 线图的帖子比纯文字拿到更多分发',
    mode: 'experiment',
    dimension: 'chart',
    arms: ['chart', 'text'],
    metric: 'views24h',
    minSamples: 8,
    how: '同一格子内随机让一部分帖子不带图，比较 24 小时浏览量与上榜率。',
    risk: '无图的那部分短期浏览量可能更低 —— 这是唯一能证明「图有没有用」的代价。',
  },
  {
    id: 'h_hashtag_count',
    claim: '主题标签的数量影响能不能被塞进话题页',
    mode: 'experiment',
    dimension: 'hashtag_total',
    arms: ['one', 'two', 'three'],
    metric: 'views24h',
    minSamples: 8,
    how: '币标签固定，主题标签数量在 1/2/3 之间轮换，比较 24 小时浏览量。',
    risk: '几乎为零：标签不影响事实校验，也不改变正文。',
  },
  {
    id: 'h_length_band',
    claim: '信息密度更高的长帖比一句话短帖更受分发',
    mode: 'observed',
    dimension: 'length_band',
    arms: ['short', 'mid', 'long'],
    metric: 'views24h',
    minSamples: 6,
    how: '按正文字数分带（<120 / 120–220 / >220），比较中位浏览与到榜时延。',
    risk: '观察而非实验：字数带与内容格子混在一起，只能看方向，不能当因果。',
  },
  {
    id: 'h_hour_band',
    claim: '发帖时刻决定第一小时的推送量',
    mode: 'observed',
    dimension: 'hour_band',
    arms: ['morning', 'midday', 'afternoon', 'evening', 'late'],
    metric: 'views24h',
    minSamples: 5,
    how: '按北京时间时段带分组比较 24 小时浏览量与首小时增速。',
    risk: '观察：时段与当时有什么素材相关，热门币本来就集中在某些小时。',
  },
  {
    id: 'h_opening',
    claim: '以问句收尾的帖子更容易换来评论',
    mode: 'experiment',
    dimension: 'opening',
    arms: ['statement', 'question'],
    metric: 'engagementPer1k',
    minSamples: 10,
    how: '收尾句式在陈述与提问之间轮换，比较每千次浏览的回应数。',
    risk: '提问换不来评论时，等于白丢了几条帖子的位置。',
  },
  {
    id: 'h_repeat_interval',
    claim: '同一个币的同类信号短期内再发，第二条会被自我压制',
    mode: 'observed',
    dimension: 'repeat_interval',
    arms: ['within6h', '6to24h', 'over24h'],
    metric: 'views24h',
    minSamples: 5,
    how: '按与上一条同币同类帖子的间隔分带，比较本条的浏览量。',
    risk: '观察。冷却时长就是从这里定的，不是拍脑袋定的 —— 但为了让短间隔这一臂拿得到样本，有 5% 的帖子会故意绕过冷却，这部分可能确实更差。',
  },
  {
    id: 'h_surfacing_shape',
    claim: '上过公开榜的帖子，其首小时增速明显高于没上过的',
    mode: 'observed',
    dimension: 'surfacing_shape',
    arms: ['surfaced', 'unsurfaced'],
    metric: 'growth1h',
    minSamples: 5,
    how: '按是否出现在广场公开榜分组，比较 20 分钟到 1 小时的增速。',
    risk: '无。这条反过来用：增速是上榜的前兆信号，可以据此决定要不要跟进。',
  },
  // The three below come from Binance Square's own creator guidance, which states the formula as
  // 方向 + 观点 + 晒单 with a "three-second rule" on the opening. That is a strong prior from the
  // platform itself, and it is still only a prior: registering it here is what stops it from
  // becoming folklore the way "深夜发帖翻倍" did on the first live run. 晒单 is deliberately absent
  // — the account does not trade, and the same guidance lists fabricated or mismatched trade
  // evidence among the things that quietly destroy account weight.
  {
    id: 'h_hook_form',
    claim: '首句先给结论、把数字放到第二句，比直接以数据开头更能留住前三秒',
    mode: 'experiment',
    dimension: 'hook_form',
    arms: ['data', 'tension'],
    metric: 'views24h',
    minSamples: 10,
    how: '随机让一半帖子以一句方向重述开头（不含新数字），另一半保持现在的 $币 加数据开头，比较 24 小时浏览量。',
    risk: '首句变短变软，可能让挂币识别变弱；另一半是对现状的对照，不会比现在更差。',
  },
  {
    id: 'h_stance',
    claim: '带一句对形态的解读（不是建议）的帖子，比纯陈述数据更受推荐',
    mode: 'experiment',
    dimension: 'stance',
    arms: ['none', 'read'],
    metric: 'views24h',
    minSamples: 10,
    how: '随机在一半帖子里加一句由同一批事实推出的解读，比较 24 小时浏览量与互动。',
    risk: '解读可能与后续走势相悖，留下判断记录；观点句不含数字，也不会碰事实台账。',
  },
  {
    id: 'h_follow_cta',
    claim: '结尾自然地求一次关注，能提高每千次浏览带来的关注',
    mode: 'experiment',
    dimension: 'follow_cta',
    arms: ['none', 'follow'],
    metric: 'engagementPer1k',
    minSamples: 10,
    how: '随机让一半帖子结尾加一句求关注（平台明确允许"求关注"，禁止"刷关注"），比较互动与后续新增粉丝。',
    risk: '求关注可能压低点赞评论，也可能被读者反感；对照臂保持现状，效果由数据判。',
  },
];

export const byId = (id: string): Hypothesis | undefined => HYPOTHESES.find(h => h.id === id);

/** How far a belief has earned to be called a rule. */
export const CONFIDENCE_TO_ACT = 0.72;
