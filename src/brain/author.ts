import type { Store, MemoryRow } from '../db/index.ts';
import { recallBrief, remember } from './memory.ts';
import { BRAIN_RULES, type Brain } from './brain.ts';
import { revokeStaleRules, scoreAll, type Verdict } from '../rank/score.ts';
import { DIMENSION_NAMES, DIMENSIONS } from '../rank/hypotheses.ts';
import { propose, registry } from '../rank/registry.ts';
import { liveKnobs, proposeChange } from '../rank/params.ts';
import { signalLabel } from '../stats/insight.ts';
import { settingsFrom } from '../schedule.ts';
import { UPGRADE_AREAS, fileFromReply, upgradesForSnapshot } from './upgrades.ts';

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
export async function reflect(store: Store, brain: Brain | null, opts: { days?: number; target?: 'views' | 'engagement' | 'money' } = {}): Promise<{ stored: string[]; notes: string[] }> {
  const settings = settingsFrom(store);
  const verdicts = scoreAll(store, { days: opts.days ?? 30, writeMemory: true, target: opts.target });
  const stored: string[] = [];
  const notes: string[] = [];

  // scoreAll already wrote these into the ledger, with the stratification and replication detail
  // in the sentence. Restating them here used to supersede that entry with a shorter one, so
  // every reflection quietly downgraded the rule it was supposed to be reflecting on.
  for (const v of verdicts.filter(x => x.status === 'rule' || x.status === 'flat')) stored.push(v.id);
  const revoked = revokeStaleRules(store, verdicts);
  if (revoked.length) notes.push(`撤销 ${revoked.length} 条已不被测量支持的规则：${revoked.join('、')}。`);

  const stuck = verdicts.filter(v => v.status === 'observing' && v.mode === 'experiment');
  if (!brain) {
    notes.push('未启用 AI 大脑：只做了确定性归纳（规则已写入长期记忆）。');
    if (stuck.length) notes.push(`${stuck.length} 个实验还在攒样本：${stuck.map(v => v.id).join('、')}。`);
    return { stored, notes };
  }

  const registered = registry(store);
  const evidence = verdicts
    .map(v => `${v.id} [${v.status}] ${v.claim}｜${v.arms.map(a => `${a.arm}=${a.median == null ? '—' : Math.round(a.median)}/${a.n}`).join(' ')}`)
    .join('\n');
  const vocabulary = DIMENSION_NAMES
    .map(d => `${d}（${DIMENSIONS[d].label}，臂 ${DIMENSIONS[d].arms.join('/')}，${DIMENSIONS[d].kind === 'knob' ? '可随机分配' : '只能观察'}）`)
    .join('；');
  const knobs = liveKnobs(settingsFrom(store)).map(k => `${k.key}（${k.label}，现在 ${k.judge} 判定）`).join('；');
  // The measured failure this format is designed against: with a free-form prompt the model spent
  // its daily suggestion restating h_chart, h_hashtag_count and h_opening. Asking for a line in a
  // closed vocabulary makes a restatement impossible to submit — `propose()` rejects it — and
  // makes a real idea actionable, which is the only difference between advising and optimising.
  const r = await brain.ask({
    purpose: 'reflect',
    system: `${BRAIN_RULES}

你的任务：读完后给出最多 3 行，每行只能是下面三种之一。

1) 一条新的、还没有被登记过的比较：
   TEST|维度代号|指标代号|experiment或observed|一句话主张
   可用维度：${vocabulary}
   可用指标：views24h / growth1h / engagementPer1k / qualityPer1k / rebatePer1k
   只有「可随机分配」的维度才允许写 experiment。

2) 一次有界的参数调整建议（最多一行，且必须有理由）：
   PARAM|旋钮代号|目标值|一句话理由
   可调旋钮：${knobs}

3) 一句你注意到但这些格式表达不了的观察，直接写中文，不要加前缀。

4) 一个只有改代码才能解决的问题（缺一个维度、口径对不上、数据没采到、实验结构上测不出结果），登记给操作者：
   UPGRADE|领域代号|一句话标题|证据（只用上面给的数字）
   领域代号：${Object.keys(UPGRADE_AREAS).join(' / ')}。下面「已登记的升级需求」里有的不要换个说法再提。

**已经登记在测的比较见下面，复述它们会被系统拒绝。如果你觉得答案就是"继续攒样本"，那就只输出第 3 类或者什么都不输出。**`,
    context: `最近 30 天各假设的测量结果（median/样本数）：\n${evidence}\n\n已经在测的主张：\n${registered.map(h => `- ${h.id}: ${h.claim}`).join('\n')}\n\n还没结论的实验：${stuck.map(v => `${v.id}(还需 ${v.missing} 条)`).join('、') || '无'}\n\n已登记的升级需求：${upgradesForSnapshot(store).open.map(u => `#${u.id} ${u.title}`).join('；') || '无'}`,
    maxTokens: settings.brainMaxTokensDaily,
  });
  if (!r.ok) {
    notes.push(`大脑反思失败：${r.error.slice(0, 90)}`);
    return { stored, notes };
  }
  const lines = r.text
    .split('\n')
    .map(l => l.replace(/^[-·\d.、\s]+/, '').trim())
    .filter(l => l.length >= 6);

  let proposalsIn = 0;
  let paramsIn = 0;
  let prose = 0;
  let upgradesIn = 0;
  for (const line of lines) {
    if (line.toUpperCase().startsWith('UPGRADE|')) {
      const filed = fileFromReply(store, line, { source: 'reflect' });
      if (filed.length) { upgradesIn++; notes.push(`大脑登记了需要改代码的事：${filed[0]}`); }
      continue;
    }
    if (line.toUpperCase().startsWith('TEST|')) {
      const [, dimension, metric, mode, ...rest] = line.split('|');
      const res = propose(store, {
        claim: rest.join('|').trim(),
        mode: (mode ?? 'observed').trim().toLowerCase(),
        dimension: (dimension ?? '').trim(),
        metric: (metric ?? '').trim(),
        origin: 'brain',
      });
      if (res.ok) {
        proposalsIn++;
        notes.push(res.status === 'active'
          ? `大脑登记的观察假设已上线：${rest.join('|').trim()}`
          : `大脑提议的实验等审批（会占用真实流量）：${rest.join('|').trim()}`);
      } else {
        // Kept in the ledger on purpose: the next reflection reads it, so a rejected idea is not
        // proposed again with the same confidence next week.
        remember(store, {
          kind: 'engine-model', key: `brain:rejected:test:${proposalsIn + prose}`, text: `你提的测试被拒了：${res.reason}`,
          source: 'registry', confidence: 0.4, ttlMinutes: 3 * 24 * 60,
        });
        notes.push(`大脑的测试提议被拒：${res.reason}`);
      }
      continue;
    }
    if (line.toUpperCase().startsWith('PARAM|')) {
      const [, key, to, ...rest] = line.split('|');
      const value = Number((to ?? '').trim());
      const res = Number.isFinite(value)
        ? proposeChange(store, { key: (key ?? '').trim(), to: value, reason: rest.join('|').trim(), origin: 'brain' })
        : ({ ok: false, reason: `目标值「${to}」不是数字` } as const);
      if (res.ok) {
        paramsIn++;
        notes.push(`参数改动已排队，下一轮开始验证（${key} → ${to}）`);
      } else {
        remember(store, {
          kind: 'engine-model', key: `brain:rejected:param:${proposalsIn + prose}`, text: `你提的参数改动被拒了：${res.reason}`,
          source: 'param-loop', confidence: 0.4, ttlMinutes: 3 * 24 * 60,
        });
        notes.push(`参数提议被拒：${res.reason}`);
      }
      continue;
    }
    remember(store, {
      kind: 'engine-model',
      key: `brain:next:${prose}`,
      text: line,
      // A suggestion from the model is the least trusted thing in the ledger until measured.
      confidence: 0.35,
      evidenceN: 0,
      source: 'brain',
      ttlMinutes: 7 * 24 * 60,
    });
    stored.push(`brain:${prose}`);
    prose++;
  }
  if (!proposalsIn && !paramsIn && !prose && !upgradesIn) notes.push('大脑这轮没有给出可用输出（按规则，"还不知道"也是合法答案）。');
  else notes.push(`大脑本轮：${proposalsIn} 条新假设、${paramsIn} 条参数改动、${upgradesIn} 条升级需求、${prose} 条备注。`);
  return { stored, notes };
}

/** What the writer is handed. Kept separate from `brief` so the AI path and the template path see the same thing. */
export function writingNotes(store: Store, ctx: Parameters<typeof brief>[1]): string {
  return brief(store, ctx).text;
}
