import type { TemplateDef } from '../engine/types.ts';

/**
 * Templates are the fact-preserving half of the system: they own structure,
 * numbers and compliance; the LLM layer (if enabled) may only reword.
 *
 * Contract rule: every field in `requires` must exist on the material context,
 * otherwise the template is skipped rather than rendering a hole.
 */
export const templates: TemplateDef[] = [
  {
    id: 'funding.ledger',
    name: '资金费率·持仓成本账',
    category: 'funding',
    subType: 'funding_extreme',
    angle: '算账',
    style: 'capital',
    weight: 1.2,
    requires: [
      { path: 'cashtag' },
      { path: 'funding' },
      // Optional: the annualised figure is dropped when it would be meaningless,
      // and the most extreme rates are exactly the ones where that happens.
      { path: 'annualized', required: false },
      { path: 'payer' },
    ],
    body: `{{@hook.data}}{{cashtag}} 资金费率，算笔账：
当期 {{funding|rate}}，每 {{intervalHours|fixed:0}} 小时结算一次{{#if annualized}}，折合年化约 {{annualized|fixed:1}}%{{/if}}，付费的一方是{{payer}}。
{{#if payer == '多头'}}{{@take.funding.long}}。拿得越久成本越厚，价格一旦滞涨，多单松动会比想象中快。
{{#else}}{{@take.funding.short}}。空单扛久了同样难受，价格一反弹，回补会把行情推得更快。
{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'funding.asymmetry',
    name: '资金费率·盈亏比不对称',
    category: 'funding',
    subType: 'funding_extreme',
    angle: '结构',
    style: 'capital',
    requires: [{ path: 'cashtag' }, { path: 'funding' }, { path: 'annualized' }],
    body: `{{cashtag}} 当期费率 {{funding|rate}}{{#if annualized}}，年化 {{annualized|fixed:1}}%{{/if}}。
{{#if annualized}}{{#if annualized > 40}}费率已经偏极端，{{@take.funding.long}}。价格未必立刻反应，但多空两侧的盈亏比已经不对称了。{{@word.watch}}。
{{#elif annualized < -40}}负费率走到这个位置，{{@take.funding.short}}。
{{#else}}还在中性区间，杠杆情绪没有一边倒，不值得单独拿出来做决策。{{/if}}{{#else}}单期费率已经大到折算年化超出可读区间——这种极端值多半来自新上线或流动性薄的合约，费率本身比年化数字更有意义。{{/if}}
{{@closing}}`,
  },
  {
    id: 'move.spike.emotion',
    name: '短线拉升·情绪派',
    category: 'market_move',
    subType: 'spike',
    style: 'emotion',
    weight: 1.1,
    requires: [{ path: 'cashtag' }, { path: 'chg' }, { path: 'longRatio' }],
    body: `{{cashtag}} {{tf}}拉了 {{chg|pcta}}，同一时间多空比 {{longRatio|fixed:2}}。
{{#if longRatio > 2.5}}人已经挤在这一边了，这种拉升最怕的不是空炮，是没人接。
{{#elif longRatio > 1.3}}多头占优但不算极端，{{@take.move.up}}。
{{#elif longRatio < 0.9}}涨的是价，占优的还是空头——这波是有人在被推着走。
{{#else}}两边对半，说明这波量不是情绪推出来的。{{/if}}
{{#if payer}}而且现在是{{payer}}在付费。{{/if}}
{{@cta.question}}`,
  },
  {
    id: 'move.spike.capital',
    name: '短线拉升·看量能',
    category: 'market_move',
    subType: 'spike',
    angle: '资金',
    style: 'capital',
    requires: [
      { path: 'cashtag' },
      { path: 'chg' },
      { path: 'price' },
      { path: 'volMultiple' },
    ],
    body: `{盯资金的|做差价的}{注意|看过来}👀
{{cashtag}} {{tf}}{急拉|拉升} {{chg|pcta}}，现价 {{price|price}}，成交额放到 {{volMultiple|fixed:1}} 倍。
{{#if volMultiple >= 3}}量是真放出来了，{{@take.move.vol}}。
{{#else}}量能没跟上，这种拉升一日游的概率不低。{{/if}}{{@phrase.risk}}`,
  },
  {
    id: 'move.dump',
    name: '短线跳水·不接飞刀',
    category: 'market_move',
    subType: 'dump',
    style: 'any',
    requires: [{ path: 'cashtag' }, { path: 'chg' }, { path: 'price' }],
    body: `{{cashtag}} {{tf}}跳水 {{chg|pcta}}，现价 {{price|price}}。
{{#if chg24h < -5}}24h 累计 {{chg24h|spct}}，{{@take.move.down}}。
{{#else}}日内还有 {{chg24h|spct}}，先别把一次下影当成趋势。{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'move.extreme',
    name: '新高新低·承接与抛压',
    category: 'market_move',
    style: 'tech',
    requires: [{ path: 'cashtag' }, { path: 'price' }, { path: 'extreme' }],
    body: `{{#if subType == 'new_high'}}🏔 {{cashtag}} 创出 24 小时新高 {{extreme|price}}，现报 {{price|price}}（24h {{chg24h|spct}}）。
新高从来不缺跟风盘，缺的是回踩时的承接。{{@word.look}}。
{{#else}}🕳 {{cashtag}} 跌破 24 小时低点 {{extreme|price}}，现报 {{price|price}}（24h {{chg24h|spct}}）。
破新低意味着这一档没人愿意接，{{@take.move.down}}{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'board.leaderboard',
    name: '涨跌幅榜·逐条列出',
    category: 'leaderboard',
    subType: 'gainers',
    style: 'any',
    requires: [{ path: 'scope' }, { path: 'board' }],
    body: `{{scope}}涨幅前列：
{{#each board as row max=5 sep="
"}}{{row.rank}}. {{row.symbol|cash}} {{row.chg|spct}}{{/each}}
{{@take.leaderboard}}。{{@cta.question}}`,
  },
  {
    id: 'ls.ratio',
    name: '多空比·一致预期最贵',
    category: 'long_short',
    subType: 'account_ratio',
    style: 'data',
    requires: [{ path: 'ratio' }, { path: 'longPct' }, { path: 'shortPct' }],
    body: `{{@hook.data}}{{#if cashtag}}{{cashtag}} {{/if}}{{scope}}多空比 {{ratio|fixed:2}}：多头 {{longPct|fixed:1}}%，空头 {{shortPct|fixed:1}}%。
{{#if ratio > 1.3}}多头明显占优。{{@take.sentiment}}。
{{#elif ratio < 0.77}}空头堆得有点密，{{@take.funding.short}}。
{{#else}}多空接近均衡，这个读数本身没什么信息量。{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'sentiment.fearGreed',
    name: '恐惧贪婪指数·情绪读数',
    category: 'sentiment',
    subType: 'fear_greed',
    style: 'any',
    requires: [{ path: 'value' }, { path: 'label' }],
    body: `{{#if value >= 70}}🤑 {{#elif value <= 30}}😨 {{#else}}😐 {{/if}}恐惧贪婪指数 {{value}}（{{label}}），昨日 {{prev}}。
{{@take.sentiment}}。{{#if cashtag}}{{cashtag}} {{@word.watch}}。{{/if}}{{#maybe 70}}{{@cta.question}}{{/maybe}}`,
  },
  {
    id: 'etf.flow',
    name: 'ETF 资金流·连续同向才重要',
    category: 'etf_flow',
    subType: 'daily_flow',
    style: 'data',
    weight: 1.15,
    requires: [{ path: 'assetName' }, { path: 'flowUsd' }, { path: 'flowDir' }],
    body: `{{#if flowUsd >= 0}}{{@emoji.bull}}{{#else}}{{@emoji.bear}}{{/if}} {{assetName}}现货 ETF {{flowDate}}{{flowDir}} {{flowUsd|abs|usd}}{{#if streak >= 2}}，已连续 {{streak}} 天{{streakDir}}{{/if}}。
{{@take.etf}}。{{#maybe 75}}{{@cta.question}}{{/maybe}}`,
  },
  {
    id: 'liq.cascade',
    name: '爆仓·连环清算',
    category: 'liquidation',
    subType: 'cascade',
    style: 'capital',
    requires: [{ path: 'amountUsd' }, { path: 'side' }, { path: 'window' }],
    body: `{{@hook.alert}}{{#if cashtag}}{{cashtag}} {{/if}}{{window}}内连环爆仓，{{side}}单被扫 {{amountUsd|usd}}。
{{@take.liq}}。{{#maybe 70}}{{@cta.question}}{{/maybe}}`,
  },
  {
    id: 'move.volume',
    name: '异常放量·量在但方向未定',
    category: 'market_move',
    subType: 'volume_surge',
    angle: '量能',
    style: 'capital',
    requires: [{ path: 'cashtag' }, { path: 'volMultiple' }, { path: 'price' }],
    body: `{{cashtag}} 1 小时成交额放到 {{volMultiple|fixed:1}} 倍，现价 {{price|price}}（24h {{chg24h|spct}}）。
{{#if volMultiple >= 5}}这个量级不是散户能堆出来的，{{@take.move.vol}}。
{{#else}}量是有了，方向还得再看一根确认。{{@word.look}}。{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'attention.follow',
    name: '热度跟进·讨论与数据对照',
    category: 'attention',
    subType: 'follow',
    angle: '跟进',
    style: 'data',
    requires: [
      { path: 'cashtag' },
      { path: 'price' },
      { path: 'chg24h' },
      { path: 'chg1h' },
      { path: 'volMultiple' },
      { path: 'squareViews' },
    ],
    body: `{{#if squarePosts > 3}}{{cashtag}} 这几天在广场上被反复提起：相关帖子 {{squarePosts}} 条，累计浏览 {{squareViews|count}}。
{{#else}}{{cashtag}} 现在排在广场热榜第 {{squareRank}} 位：{{squarePosts}} 条相关帖子，累计浏览 {{squareViews|count}}。
{{/if}}把数据摆在一起看：现价 {{price|price}}，24 小时 {{chg24h|spct}}，1 小时 {{chg1h|spct}}；最近 1 小时成交额是前六小时均值的 {{volMultiple|fixed:1}} 倍{{#if oiChangePct}}，持仓同期{{#if oiChangePct > 0}}增加{{#else}}减少{{/if}}约 {{oiChangePct|abs|fixed:1}}%{{/if}}。
{{#if funding}}资金费率 {{funding|rate}}{{#if annualized}}，折合年化约 {{annualized|fixed:1}}%{{/if}}，{{#if funding > 0}}付费方是多头{{#else}}付费方是空头{{/if}}。{{/if}}{{#if sustainedHours}}这个状态已经持续约 {{sustainedHours}} 小时。{{/if}}
{{#if chg24h > 0}}{{#if volMultiple >= 1.2}}{{@take.move.up}}{{#else}}{{@take.move.thin}}{{/if}}{{#else}}{{@take.move.down}}{{/if}}。
{{@phrase.notAdvice}}`,
  },
  {
    id: 'attention.digest',
    name: '热度跟进·数据清单',
    category: 'attention',
    subType: 'follow',
    angle: '清单',
    style: 'tech',
    requires: [{ path: 'cashtag' }, { path: 'price' }, { path: 'chg24h' }, { path: 'chg1h' }, { path: 'volMultiple' }],
    body: `{{cashtag}} 现在的盘面，一条条列：
· 价格 {{price|price}}（24h {{chg24h|spct}} / 1h {{chg1h|spct}}）
· 量能 {{volMultiple|fixed:1}} 倍于近 6 小时均值{{#if quoteVolume24h}}，24h 成交 {{quoteVolume24h|usd}}{{/if}}
{{#if oiChangePct}}· 持仓变化 {{oiChangePct|spct}}
{{/if}}{{#if longRatio}}· 全局多空比 {{longRatio|fixed:2}}
{{/if}}{{#if funding}}· 当期费率 {{funding|rate}}
{{/if}}{{#if sustainedHours}}这个状态已经持续约 {{sustainedHours}} 小时，不是一根针。{{/if}}
{{#if agreeing}}几个方向互相印证，{{#else}}信号比较单一，{{/if}}{{@word.look}}。
{{@phrase.notAdvice}}`,
  },
  {
    id: 'attention.topic',
    name: '热度跟进·借话题入场',
    category: 'attention',
    subType: 'topic',
    angle: '话题',
    style: 'data',
    requires: [{ path: 'hashtag' }, { path: 'cashtag' }, { path: 'chg24h' }],
    body: `{{hashtag}} 现在在广场热榜第 {{squareRank}} 位，讨论 {{squareDiscuss}} 次。
顺着看到 {{cashtag}}：现价 {{price|price}}，24 小时 {{chg24h|spct}}{{#if volMultiple}}，1 小时量能 {{volMultiple|fixed:1}} 倍{{/if}}。{{#if chg24h > 0}}{{#if volMultiple >= 1.2}}讨论度和价格方向一致，{{@take.move.up}}{{#else}}价格确实在涨，但{{@take.move.thin}}{{/if}}{{#else}}讨论度上来了、价格没跟上，更像是情绪在被消耗。{{/if}}
{{@cta.question}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'ls.crowd',
    name: '多空比·人多的地方容易踩',
    category: 'long_short',
    subType: 'account_ratio',
    angle: '拥挤度',
    style: 'chat',
    requires: [{ path: 'cashtag' }, { path: 'ratio' }],
    body: `{{@hook.story}}{{cashtag}} 的{{scope}}多空比 {{ratio|fixed:2}}，{{#if ratio > 1}}多头占 {{longPct|fixed:1}}%{{#else}}空头占 {{shortPct|fixed:1}}%{{/if}}。
{{#if ratio > 2}}{{#if ratio > 3}}这已经挤到极点了，我反而不敢碰。{{#else}}这已经挤到一起了。{{/if}}方向我说不准，但{人多的位置我不太敢加仓|一致看多的时候，踩踏往往就一下|我先站在人少的那边想想}。
{{#elif ratio > 1.2}}偏多，还没到极端，可以接着看。
{{#else}}偏空，就看谁先扛不住。{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'ls.shift',
    name: '多空比·边际变化',
    category: 'long_short',
    subType: 'account_ratio',
    angle: '变化量',
    style: 'data',
    requires: [{ path: 'cashtag' }, { path: 'ratio' }, { path: 'ratioDiff' }],
    body: `{{@hook.data}}{{cashtag}} {{scope}}多空比 {{ratio|fixed:2}}，上期 {{prevRatio|fixed:2}}，{{#if ratioDiff >= 0}}+{{/if}}{{ratioDiff|fixed:2}}。
{{#if ratioDiff >= 0.15}}多头在加仓，{{#elif ratioDiff <= -0.15}}多头在撤退，{{#else}}几乎没动，{{/if}}{{@take.sentiment}}。
{{@cta.question}}`,
  },
  {
    id: 'board.losers',
    name: '跌幅榜·资金撤离方向',
    category: 'leaderboard',
    subType: 'losers',
    angle: '离场',
    style: 'any',
    requires: [{ path: 'scope' }, { path: 'board' }],
    body: `{{scope}}跌幅前列：
{{#each board as row max=5 sep="
"}}{{row.rank}}. {{row.symbol|cash}} {{row.chg|spct}}{{/each}}
跌榜更有用的地方不是"谁跌得惨"，而是钱在往哪些方向撤。{{@take.leaderboard}}。{{@cta.question}}`,
  },
  {
    id: 'stable.delta',
    name: '稳定币供应·流动性读数',
    category: 'stablecoin',
    subType: 'daily_delta',
    angle: '流动性',
    style: 'data',
    requires: [{ path: 'assetName' }, { path: 'delta' }, { path: 'direction' }],
    body: `{{@hook.data}}{{assetName}} 流通量 24 小时{{direction}}约 {{delta|abs|money}} 枚。
{{#if delta > 0}}场外可动用的钱在变多，{{@take.move.up}}{{#else}}稳定币在收缩，一般对应风险偏好往下走。{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'trend.link',
    name: '全网热搜·只在真能对上时提',
    category: 'trending',
    subType: 'hot_board',
    style: 'chat',
    requires: [{ path: 'topic' }, { path: 'boardName' }],
    body: `{{@hook.story}}{{boardName}}上看到「{{topic}}」。
{{#if cashtag}}这条能直接牵到 {{cashtag}} 上，{{@word.watch}}。{{#else}}热度是真热度，但跟币的关系我不硬凑。{{/if}}{{@take.hot}}。
{{@phrase.notAdvice}}`,
  },
  {
    id: 'dex.hot',
    name: 'DEX 热门榜·链上资金',
    category: 'dex',
    subType: 'trending_pool',
    angle: '链上',
    style: 'capital',
    requires: [{ path: 'cashtag' }, { path: 'chain' }, { path: 'volume24h' }],
    body: `{{@hook.alert}}{{cashtag}} 进了 {{chain}} 链 DEX 热门榜。
池子 24 小时成交 {{volume24h|usd}}{{#if chg24h}}，价格 {{chg24h|spct}}{{/if}}{{#if reserveUsd}}，池内储备约 {{reserveUsd|usd}}{{/if}}。
{{@take.dex}}。{{#if reserveUsd}}{{#if reserveUsd < 300000}}池子偏薄，滑点会吃掉大部分收益，{{@phrase.risk}}{{/if}}{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'ann.batch',
    name: '公告·原文转述',
    category: 'announcement',
    angle: '转述',
    style: 'news',
    requires: [{ path: 'title' }, { path: 'catalogLabel' }],
    body: `币安「{{catalogLabel}}」刚发了一条公告：
{{title}}
{{#if cashtag}}{{cashtag}} {{@word.watch}}。{{#else}}这条没点名具体币种，涉及范围要看公告列的交易对清单，{{@word.look}}。{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'ann.delist',
    name: '公告·下架的定价节奏',
    category: 'announcement',
    subType: 'delisting',
    angle: '下架',
    style: 'news',
    requires: [{ path: 'cashtag' }, { path: 'title' }],
    body: `{{cashtag}}：{{title}}
下架类消息的节奏通常很像：先跌一波看承接，临近截止再走一次。真正决定结果的是流动性有没有转走，不是标题本身。
{{@word.look}}，{{@phrase.risk}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'ann.list',
    name: '公告·上线情绪盘',
    category: 'announcement',
    subType: 'listing',
    angle: '上线',
    style: 'news',
    requires: [{ path: 'cashtag' }, { path: 'title' }],
    body: `{{@hook.news}}{{cashtag}} 要上线了：{{title}}
首日波动一般很大，冲进去的和等着的都是各自的判断。我先记一笔。
{{@cta.question}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'flash.brief',
    name: '快讯·一句话播报',
    category: 'newsflash',
    subType: 'general',
    style: 'news',
    requires: [{ path: 'title' }],
    body: `{{@hook.news}}{{title}}{{#if ageMinutes}}（{{ageMinutes}} 分钟前）{{/if}}
{{#if cashtag}}{{cashtag}} {{@word.watch}}。{{/if}}{{@take.news}}。
{{@phrase.notAdvice}}`,
  },
  {
    id: 'flash.reg',
    name: '快讯·监管角度',
    category: 'newsflash',
    subType: 'regulation',
    angle: '监管',
    style: 'news',
    requires: [{ path: 'title' }],
    body: `{{@hook.alert}}{{title}}
{{@take.reg}}。{{#if cashtag}}{{cashtag}} 这边{{@word.look}}。{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'flash.inst',
    name: '快讯·机构动作',
    category: 'newsflash',
    subType: 'institution',
    angle: '机构',
    style: 'news',
    requires: [{ path: 'title' }],
    body: `{{@hook.data}}{{title}}
{{@take.inst}}。{{#if cashtag}}{{cashtag}} 值得跟一下后续。{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'flash.sec',
    name: '快讯·安全事件',
    category: 'newsflash',
    subType: 'security',
    angle: '安全',
    style: 'any',
    requires: [{ path: 'title' }],
    body: `{{@hook.alert}}{{title}}
{{@take.sec}}。{{#if cashtag}}{{cashtag}} 这类事件之后一般先跌再分化，{{@word.look}}。{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'flash.proj',
    name: '快讯·项目与技术变化',
    category: 'newsflash',
    subType: 'project',
    angle: '项目',
    style: 'chat',
    requires: [{ path: 'title' }],
    body: `{{@hook.story}}{{title}}
{{#if cashtag}}{{cashtag}} 这边{{@word.look}}。{{/if}}技术面的变化一般要等一两周才看得出发没发生变化。
{{@phrase.notAdvice}}`,
  },
  {
    id: 'flash.exch',
    name: '快讯·上所与流动性',
    category: 'newsflash',
    subType: 'exchange',
    angle: '上所',
    style: 'news',
    requires: [{ path: 'title' }],
    body: `{{@hook.news}}{{title}}
{{#if cashtag}}{{cashtag}} 上所类消息看两点：新增的流动性在哪，以及首批成交是不是真量。{{/if}}{{@take.news}}。
{{@phrase.notAdvice}}`,
  },
  {
    id: 'hl.funding',
    name: 'Hyperliquid·费率分歧',
    category: 'onchain',
    subType: 'hl_funding',
    angle: '跨所',
    style: 'capital',
    requires: [
      { path: 'cashtag' },
      { path: 'fundingPct' },
      { path: 'price' },
      { path: 'volume24h' },
    ],
    body: `{{cashtag}} 在 Hyperliquid 的当期费率 {{fundingPct|fixed:3}}%{{#if annualized}}，按小时结算折年化约 {{annualized|fixed:1}}%{{/if}}，{{#if payer}}付费方是{{payer}}{{/if}}。
现价 {{price|price}}，24 小时 {{chg24h|spct}}，该所 24 小时成交 {{volume24h|usd}}。
{{#if chg24h > 0}}涨的时候费率还这样，说明杠杆在追。{{#else}}跌了费率还在付费侧，说明有人不肯离场。{{/if}}{{@phrase.risk}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'hl.move',
    name: 'Hyperliquid·跨所价差信号',
    category: 'onchain',
    subType: 'hl_move',
    angle: '波动',
    style: 'data',
    requires: [{ path: 'cashtag' }, { path: 'chg24h' }, { path: 'price' }],
    body: `{{@hook.data}}{{cashtag}} 在 Hyperliquid 上 24 小时{{#if chg24h > 0}}涨{{#else}}跌{{/if}} {{chg24h|abs|fixed:2}}%，现报 {{price|price}}。
{{#if volume24h}}该所 24 小时成交 {{volume24h|usd}}。{{/if}}{{#if oiUsd}}未平仓约合 {{oiUsd|usd}}。{{/if}}
{{#if chg24h > 0}}{{@take.move.up}}{{#else}}{{@take.move.down}}{{/if}}。
{{@phrase.notAdvice}}`,
  },
  {
    id: 'joke.spike',
    name: '段子手·拉升看戏',
    category: 'market_move',
    subType: 'spike',
    angle: '玩梗',
    style: 'joke',
    requires: [{ path: 'cashtag' }, { path: 'chg' }],
    body: `{{cashtag}} {{tf}}拉了 {{chg|pcta}}。
问我现在什么心情：我仓位不大，心态极好。
反正我是不敢追了。{{@joke.cta}}`,
  },
  {
    id: 'joke.funding',
    name: '段子手·停车费',
    category: 'funding',
    subType: 'funding_extreme',
    angle: '玩梗',
    style: 'joke',
    requires: [{ path: 'cashtag' }, { path: 'funding' }, { path: 'payer' }],
    body: `{{cashtag}} 费率 {{funding|rate}}，{{#if annualized}}年化 {{annualized|fixed:1}}%，{{/if}}{{#if payer == '多头'}}多头在付费{{#else}}空头在付费{{/if}}。
翻译一下：{{#if payer == '多头'}}想拿多单，得先交停车费。{{#else}}做空也不是白做的，一样有人收你钱。{{/if}}
{{@joke.cta}}`,
  },

  /* ------------------------------------------------------------------------ *
   * Added against the variety report (scripts/variety.ts): these cells were
   * producing 3-12 distinct posts each, which is where a feed starts to look
   * automated. Depth per cell beats a bigger template count.
   * ------------------------------------------------------------------------ */
  {
    id: 'attention.radar',
    name: '热度跟进·观察名单',
    category: 'attention',
    subType: 'follow',
    angle: '清单',
    style: 'tech',
    requires: [
      { path: 'cashtag' },
      { path: 'price' },
      { path: 'chg24h' },
      { path: 'chg1h' },
      { path: 'volMultiple' },
      { path: 'squareViews' },
    ],
    body: `{{cashtag}} 进观察名单的理由不止一条：
· 广场讨论 {{squarePosts}} 条，累计浏览 {{squareViews|count}}
· 价格 {{price|price}}，24 小时 {{chg24h|spct}}，1 小时 {{chg1h|spct}}
· 1 小时量能 {{volMultiple|fixed:1}} 倍于前六小时均值
{{#if oiChangePct}}· 持仓 24 小时 {{oiChangePct|spct}}
{{/if}}{{#if longRatio}}· 全局多空比 {{longRatio|fixed:2}}
{{/if}}{{#if funding}}· 当期费率 {{funding|rate}}
{{/if}}{{#if sustainedHours}}这个状态从 {{scoreStart}} 分走到 {{attentionScore}} 分，已经持续约 {{sustainedHours}} 小时。{{/if}}
{{#if agreeing >= 3}}几路指标同向，{{@take.attention}}。{{#else}}指标还没完全对齐，{{@take.attention}}。{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'attention.heat',
    name: '热度跟进·讨论与价格背离',
    category: 'attention',
    subType: 'follow',
    angle: '背离',
    style: 'chat',
    requires: [{ path: 'cashtag' }, { path: 'chg24h' }, { path: 'squarePosts' }],
    body: `{{@hook.story}}注意到 {{cashtag}} 在广场上挂了好一阵，{{squarePosts}} 条帖子、{{squareViews|count}} 浏览。
{{#if chg24h > 2}}价格也确实给了 {{chg24h|spct}}，{{#elif chg24h < -2}}但价格是 {{chg24h|spct}}，{{#else}}价格 {{chg24h|spct}}，基本没动，{{/if}}{{@take.attention}}。
{{#if sustainedHours}}我这边连续看了约 {{sustainedHours}} 小时。{{/if}}{{@cta.question}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'move.volume.reading',
    name: '异常放量·量能读数',
    category: 'market_move',
    subType: 'volume_surge',
    angle: '读数',
    style: 'data',
    requires: [{ path: 'cashtag' }, { path: 'volMultiple' }, { path: 'price' }],
    body: `{{cashtag}} 的量能读数：{{#if quoteVolumeHour}}1 小时成交 {{quoteVolumeHour|usd}}，{{/if}}是前六小时均值的 {{volMultiple|fixed:1}} 倍。价格 {{price|price}}，24 小时 {{chg24h|spct}}。
{{#if volMultiple >= 6}}这个倍数已经不是普通波动，{{@take.move.vol}}。
{{#elif volMultiple >= 3}}量起来了，{{@take.move.vol}}。
{{#else}}量只是略放大，还构不成信号。{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'move.volume.brief',
    name: '异常放量·即时播报',
    category: 'market_move',
    subType: 'volume_surge',
    angle: '播报',
    style: 'any',
    requires: [{ path: 'cashtag' }, { path: 'volMultiple' }, { path: 'price' }],
    body: `{{@hook.news}}{{cashtag}} 异常放量：1 小时 {{volMultiple|fixed:1}} 倍于均值，现报 {{price|price}}（24h {{chg24h|spct}}）。
{{#if chg24h > 0}}方向朝上，{{#else}}方向朝下，{{/if}}{{@take.move.vol}}。{{@cta.news}}`,
  },
  {
    // One voice per lens, so picking a style changes what the post *tells you*, not just
    // how it says it. These four all cover a volume surge; none of them can be swapped
    // for another without losing information.
    id: 'move.volume.tech',
    name: '异常放量·位置判断',
    category: 'market_move',
    subType: 'volume_surge',
    angle: '结构',
    style: 'tech',
    requires: [{ path: 'cashtag' }, { path: 'volMultiple' }, { path: 'price' }, { path: 'chg1h' }],
    body: `{{cashtag}} 现价 {{price|price}}，1 小时 {{chg1h|spct}}，24 小时 {{chg24h|spct}}，量能放到 {{volMultiple|fixed:1}} 倍。
{{#if chg1h > 0 && chg24h < 0}}短线在抬，但还没走出 24 小时的区间——放量反抽和放量突破不是一回事。
{{#elif chg1h > 0}}短线和日线同向，{{volMultiple|fixed:1}} 倍的量配这个斜率，回踩位置比追高位置舒服。
{{#else}}放量往下，这种结构不谈支撑，先看量能什么时候枯。{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'move.volume.crowd',
    name: '异常放量·人群站位',
    category: 'market_move',
    subType: 'volume_surge',
    angle: '拥挤度',
    style: 'emotion',
    requires: [{ path: 'cashtag' }, { path: 'volMultiple' }, { path: 'longRatio' }],
    body: `{{cashtag}} 放量 {{volMultiple|fixed:1}} 倍的同一时间，多空比 {{longRatio|fixed:2}}。
{{#if longRatio > 2.5}}人多成这样，量再放也很少有人愿意在这个位置加仓了。
{{#elif longRatio > 1.3}}多头占优，但没到极端，这种位置放量还有讨论空间。
{{#elif longRatio < 0.9}}量在放、空头却占优，这是有人在接盘的形状。
{{#else}}两边差不多，说明这波量不是单边推出来的。{{/if}}
{{#if payer}}同期是{{payer}}在付费。{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'move.volume.chat',
    name: '异常放量·我看到之后',
    category: 'market_move',
    subType: 'volume_surge',
    angle: '第一人称',
    style: 'chat',
    requires: [{ path: 'cashtag' }, { path: 'volMultiple' }, { path: 'price' }],
    body: `刚盯到 {{cashtag}} 一小时成交冲到均值的 {{volMultiple|fixed:1}} 倍，价格 {{price|price}}。
{{#if volMultiple >= 6}}这个量我第一反应是先看它能不能站稳，而不是先想上车。
{{#else}}量不算夸张，我先记一笔，等下一根再说。{{/if}}
说实话，放量当天做决定，多数时候都会后悔。{{@cta.question}}`,
  },
  {
    id: 'move.volume.joke',
    name: '异常放量·段子',
    category: 'market_move',
    subType: 'volume_surge',
    angle: '玩梗',
    style: 'joke',
    requires: [{ path: 'cashtag' }, { path: 'volMultiple' }],
    body: `{{cashtag}} 这一小时的量是平时的 {{volMultiple|fixed:1}} 倍。
热闹是这个点最不缺的东西，缺的是热闹散了以后还留在场上的人。
{{@cta.short}}`,
  },
  {
    id: 'move.dump.emotion',
    name: '短线跳水·情绪侧',
    category: 'market_move',
    subType: 'dump',
    style: 'emotion',
    requires: [{ path: 'cashtag' }, { path: 'chg' }, { path: 'longRatio' }],
    body: `{{cashtag}} {{tf}}跳水 {{chg|pcta}}，多空比 {{longRatio|fixed:2}}。
{{#if longRatio > 2}}多头还堆在这一边。这种跌法最疼的不是价格，是仓位没动。
{{#elif longRatio > 1.3}}多头略占优，{{@take.move.down}}。
{{#elif longRatio < 0.9}}空头已经占优了，那这波杀的多半是止损盘，不是新空单。
{{#else}}两边对半，说明砸下来也没人急着站队。{{/if}}
{{@cta.question}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'move.dump.joke',
    name: '短线跳水·段子手',
    category: 'market_move',
    subType: 'dump',
    angle: '玩梗',
    style: 'joke',
    requires: [{ path: 'cashtag' }, { path: 'chg' }],
    body: `{{cashtag}} {{tf}} {{chg|pcta}}。
{{#if chg24h < 0}}今天的走势像我月初的余额，一路向下还不回头。{{#else}}至少 24 小时还是正的，我选择先乐观五分钟。{{/if}}
{{@joke.cta}}`,
  },
  {
    id: 'hl.funding.reading',
    name: 'Hyperliquid·费率读数',
    category: 'onchain',
    subType: 'hl_funding',
    angle: '读数',
    style: 'data',
    requires: [
      { path: 'cashtag' },
      { path: 'fundingPct' },
      { path: 'volume24h' },
      { path: 'chg24h' },
      { path: 'price' },
      { path: 'oiUsd' },
    ],
    body: `{{@hook.data}}{{cashtag}} 在 {{venue}}：当期费率 {{fundingPct|fixed:3}}%{{#if annualized}}，折年化 {{annualized|fixed:1}}%{{/if}}。
未平仓约合 {{oiUsd|usd}}，24 小时成交 {{volume24h|usd}}，价格 {{price|price}}{{#if chg24h}}（{{chg24h|spct}}）{{/if}}。
{{#if annualized}}{{#if annualized > 100}}年化走到三位数，说明持有的人愿意花大价钱。{{#elif annualized < -100}}{{@take.funding.short}}。{{#else}}费率有偏向，但还不极端。{{/if}}{{#else}}单期费率极端到年化不可读，这种通常出现在薄流动性合约上。{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'ann.campaign.detail',
    name: '公告·活动规则视角',
    category: 'announcement',
    subType: 'campaign',
    angle: '规则',
    style: 'chat',
    requires: [{ path: 'title' }, { path: 'catalogLabel' }],
    body: `{{@hook.story}}币安「{{catalogLabel}}」：{{title}}
{{#if cashtag}}{{cashtag}} 相关的活动，{{#else}}这类活动，{{/if}}{{@take.campaign}}。
{{@cta.question}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'flash.inst.read',
    name: '快讯·机构动作解读',
    category: 'newsflash',
    subType: 'institution',
    angle: '解读',
    style: 'news',
    requires: [{ path: 'title' }],
    body: `{{@hook.data}}{{title}}
{{@take.inst}}。{{#if cashtag}}{{cashtag}} {{@word.watch}}。{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'board.top3',
    name: '榜单·只列前三',
    category: 'leaderboard',
    angle: '精简',
    style: 'data',
    requires: [{ path: 'scope' }, { path: 'board' }],
    body: `{{scope}}前三：{{#each board as row max=3 sep="、"}}{{row.symbol|cash}} {{row.chg|spct}}{{/each}}。
{{@take.leaderboard}}。{{@cta.question}}`,
  },
  {
    id: 'board.spread',
    name: '榜单·梯队分布',
    category: 'leaderboard',
    angle: '梯队',
    style: 'data',
    requires: [{ path: 'scope' }, { path: 'board' }, { path: 'topChg' }],
    body: `{{scope}}榜首 {{topChg|spct}}。
{{#each board as row max=5 sep="
"}}{{row.rank}}. {{row.symbol|cash}} {{row.chg|spct}}{{/each}}
{{#if topChg >= 20}}头部和后面差得有点开，{{@phrase.risk}}
{{#elif topChg <= -20}}跌得最狠的和后面的差距也拉开了，{{@take.move.down}}。
{{#else}}整体比较温和，梯队还算健康。{{/if}}
{{@take.leaderboard}}。{{@cta.question}}`,
  },
  {
    id: 'board.exit',
    name: '榜单·资金撤离顺序',
    category: 'leaderboard',
    subType: 'losers',
    angle: '顺序',
    style: 'data',
    requires: [{ path: 'scope' }, { path: 'board' }],
    body: `{{@hook.alert}}{{scope}}资金撤离靠前：
{{#each board as row max=5 sep="
"}}{{row.rank}}. {{row.symbol|cash}} {{row.chg|spct}}{{/each}}
跌榜上真正有用的是顺序而不是幅度——排在最前面的，往往是先被放弃的。{{@take.leaderboard}}。{{@cta.question}}`,
  },
  {
    id: 'move.extreme.emotion',
    name: '新高新低·情绪侧',
    category: 'market_move',
    style: 'emotion',
    requires: [{ path: 'cashtag' }, { path: 'price' }, { path: 'extreme' }, { path: 'longRatio' }],
    body: `{{#if subType == 'new_high'}}🏔 {{cashtag}} 摸到 24 小时新高 {{extreme|price}}，多空比 {{longRatio|fixed:2}}。
{{#if longRatio > 2.5}}新高 + 人群全在这一边，这两件事同时出现通常不是好信号——上面已经没有比这更乐观的人了。
{{#else}}新高还谈不上拥挤，{{@word.look}}。{{/if}}
{{#else}}🕳 {{cashtag}} 跌破 24 小时低点 {{extreme|price}}，多空比 {{longRatio|fixed:2}}。
{{#if longRatio > 2}}这个位置多头还占优，说明没人认输——真正的底一般发生在另一边。
{{#elif longRatio < 0.9}}空头已经占优，{{@take.move.down}}。{{#else}}两边对半，这个位置谈支撑太早。{{/if}}{{/if}}
{{@cta.question}}
{{@phrase.notAdvice}}`,
  },

  /* ------------------------------------------------------------------------ *
   * Short form. Their highest-scoring post was ~40 characters with a label
   * line and a question; long analytical posts are a different (smaller) game.
   * Target 30-70 characters before the disclaimer.
   * ------------------------------------------------------------------------ */
  {
    id: 'short.move',
    name: '短帖·异动一句话',
    category: 'market_move',
    style: 'any',
    requires: [{ path: 'cashtag' }, { path: 'chg' }, { path: 'price' }, { path: 'tf' }],
    body: `{{@hook.label}}👀
{{cashtag}} {{tf}} {{chg|spct}}，现价 {{price|price}}{{#if volMultiple}}，量能 {{volMultiple|fixed:1}} 倍{{/if}}。{{@cta.short}}
{{#maybe 35}}{{@cta.follow}}{{/maybe}}`,
  },
  {
    id: 'short.ratio',
    name: '短帖·持仓速报',
    category: 'long_short',
    subType: 'account_ratio',
    style: 'emotion',
    requires: [{ path: 'cashtag' }, { path: 'ratio' }],
    body: `持仓速报👀
{{cashtag}} 多空比 {{ratio|fixed:2}}，{{#if ratio > 2}}多头很集中{{#elif ratio > 1.3}}多头明显占优{{#elif ratio > 0.9}}两边差不多{{#else}}空头占优{{/if}}。{{@cta.short}}
{{#maybe 35}}{{@cta.follow}}{{/maybe}}`,
  },
  {
    id: 'short.funding',
    name: '短帖·费率速报',
    category: 'funding',
    subType: 'funding_extreme',
    style: 'capital',
    requires: [{ path: 'cashtag' }, { path: 'funding' }, { path: 'payer' }],
    body: `费率速报👀
{{cashtag}} {{funding|rate}}，{{#if payer == '多头'}}多头在付费{{#else}}空头在付费{{/if}}。{{@cta.short}}
{{#maybe 35}}{{@cta.follow}}{{/maybe}}`,
  },
  {
    id: 'short.board',
    name: '短帖·榜首一句话',
    category: 'leaderboard',
    style: 'data',
    requires: [{ path: 'scope' }, { path: 'board' }, { path: 'topChg' }],
    body: `{{scope}}榜首：{{#each board as row max=1}}{{row.symbol|cash}} {{row.chg|spct}}{{/each}}。{{@take.leaderboard}}。{{@cta.short}}
{{#maybe 35}}{{@cta.follow}}{{/maybe}}`,
  },
  {
    id: 'short.flash',
    name: '短帖·有消息',
    category: 'newsflash',
    style: 'news',
    requires: [{ path: 'title' }],
    body: `{{@hook.label}}：
{{title}}
{{#if cashtag}}{{cashtag}} {{@word.watch}}。{{/if}}{{#maybe 40}}{{@cta.follow}}{{/maybe}}`,
  },
  {
    id: 'short.sentiment',
    name: '短帖·情绪读数',
    category: 'sentiment',
    subType: 'fear_greed',
    style: 'any',
    requires: [{ path: 'value' }, { path: 'label' }],
    body: `{{#if value >= 70}}🤑 {{#elif value <= 30}}😨 {{#else}}😐 {{/if}}恐惧贪婪指数 {{value}}（{{label}}），昨日 {{prev}}。
{{@take.sentiment}}。{{@cta.short}}
{{#maybe 35}}{{@cta.follow}}{{/maybe}}`,
  },

  /* ------------------------------------------------------ 持仓量异动（OI）---
   * The whole point of this detector is that open interest and price move in four
   * different combinations, and each combination means something else. A template that
   * only prints the percentage is strictly worse than the number alone, so `shape` — the
   * name of the combination — carries these bodies.
   */
  {
    id: 'oi.shape',
    name: '持仓异动·谁在开仓',
    category: 'open_interest',
    subType: 'oi_shift',
    angle: '谁在开仓',
    style: 'capital',
    weight: 1.5,
    requires: [{ path: 'cashtag' }, { path: 'window' }, { path: 'dir' }, { path: 'oiChangePct' }, { path: 'oiUsd' }, { path: 'shape' }],
    body: `{{@hook.data}}{{cashtag}} 近{{window}}持仓量{{dir}} {{oiChangePct|pcta}}，总持仓来到 {{oiUsd|usd}}。
同期价格 {{chg24h|spct}} —— 这两个数必须一起看，单独哪一个都说明不了什么。
{{#if shape == '多头开仓'}}{{@take.oi.long}}。
{{#elif shape == '空头开仓'}}{{@take.oi.short}}。
{{#elif shape == '空头回补'}}{{@take.oi.cover}}。
{{#else}}{{@take.oi.stop}}。{{/if}}
{{#maybe 45}} {{@cta.lev}}{{/maybe}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'oi.ledger',
    name: '持仓异动·费率对照',
    category: 'open_interest',
    subType: 'oi_shift',
    angle: '算账',
    style: 'capital',
    weight: 1.2,
    requires: [{ path: 'cashtag' }, { path: 'dir' }, { path: 'oiChangePct' }, { path: 'shape' }, { path: 'funding' }, { path: 'payer' }],
    body: `{{cashtag}} 持仓量{{dir}} {{oiChangePct|pcta}}（{{shape}}）；费率这一侧当期 {{funding|rate}}{{#if annualized}}，折年化 {{annualized|fixed:1}}%{{/if}}，付费的是{{payer}}。
{{#if payer == '多头'}}{{@take.funding.long}}，而仓位这一侧走成了{{shape}}——两个数得一起读。
{{#else}}{{@take.funding.short}}，而仓位这一侧走成了{{shape}}——两个数得一起读。{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'oi.magnitude',
    name: '持仓异动·量级对比',
    category: 'open_interest',
    subType: 'oi_shift',
    angle: '读数',
    style: 'data',
    requires: [{ path: 'cashtag' }, { path: 'oiChangePct' }, { path: 'chg24h' }, { path: 'gapRatio' }],
    body: `{{@hook.data}}{{cashtag}} 三个数，{{window}}内：
持仓量 {{oiChangePct|spct}}｜价格 {{chg24h|spct}}｜24 小时成交 {{quoteVolume24h|usd}}。
{{#if gapRatio > 2}}{{#if oiChangePct > 0}}持仓动得比价格快 {{gapRatio}} 倍，新开的位置还没走到价格上。
{{#else}}仓缩得比价格快 {{gapRatio}} 倍，离场的人已经动手了，价格还没跟上。{{/if}}
{{#elif gapRatio < 0.5}}价格动得比持仓多——这波主要是已有的仓在推，不是新钱进场。
{{#else}}两边动的量级差不多，属于正常的同步波动。{{/if}}
{{@disclaimer.data}}`,
  },
  {
    id: 'oi.crowd',
    name: '持仓异动·人群在哪边',
    category: 'open_interest',
    subType: 'oi_shift',
    angle: '拥挤度',
    style: 'emotion',
    requires: [{ path: 'cashtag' }, { path: 'longRatio' }, { path: 'shape' }, { path: 'oiChangePct' }],
    body: `{{cashtag}} 持仓量{{dir}} {{oiChangePct|pcta}}，账户多空比 {{longRatio|fixed:2}}{{#if payer}}，付费的是{{payer}}{{/if}}。
{{#if longRatio > 2.2}}人挤在多这一边，{{@take.sentiment}}。
{{#elif longRatio > 1.4}}仓位偏多但没到极端，{{@take.sentiment}}。
{{#elif longRatio < 0.75}}空单挤在这一边，{{@take.sentiment}}。
{{#else}}两边人数差不太多，{{shape}}更像是资金的动作，不是散户的情绪。{{/if}}
{{@cta.question}}`,
  },
  {
    id: 'oi.structure',
    name: '持仓异动·结构位置',
    category: 'open_interest',
    subType: 'oi_shift',
    angle: '结构',
    style: 'tech',
    requires: [{ path: 'cashtag' }, { path: 'price' }, { path: 'chg24h' }, { path: 'chg1h' }],
    body: `{{cashtag}} 现价 {{price|price}}，24 小时 {{chg24h|spct}}、1 小时 {{chg1h|spct}}；同期持仓量{{dir}} {{oiChangePct|pcta}}。
{{#if chg1h > 0 && chg24h < 0}}短线在往上抬，但日内还是负的——{{@take.move.down}}。
{{#elif chg1h < 0 && chg24h > 0}}小时级已经掉头了，日线涨幅还在，这种背离比单看一侧更值得记。
{{#else}}短周期和日内同向，结构上没有分歧，{{@word.watch}}。{{/if}}
{{@closing}}`,
  },

  /* ------------------------------------------------------------ 均线交叉 --- */
  {
    id: 'ma.golden.tech',
    name: '均线金叉·结构确认',
    category: 'market_move',
    subType: 'ma_golden',
    angle: '结构',
    style: 'tech',
    weight: 1.4,
    requires: [{ path: 'cashtag' }, { path: 'tf' }, { path: 'price' }, { path: 'maFast' }, { path: 'maSlow' }, { path: 'gapPct' }],
    body: `{{@hook.data}}{{cashtag}} {{tf}}金叉：MA{{fastLen}} 上穿 MA{{slowLen}}。
现价 {{price|price}}，快线 {{maFast|price}}、慢线 {{maSlow|price}}。
{{#maybe 60}}{{@take.ma}}。{{/maybe}}
{{#if gapPct > 5}}价格已经甩开快线 {{gapPct|pcta}}，交叉是真的，但这个位置追进去，接的是回踩。
{{#elif gapPct < -2}}尴尬的是价格又掉回了快线下方 {{gapPct|pcta}}——这种金叉下一根 K 线就能收回。
{{#else}}价格就贴着快线走，差 {{gapPct|pcta}}，回踩不破这条线才算站稳。{{/if}}
{{@closing}}`,
  },
  {
    id: 'ma.death.tech',
    name: '均线死叉·结构确认',
    category: 'market_move',
    subType: 'ma_death',
    angle: '结构',
    style: 'tech',
    weight: 1.4,
    requires: [{ path: 'cashtag' }, { path: 'tf' }, { path: 'price' }, { path: 'maFast' }, { path: 'maSlow' }, { path: 'gapPct' }],
    body: `{{cashtag}} {{tf}}死叉：MA{{fastLen}} 下穿 MA{{slowLen}}。
现价 {{price|price}}，快线 {{maFast|price}}，已经跌破 {{gapPct|pcta}}。
{{#maybe 60}}{{@take.ma}}。{{/maybe}}
{{#if chg24h < -5}}24 小时 {{chg24h|spct}}，是先跌出来的交叉，不是交叉带来的跌——{{@take.move.down}}。
{{#elif chg24h < 0}}24 小时 {{chg24h|spct}}，价格和均线一起往下走，结构上没有分歧。
{{#else}}有意思的是 24 小时还留着 {{chg24h|spct}}——价格在涨，均线却已经翻向，这种背离通常比单纯的下跌更要留心。{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'ma.volume.data',
    name: '均线交叉·量能核对',
    category: 'market_move',
    angle: '量能',
    style: 'data',
    requires: [{ path: 'cashtag' }, { path: 'cross' }, { path: 'volMultiple' }, { path: 'chg24h' }],
    body: `{{cashtag}} {{tf}}{{cross}}，先把量能对上：
24 小时成交 {{quoteVolume24h|usd}}；最近一个小时的量是前 7 小时均量的 {{volMultiple|fixed:2}} 倍，价格 24 小时 {{chg24h|spct}}。
{{#if volMultiple > 1.6}}放量交叉，{{@take.move.vol}}。
{{#elif volMultiple < 0.8}}量在缩——{{@take.move.thin}}。
{{#else}}量能跟平时差不多，这次交叉没有额外的量做注脚。{{/if}}
{{@disclaimer.data}}`,
  },
  {
    id: 'ma.confirm.capital',
    name: '均线交叉·资金是否配合',
    category: 'market_move',
    angle: '资金',
    style: 'capital',
    requires: [{ path: 'cashtag' }, { path: 'cross' }, { path: 'oiChangePct' }, { path: 'quoteVolume24h' }],
    body: `{{cashtag}} {{tf}}{{cross}}，钱这一侧配不配合？
24 小时成交 {{quoteVolume24h|usd}}，同期持仓量 {{oiChangePct|spct}}{{#if payer}}，费率 {{funding|rate}}，{{payer}}在付{{/if}}。
{{#if oiChangePct > 3}}{{cross}}之后仓位还在加，说明这波结构变化后面是真有钱进来的。
{{#elif oiChangePct < -3}}{{@take.oi.flat}}。
{{#else}}持仓基本没动，交叉归交叉，资金还没表态。{{/if}}
{{@phrase.notAdvice}}`,
  },

  /* ------------------------------------------------------- Hyperliquid 价差 ---
   * hl_move materials exist to name a divergence between two venues, so the venue has to
   * be in the sentence — a post that reads identically whether it came from Binance or
   * Hyperliquid is not using the source at all.
   */
  {
    id: 'hl.move.venue',
    name: 'HL 波动·跨所对照',
    category: 'onchain',
    subType: 'hl_move',
    angle: '跨所',
    style: 'capital',
    weight: 1.3,
    requires: [{ path: 'cashtag' }, { path: 'venue' }, { path: 'chg24h' }, { path: 'oiUsd' }, { path: 'venueSharePct' }],
    body: `{{@hook.data}}{{cashtag}} 在 {{venue}} 上 24 小时 {{chg24h|spct}}，现价 {{price|price}}。
{{venue}} 日成交 {{volume24h|usd}}、未平仓 {{oiUsd|usd}}——只相当于币安同标的成交的 {{venueSharePct|pct}}。
{{#if venueSharePct < 10}}量差得很远，{{venue}}这一侧的价格带动不了大盘，看着热闹而已。
{{#elif venueSharePct < 30}}{{venue}}的量在币安面前只是个零头，这波更像是{{venue}}自己的行情。
{{#else}}两边量级差不太多，{{#if chg24h > 0}}{{@take.move.up}}{{#else}}{{@take.move.down}}{{/if}}。{{/if}}
{{#if funding}}费率 {{funding|rate}}{{#if payer}}，{{payer}}在付{{/if}}。{{/if}}
{{@phrase.notAdvice}}`,
  },
  {
    id: 'hl.move.structure',
    name: 'HL 波动·结构读数',
    category: 'onchain',
    subType: 'hl_move',
    angle: '结构',
    style: 'tech',
    requires: [{ path: 'cashtag' }, { path: 'price' }, { path: 'chg24h' }, { path: 'chg1h' }],
    body: `{{cashtag}} {{price|price}}，{{venue}}口径：24 小时 {{chg24h|spct}}，最近一小时 {{chg1h|spct}}。
{{#if chg24h > 0 && chg1h > 0}}两个周期同向，{{@take.move.up}}。
{{#elif chg24h > 0 && chg1h < 0}}日内还是红的，但小时级已经转弱——{{@take.move.down}}。
{{#elif chg24h < 0 && chg1h > 0}}跌了一天，短线开始反弹，这种位置最容易被当成反转。
{{#else}}两个周期都朝下，结构上没给出任何分歧。{{/if}}
{{@word.watch}}。
{{@closing}}`,
  },

  /* ------------------------------------------------------------------ 补齐风格 ---
   * These fill cells that had exactly one voice. A cell with one template is a coin
   * flip: whichever account draws it gets the same wording, which is what the cross-account
   * similarity gate then has to reject, wasting the slot. Each body is anchored on a field
   * belonging to its own lens, so the styles differ by what they point at, not by synonyms.
   */
  {
    id: 'board.chat',
    name: '榜单·第一人称',
    category: 'leaderboard',
    angle: '第一人称',
    style: 'chat',
    requires: [{ path: 'board' }, { path: 'topChg' }],
    body: `{{scope}}榜我只看第一个名字：{{#each board as row max=1}}{{row.symbol|cash}} {{row.chg|spct}}{{/each}}。
{{#if topChg > 30}}这个位置追进去，{{@take.leaderboard}}。
{{#elif topChg < 10}}涨幅不到两位数，说实话没什么好看的。
{{#else}}我先记下来，{{@word.look}}。{{/if}}
前三：{{#each board as row max=3 sep="、"}}{{row.symbol|cash}}{{/each}}。{{@cta.short}}`,
  },
  {
    id: 'board.joke',
    name: '榜单·玩梗',
    category: 'leaderboard',
    angle: '玩梗',
    style: 'joke',
    requires: [{ path: 'board' }, { path: 'topChg' }],
    body: `{{#if topChg > 0}}{{@hook.story}}{{scope}}榜首 {{#each board as row max=1}}{{row.symbol|cash}}{{/each}}，{{topChg|spct}}。
这名字昨天我连搜索都没搜过。{{@joke.cta}}
{{#else}}{{@hook.story}}{{scope}}跌幅榜第一 {{#each board as row max=1}}{{row.symbol|cash}}{{/each}}，{{topChg|spct}}。
{{@phrase.hindsight}}{{@joke.cta}}{{/if}}`,
  },
  {
    id: 'funding.emotion',
    name: '资金费率·人群在哪边',
    category: 'funding',
    subType: 'funding_extreme',
    angle: '拥挤度',
    style: 'emotion',
    requires: [{ path: 'cashtag' }, { path: 'payer' }, { path: 'longRatio' }],
    body: `{{cashtag}} 费率 {{funding|rate}}，{{payer}}在付；账户这边多空比 {{longRatio|fixed:2}}。
{{#if longRatio > 2 && payer == '多头'}}人挤在多这一边，还在给对面交钱——{{@take.funding.long}}。
{{#elif longRatio < 0.9 && payer == '空头'}}空单占多数，又是付费的那一方，{{@take.funding.short}}。
{{#elif payer == '多头'}}{{@take.funding.long}}，但人数没到极端，还在可接受的范围里。
{{#else}}{{@take.funding.flat}}。{{/if}}
{{@cta.question}}`,
  },
  {
    id: 'funding.tech',
    name: '资金费率·结构位置',
    category: 'funding',
    subType: 'funding_extreme',
    angle: '结构',
    style: 'tech',
    requires: [{ path: 'cashtag' }, { path: 'price' }, { path: 'chg1h' }, { path: 'funding' }],
    body: `{{cashtag}} 现价 {{price|price}}，1 小时 {{chg1h|spct}}，同期费率 {{funding|rate}}。
{{#if chg1h > 0 && funding > 0}}价格往上、多头付费——{{@take.funding.long}}。
{{#elif chg1h < 0 && funding < 0}}跌的同时空头还在付费——方向上赚的要先抵掉这块成本，说明做空的人多到愿意付钱维持仓位。
{{#elif chg1h > 0 && funding < 0}}价格在涨、空头还在付费，更像是被推着回补，而不是新买盘进场。
{{#else}}费率和价格方向不冲突，结构上没有要提醒的。{{/if}}
{{@closing}}`,
  },
  {
    id: 'hl.funding.crowd',
    name: 'HL 费率·人群在哪边',
    category: 'onchain',
    subType: 'hl_funding',
    angle: '拥挤度',
    style: 'emotion',
    requires: [{ path: 'cashtag' }, { path: 'venue' }, { path: 'payer' }, { path: 'longRatio' }],
    body: `{{cashtag}} 在 {{venue}} 的费率已经到 {{funding|rate}}，{{payer}}每天在付；账户多空比 {{longRatio|fixed:2}}。
{{#if longRatio > 2}}{{@take.sentiment}}。
{{#elif longRatio < 0.9}}人挤在空这一边，{{@take.funding.short}}。
{{#else}}费率这么极端，人却没那么一边倒——付费的更像是几个大仓位，不是散户。{{/if}}
{{@cta.question}}`,
  },
  {
    id: 'dex.data',
    name: 'DEX 热门池·量级',
    category: 'dex',
    subType: 'trending_pool',
    angle: '读数',
    style: 'data',
    requires: [{ path: 'poolName' }, { path: 'chain' }, { path: 'chg24h' }, { path: 'reserveUsd' }],
    body: `{{@hook.data}}{{chain}} 上 {{poolName}} 这个池子 24 小时 {{chg24h|spct}}。
池内储备 {{reserveUsd|usd}}{{#if volume24h}}，日成交 {{volume24h|usd}}{{/if}}。
{{#if chg24h > 100}}三位数的涨幅配上这个储备量，{{@take.dex}}。
{{#else}}{{#if reserveUsd < 500000}}池子很薄，{{@take.dex}}。{{#else}}量级和波动还算匹配。{{/if}}{{/if}}
{{@disclaimer.data}}`,
  },
  {
    id: 'topic.crowd',
    name: '话题·人群在哪边',
    category: 'attention',
    subType: 'topic',
    angle: '拥挤度',
    style: 'emotion',
    requires: [{ path: 'cashtag' }, { path: 'squareDiscuss' }, { path: 'longRatio' }],
    body: `{{cashtag}} 在广场被讨论 {{squareDiscuss|count}} 次，同时多空比 {{longRatio|fixed:2}}。
{{#if longRatio > 2}}刷到的是热闹，仓也堆在多这一边——{{@take.attention}}。
{{#elif longRatio < 0.9}}讨论的热度在这一头，仓位却偏空，{{@take.attention}}。
{{#else}}{{@take.attention}}。{{/if}}
{{@cta.question}}`,
  },
  {
    id: 'topic.money',
    name: '话题·资金核对',
    category: 'attention',
    subType: 'topic',
    angle: '资金',
    style: 'capital',
    requires: [{ path: 'cashtag' }, { path: 'quoteVolume24h' }, { path: 'funding' }, { path: 'squareDiscuss' }, { path: 'oiChangePct' }],
    body: `{{@hook.data}}{{cashtag}} 广场上 {{squareDiscuss|count}} 条讨论，钱这边：24 小时成交 {{quoteVolume24h|usd}}，费率 {{funding|rate}}{{#if payer}}（{{payer}}在付）{{/if}}，持仓量 {{oiChangePct|spct}}。
{{#if oiChangePct > 3}}仓在增加，讨论确实变成了仓位。
{{#elif oiChangePct < -3}}热度往上、仓却在缩——{{@take.attention}}。
{{#else}}仓位没什么动静，{{@take.attention}}。{{/if}}
{{@phrase.notAdvice}}`,
  },
];

export const templatesByCategory: Map<string, TemplateDef[]> = (() => {
  const m = new Map<string, TemplateDef[]>();
  for (const t of templates) {
    const list = m.get(t.category) ?? [];
    list.push(t);
    m.set(t.category, list);
  }
  return m;
})();
