/**
 * One small client for both OpenAI-shaped and Anthropic-shaped endpoints.
 *
 * "OpenAI compatible" covers OpenRouter, new-api/one-api, LM Studio, Ollama's
 * compat layer and most corporate gateways — they all speak /chat/completions
 * and /models, so they need no separate code path, only a different base URL.
 */

export type ProviderKind = 'openai' | 'anthropic';

export interface LlmConfig {
  provider: ProviderKind;
  /** Include the version segment: https://api.openai.com/v1 or https://api.anthropic.com/v1 */
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ModelInfo {
  id: string;
  name: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const DEFAULT_BASE: Record<ProviderKind, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
};

export const ANTHROPIC_VERSION = '2023-06-01';

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * 中转/模型对 `temperature` 的支持能力缓存（进程内）。撞过一次「non-default temperature」400 的
 * model id 记在这里，后续调用直接省略该字段，避免每次白付一个失败往返。见 chat() anthropic 分支。
 */
const tempUnsupported = new Set<string>();

/** 判据：400 且明确报「不支持非默认 temperature」——只认这一条，别的 400 照常抛出。 */
function isTempRejection(err: unknown): boolean {
  return err instanceof LlmError && err.status === 400 && /non-default temperature/i.test(err.message);
}

function join(base: string, path: string): string {
  const clean = base.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(clean)) throw new LlmError(`baseUrl 必须是 http(s) 地址，收到 "${base}"`);
  return `${clean}/${path.replace(/^\/+/, '')}`;
}

function authHeaders(cfg: LlmConfig): Record<string, string> {
  if (cfg.provider === 'anthropic') {
    return { 'x-api-key': cfg.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' };
  }
  return { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' };
}

/**
 * Fetch and parse in one step. A Response body can only be consumed once, so the
 * error branch reads the text and every caller must not try to parse it again.
 */
async function callJson<T>(url: string, init: RequestInit, timeoutMs = 30_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new LlmError(`请求失败：${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = j.error?.message ?? j.message ?? detail;
    } catch {
      /* keep raw */
    }
    throw new LlmError(`HTTP ${res.status}：${detail}`, res.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LlmError(`HTTP ${res.status} 返回的不是 JSON：${text.slice(0, 200)}`);
  }
}

/** GET /models on both provider shapes; returns [] rather than throwing when unsupported. */
export async function listModels(cfg: LlmConfig): Promise<ModelInfo[]> {
  if (!cfg.apiKey) throw new LlmError('还没有填写 API Key');
  const body = await callJson<{ data?: unknown[]; models?: unknown[] }>(
    join(cfg.baseUrl, 'models'),
    { method: 'GET', headers: authHeaders(cfg) },
    15_000,
  );
  const rows = (body.data ?? body.models ?? []) as Record<string, unknown>[];
  return rows
    .map(r => {
      const id = String(r.id ?? r.name ?? r.model ?? '').trim();
      const name = String(r.display_name ?? r.name ?? r.id ?? '').trim();
      return { id, name: name || id };
    })
    .filter(m => m.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function extractText(cfg: LlmConfig, payload: unknown): string {
  const p = payload as {
    choices?: { message?: { content?: string }; text?: string }[];
    content?: { type?: string; text?: string }[];
  };
  if (cfg.provider === 'anthropic') {
    return (p.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('');
  }
  const choice = p.choices?.[0];
  return choice?.message?.content ?? choice?.text ?? '';
}

export async function chat(cfg: LlmConfig, messages: ChatMessage[]): Promise<string> {
  if (!cfg.apiKey) throw new LlmError('还没有填写 API Key');
  if (!cfg.model) throw new LlmError('还没有选择模型');

  if (cfg.provider === 'anthropic') {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const mkBody = (withTemperature: boolean) => ({
      model: cfg.model,
      max_tokens: cfg.maxTokens ?? 1024,
      ...(withTemperature ? { temperature: cfg.temperature ?? 0.7 } : {}),
      ...(system ? { system } : {}),
      messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content })),
    });
    const post = (body: unknown) =>
      callJson<unknown>(join(cfg.baseUrl, 'messages'), { method: 'POST', headers: authHeaders(cfg), body: JSON.stringify(body) });
    let payload: unknown;
    try {
      payload = await post(mkBody(!tempUnsupported.has(cfg.model)));
    } catch (err) {
      if (tempUnsupported.has(cfg.model) || !isTempRejection(err)) throw err;
      // 中转上存在「任何非默认 temperature 一律 HTTP 400」的模型（判例 2026-10-14：
      // claude-sonnet-5-5 → "does not support non-default temperature"；不发该字段或发 1 都 200）。
      // 裁定（定稿 v1.6）：代码面修，禁改 stored brainTemperature/llmTemperature 去绕 400。
      // 真实 api.anthropic.com 支持温度，故不删字段——撞 400 才去掉重试一次，并按 model 记档，
      // 本进程内后续调用不再白付一次失败往返。代价：该中转上判断任务用模型默认温度（=1）。
      tempUnsupported.add(cfg.model);
      payload = await post(mkBody(false));
    }
    return extractText(cfg, payload);
  }

  const body = {
    model: cfg.model,
    max_tokens: cfg.maxTokens ?? 1024,
    temperature: cfg.temperature ?? 0.7,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  };
  const payload = await callJson<unknown>(join(cfg.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify(body),
  });
  return extractText(cfg, payload);
}

/** Prove the endpoint and key work end to end, not just that /models answers. */
export async function testChat(cfg: LlmConfig): Promise<{ ok: true; reply: string; model: string }> {
  const reply = (await chat(cfg, [{ role: 'user', content: '只回复两个字：收到' }])).trim();
  return { ok: true, reply: reply.slice(0, 60), model: cfg.model };
}
