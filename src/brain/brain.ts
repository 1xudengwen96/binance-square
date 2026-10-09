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

export interface BrainTask {
  /** Shown in logs and in the panel, so a human can see what was asked of the model. */
  purpose: string;
  system: string;
  context: string;
  maxTokens?: number;
}

export interface Brain {
  provider: string;
  model: string;
  ask(task: BrainTask): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
}

export function brainFor(store: Store, settings: Settings): Brain | null {
  if (!settings.llmEnabled) return null;
  const cfg: LlmConfig | null = llmConfigFor(store, settings);
  if (!cfg || !cfg.apiKey || !cfg.model) return null;
  return {
    provider: cfg.provider,
    model: cfg.model,
    async ask(task: BrainTask) {
      const messages: ChatMessage[] = [
        { role: 'system', content: task.system },
        { role: 'user', content: task.context },
      ];
      try {
        const text = await chat({ ...cfg, maxTokens: task.maxTokens ?? 600 }, messages);
        return { ok: true, text: text.trim() };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
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
