/**
 * What we think the Square distribution engine does, written so that each one can be wrong.
 *
 * We cannot read the algorithm. What we can do is decide in advance which observable would look
 * different if a claim were true, refuse to conclude before the sample supports it, and let a
 * later measurement retire an earlier rule. A registry exists to make that the only way the
 * system is allowed to form an opinion about reach.
 */

export type Metric = 'views24h' | 'growth1h' | 'engagementPer1k' | 'rebatePer1k';

export interface Hypothesis {
  id: string;
  claim: string;
  /** How the arm is decided: `experiment` means the robot assigns it, `observed` means it is read off what already happened. */
  mode: 'experiment' | 'observed';
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
    id: 'h_chart',
    claim: '带自绘 K 线图的帖子比纯文字拿到更多分发',
    mode: 'experiment',
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
    arms: ['surfaced', 'unsurfaced'],
    metric: 'growth1h',
    minSamples: 5,
    how: '按是否出现在广场公开榜分组，比较 20 分钟到 1 小时的增速。',
    risk: '无。这条反过来用：增速是上榜的前兆信号，可以据此决定要不要跟进。',
  },
];

export const byId = (id: string): Hypothesis | undefined => HYPOTHESES.find(h => h.id === id);

/** How far a belief has earned to be called a rule. */
export const CONFIDENCE_TO_ACT = 0.72;
