import type { Store } from '../db/index.ts';
import type { Settings } from '../config.ts';
import { llmConfigFor } from '../pipeline.ts';
import { chat, type ChatMessage, type LlmConfig } from '../llm/providers.ts';

/**
 * The thinking layer, deliberately thin and deliberately optional.
 *
 * One interface, any provider: whatever model is configured today (an OpenAI-compatible relay,
 * Anthropic, a local endpoint) is reached through `chat()`, and nothing in this repository
 * assumes a specific vendor. The brain is an advisor with a notebook, not a source of truth —
 * it may reword, prioritise and notice; it may not introduce a number, a coin, or a rule that
 * the fact ledger and the compliance gates do not already allow. That is why every call site
 * below treats `null` as a normal, healthy answer.
 */

export type BrainPurpose = 'reflect' | 'sentinel' | 'weekly' | 'test';

export interface BrainTask {
  /** Shown in logs and in the panel, so a human can see what was asked of the model. */
  purpose: BrainPurpose;
  system: string;
  context: string;
  maxTokens?: number;
  /** Judging jobs want a low value; falls back to the configured brain temperature. */
  temperature?: number;
}

export interface Brain {
  provider: string;
  model: string;
  ask(task: BrainTask): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
}

export function brainFor(store: Store, settings: Settings): Brain | null {
  if (!settings.llmEnabled) return null;
  const base: LlmConfig | null = llmConfigFor(store, settings);
  const cfg: LlmConfig | null = base ? { ...base, model: settings.brainModel.trim() || base.model } : null;
  if (!cfg || !cfg.apiKey || !cfg.model) return null;
  return {
    provider: cfg.provider,
    model: cfg.model,
    async ask(task: BrainTask) {
      const messages: ChatMessage[] = [
        { role: 'system', content: task.system },
        { role: 'user', content: task.context },
      ];
      const started = Date.now();
      const inChars = task.system.length + task.context.length;
      // The polish layer shares the endpoint and wants some variety; the brain judges, so it has
      // its own temperature and never inherits the polish one.
      const temperature = task.temperature ?? settings.brainTemperature;
      try {
        const text = (await chat({ ...cfg, maxTokens: task.maxTokens ?? 600, temperature }, messages)).trim();
        recordCall(store, { purpose: task.purpose, cfg, ok: true, ms: Date.now() - started, inChars, reply: text });
        return { ok: true, text };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        recordCall(store, { purpose: task.purpose, cfg, ok: false, ms: Date.now() - started, inChars, error });
        return { ok: false, error };
      }
    },
  };
}

function recordCall(
  store: Store,
  c: { purpose: string; cfg: LlmConfig; ok: boolean; ms: number; inChars: number; reply?: string; error?: string },
): void {
  try {
    store.db
      .prepare('INSERT INTO brain_calls (at, purpose, provider, model, ok, ms, in_chars, out_chars, error, reply) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(Date.now(), c.purpose, c.cfg.provider, c.cfg.model, c.ok ? 1 : 0, c.ms, c.inChars, c.reply?.length ?? 0, c.error?.slice(0, 300) ?? null, c.reply?.slice(0, 4000) ?? null);
  } catch {
    /* the ledger must never be the reason a brain call fails */
  }
}

/** Calls the brain made in the last 24h, for the daily wake cap and the config page. */
export function callsSince(store: Store, since: number, purposes?: BrainPurpose[]): number {
  const where = purposes?.length ? `AND purpose IN (${purposes.map(() => '?').join(',')})` : '';
  return (store.db.prepare(`SELECT COUNT(*) AS n FROM brain_calls WHERE at >= ? ${where}`).get(since, ...(purposes ?? [])) as { n: number }).n;
}

/** The contract the brain is held to. Kept in one place so every task says the same thing. */
export const BRAIN_RULES = [
  '你在为一个自动发布到币安广场的内容系统做判断。',
  '你可以改写、排序、指出矛盾、提出下一步该试什么。',
  '你不得新增任何数字、百分比、价格、币种或时间跨度 —— 所有事实都来自系统的市场数据，超出即被丢弃。',
  '你不得给出买卖建议、目标价、点位或收益承诺；这类句子会被合规闸门直接退回。',
  '样本不足时，正确答案是「还不知道」，不是编一个方向。',
  '输出中文，简短，一条一句。',
].join('\n');
