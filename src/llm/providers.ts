/** Small HTTP client shared by OpenAI-compatible and Anthropic-compatible connections. */
export type ProviderKind = 'openai' | 'anthropic';
export interface LlmConfig {
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens?: number;
  temperature?: number;
}
export interface ModelInfo { id: string; name: string }
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export const DEFAULT_BASE: Record<ProviderKind, string> = {
  openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1',
};
export const ANTHROPIC_VERSION = '2023-06-01';
export type ErrorKind = 'configuration' | 'auth' | 'quota' | 'rate_limit' | 'upstream' | 'network' | 'timeout' | 'html' | 'invalid_response' | 'budget';
export interface ResponseMeta { endpoint?: string; contentType?: string; requestId?: string; status?: number }
export class LlmError extends Error {
  constructor(message: string, readonly status?: number, readonly kind: ErrorKind = 'configuration',
    readonly retryAfterMs?: number, readonly meta: ResponseMeta = {}, readonly code?: string) { super(message); }
}
export interface ChatAttempt extends ResponseMeta {
  ok: boolean; ms: number; errorKind?: ErrorKind; error?: string;
  inputTokens?: number; outputTokens?: number;
}
export interface ChatOptions {
  maxAttempts?: number;
  deadline?: number;
  beforeAttempt?: () => void;
  onAttempt?: (attempt: ChatAttempt) => void;
}

/** No credentials, query tokens or terminal API paths in a stored base URL. */
export function validateBaseUrl(base: string): string {
  let url: URL;
  try { url = new URL(base.trim()); } catch { throw new LlmError('Base URL 必须是 http(s) 地址'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new LlmError('Base URL 必须是 http(s) 地址，不能包含账号、密码、查询参数或片段');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (/\/(?:messages|chat\/completions|models|responses)$/i.test(path)) {
    throw new LlmError('Base URL 请填写 API 根地址（例如 /v1），不要包含 /messages、/chat/completions 或 /models');
  }
  return `${url.origin}${path}`;
}
export const completionPath = (provider: ProviderKind): string => provider === 'anthropic' ? 'messages' : 'chat/completions';
export function endpointFor(cfg: Pick<LlmConfig, 'baseUrl' | 'provider'>): string {
  return `${validateBaseUrl(cfg.baseUrl)}/${completionPath(cfg.provider)}`;
}
export function redact(text: string, secrets: string[] = []): string {
  let safe = text;
  for (const secret of secrets) if (secret) safe = safe.split(secret).join('[redacted]');
  return safe.replace(/sk-[a-zA-Z0-9_-]+/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/[^\s<>"']+/g, value => {
      try { const u = new URL(value); return u.origin + u.pathname; } catch { return '[url]'; }
    });
}
function headers(cfg: LlmConfig): Record<string, string> {
  return cfg.provider === 'anthropic'
    ? { 'x-api-key': cfg.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' }
    : { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' };
}
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
function errorKind(status: number, code: string, message: string): ErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (/quota|credit|balance|billing|spend_limit|usage_limit|余额|额度不足/i.test(code + ' ' + message)) return 'quota';
  if (status === 429) return 'rate_limit';
  if ([408, 409, 500, 502, 503, 504, 529].includes(status)) return 'upstream';
  return 'configuration';
}
export function isRecoverable(err: unknown): boolean {
  return err instanceof LlmError && ['rate_limit', 'upstream', 'network'].includes(err.kind);
}
export function chatTimeoutMs(maxTokens: number | undefined): number {
  return 30_000 + Math.min(4096, Math.max(0, maxTokens ?? 1024)) * 40;
}
async function requestJson(cfg: LlmConfig, url: string, init: RequestInit, timeoutMs: number): Promise<{ payload: any; meta: ResponseMeta }> {
  let meta: ResponseMeta = { endpoint: url };
  const signal = AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));
  try {
    // A redirect must never forward a configured credential to another route or host.
    const res = await fetch(url, { ...init, redirect: 'manual', signal });
    meta = { endpoint: url, status: res.status, contentType: res.headers?.get('content-type') ?? undefined,
      requestId: res.headers?.get('x-request-id') ?? res.headers?.get('request-id') ?? undefined };
    const text = await res.text();
    let payload: any;
    try { payload = JSON.parse(text); } catch { /* classified below */ }
    if (res.status >= 300 && res.status < 400) throw new LlmError('接口发生重定向，请检查 Base URL；未跟随跳转', res.status, 'configuration', undefined, meta);
    if (!res.ok) {
      const detail = redact(String(payload?.error?.message ?? payload?.message ?? (/<(?:!doctype|html)/i.test(text) ? '网关返回 HTML 错误页' : text.slice(0, 300))), [cfg.apiKey]);
      const code = String(payload?.error?.code ?? payload?.error?.type ?? '');
      throw new LlmError(`HTTP ${res.status}：${detail}`, res.status, errorKind(res.status, code, detail), retryAfter(res.headers?.get('retry-after') ?? null), meta, code);
    }
    if (payload === undefined) {
      const html = /<(?:!doctype|html|head|body)/i.test(text) || /text\/html/i.test(meta.contentType ?? '');
      throw new LlmError(html ? '接口返回网页而非模型 JSON，请检查 Base URL、接口协议或中转路由' : `HTTP ${res.status} 返回的不是 JSON`,
        res.status, html ? 'html' : 'invalid_response', undefined, meta);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new LlmError('模型返回无效 JSON 对象', res.status, 'invalid_response', undefined, meta);
    return { payload, meta };
  } catch (err) {
    if (err instanceof LlmError) throw err;
    const timeout = signal.aborted || (err instanceof Error && /timeout|abort/i.test(err.name));
    throw new LlmError(timeout ? '请求超时：模型未在时限内完成' : `请求失败：${redact(err instanceof Error ? err.message : String(err), [cfg.apiKey])}`,
      undefined, timeout ? 'timeout' : 'network', undefined, meta);
  }
}
function extractText(cfg: LlmConfig, p: any): string {
  if (cfg.provider === 'anthropic') return Array.isArray(p.content) ? p.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('') : '';
  return p.choices?.[0]?.message?.content ?? p.choices?.[0]?.text ?? '';
}
const tempUnsupported = new Set<string>();
const completionTokensRequired = new Set<string>();
export async function chat(cfg: LlmConfig, messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
  if (!cfg.apiKey) throw new LlmError('还没有填写 API Key');
  if (!cfg.model) throw new LlmError('还没有选择模型');
  const url = endpointFor(cfg);
  const key = `${cfg.provider}:${cfg.baseUrl}:${cfg.model}`;
  const reasoningModel = cfg.provider === 'openai' && /^(?:o\d|gpt-[5-9])/i.test(cfg.model);
  const maxAttempts = Math.min(2, Math.max(1, options.maxAttempts ?? 2));
  const deadline = options.deadline ?? Date.now() + chatTimeoutMs(cfg.maxTokens) * 2 + 5000;
  const emit = (attempt: ChatAttempt) => { try { options.onAttempt?.(attempt); } catch { /* a logging failure must not resend a completion */ } };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new LlmError('任务总时限已到，等待下一次补跑', undefined, 'timeout');
    options.beforeAttempt?.();
    const started = Date.now();
    const withTemperature = !reasoningModel && !tempUnsupported.has(key);
    const completionTokens = reasoningModel || completionTokensRequired.has(key);
    const body = cfg.provider === 'anthropic' ? {
      model: cfg.model, max_tokens: cfg.maxTokens ?? 1024,
      ...(withTemperature ? { temperature: cfg.temperature ?? 0.7 } : {}),
      system: messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n'),
      messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content })),
    } : {
      model: cfg.model, ...(completionTokens ? { max_completion_tokens: cfg.maxTokens ?? 1024 } : { max_tokens: cfg.maxTokens ?? 1024 }),
      ...(withTemperature ? { temperature: cfg.temperature ?? 0.7 } : {}), messages,
    };
    let meta: ResponseMeta = { endpoint: url };
    try {
      const res = await requestJson(cfg, url, { method: 'POST', headers: headers(cfg), body: JSON.stringify(body) }, Math.min(chatTimeoutMs(cfg.maxTokens), remaining));
      meta = res.meta;
      const text = extractText(cfg, res.payload);
      if (typeof text !== 'string' || !text.trim()) throw new LlmError('模型返回空文本或不支持的输出结构', meta.status, 'invalid_response', undefined, meta);
      const usage = res.payload.usage;
      const tokens = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
      emit({ ...meta, ok: true, ms: Date.now() - started,
        inputTokens: tokens(usage?.input_tokens ?? usage?.prompt_tokens), outputTokens: tokens(usage?.output_tokens ?? usage?.completion_tokens) });
      return text;
    } catch (err) {
      const e = err instanceof LlmError ? err : new LlmError(redact(String(err), [cfg.apiKey]), undefined, 'invalid_response', undefined, meta);
      emit({ ...e.meta, ok: false, ms: Date.now() - started, errorKind: e.kind, error: redact(e.message, [cfg.apiKey]) });
      const temp = e.status === 400 && /temperature/i.test(e.message) && /non-default|unsupported|not support|only.*default/i.test(e.message) && withTemperature;
      const tokenParam = cfg.provider === 'openai' && e.status === 400 && /max_tokens/i.test(e.message)
        && /max_completion_tokens/i.test(e.message) && !completionTokens;
      if (temp) tempUnsupported.add(key);
      if (tokenParam) completionTokensRequired.add(key);
      if (attempt + 1 >= maxAttempts || (!temp && !tokenParam && !isRecoverable(e))) throw e;
      const delay = temp || tokenParam ? 0 : Math.max(e.retryAfterMs ?? 0, 1500 * 2 ** attempt) + Math.floor(Math.random() * 250);
      if (Date.now() + delay + 1000 >= deadline) throw e;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new LlmError('已达到重试上限');
}
export async function listModels(cfg: LlmConfig): Promise<ModelInfo[]> {
  if (!cfg.apiKey) throw new LlmError('还没有填写 API Key');
  const { payload } = await requestJson(cfg, `${validateBaseUrl(cfg.baseUrl)}/models`, { method: 'GET', headers: headers(cfg) }, 15_000);
  const rows = payload.data ?? payload.models ?? [];
  if (!Array.isArray(rows)) throw new LlmError('模型列表结构无效', undefined, 'invalid_response');
  return rows.map((r: any) => ({ id: String(r?.id ?? r?.name ?? r?.model ?? '').trim(), name: String(r?.display_name ?? r?.name ?? r?.id ?? '').trim() }))
    .filter((m: ModelInfo) => m.id).sort((a: ModelInfo, b: ModelInfo) => a.id.localeCompare(b.id));
}
export async function testChat(cfg: LlmConfig): Promise<{ ok: true; reply: string; model: string }> {
  const reply = (await chat(cfg, [{ role: 'user', content: '只回复两个字：收到' }])).trim();
  return { ok: true, reply: reply.slice(0, 60), model: cfg.model };
}
