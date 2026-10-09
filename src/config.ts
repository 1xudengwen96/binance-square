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
  targetMetric: 'views' | 'money';

  /* --- optional AI polish layer --- */
  llmEnabled: boolean;
  /** 'openai' also covers every OpenAI-compatible gateway. */
  llmProvider: 'openai' | 'anthropic';
  /** Include the version segment, e.g. https://api.openai.com/v1 */
  llmBaseUrl: string;
  llmModel: string;
  llmMaxTokens: number;
  llmTemperature: number;
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
  dailyCap: 12,
  postsPerDay: 8,
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
};
