import type { Context } from '../engine/types.ts';
import type { ArticleSpec } from './compose.ts';

/**
 * The article library.
 *
 * Content, not infrastructure — kept apart from `compose.ts` so the argument shape stays
 * reviewable as the pieces change.
 *
 * Three rules every piece here obeys, and they are what separates it from the short-post
 * templates:
 *
 * 1. **No number is written into the prose.** Every figure is interpolated from a material
 *    field, because a hand-typed example goes stale silently and a teaching account that
 *    quotes a dead number loses exactly the trust it exists on. (This is not theoretical:
 *    the first article we published would have printed a meaningless -1075% annualised
 *    figure had the number been hardcoded.)
 * 2. **Every piece states what its indicator cannot see.** The refusal list bans conclusions;
 *    this bans overclaiming, which is the subtler failure.
 * 3. **The reader is handed the means to check it.** "在哪查" is a required section, not a
 *    courtesy — a lesson you cannot verify is a tip.
 */

const sym = (c: Context): string => String(c.cashtag || c.symbol || '这个币');

/**
 * Titles are built in JavaScript, not the template DSL — they are computed before any
 * render pass exists. Leaving `{{field}}` in a title ships the braces to Square verbatim,
 * which is what the first drafts of these three titles did.
 */
const pct = (v: unknown, digits = 2): string => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '若干';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
};
const num = (v: unknown, digits = 2): string => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : '若干';
};

/* -------------------------------------------------------------------------- */

const FUNDING_WHO_PAYS: ArticleSpec = {
  conceptId: 'funding_who_pays',
  needsChart: false,
  validForHours: 36,
  titleOf: c => `${sym(c)} 的费率在收${c.payer === '空头' ? '空头' : '多头'}的钱：先搞清谁付给谁`,
  sections: [
    {
      id: 'hook',
      label: '钩子',
      mandatory: true,
      requires: [{ path: 'funding' }, { path: 'payer' }],
      body: `{{cashtag}} 这期资金费率 {{funding|rate}}，{{intervalHours|fixed:0}} 小时结算一次，付钱的一方是{{payer}}。

这句话里最容易读错的是"付钱的一方"。它不等于"人多的一方"，也不等于"占优的一方"。下面把这三件事拆开。`,
    },
    {
      id: 'mechanism',
      label: '机制拆解',
      mandatory: true,
      body: `先说一个很多人没意识到的事实：**合约市场上，多单和空单的数量永远相等。**每一张多单背后必然对应一张空单，这是撮合机制决定的，跟谁看涨谁看跌无关。

所以"多头占优"这句话，在仓位张数上永远不成立——两边张数一模一样。它只能指两件别的事：

一是**账户个数**。多少人站在多头那边，这是多空比在统计的东西，跟资金量无关。
二是**谁在付钱**。这才是资金费率真正在说的事情。

费率机制存在的目的，是让永续合约的价格不要偏离现货太远。当愿意做多的人更多、把合约价推高到现货之上，结算就把钱从多头转给空头，用成本劝退一部分追多的、奖励一部分做空的，价格被拉回来。反过来同理。

所以看到负费率，正确的读法不是"空头更强"，而是：**愿意顶着每天结算的成本做空的人，已经多到把合约价压到现货之下了。**`,
    },
    {
      id: 'naive-break',
      label: '为什么不能简单算',
      mandatory: true,
      requires: [{ path: 'funding' }, { path: 'intervalHours' }],
      // 365 is the argument's own arithmetic — "do not annualise" — not a market reading.
      // Declaring it keeps the literal guard meaningful for every other number here.
      literals: ['365'],
      body: `现在可以把"付钱"换算成一个具体负担。{{cashtag}} 当期 {{funding|rate}}，{{intervalHours|fixed:0}} 小时一次，一天结算 {{perDay}} 次，也就是持仓一天的成本约 {{dailyCost}}。

这一步很多人会顺手乘个 365 做年化。**这里恰恰不能这么算。**费率不是利率，它不会以今天的速率持续一年：极端费率几乎总是来自某个具体情境——新上线、流动性薄、或者多空对某个消息严重对赌——它会在几天内自己收敛。把 {{funding|rate}} 乘成年化，得到的数字大得荒谬，反而让人不敢信了。

有意义的问法是：**这个成本扛得住几天。** 一天 {{dailyCost}}，一周就是 {{weeklyCost}}。这是能拿来做决策的量级，年化不是。`,
    },
    {
      id: 'misreads',
      label: '常见误读',
      body: `· **看到负费率就想做多。** 负费率说明空头在付代价，不说明空头会爆。代价高不等于会爆，这两件事之间隔着不确定的时间。
· **把费率当方向信号。** 它是"市场此刻有多不平衡"的读数，是一个状态量，不是预测量。
· **只看一期数值下结论。** 连着多期同向、并且持仓量配合，才是结构；单期跳一下大概率是噪声。
· **不同市值的币用同一个阈值比较。** 同样的费率，在大市值币上是情绪，在小市值币上可能只是没流动性。`,
    },
    {
      id: 'verify',
      label: '在哪自己查',
      body: `不用信我上面任何一个数，三个地方都能自己核对：

**费率现值与历史**：进 {{cashtag}} 的永续合约页，行情栏直接显示当期费率和下次结算时间；往下翻有费率历史图，能看出这波是从哪天开始的。
**结算周期**：就是上面那个"几小时一次"，不同币不一样，别统一按 8 小时算。
**多空两边谁在付**：费率为正、多头付；费率为负、空头付。这一条记反，整段分析就是反的。

最后说清这篇能支撑什么结论：它能让你判断**此刻谁在为持仓付钱、付得多重**，不能让你判断明天涨跌。把它当温度计，别当信号。

内容仅为数据梳理与方法说明，不构成任何投资建议。合约有强平风险，仓位自己决定。`,
    },
  ],
  claimsOf: c => [
    { field: 'funding', assertion: Number(c.funding) > 0 ? 'above' : 'below', value: Number(c.funding), phrase: `${sym(c)} 费率为 ${Number(c.funding) > 0 ? '正' : '负'}，${String(c.payer)}在付费` },
  ],
};

/* -------------------------------------------------------------------------- */

const OI_VS_VOLUME: ArticleSpec = {
  conceptId: 'oi_vs_volume',
  needsChart: true,
  validForHours: 24,
  titleOf: c => `${sym(c)} 涨了 ${pct(c.chg24h)}，是有人进场还是有人撤退？`,
  sections: [
    {
      id: 'hook',
      label: '钩子',
      mandatory: true,
      requires: [{ path: 'quoteVolume24h' }, { path: 'oiUsd' }],
      body: `{{cashtag}} 24 小时成交 {{quoteVolume24h|usd}}，未平仓 {{oiUsd|usd}}，同期价格 {{chg24h|spct}}、持仓量 {{dir}} {{oiChangePct|pcta}}。

上面两个"量"，是盘面里最常被混为一谈的一对。混了之后，几乎所有行情解读都会得出反的结论。`,
    },
    {
      id: 'mechanism',
      label: '机制拆解',
      mandatory: true,
      body: `**成交量是流量，持仓量是存量。**

成交量统计的是这段时间里换手了多少——一笔买入配一笔卖出，记一次。它回答"有多少人在动"，不回答"他们动完之后留下了什么"。两个人互相倒手一百万次，成交量很大，但没有任何新仓位被建立。

持仓量（未平仓合约，OI）统计的是此刻还开着的单子总价值。它只会在**新开仓**时增加，在**平仓**时减少。

这个区别带来一组必须分开看的组合。价格和持仓同向还是反向，一共四种情况，含义完全不同：

· 持仓增加 + 价格上行 → 新多头进场把钱推上去的，趋势有增量资金。
· 持仓增加 + 价格下行 → 新空头主动开仓砸下来的，下跌是有人真金白银打出来的。
· 持仓减少 + 价格上行 → 空头在平仓还债。空头买入平仓本身会推高价格，所以这种涨不依赖新买盘，持续性通常要打折。
· 持仓减少 + 价格下行 → 多头在认输离场，杀跌的能量来自撤退而不是新增做空。

{{#if shape}}现在 {{cashtag}} 落在其中一种：**{{shape}}**。{{/if}}`,
    },
    {
      id: 'naive-break',
      label: '为什么不能简单算',
      mandatory: true,
      requires: [{ path: 'oiChangePct' }, { path: 'chg24h' }],
      body: `单看持仓量的涨跌幅也是个陷阱，因为它是个相对数，分母可以小到让百分比失去意义。

{{cashtag}} 这期持仓量变化 {{oiChangePct|spct}}。如果它的未平仓只有几百万美元，这个百分比可能来自两三张大单；同样的数字放在几十亿持仓的币上，才谈得上"一批人在动"。

所以我们把两个数放在一起看：持仓绝对值 {{oiUsd|usd}}，24 小时成交 {{quoteVolume24h|usd}}。**先看量级，再看变化率**——顺序反了，你会为一件其实没发生的事兴奋。`,
    },
    {
      id: 'misreads',
      label: '常见误读',
      body: `· **"放量上涨"和"增仓上涨"当同一件事。** 放量可能只是换手（老仓对倒），增仓才说明有新钱建立仓位。
· **看到持仓量暴跌就认为利空。** 持仓下降 + 价格上涨，是空头撤退，对多头反而是好事。方向要配着价格读。
· **拿小市值币的持仓百分比和主流币比。** 分母不同，百分比不可比。先比绝对量级。
· **只看一个时刻的持仓量。** 持仓量本身的高低不说明什么，它相对自己近期均值的**变化**才有信息。`,
    },
    {
      id: 'verify',
      label: '在哪自己查',
      body: `**未平仓合约**：合约数据页有"未平仓合约"，可切 1 小时 / 4 小时 / 日线周期，看的是存量。
**成交量**：同一个页面的成交额，看的是流量。两个都截下来，对照上面那四种情况套一次。
**注意单位**：有些接口给的是币的张数而不是美元价值，直接读会得出离谱的量级。换算方式是持仓张数 × 当前标记价。

这套判断的价值不在于预测，而在于让你每次看到"涨了 X%"时，能多问一句：**是谁的钱、以什么方式把它推上去的。**

数据来自公开信息，请自行判断，不构成投资建议。`,
    },
  ],
  claimsOf: c => [
    { field: 'oiChangePct', assertion: Number(c.oiChangePct) > 0 ? 'increasing' : 'decreasing', value: Number(c.oiChangePct), phrase: `${sym(c)} 持仓量${String(c.dir)} ${Math.abs(Number(c.oiChangePct)).toFixed(1)}%` },
  ],
};

/* -------------------------------------------------------------------------- */

const LS_RATIO_IS_ACCOUNTS: ArticleSpec = {
  conceptId: 'ls_ratio_is_accounts',
  validForHours: 24,
  titleOf: c => `多空比 ${num(c.longRatio)}：它数的是人头，不是钱`,
  sections: [
    {
      id: 'hook',
      label: '钩子',
      mandatory: true,
      requires: [{ path: 'longRatio' }, { path: 'longPct' }, { path: 'shortPct' }],
      body: `{{cashtag}} {{scope}}多空比 {{longRatio|fixed:2}}：多头账户占 {{longPct|fixed:1}}%，空头账户占 {{shortPct|fixed:1}}%。

第一反应通常是"多头更多，所以看涨的人多"。这句话有一半是错的，而且错的就是关键的那一半。`,
    },
    {
      id: 'mechanism',
      label: '机制拆解',
      mandatory: true,
      body: `这个指标的全名是**多空账户比**：统计有多少个账户持多、多少个持空。注意是"多少个账户"。

一个管理十亿美元的机构账户，和一个开了十美元仓位的账户，在分子上各算一个 1。

所以多空比能可靠告诉你的是**人数分布**，不能告诉你**资金分布**。而决定价格的是后者。

这也解释了为什么它常被当成反向指标用：人数上的多数派，往往是资金上的少数派。当绝大多数账户都挤在同一边，通常意味着这波情绪已经扩散到末端——真正的大钱更可能站在对面，或者已经离场。`,
    },
    {
      id: 'naive-break',
      label: '为什么不能简单算',
      mandatory: true,
      requires: [{ path: 'longRatio' }],
      body: `把 {{longRatio|fixed:2}} 读成"多头强 {{longRatio|fixed:2}} 倍"是最常见的算法错误——它不是仓位规模之比，甚至不是资金之比。

而且这个数要配合变化看。{{#if prevRatio}}上一期是 {{prevRatio|fixed:2}}，这期 {{ratioDiff|spct}}。{{#else}}单期数值本身不构成信号，要看它接下来怎么动。{{/if}}

人数一边倒、同时费率在惩罚这一边，才是有价值的组合——那说明多数人在付钱维持仓位。{{cashtag}} 当前费率 {{funding|rate}}，付费方是{{payer}}。`,
    },
    {
      id: 'misreads',
      label: '常见误读',
      body: `· **把账户比当资金比。** 这是本篇的核心，几乎所有后续误读都从这一步开始。
· **用单一交易所的多空比推全市场。** 它只覆盖这一个平台的用户，不同平台的用户结构差别很大。
· **忽略口径。** 有的统计全量账户，有的只统计持仓账户，有的只看大户，同名指标数值可以差很多。
· **把"多数人在多头"直接当买入理由。** 如果这有效，散户就不会亏钱了。`,
    },
    {
      id: 'verify',
      label: '在哪自己查',
      body: `在合约数据页找"多空账户比"，注意同时看**全局**和**头部交易者**两个口径——两者背离时往往更有信息量，因为它说明散户和大户不在同一边。

配合资金费率一起看，你才同时掌握了"多少人站这边"和"站这边的人每天付多少钱"。

一句话总结：**多空比告诉你人群在哪一边，资金费率告诉你这一边的人愿为这个信念付多少。** 两个一起才勉强算读完了情绪。

数据来自公开信息，请自行判断，不构成投资建议。`,
    },
  ],
  claimsOf: c => [
    { field: 'longRatio', assertion: Number(c.longRatio) > 1 ? 'above' : 'below', value: Number(c.longRatio), phrase: `${sym(c)} 多空账户比 ${Number(c.longRatio).toFixed(2)}，多头账户占多数` },
  ],
};

/* -------------------------------------------------------------------------- */

const EXTREME_FUNDING_NOT_ANNUALIZED: ArticleSpec = {
  conceptId: 'extreme_funding_not_annualized',
  validForHours: 24,
  titleOf: c => `费率极端到不能年化的时候，该怎么算成本`,
  sections: [
    {
      id: 'hook',
      label: '钩子',
      mandatory: true,
      requires: [{ path: 'funding' }, { path: 'intervalHours' }],
      body: `{{cashtag}} 当期资金费率 {{funding|rate}}，{{intervalHours|fixed:0}} 小时结算一次。

如果你顺手把它乘成年化，会得到一个看起来像印钞机或者绞肉机的数字。那个数字是错的，不是算错，是**这个方法在这种时候就不成立**。`,
    },
    {
      id: 'mechanism',
      label: '机制拆解',
      mandatory: true,
      body: `年化这个动作隐含了一个假设：**当前的速率会持续。** 利率、通胀、股息用年化是合理的，因为它们本身就是慢变量。

资金费率不是。它是合约价与现货价偏离程度的**实时惩罚项**——偏离越大，费率越高，而高费率本身就在驱使人平仓，平仓又让偏离收敛。也就是说，费率越高，它自己越难维持。

一个会自我消灭的量做年化，得到的数字描述的是一个永远不会持续一年的状态。所以极端费率下，年化不是"保守估计"，是**系统性高估**。`,
    },
    {
      id: 'naive-break',
      label: '为什么不能简单算',
      mandatory: true,
      requires: [{ path: 'funding' }, { path: 'intervalHours' }],
      body: `正确的问法不是"年化多少"，而是**"这个成本扛得住几天"**。

按 {{intervalHours|fixed:0}} 小时结算、一天 {{perDay}} 次算，持仓一天的费率成本约 {{dailyCost}}，一周约 {{weeklyCost}}。这两个数字才是可决策的：它直接告诉你，价格横着不动一周，你光费率就要交掉 {{weeklyCost}}，而这还没算方向上的盈亏。

极端值通常撑不过几天。真正常驻的，是每天零点几个百分点这个量级——那个才适合年化去比较不同品种的资金成本。`,
    },
    {
      id: 'misreads',
      label: '常见误读',
      body: `· **拿极端费率年化去论证"必有人爆仓"。** 收敛速度不可知，成本再高也可能扛很久。
· **反过来，用年化失真当理由忽略它。** 不能年化不等于不重要，一天 {{dailyCost}} 是实打实的。
· **忽略结算周期不同。** 有的币 8 小时、有的 4 小时、新上线的常见 1 小时。同样 {{funding|rate}}，周期越短，日复利越凶。
· **不看成交额就信费率。** 流动性薄的品种，几张大单就能把费率推到极端，那反映的是市场太小，不是多空对赌太激烈。{{cashtag}} 24 小时成交 {{quoteVolume24h|usd}}，这个量级要一起放进判断里。`,
    },
    {
      id: 'verify',
      label: '在哪自己查',
      body: `**结算周期**：合约页会显示下次结算时间，两个相邻结算点之差就是周期，别靠记忆。
**费率历史**：费率历史图能直接看出这波极端从哪天开始、有没有收敛迹象——比单点数值有用得多。
**成交额**：同一个合约页的 24 小时成交额，用来判断这个费率值不值得当真。

方法就一句话：**能年化的前提是速率会持续；不满足时，换成"扛得住几天"。**

数据来自公开信息，请自行判断，不构成投资建议。`,
    },
  ],
  claimsOf: c => [
    { field: 'funding', assertion: Math.abs(Number(c.funding)) > 0.001 ? 'above' : 'below', value: Math.abs(Number(c.funding)), phrase: `${sym(c)} 费率绝对值处于极端区间` },
  ],
};

/* -------------------------------------------------------------------------- */

const MA_IS_LAGGING: ArticleSpec = {
  conceptId: 'ma_is_lagging',
  needsChart: true,
  validForHours: 24,
  titleOf: c => `${sym(c)} ${String(c.tf ?? '')}${String(c.cross ?? '均线交叉')}：它确认的是已经走完的那一段`,
  sections: [
    {
      id: 'hook',
      label: '钩子',
      mandatory: true,
      requires: [{ path: 'cross' }, { path: 'tf' }, { path: 'maFast' }],
      body: `{{cashtag}} {{tf}}出现{{cross}}：MA{{fastLen}} {{dir}} MA{{slowLen}}，现价 {{price|price}}，快线在 {{maFast|price}}，价差 {{gapPct|spct}}。

这条信号最容易被高估的地方在于：它看起来像在说未来，其实它只在说过去。`,
    },
    {
      id: 'mechanism',
      label: '机制拆解',
      mandatory: true,
      requires: [{ path: 'fastLen' }, { path: 'slowLen' }],
      body: `均线是一段窗口内收盘价的平均。窗口越长，它越"重"，转向越慢。

快线（MA{{fastLen}}）跟着近期价格走，慢线（MA{{slowLen}}）被很久之前的价格拖住。所谓交叉，发生的原因是：**近期这段价格已经持续偏离远期均价足够久，久到平均值本身被推动了。**

所以交叉从来不是行情的起点被发现了，而是"一段已经走完的行情，其持续性终于改变了均线结构"。它是行情的**结果**被登记下来，不是原因。`,
    },
    {
      id: 'naive-break',
      label: '为什么不能简单算',
      mandatory: true,
      requires: [{ path: 'gapPct' }, { path: 'maFast' }],
      body: `更要紧的是：交叉的有效性取决于它离现价多远。

{{#if gapPct > 5}}现在价格已经甩开快线 {{gapPct|pcta}}。交叉是真的，但它是被这段已经发生的涨幅推出来的——此刻按交叉进场，你买的是"已经涨过"这件事。
{{#elif gapPct < -2}}反过来，价格又掉回了快线下方 {{gapPct|pcta}}。这说明推动均线的力量已经消失，这种交叉下一根 K 线就可能被收回。
{{#else}}价格就贴着快线走（{{gapPct|spct}}）。这种交叉最脆弱——它刚刚成立，任何一次回踩都可能让它消失。
{{/if}}

同一个"金叉"，在三种位置上的含义完全不同。把它当一个二元信号（发生/没发生）来用，是用错了这个工具。`,
    },
    {
      id: 'misreads',
      label: '常见误读',
      body: `· **把交叉当预测。** 它是滞后指标，滞后是它的定义，不是它的缺陷。
· **忽略周期。** {{tf}}级别的交叉和日线级别的交叉，量级差一个数量级，不能互相替代。
· **在震荡市里连续采信。** 均线策略在趋势市有效、在横盘里会被反复打脸，而交叉信号本身不会告诉你现在是哪一种。
· **用未收盘的 K 线判断交叉。** 当根 K 线还在走，交叉可能只是几分钟的插针。要等它收盘。`,
    },
    {
      id: 'verify',
      label: '在哪自己查',
      body: `在 K 线图上把周期切到 {{tf}}，叠加 MA{{fastLen}} 和 MA{{slowLen}} 两条线，然后做三件事：

1. 确认交叉发生在**已收盘**的那根 K 线上；
2. 量一下现价离快线多远——就是上面说的"位置"，这决定这次交叉值不值得看；
3. 往回翻三次同类交叉，看之后价格走了多久。这一步最有用：**均线信号的历史胜率，你自己十分钟就能数出来**，不需要任何人给结论。

它是有用的，但用处在于描述"一段趋势已经确立到什么程度"，不在于告诉你下一步。

内容仅为方法说明，不构成任何投资建议。`,
    },
  ],
  claimsOf: c => [
    { field: 'gapPct', assertion: Number(c.gapPct) > 0 ? 'above' : 'below', value: Number(c.gapPct), phrase: `${sym(c)} 现价位于快线${Number(c.gapPct) > 0 ? '上方' : '下方'} ${Math.abs(Number(c.gapPct)).toFixed(2)}%` },
  ],
};

export const ARTICLE_LIBRARY: ArticleSpec[] = [
  FUNDING_WHO_PAYS,
  OI_VS_VOLUME,
  LS_RATIO_IS_ACCOUNTS,
  EXTREME_FUNDING_NOT_ANNUALIZED,
  MA_IS_LAGGING,
];

export function specFor(conceptId: string): ArticleSpec | undefined {
  return ARTICLE_LIBRARY.find(s => s.conceptId === conceptId);
}
