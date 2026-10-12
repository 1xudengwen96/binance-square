/** Everything a single-user install needs. No tiers, no quotas imposed on you by a vendor. */

export interface Settings {
  /** Our own ceiling, kept below Binance's hard 100/day. */
  dailyCap: number;
  /** Target posts per day; drives spacing inside the active window. */
  postsPerDay: number;
  /** Hard floor between two posts, in minutes. */
  minIntervalMinutes: number;
  activeStartHour: number;
  /** 24 means "through midnight". */
  activeEndHour: number;
  /** 'mixed' rotates all styles, or one style id. */
  style: string;
  /** Off by default: nothing reaches Square without you approving it. */
  autoPublish: boolean;
  enabledCategories: string[];
  sensitiveWords: string[];
  appendDisclaimer: boolean;
  /** `#COIN` in the body is parsed by Square and files the post on that hashtag page. */
  appendHashtags: boolean;
  /** Skip a material if the same fingerprint was posted within this many minutes. */
  fingerprintCooldownMinutes: number;
  /**
   * Minimum spacing between ANY two accounts' posts. Ten accounts each minding their own
   * cadence still produce a recognisable burst if they fire together; this is what stops
   * the matrix looking like one operator with ten mouths.
   */
  crossAccountGapMinutes: number;
  /** How long a coin stays reserved to the account that first took it. */
  crossAccountCoinExclusionMinutes: number;
  /**
   * How long the same account must wait before saying anything else about the same coin's same
   * kind of signal. Four funding posts about one coin in six hours each looked novel on its own
   * and read as one person shouting about one number.
   */
  coinSignalCooldownMinutes: number;
  /**
   * How many posts about one coin a single account may put out per day, across every category.
   *
   * `coinSignalCooldownMinutes` only compares like with like, so funding → onchain → leaderboard
   * about the same symbol slipped straight through it: the live log shows one account queueing
   * eight STRK posts in an evening under three different headings. Binance's creator guidance
   * names exactly this — 「一味蹭热门币会影响账号健康度」— so the cap has to be on the coin, not
   * on the coin-and-category. Three still lets a story develop over a day; it stops the pile-up.
   */
  symbolDailyCap: number;
  /**
   * Accounts on the fixed column lane post only that column (see src/column.ts). Off by default so
   * existing installs keep their behaviour; the ceiling below is a maximum, not a target.
   */
  columnMode: boolean;
  columnPostsPerDay: number;
  /** Hours before the column may name the same coin again. A tunable knob (see rank/params.ts). */
  columnCoinCooldownHours: number;
  /** Rows older than this are deleted outright; expiry is separate and much shorter. */
  dataRetentionDays: number;
  /** Chart PNGs are regenerable, so unreferenced ones go after this long. */
  chartRetentionHours: number;
  /** Run the collect→draft→stats loop inside the panel process, so no second command is needed. */
  autoRun: boolean;
  tickMinutes: number;

  /* --- attention pool --- */
  /** Composite score a coin must reach to enter the pool. Calibrated against the
   *  live distribution: the top Square coin scores in the mid-50s, the 8th in the low-40s. */
  attentionThreshold: number;
  /** Only the strongest few candidates are ever considered. */
  poolTopN: number;
  /** How long it must have stayed above the threshold before we post — the "data has matured" rule. */
  matureMinutes: number;
  /** Minimum number of samples inside the maturity window. */
  matureSamples: number;
  /** After posting about a coin, do not post about the same rise again for this long. */
  claimCooldownMinutes: number;
  /** Keep attention history for this long. */
  sampleRetentionHours: number;

  /** Attach a generated candlestick chart to attention follow-up posts. */
  attachChart: boolean;
  chartInterval: '1h' | '4h' | '1d';

  /**
   * Relative share of the queue per category. Seeded from a competitor account's
   * measured medians: 行情异动 128 / 市场情绪 170 / 快讯 98 views, but 全网热搜 3.
   * Hype that cannot be tied to a coin does not earn attention, so it does not
   * earn an equal share of the schedule.
   */
  categoryWeights: Record<string, number>;

  /**
   * What the experiment engine should be optimising for. `views` is measurable automatically and
   * is a proxy; `money` uses the rebate figures the operator types in once a day, apportioned
   * across posts by views. Switching to `money` does nothing until at least one day is entered.
   */
  targetMetric: 'views' | 'engagement' | 'money';
  /**
   * 'auto': the target follows the gates (views until gate A is cleared, then engagement).
   * 'manual': `targetMetric` is used as set. Existing installs stay on manual so nothing flips
   * under an operator who chose a target on purpose.
   */
  targetMode: 'auto' | 'manual';

  /* --- optional AI polish layer --- */
  llmEnabled: boolean;
  /** 'openai' also covers every OpenAI-compatible gateway. */
  llmProvider: 'openai' | 'anthropic';
  /** Include the version segment, e.g. https://api.openai.com/v1 */
  llmBaseUrl: string;
  llmModel: string;
  llmMaxTokens: number;
  llmTemperature: number;

  /* --- the algorithm brain (docs/算法大脑总方案.md) --- */
  /** Use the connection above to polish post wording. Independent of the brain, so each can be switched off alone. */
  llmPolish: boolean;
  /** Model for the brain's jobs; empty means the same model as polish. Judging usually wants a stronger one. */
  brainModel: string;
  /** Which jobs the brain is allowed to be woken for. The daily reflection is the existing one. */
  brainDaily: boolean;
  brainSentinel: boolean;
  brainWeekly: boolean;
  /** Per-job output budgets (tokens) and sampling temperature; judging jobs want a low one. */
  brainMaxTokensDaily: number;
  brainMaxTokensSentinel: number;
  brainMaxTokensWeekly: number;
  brainTemperature: number;
  /** Most times per day the sentinel may wake the brain, however many alarms fire. */
  brainWakeCapPerDay: number;
  /** Stop publishing when the last N posts' median views fall under the floor. */
  breakerEnabled: boolean;
  /**
   * Hypotheses allowed to draw random arms, i.e. to spend real posts on a comparison. Everything
   * else stays registered and is still read off what happened, but gets no traffic: at this
   * volume ten parallel experiments each had a handful of posts and could conclude nothing.
   * null means «all registered», which is the behaviour before this setting existed.
   *
   * Every name here must be a row in the `hypotheses` table with `mode='experiment'` and
   * `status='active'` — the registry is the only truth about what can be sampled. `planArms` skips
   * anything that is not an experiment, so a list that names one (as this default did, with
   * `h_hour_band`) is not inert-but-harmless: the panel reads this list to say «正在分配流量的实验»,
   * and an id in it that cannot draw is a lie on the panel and a hypothesis that quietly never
   * accumulates. The invariant is asserted in `test/rank.test.ts` so the two cannot drift apart.
   */
  activeExperiments: string[] | null;
  /**
   * Optional https URL that receives every new sentinel alarm as JSON
   * ({ text, code, detail, at }) — a Feishu/DingTalk/Slack-style robot. Empty means panel only.
   */
  alertWebhook: string;
}

export const ALL_CATEGORIES = [
  'attention',
  'announcement',
  'newsflash',
  'market_move',
  'funding',
  'long_short',
  'open_interest',
  'leaderboard',
  'sentiment',
  'stablecoin',
  'trending',
  'onchain',
  'dex',
  'liquidation',
] as const;

export const STYLE_LABELS: Record<string, string> = {
  mixed: '混合风格',
  tech: '技术分析派',
  news: '快讯速递派',
  data: '数据派',
  capital: '资金追踪派',
  emotion: '情绪派',
  chat: '唠嗑派',
  joke: '段子手',
  any: '不限',
};

export const DEFAULT_SETTINGS: Settings = {
  targetMetric: 'views',
  targetMode: 'manual',
  dailyCap: 12,
  // 定稿 §2 节奏：每号短帖承诺 4 条/日（区间 3–5，取 4 作期望告警分母）。
  // default 必须和线上 stored 同值——「改了代码没改线上」已经绊过两次（activeExperiments、
  // symbolDailyCap），测试口径新增 default/stored 一致性机检，这一条不许反向漂移。
  postsPerDay: 4,
  minIntervalMinutes: 45,
  activeStartHour: 8,
  activeEndHour: 24,
  style: 'mixed',
  autoPublish: false,
  enabledCategories: [...ALL_CATEGORIES],
  sensitiveWords: ['稳赚不赔', '保证收益', '必涨', '翻倍', '带单', '跟单', '代客理财', '稳赚', '无风险套利', '内幕消息'],
  appendDisclaimer: true,
  appendHashtags: true,
  fingerprintCooldownMinutes: 720,
  crossAccountGapMinutes: 14,
  crossAccountCoinExclusionMinutes: 360,
  coinSignalCooldownMinutes: 720,
  // 定稿 v1.2/v1.5 §7.9: 3→2. Same guardrail, tightened — the rolling 24h account×symbol
  // count in pipeline.ts IS the ≤2 cap; no parallel check. The stored override in the live
  // DB must be rewritten with this default at the ④ restart (two stale keys land together:
  // this and activeExperiments), or the runtime keeps posting by 3.
  symbolDailyCap: 2,
  columnMode: false,
  columnPostsPerDay: 4,
  columnCoinCooldownHours: 24,
  dataRetentionDays: 14,
  chartRetentionHours: 72,
  autoRun: true,
  tickMinutes: 15,
  attentionThreshold: 45,
  poolTopN: 6,
  attachChart: true,
  chartInterval: '1h',
  categoryWeights: {
    attention: 1.35,
    market_move: 1.25,
    long_short: 1.2,
    open_interest: 1.2,
    funding: 1.1,
    leaderboard: 1.0,
    announcement: 1.0,
    newsflash: 1.0,
    sentiment: 0.9,
    onchain: 0.9,
    dex: 0.75,
    stablecoin: 0.7,
    liquidation: 0.7,
    trending: 0.3,
  },
  matureMinutes: 40,
  matureSamples: 4,
  claimCooldownMinutes: 360,
  sampleRetentionHours: 48,
  llmEnabled: false,
  llmProvider: 'openai',
  llmBaseUrl: 'https://api.openai.com/v1',
  llmModel: '',
  llmMaxTokens: 1024,
  llmTemperature: 0.7,
  llmPolish: true,
  brainModel: '',
  brainDaily: true,
  brainSentinel: true,
  brainWeekly: true,
  brainMaxTokensDaily: 700,
  brainMaxTokensSentinel: 1200,
  brainMaxTokensWeekly: 2500,
  brainTemperature: 0.2,
  brainWakeCapPerDay: 2,
  breakerEnabled: true,
  // Three, in the lanes that can actually run them: the column shape and its AI-polish arm are
  // drawn by `column.ts`; `h_chart` is drawn everywhere except the column lane. `h_hour_band` used
  // to sit here and drew nothing — it is an `observed` hypothesis, so its arms come out of the clock,
  // not out of a random draw, and no post can ever be assigned to it.
  activeExperiments: ['h_column', 'h_column_polish', 'h_chart'],
  alertWebhook: '',
};
