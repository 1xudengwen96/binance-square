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
    const body = {
      model: cfg.model,
      max_tokens: cfg.maxTokens ?? 1024,
      temperature: cfg.temperature ?? 0.7,
      ...(system ? { system } : {}),
      messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content })),
    };
    const payload = await callJson<unknown>(join(cfg.baseUrl, 'messages'), {
      method: 'POST',
      headers: authHeaders(cfg),
      body: JSON.stringify(body),
    });
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
