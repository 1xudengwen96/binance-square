/**
 * Shared phrase pools. Templates reference these as `{{@key.path}}` so a single
 * tone decision can be tuned in one place instead of across hundreds of templates.
 * Entries may themselves use pools and conditionals.
 */
export const wordBank: Record<string, string> = {
  /* ---------------------------------------------------------- hooks --- */
  'hook.news': '{📣|🔊|⚡|🗞} ',
  'hook.story': '{说实话|讲真|刚刷到|正好看到}，',
  'hook.alert': '{🚨|⚠️|👀|📌} ',
  'hook.data': '{📊|🔢|📈|🧮} ',
  'emoji.bull': '{📈|💰|🟢}',
  'emoji.bear': '{📉|🔴|🩸}',

  /* --------------------------------------------------------- words --- */
  'word.now': '{刚刚|快讯|第一时间}',
  'word.watch': '{值得盯一下|可以多留意|先加个自选|建议关注}',
  'word.look': '{先看看|等等再说|观察一下}',

  /* ---------------------------------------------------- risk phrases --- */
  // These are used as standalone lines, so each variant carries its own terminator.
  'phrase.risk': '{注意仓位。|别上头。|控制一下风险。|自己把握分寸。}',
  'phrase.notAdvice': '{以上仅为信息整理，不构成建议。|个人观点，不构成投资建议。|数据摆在这儿，决定你自己做。}',
  'phrase.hindsight': '{事后看都简单，当时谁不慌。|消息出来之前谁也没料到。}',

  /* ------------------------------------------------- opinion: 资金费率 --- */
  'take.funding.long': '{多头有点拥挤|付费的是多头，杠杆偏多|多单在持续失血}',
  'take.funding.short': '{空头在付费，说明做空不便宜|空单拥挤，轧空的条件在攒|资金偏空，空头每天在交保护费}',
  'take.funding.flat': '{费率回到中性，多空都没占便宜|费率不极端，杠杆情绪还算冷静}',

  /* --------------------------------------------------- opinion: 行情 --- */
  'take.move.up': '{量价配合得还行|这波有量能支撑|不是无量空涨}',
  'take.move.thin': '{但量能没有同步放大，这种拉升的持续性要打个问号|缩量推上去的价格，回起来也通常比较快|涨幅是真的，量能是不足的，两件事得分开说}',
  'take.move.down': '{接不接得住要看量|先别急着抄底|下跌途中接飞刀不划算|这个位置谈支撑还太早|缩量阴跌比放量杀跌更难处理}',
  'take.move.vol': '{成交额才是这轮的关键信号|量在，说明分歧也大|放量比涨幅更难造假|先看量能不能续住|量出来了，接下来看价格认不认}',
  /* ------------------------------------------------------------ opinions ---
   * Convention: `take.*` entries never carry a terminator. Some sites use them
   * mid-sentence, so a stored full stop would double up; every template supplies
   * its own punctuation. `phrase.*` is the opposite family — standalone sentences
   * that do carry it.
   */
  'take.sentiment': '{情绪不等于方向，但情绪决定波动|市场情绪从来不是好消息，也不是坏消息本身}',
  'take.news': '{消息面的一天，先看资金怎么反应|这类消息落地后，价格往往比想象中平淡|信息本身不难读，难的是别被节奏带着走}',
  'take.reg': '{监管的消息从来不是当天定价的|规则变化影响的是后面几个月}',
  'take.inst': '{机构的动作要看连续性，单笔说明不了什么|机构侧的数据总是慢半拍，但方向感比散户强|钱往哪走比话说什么都直接|这类动作值得连着看几天}',
  'take.sec': '{安全事件之后，市场通常会先跌、再分化|出了安全问题，先分清是协议层还是中心化环节|事件本身要看资金流向，公告措辞反而次要|损失金额没定论之前，情绪跑得比事实快}',
  'take.attention': '{讨论度和价格对不上，说明热度还没变成买盘|热度是热度，仓位是仓位，两件事|被讨论得多不等于被买得多|广场热闹的时候，更该看的是量价}',
  'take.campaign': '{活动类公告看两点：门槛和真实收益|羊毛是可以薅的，但要把规则读完|奖励是名义的，成本是自己的}',
  'take.dex': '{链上热门榜的持续性一般不长|榜单是结果，不是买入理由}',
  'take.hot': '{热度高不等于机会大|先看看资金买不买账}',
  'take.leaderboard': '{榜首的持续性通常比涨幅本身更值得看|榜单是结果，不是理由|榜上的名字换得比指数快|能上榜不代表能拿住|涨幅榜从来不是买入清单|排在前面的是波动，不是基本面}',

  /* -------------------------------------------- opinion: 持仓量（OI）---
   * The four shapes are what the detector exists to name, so each needs its own read.
   */
  'take.oi.long': '{价格和持仓一起往上走，这是新多单真金白银开进来的|仓和价同向，说明这波是建仓，不是平仓推出来的}',
  'take.oi.short': '{价格在跌、持仓还在涨，空单是真开出来的，不是止损砸出来的|跌的同时仓越堆越厚，看空的人正在用钱投票}',
  'take.oi.cover': '{价格涨、持仓反而掉，这是空头在平仓还债|涨的是回补，不是新买盘——这两种涨法后面完全不是一回事}',
  'take.oi.stop': '{价格和持仓一起往下，多半是多单在被清出去|仓位在缩，说明这波减仓是认输，不是换手}',
  'take.oi.flat': '{持仓变化不大，说明这波行情里没人新开仓，都是在动已有的仓位}',

  /* --------------------------------------------- opinion: 均线交叉 --- */
  'take.ma': '{均线交叉是滞后指标，它确认的是已经走完的那一段|交叉本身不产生行情，只是把已经发生的事画了出来|这类结构信号慢半拍，但胜在不骗人}',
  'take.etf': '{单日说明不了趋势，连续同方向才要重视|机构资金的动作比散户慢，但更持久}',
  'take.liq': '{连环爆仓往往一段一段来|爆仓单出完，短期压力就卸了}',

  /* ---------------------------------------------------------- CTA --- */
  'cta.question': '{你怎么看？|你站哪边？|评论区说说你的判断。|你上车了还是在等？}',
  'cta.lev': '{做合约的朋友注意费率变化。|杠杆仓位自己算一下成本。}',
  'cta.hot': '{有在跟的朋友冒个泡。|这波热度你参与了吗？}',
  'cta.news': '{先记一笔，看市场怎么消化。|后面怎么走值得盯。}',
  'joke.cta': '{不说了，我去刷新余额了。|我先去冷静一下。|笑完继续搬砖。}',

  /* ------------------------------------------------------ closing --- */
  'closing': '{先写这么多，晚点再更。|以上，持续跟。|先记一下，看后续。}',

  /* ------------------------------------------------ short-form hooks ---
   * Their best-performing post was ~40 chars with a label line and a question.
   * Feed scrolling rewards a headline more than a paragraph.
   */
  'hook.label': '{持仓速报|盘面速报|异动速报|数据一眼|值得注意|刚看到}',
  'cta.short': '{你怎么看？|要不要跟？|你怎么押？|你站哪边？|评论区说说。}',
  'cta.follow': '{点关注，别错过异动。|关注一下，有异动我会发。|关注我，异动不迷路。}',

  /* -------------------------------------------------- disclaimer --- */
  'disclaimer.default': '内容仅供参考，不构成投资建议，DYOR。',
  'disclaimer.soft': '个人观察记录，不构成任何建议。',
  'disclaimer.data': '数据来自公开信息，请自行判断。',
};
