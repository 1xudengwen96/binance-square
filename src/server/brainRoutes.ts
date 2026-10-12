import type { FastifyInstance } from 'fastify';
import type { Store } from '../db/index.ts';
import { DEFAULT_SETTINGS, type Settings } from '../config.ts';
import { saveSettings, settingsFrom } from '../schedule.ts';
import { DEFAULT_BASE, listModels, type LlmConfig, type ProviderKind } from '../llm/providers.ts';
import { getSecret, mask, secretViews, setSecret, type SecretName } from '../secrets.ts';
import { brainFor, callsSince, type BrainTask } from '../brain/brain.ts';
import { buildSnapshot } from '../brain/snapshot.ts';
import { runSentinel } from '../brain/sentinel.ts';
import { approveReport, dismissReport, runWeekly } from '../brain/weekly.ts';
import { SENTINEL_SYSTEM, WEEKLY_SYSTEM, BRAIN_RULES } from '../brain/prompts.ts';
import { effectiveTarget, evaluateBreaker, gateReport, resetBreaker, GATE_LINES, BREAKER } from '../rank/gates.ts';
import { BUILTIN_VARIANTS, isSafeVariant, seedVariants } from '../content/columns.ts';
import { boardComposition } from '../stats/benchmarks.ts';
import { tally } from '../calls.ts';

/**
 * Everything the 「AI 大脑」 page talks to.
 *
 * Three rules shared by every route here:
 *  - a key is accepted and stored, never returned (the response carries only a masked hint);
 *  - a setting is validated and clamped on the server, because the page is not a trust boundary;
 *  - nothing here can move a gate line or call a model without leaving a row in `brain_calls`.
 */

const BRAIN_KEYS = [
  'llmEnabled', 'llmPolish', 'llmProvider', 'llmBaseUrl', 'llmModel', 'llmMaxTokens', 'llmTemperature',
  'brainModel', 'brainDaily', 'brainSentinel', 'brainWeekly',
  'brainMaxTokensDaily', 'brainMaxTokensSentinel', 'brainMaxTokensWeekly', 'brainTemperature', 'brainWakeCapPerDay',
  'breakerEnabled', 'targetMode', 'columnMode', 'columnPostsPerDay', 'activeExperiments', 'alertWebhook',
] as const;
type BrainKey = (typeof BRAIN_KEYS)[number];

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** The only place a posted body becomes settings. Unknown keys are dropped, known ones clamped. */
export function sanitizeBrainSettings(body: Record<string, unknown>, cur: Settings): { next: Settings; changed: BrainKey[]; errors: string[] } {
  const next: Settings = { ...cur };
  const errors: string[] = [];
  const changed: BrainKey[] = [];
  const set = <K extends BrainKey>(k: K, v: Settings[K]): void => {
    if (JSON.stringify(next[k]) !== JSON.stringify(v)) { (next as unknown as Record<string, unknown>)[k] = v; changed.push(k); }
  };
  for (const k of BRAIN_KEYS) {
    if (!(k in body)) continue;
    const v = body[k];
    switch (k) {
      case 'llmProvider':
        if (v === 'openai' || v === 'anthropic') set(k, v); else errors.push('接口类型只能是 openai 或 anthropic');
        break;
      case 'llmBaseUrl': {
        const u = String(v ?? '').trim().replace(/\/+$/, '');
        if (!/^https?:\/\/[^\s]+$/i.test(u)) { errors.push('Base URL 必须是 http(s) 地址'); break; }
        set(k, u);
        break;
      }
      case 'llmModel': case 'brainModel': set(k, String(v ?? '').trim().slice(0, 120)); break;
      case 'alertWebhook': {
        const u = String(v ?? '').trim();
        if (u && !/^https:\/\/[^\s]+$/i.test(u)) { errors.push('报警 Webhook 必须是 https 地址（留空表示不推送）'); break; }
        set(k, u.slice(0, 500));
        break;
      }
      case 'llmMaxTokens': set(k, Math.round(clamp(v, 64, 8000, cur.llmMaxTokens))); break;
      case 'llmTemperature': set(k, clamp(v, 0, 2, cur.llmTemperature)); break;
      case 'brainTemperature': set(k, clamp(v, 0, 1, cur.brainTemperature)); break;
      case 'brainMaxTokensDaily': set(k, Math.round(clamp(v, 200, 4000, cur.brainMaxTokensDaily))); break;
      case 'brainMaxTokensSentinel': set(k, Math.round(clamp(v, 200, 4000, cur.brainMaxTokensSentinel))); break;
      case 'brainMaxTokensWeekly': set(k, Math.round(clamp(v, 500, 8000, cur.brainMaxTokensWeekly))); break;
      case 'brainWakeCapPerDay': set(k, Math.round(clamp(v, 0, 10, cur.brainWakeCapPerDay))); break;
      case 'columnPostsPerDay': set(k, Math.round(clamp(v, 1, 6, cur.columnPostsPerDay))); break;
      case 'targetMode':
        if (v === 'auto' || v === 'manual') set(k, v); else errors.push('目标模式只能是 auto 或 manual');
        break;
      case 'activeExperiments': {
        if (v === null) { set(k, null); break; }
        if (!Array.isArray(v)) { errors.push('activeExperiments 必须是列表'); break; }
        set(k, v.map(String).filter(x => /^[a-z0-9_:]{2,40}$/i.test(x)).slice(0, 12));
        break;
      }
      default: set(k as 'llmEnabled', bool(v, next[k as 'llmEnabled'] as boolean) as never);
    }
  }
  return { next, changed, errors };
}

function cfgFor(s: Settings, store: Store, o: { provider?: ProviderKind; baseUrl?: string; model?: string; apiKey?: string } = {}): LlmConfig {
  const provider = (o.provider ?? s.llmProvider) as ProviderKind;
  const keyName: SecretName = provider === 'anthropic' ? 'anthropicApiKey' : 'openaiApiKey';
  return {
    provider,
    baseUrl: o.baseUrl ?? s.llmBaseUrl ?? DEFAULT_BASE[provider],
    model: o.model ?? s.llmModel,
    apiKey: o.apiKey ?? getSecret(store, keyName),
    maxTokens: s.llmMaxTokens,
    temperature: s.llmTemperature,
  };
}

export function registerBrainRoutes(app: FastifyInstance, store: Store): void {
  seedVariants(store);

  /** One round trip for the whole page. */
  app.get('/api/brain', (_req, reply) => {
    const s = settingsFrom(store);
    const keys = secretViews(store);
    const provider = s.llmProvider;
    const keyView = keys.find(k => k.name === (provider === 'anthropic' ? 'anthropicApiKey' : 'openaiApiKey'));
    const gates = gateReport(store);
    const day = 86_400_000;
    const calls = store.db.prepare('SELECT id, at, purpose, provider, model, ok, ms, in_chars, out_chars, error FROM brain_calls ORDER BY id DESC LIMIT 25').all();
    const tokens = store.db
      .prepare("SELECT purpose, COUNT(*) AS n, SUM(in_chars) AS inChars, SUM(out_chars) AS outChars, SUM(ok = 0) AS failed FROM brain_calls WHERE at >= ? GROUP BY purpose")
      .all(Date.now() - 7 * day);
    reply.send({
      settings: Object.fromEntries(BRAIN_KEYS.map(k => [k, s[k]])),
      defaults: Object.fromEntries(BRAIN_KEYS.map(k => [k, (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k]])),
      key: { provider, set: Boolean(keyView?.set), masked: keyView?.masked ?? '', fromEnv: Boolean(keyView?.fromEnv) },
      ready: Boolean(brainFor(store, s)),
      readyWhy: brainReadiness(store, s),
      gates,
      gateLines: GATE_LINES,
      breaker: { ...evaluateBreaker(store, s), line: BREAKER },
      target: effectiveTarget(s, gates),
      calls,
      usage7d: tokens,
      wakesToday: callsSince(store, Date.now() - day, ['sentinel']),
      reports: store.db.prepare('SELECT id, kind, created_at, title, status, resolved_at FROM brain_reports ORDER BY id DESC LIMIT 20').all(),
      alarms: store.db.prepare('SELECT id, at, code, detail, woke, report_id FROM brain_alarms ORDER BY id DESC LIMIT 20').all(),
      variants: store.db.prepare('SELECT id, kind, slot, text, status, origin, off_reason FROM column_variants ORDER BY kind, slot, id').all(),
      calls_ledger: { tally: tally(store), recent: store.db.prepare('SELECT id, symbol, payer, rate_at, rate_after, outcome, status, check_at, judged_at FROM column_calls ORDER BY id DESC LIMIT 15').all() },
      benchmark: { composition: boardComposition(store), byLang: store.boardCountByLang() },
      notes: store.getSetting<string>('brainNotes', ''),
      prompts: { rules: BRAIN_RULES, weekly: WEEKLY_SYSTEM, sentinel: SENTINEL_SYSTEM },
    });
  });

  /** Save connection + brain settings. Validated and clamped here. */
  app.post('/api/brain/config', (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cur = settingsFrom(store);
    const { next, changed, errors } = sanitizeBrainSettings(body, cur);
    if (errors.length) return reply.code(400).send({ error: errors.join('；') });
    if (changed.length) {
      saveSettings(store, next);
      store.log('brain_config', { changed });
    }
    reply.send({ ok: true, changed });
  });

  /** Store a key without echoing it; the response carries the mask only. */
  app.post('/api/brain/key', (req, reply) => {
    const b = (req.body ?? {}) as { provider?: ProviderKind; value?: string };
    const provider: ProviderKind = b.provider === 'anthropic' ? 'anthropic' : 'openai';
    const name: SecretName = provider === 'anthropic' ? 'anthropicApiKey' : 'openaiApiKey';
    const value = String(b.value ?? '').trim();
    setSecret(store, name, value);
    store.log('brain_key', { provider, cleared: !value });
    reply.send({ ok: true, set: Boolean(value), masked: mask(value) });
  });

  app.post('/api/brain/models', async (req, reply) => {
    const b = (req.body ?? {}) as { provider?: ProviderKind; baseUrl?: string; apiKey?: string };
    const s = settingsFrom(store);
    try {
      const models = await listModels(cfgFor(s, store, { provider: b.provider, baseUrl: b.baseUrl?.trim() || undefined, apiKey: b.apiKey?.trim() || undefined }));
      reply.send({ models, count: models.length });
    } catch (err) {
      reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** A real round trip through the brain path, so the ledger and the temperature are exercised. */
  app.post('/api/brain/test', async (_req, reply) => {
    const s = settingsFrom(store);
    const brain = brainFor(store, s);
    if (!brain) return reply.code(400).send({ error: brainReadiness(store, s) ?? '大脑没有配置好' });
    const task: BrainTask = { purpose: 'test', system: '你在做连通性测试。', context: '只回复两个字：收到', maxTokens: 40 };
    const started = Date.now();
    const r = await brain.ask(task);
    if (!r.ok) return reply.code(502).send({ error: r.error });
    reply.send({ ok: true, reply: r.text.slice(0, 80), model: brain.model, provider: brain.provider, ms: Date.now() - started });
  });

  app.get('/api/brain/snapshot', (_req, reply) => reply.send(buildSnapshot(store, settingsFrom(store))));

  app.post('/api/brain/weekly', async (_req, reply) => {
    const r = await runWeekly(store, settingsFrom(store), Date.now(), true);
    reply.code(r.ok ? 200 : 400).send(r);
  });

  app.post('/api/brain/sentinel', async (_req, reply) => reply.send(await runSentinel(store, settingsFrom(store))));

  app.get('/api/brain/reports/:id', (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = store.db.prepare('SELECT * FROM brain_reports WHERE id = ?').get(id);
    if (!row) return reply.code(404).send({ error: '找不到这份报告' });
    reply.send(row);
  });

  app.post('/api/brain/reports/:id/approve', (req, reply) => {
    const r = approveReport(store, Number((req.params as { id: string }).id));
    reply.code(r.ok ? 200 : 400).send(r);
  });

  app.post('/api/brain/reports/:id/dismiss', (req, reply) => {
    const ok = dismissReport(store, Number((req.params as { id: string }).id));
    reply.code(ok ? 200 : 400).send({ ok });
  });

  app.post('/api/brain/notes', (req, reply) => {
    const text = String(((req.body ?? {}) as { text?: string }).text ?? '').slice(0, 1000);
    store.setSetting('brainNotes', text);
    reply.send({ ok: true });
  });

  /** Operator-only. The brain cannot reach this: no brain output is ever routed here. */
  app.post('/api/brain/breaker/reset', (_req, reply) => reply.send({ ok: true, ...resetBreaker(store) }));

  app.post('/api/brain/variants', (req, reply) => {
    const b = (req.body ?? {}) as { kind?: string; slot?: string; text?: string };
    if (!['question', 'anomaly', 'recap'].includes(b.kind ?? '')) return reply.code(400).send({ error: '栏目只能是 question / anomaly / recap' });
    if (!['ask', 'watch', 'close'].includes(b.slot ?? '')) return reply.code(400).send({ error: '位置只能是 ask / watch / close' });
    const safe = isSafeVariant(String(b.text ?? ''));
    if (!safe.ok) return reply.code(400).send({ error: safe.why });
    const r = store.db.prepare("INSERT OR IGNORE INTO column_variants (kind, slot, text, status, origin, created_at) VALUES (?,?,?,'active','operator',?)").run(b.kind, b.slot, String(b.text).trim(), Date.now());
    reply.send({ ok: r.changes > 0 });
  });

  app.post('/api/brain/variants/:id/toggle', (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = store.db.prepare('SELECT status FROM column_variants WHERE id = ?').get(id) as { status: string } | undefined;
    if (!row) return reply.code(404).send({ error: '没有这个变体' });
    const next = row.status === 'active' ? 'off' : 'active';
    store.db.prepare('UPDATE column_variants SET status = ?, off_reason = ?, off_at = ? WHERE id = ?').run(next, next === 'off' ? '操作者手动下线' : null, next === 'off' ? Date.now() : null, id);
    reply.send({ ok: true, status: next });
  });

  void BUILTIN_VARIANTS;
}

/** Why the brain is not usable right now, in the operator's words; null when it is. */
export function brainReadiness(store: Store, s: Settings): string | null {
  if (!s.llmEnabled) return '连接没有启用（勾选「启用连接」）';
  const keyName = s.llmProvider === 'anthropic' ? 'anthropicApiKey' : 'openaiApiKey';
  if (!getSecret(store, keyName)) return '还没有保存 Key';
  if (!(s.brainModel.trim() || s.llmModel.trim())) return '还没有选模型（点「拉取模型」）';
  return null;
}
