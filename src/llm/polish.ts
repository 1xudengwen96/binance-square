import type { Fact } from '../engine/types.ts';
import { auditAgainstFacts } from '../engine/verify.ts';
import { claimsPosition } from '../engine/preflight.ts';
import { chat, type LlmConfig } from './providers.ts';

/**
 * The AI layer is a rewriter, never an author.
 *
 * It receives copy whose numbers already exist and may only change wording. Every
 * result is re-checked against the fact ledger the renderer produced, so a model
 * that invents a price, a percentage or a second ticker is discarded and the
 * template output is posted instead. That gate is the whole reason this is safe to
 * run unattended.
 */

const SYSTEM = `你是中文加密货币内容编辑。你的任务是**改写措辞**，不是创作。

硬性规则，违反任何一条即视为失败：
1. 原文中出现的所有数字、百分比、价格、金额必须原样保留，不得新增、删除、改写、四舍五入或换算单位。
2. 所有 $币种 和 #话题 标签必须原样保留，不得增删。
3. 不得新增任何原文没有的事实、数据、时间、机构名、判断或建议。
4. 保持原有的行数和分段结构（每行对应一行），可以在行内调整语序和用词。
5. 保留结尾的免责声明句，不要删除也不要改写其含义。
6. 口语化但不夸张，不用"必涨""稳赚""错过没有"这类词。
7. 只输出改写后的正文，不要解释、不要加引号、不要加前后缀。`;

/**
 * The column's rewriter. The strict prompt above keeps the line structure, and with it the
 * template's skeleton — which is exactly the part that reads as a machine. Here the model may
 * reorder, merge and split sentences and speak as someone watching the market; the numbers,
 * the coins and the no-position rule are held by the same checks either way.
 */
const VOICE_SYSTEM = `你在帮一个盯盘的人把币安广场的短帖改得像真人随手写的，而不是机器播报。

硬性规则，违反任何一条即视为失败：
1. 所有数字、百分比原样保留：不新增、不删除、不改写、不四舍五入。
2. 所有 $币种 和 #话题 标签原样保留，不增删。
3. 不新增原文没有的事实、数据、时间、机构名。
4. 不给买卖建议、点位、目标价、收益承诺。
5. 可以用「我」说观察（我注意到、我更在意、我会盯着），但绝不能写自己买了、卖了、开了多单空单、有仓位——这个账号不做真实交易。
6. 不用「必涨」「稳赚」「家人们」「冲」「错过没有」这类词，不堆 emoji。

可以做的：调整语序，合并或拆开句子，换掉生硬的连接词，用更口语的说法。篇幅和原文差不多，分成 2–4 行。
只输出改写后的正文，不要解释、不要加引号。`;

export type PolishMode = 'strict' | 'voice';

export interface PolishResult {
  text: string;
  changed: boolean;
  reason?: string;
}

const CASHTAG_RE = /\$[A-Za-z][A-Za-z0-9]{0,11}/g;

function tagSet(text: string): Set<string> {
  return new Set((text.match(CASHTAG_RE) ?? []).map(s => s.toUpperCase()));
}

export function sameTags(a: string, b: string): boolean {
  const A = tagSet(a);
  const B = tagSet(b);
  if (A.size !== B.size) return false;
  for (const t of A) if (!B.has(t)) return false;
  return true;
}

/** Reject anything that drifted from the template output in a way we cannot verify. */
export function polishAcceptable(original: string, out: string, facts: Fact[], mode: PolishMode = 'strict'): { ok: boolean; reason?: string } {
  const trimmed = out.trim();
  if (!trimmed) return { ok: false, reason: '模型返回空内容' };
  if (trimmed.length < original.length * 0.5) return { ok: false, reason: `改写后过短 (${trimmed.length}/${original.length} 字)` };
  if (trimmed.length > original.length * 1.6) return { ok: false, reason: `改写后过长 (${trimmed.length}/${original.length} 字)` };

  const srcLines = original.split('\n').filter(l => l.trim()).length;
  const outLines = trimmed.split('\n').filter(l => l.trim()).length;
  // Voice mode is allowed to re-break the lines; it is the fixed line skeleton it is there to undo.
  if (mode === 'strict' && Math.abs(srcLines - outLines) > 1) return { ok: false, reason: `行数从 ${srcLines} 变成 ${outLines}` };
  if (mode === 'voice' && outLines > srcLines + 2) return { ok: false, reason: `行数从 ${srcLines} 变成 ${outLines}` };

  if (!sameTags(original, trimmed)) return { ok: false, reason: '币种标签被增删' };

  const audit = auditAgainstFacts(trimmed, facts);
  if (!audit.ok) {
    return { ok: false, reason: `新增了没有依据的数字/币种：${[...audit.inventedNumbers, ...audit.inventedSymbols].join(', ')}` };
  }

  // A rewrite that speaks in the first person must not slide into a trade claim. The publish gate
  // would refuse it anyway; refusing it here keeps the template text instead of losing the post.
  const position = claimsPosition(trimmed);
  if (position && !claimsPosition(original)) return { ok: false, reason: `改写引入了不允许的表述：${position}` };
  return { ok: true };
}

export async function polish(
  cfg: LlmConfig | null, original: string, facts: Fact[], persona = '', notes = '', mode: PolishMode = 'strict',
): Promise<PolishResult> {
  if (!cfg || !cfg.apiKey || !cfg.model) return { text: original, changed: false, reason: 'AI 未启用或未配置' };

  // A persona may change tone but never the hard rules, so it is appended as an explicit
  // subordinate line rather than folded into the system prompt where it could dilute them.
  // The account's standing lessons are subordinate for the same reason: they may change which
  // phrasing survives, never what may be claimed.
  const extra = [
    persona.trim() ? `【本账号语气】${persona.trim()}` : '',
    notes.trim() ? `【本账号从数据里学到的（只影响取舍与措辞，不得放宽上面任何一条硬性限制）】\n${notes.trim()}` : '',
  ].filter(Boolean).join('\n\n');
  const base = mode === 'voice' ? VOICE_SYSTEM : SYSTEM;
  const system = extra ? `${base}\n\n${extra}（这些补充只影响措辞，不得放宽任何一条硬性限制）` : base;

  let raw: string;
  try {
    raw = await chat(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: original },
    ]);
  } catch (err) {
    return { text: original, changed: false, reason: `调用失败：${err instanceof Error ? err.message.slice(0, 120) : String(err)}` };
  }

  // Strip a code fence or quoted wrapper models sometimes add despite instructions.
  const cleaned = raw
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/^["“]|["”]$/g, '')
    .trim();

  const verdict = polishAcceptable(original, cleaned, facts, mode);
  if (!verdict.ok) return { text: original, changed: false, reason: verdict.reason };
  return { text: cleaned, changed: true };
}
