import type { Fact } from '../engine/types.ts';
import { auditAgainstFacts } from '../engine/verify.ts';
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
export function polishAcceptable(original: string, out: string, facts: Fact[]): { ok: boolean; reason?: string } {
  const trimmed = out.trim();
  if (!trimmed) return { ok: false, reason: '模型返回空内容' };
  if (trimmed.length < original.length * 0.5) return { ok: false, reason: `改写后过短 (${trimmed.length}/${original.length} 字)` };
  if (trimmed.length > original.length * 1.6) return { ok: false, reason: `改写后过长 (${trimmed.length}/${original.length} 字)` };

  const srcLines = original.split('\n').filter(l => l.trim()).length;
  const outLines = trimmed.split('\n').filter(l => l.trim()).length;
  if (Math.abs(srcLines - outLines) > 1) return { ok: false, reason: `行数从 ${srcLines} 变成 ${outLines}` };

  if (!sameTags(original, trimmed)) return { ok: false, reason: '币种标签被增删' };

  const audit = auditAgainstFacts(trimmed, facts);
  if (!audit.ok) {
    return { ok: false, reason: `新增了没有依据的数字/币种：${[...audit.inventedNumbers, ...audit.inventedSymbols].join(', ')}` };
  }
  return { ok: true };
}

export async function polish(cfg: LlmConfig | null, original: string, facts: Fact[], persona = ''): Promise<PolishResult> {
  if (!cfg || !cfg.apiKey || !cfg.model) return { text: original, changed: false, reason: 'AI 未启用或未配置' };

  // A persona may change tone but never the hard rules, so it is appended as an explicit
  // subordinate line rather than folded into the system prompt where it could dilute them.
  const system = persona.trim() ? `${SYSTEM}\n\n【本账号语气】${persona.trim()}（只影响措辞，不得放宽上面任何一条硬性限制）` : SYSTEM;

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

  const verdict = polishAcceptable(original, cleaned, facts);
  if (!verdict.ok) return { text: original, changed: false, reason: verdict.reason };
  return { text: cleaned, changed: true };
}
