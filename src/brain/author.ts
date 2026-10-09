import type { Store, MemoryRow } from '../db/index.ts';
import { recallBrief, remember } from './memory.ts';
import { BRAIN_RULES, type Brain } from './brain.ts';
import { scoreAll, type Verdict } from '../rank/score.ts';
import { signalLabel } from '../stats/insight.ts';

/**
 * The part that behaves like a person who writes regularly: before drafting, it re-reads what it
 * knows about this subject and this audience; after publishing, it notices what happened and
 * writes it down where the next draft will find it.
 *
 * Nothing here is required. With no brain configured, `brief` still assembles from the memory
 * ledger and `reflect` still distils rules deterministically from the measured verdicts — the
 * model adds judgement about what is worth saying next, not the ability to remember.
 */

export interface AuthorBrief {
  memory: MemoryRow[];
  text: string;
  verdicts: Verdict[];
}

export function brief(
  store: Store,
  ctx: { category?: string | null; subType?: string | null; symbol?: string | null; style?: string | null; verdicts?: Verdict[] | null },
): AuthorBrief {
  const about = [signalLabel(ctx.category ?? null, ctx.subType ?? null), ctx.symbol, ctx.style].filter(Boolean).join(' ');
  // Callers that already scored this pass hand the verdicts in. Scoring is a 30-day table scan
  // across every hypothesis, and the writer runs once per post — recomputing it there means a
  // batch of eight drafts does the same scan nine times to reach the same answer.
  const verdicts = ctx.verdicts ?? scoreAll(store, { writeMemory: false });
  const { text, rows } = recallBrief(store, { about, limit: 6, max: 5 });
  return { memory: rows, text, verdicts };
}

/**
 * Turn measurement into memory.
 *
 * The default path is deterministic: a rule that earned its confidence is already a sentence, so
 * it needs no model to restate it. When a brain is configured it gets the same evidence and is
 * asked for the one thing a template cannot do — what to try next, given that these arms are
 * still indistinguishable. Its answer is stored as a hypothesis to test, never as a fact.
 */
export async function reflect(store: Store, brain: Brain | null, opts: { days?: number } = {}): Promise<{ stored: string[]; notes: string[] }> {
  const verdicts = scoreAll(store, { days: opts.days ?? 30, writeMemory: true });
  const stored: string[] = [];
  const notes: string[] = [];

  // scoreAll already wrote these into the ledger, with the stratification and replication detail
  // in the sentence. Restating them here used to supersede that entry with a shorter one, so
  // every reflection quietly downgraded the rule it was supposed to be reflecting on.
  for (const v of verdicts.filter(x => x.status === 'rule' || x.status === 'flat')) stored.push(v.id);

  const stuck = verdicts.filter(v => v.status === 'observing' && v.mode === 'experiment');
  if (!brain) {
    notes.push('未启用 AI 大脑：只做了确定性归纳（规则已写入长期记忆）。');
    if (stuck.length) notes.push(`${stuck.length} 个实验还在攒样本：${stuck.map(v => v.id).join('、')}。`);
    return { stored, notes };
  }

  const evidence = verdicts
    .map(v => `${v.id} [${v.status}] ${v.claim}｜${v.arms.map(a => `${a.arm}=${a.median == null ? '—' : Math.round(a.median)}/${a.n}`).join(' ')}`)
    .join('\n');
  const r = await brain.ask({
    purpose: 'reflect',
    system: `${BRAIN_RULES}\n\n你的任务：读完后给出 1–3 条「下一步该试什么」，每条一句话，必须可被现有指标验证。不要复述数据，不要给投资判断。`,
    context: `最近 30 天各假设的测量结果（median/样本数）：\n${evidence}\n\n还没结论的实验：${stuck.map(v => `${v.id}(还需 ${v.missing} 条)`).join('、') || '无'}`,
    maxTokens: 500,
  });
  if (!r.ok) {
    notes.push(`大脑反思失败：${r.error.slice(0, 90)}`);
    return { stored, notes };
  }
  const lines = r.text
    .split('\n')
    .map(l => l.replace(/^[-·\d.、\s]+/, '').trim())
    .filter(l => l.length >= 8);
  for (const [i, line] of lines.slice(0, 3).entries()) {
    remember(store, {
      kind: 'engine-model',
      key: `brain:next:${i}`,
      text: line,
      // A suggestion from the model is the least trusted thing in the ledger until measured.
      confidence: 0.35,
      evidenceN: 0,
      source: 'brain',
      ttlMinutes: 7 * 24 * 60,
    });
    stored.push(`brain:${i}`);
  }
  notes.push(`大脑给出 ${lines.slice(0, 3).length} 条下一步建议，已作为待验证假设写入记忆（不是事实）。`);
  return { stored, notes };
}

/** What the writer is handed. Kept separate from `brief` so the AI path and the template path see the same thing. */
export function writingNotes(store: Store, ctx: Parameters<typeof brief>[1]): string {
  return brief(store, ctx).text;
}
