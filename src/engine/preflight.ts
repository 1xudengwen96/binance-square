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
  { pattern: /目标价|目标位|第一目标|看到\d+|上看\d+/, why: '给出了价格目标' },
  { pattern: /(必涨|必跌|稳赚|包赚|无风险|保底收益|躺赚)/, why: '承诺了收益或无风险' },
  { pattern: /(带单|跟单|一起操作|跟我做|私我|加我微信|扫码)/, why: '拉人跟单或引流' },
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
