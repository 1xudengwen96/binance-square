import { auditAgainstFacts } from './verify.ts';
import type { Fact } from './types.ts';
import { wordBank } from '../content/wordbank.ts';

/**
 * The last gate before the bytes go to Binance.
 *
 * Generation checks content once, but three things can happen after that: the AI polish rewrites
 * a sentence, the operator edits the draft in the panel, or a reroll swaps the copy. The audit
 * found four published posts with no disclaimer, and the cause was exactly that class of gap —
 * a check that lived at the wrong end of the pipeline. So this re-checks the final string,
 * against the fact ledger that was stored with the post, at the only moment where nothing can
 * change afterwards.
 *
 * It also *appends* the disclaimer rather than merely requiring it. A guarantee that depends on
 * every future call site remembering to write a line is not a guarantee.
 */

const DISCLAIMER_RE = /不构成[^。\n]{0,10}建议|仅为信息整理|不构成任何建议|仅供参考|DYOR|请自行判断/i;

/**
 * Directive language, independent of any track. The teaching lane keeps a longer list; this is
 * the floor every account must clear, because these are the phrasings that turn a market note
 * into advice and get an account restricted.
 */
const DIRECTIVE: { pattern: RegExp; why: string }[] = [
  { pattern: /建议(大家|各位)?(立即|马上)?(买入|卖出|加仓|减仓|做多|做空|建仓|清仓|上车|抄底)/, why: '给出了买卖指令' },
  // A price level, not merely a digit after a looking-verb. The bare `看到\d+` also caught
  // 「看到2个信号」and「上看3条」— ordinary copy about counts. A gate that cries wolf on clean
  // text gets its verdicts ignored, which is worse than the phrasing it was added to stop.
  // `(?![\d,.])` matters: without it the engine gives digits back one at a time, so 「看到10%」
  // matches on 「看到1」 and the counter-word check never sees the percent sign.
  { pattern: /目标价|目标位|第一目标|(?:看到|上看|下看|看向)\s*\d[\d,.]*(?![\d,.])(?!\s*(?:条|篇|个|次|位|名|天|小时|分钟|秒|倍|%|％|点|档|轮))/, why: '给出了价格目标' },
  { pattern: /(必涨|必跌|稳赚|包赚|无风险|保底收益|躺赚)/, why: '承诺了收益或无风险' },
  { pattern: /(带单|跟单|一起操作|跟我做|私我|加我微信|扫码)/, why: '拉人跟单或引流' },
];

/**
 * Claims that the author holds, held, or acted.
 *
 * The account behind this system does not trade. The platform's creator guidance lists
 * "持仓和晒单不匹配", "秒开秒平" and fake screenshots among the things that damage account
 * weight, and it says plainly that it verifies them — so a sentence like 我刚建了多单 is not
 * flavour text, it is a fabricated trade claim on a channel that checks. Adding interpretation to
 * the copy (the whole point of `content/voice.ts`) makes this gate necessary rather than
 * precautionary: the moment a post is allowed to have a viewpoint, "I'm in this position" starts
 * looking like a valid way to express one.
 *
 * It is a hard block at the publish boundary rather than a prompt instruction because the polish
 * layer and a human editor can both introduce it after generation has passed.
 */
const FABRICATED_POSITION: { pattern: RegExp; why: string }[] = [
  // Proximity, not a verb list: 「我刚建了多单」contains no 建仓, and 「我这个空单赚了」no 持仓.
  // `我(?!们)` keeps 我们 — which the copy uses to mean "readers and I" — from matching as a
  // first-person trading claim.
  { pattern: /(?:本人|本人?自己|我(?!们))[^。！？]{0,14}(建仓|建了|建过|开仓|开了仓|平仓|买入|买进|卖出|做多|做空|加杠杆|上车|抄底|追了|接了|进了|出了|多单|空单|仓位|持仓|单子|头寸)/, why: '声称了作者自己的交易动作或持仓' },
  { pattern: /我的(仓位|多单|空单|持仓|单子|头寸|本金|杠杆)/, why: '声称了作者的持仓' },
  { pattern: /(晒|秀|亮|公开)(一下|个)?(我的|本人的)?(持仓|仓位|收益|战绩|交易记录|交易截图)/, why: '声称在展示真实交易记录' },
  { pattern: /(跟着我|照着我|学着我)(一起)?(做|买|买进入场|操作)|我这个(单|仓)(赚|亏)/, why: '以个人交易结果作号召' },
];

export type PreFlightResult = { ok: true; text: string; note?: string } | { ok: false; reason: string };

export function preFlight(opts: {
  text: string;
  facts: Fact[] | null;
  disclaimerRequired: boolean;
  sensitiveWords: string[];
  maxChars: number;
}): PreFlightResult {
  let text = opts.text;

  if (!text.trim()) return { ok: false, reason: '正文为空' };
  if (text.length > opts.maxChars) return { ok: false, reason: `正文超过 ${opts.maxChars} 字（${text.length}），不做截断发送` };

  const hit = DIRECTIVE.find(d => d.pattern.test(text));
  if (hit) return { ok: false, reason: `${hit.why}，已拦下不发送` };

  const fake = FABRICATED_POSITION.find(d => d.pattern.test(text));
  if (fake) return { ok: false, reason: `${fake.why}，而这个账号不做真实交易，已拦下不发送` };

  const word = opts.sensitiveWords.find(w => w && text.includes(w));
  if (word) return { ok: false, reason: `命中敏感词「${word}」` };

  if (opts.disclaimerRequired && !DISCLAIMER_RE.test(text)) {
    text = `${text}\n${wordBank['disclaimer.default']}`;
  }

  // Re-run the fact ledger on the final string. This is what catches a polish layer that
  // quietly added a number, and it is the one check that cannot be done at generation time
  // because the text it applies to did not exist yet.
  if (opts.facts && opts.facts.length) {
    const audit = auditAgainstFacts(text, opts.facts);
    if (!audit.ok) {
      return {
        ok: false,
        reason: `正文出现台账外的${[...audit.inventedNumbers, ...audit.inventedSymbols].join('、')}（可能被润色或人工改写引入）`,
      };
    }
  }

  const changed = text !== opts.text;
  return { ok: true, text, note: changed ? '发布前补上免责声明' : undefined };
}
