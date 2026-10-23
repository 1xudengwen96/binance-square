import type { Store } from '../db/index.ts';
import type { Settings } from '../config.ts';
import { randomUUID } from 'node:crypto';
import { connectionConfig, connectionView, type BrainConnection } from './connections.ts';
import { chat, LlmError, redact, type ChatMessage, type LlmConfig, type ChatAttempt } from '../llm/providers.ts';

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

export type BrainPurpose = 'reflect' | 'sentinel' | 'weekly' | 'test' | 'review';

export interface BrainTask {
  /** Shown in logs and in the panel, so a human can see what was asked of the model. */
  purpose: BrainPurpose;
  system: string;
  context: string;
  maxTokens?: number;
  /** Judging jobs want a low value; falls back to the configured brain temperature. */
  temperature?: number;
  /** Optional output contract, checked before declaring the logical call successful. */
  validate?: (text: string) => void;
}

export interface Brain {
  provider: string;
  model: string;
  ask(task: BrainTask): Promise<{ ok: true; text: string; connection?: BrainConnection; model?: string; provider?: string } | { ok: false; error: string; retryAt?: number }>;
}

export function brainFor(store: Store, settings: Settings, options: { connection?: BrainConnection; allowFallback?: boolean } = {}): Brain | null {
  if (!settings.llmEnabled) return null;
  const slot = options.connection ?? 'primary';
  const cfg = connectionConfig(store, settings, slot);
  const secondary = connectionConfig(store, settings, 'secondary');
  const useFallback = slot === 'primary' && options.allowFallback !== false && settings.brainFallbackEnabled
    && connectionView(store, settings, 'secondary').ready
    && [cfg.provider, cfg.baseUrl, cfg.model, cfg.apiKey].join('\n') !== [secondary.provider, secondary.baseUrl, secondary.model, secondary.apiKey].join('\n');
  if ((!cfg.apiKey || !cfg.model) && !useFallback) return null;
  return {
    provider: cfg.provider, model: cfg.model,
    async ask(task) {
      const started = Date.now();
      const callKey = randomUUID();
      const deadline = started + (task.purpose === 'weekly' ? 180_000 : 120_000);
      const inChars = task.system.length + task.context.length;
      const messages: ChatMessage[] = [{ role: 'system', content: task.system }, { role: 'user', content: task.context }];
      let count = 0;
      let finalCfg = cfg;
      let finalSlot = slot;
      let lastError: unknown;
      let retryAt: number | undefined;
      const secrets = [cfg.apiKey, secondary.apiKey];
      const record = (ok: boolean, text?: string, error?: string, errorKind?: string) => {
        try {
        store.db.prepare(`INSERT INTO brain_calls
          (at, purpose, provider, model, ok, ms, in_chars, out_chars, error, reply, call_key, connection, attempt_count, error_kind)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(Date.now(), task.purpose, finalCfg.provider, finalCfg.model, ok ? 1 : 0,
          Date.now() - started, inChars, text?.length ?? 0, error?.slice(0, 300) ?? null,
          text ? redact(text, secrets).slice(0, 4000) : null, callKey, finalSlot, count, errorKind ?? null);
        } catch { /* telemetry must not trigger another generation after a usable response */ }
      };
      const candidates: { slot: BrainConnection; cfg: LlmConfig; attempts: number; deadline: number }[] = [
        { slot, cfg, attempts: task.purpose === 'review' ? 1 : 2,
          deadline: useFallback ? deadline - (task.purpose === 'weekly' ? 60_000 : 40_000) : deadline },
        ...(useFallback && task.purpose !== 'test' ? [{ slot: 'secondary' as const, cfg: secondary, attempts: 1, deadline }] : []),
      ];
      for (const candidate of candidates) {
        finalCfg = candidate.cfg;
        finalSlot = candidate.slot;
        let attemptId: number | null = null;
        const reserve = Buffer.byteLength(task.system + task.context, 'utf8') + (task.maxTokens ?? 600);
        try {
          const text = (await chat({ ...candidate.cfg, maxTokens: task.maxTokens ?? 600,
            temperature: task.temperature ?? settings.brainTemperature }, messages, {
            maxAttempts: candidate.attempts, deadline: candidate.deadline,
            beforeAttempt: () => {
              attemptId = store.db.transaction(() => {
                const used = store.db.prepare(`SELECT COUNT(*) AS n,
                  COALESCE(SUM(CASE WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL
                    THEN input_tokens + output_tokens ELSE reserved_tokens END), 0) AS tokens
                  FROM brain_attempts WHERE at >= ?`).get(Date.now() - 86_400_000) as { n: number; tokens: number };
                if (used.n >= settings.brainAttemptCapPerDay || used.tokens + reserve > settings.brainTokenCapPerDay) {
                  throw new LlmError('已达到大脑每日尝试次数或 token 预算，等待额度恢复', undefined, 'budget');
                }
                count++;
                return Number(store.db.prepare(`INSERT INTO brain_attempts
                  (call_key, at, purpose, connection, provider, model, ok, ms, error_kind, reserved_tokens)
                  VALUES (?,?,?,?,?,?,0,0,'in_progress',?)`).run(callKey, Date.now(), task.purpose, candidate.slot,
                    candidate.cfg.provider, candidate.cfg.model, reserve).lastInsertRowid);
              })();
            },
            onAttempt: (a: ChatAttempt) => {
              if (attemptId == null) return;
              store.db.prepare(`UPDATE brain_attempts SET ok=?, ms=?, error_kind=?, error=?, status=?, request_id=?, endpoint=?,
                content_type=?, input_tokens=?, output_tokens=? WHERE id=?`).run(a.ok ? 1 : 0, a.ms, a.errorKind ?? null,
                a.error ? redact(a.error, secrets).slice(0, 300) : null, a.status ?? null,
                a.requestId ? redact(a.requestId, secrets).slice(0, 120) : null, a.endpoint ?? null, a.contentType?.slice(0, 120) ?? null,
                a.inputTokens ?? null, a.outputTokens ?? null, attemptId);
            },
          })).trim();
          try { task.validate?.(text); }
          catch (err) { throw new LlmError(`输出不可用：${err instanceof Error ? err.message : String(err)}`, undefined, 'invalid_response'); }
          record(true, text);
          return { ok: true, text, connection: candidate.slot, model: candidate.cfg.model, provider: candidate.cfg.provider };
        } catch (err) {
          lastError = err;
          if (err instanceof LlmError && err.retryAfterMs != null) retryAt = Math.max(retryAt ?? 0, Date.now() + err.retryAfterMs);
          if (err instanceof LlmError && err.kind === 'budget') break;
        }
      }
      const error = redact(lastError instanceof Error ? lastError.message : String(lastError), secrets);
      record(false, undefined, error, lastError instanceof LlmError ? lastError.kind : 'unknown');
      return { ok: false, error, ...(retryAt ? { retryAt } : {}) };
    },
  };
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
