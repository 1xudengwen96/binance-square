import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { Store } from '../src/db/index.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/config.ts';
import { saveSettings, settingsFrom } from '../src/schedule.ts';
import { getSecret, setSecret } from '../src/secrets.ts';
import { chat, LlmError, type LlmConfig } from '../src/llm/providers.ts';
import { brainFor } from '../src/brain/brain.ts';
import { registerBrainRoutes } from '../src/server/brainRoutes.ts';
import { buildSnapshot } from '../src/brain/snapshot.ts';
import { parseReview } from '../src/brain/review.ts';
import { runWeekly } from '../src/brain/weekly.ts';
import { runSentinel } from '../src/brain/sentinel.ts';
import { claimJob, enqueueJob, failJob, hasDueJob, pendingJob } from '../src/brain/jobs.ts';
import { reliability } from '../src/brain/reliability.ts';

const PRIMARY_KEY = 'primary-key-test-only';
const SECONDARY_KEY = 'secondary-key-test-only';
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, llmEnabled: true, llmProvider: 'openai', llmBaseUrl: 'https://primary.example/v1', llmModel: 'main',
  brainSecondaryProvider: 'anthropic', brainSecondaryBaseUrl: 'https://secondary.example/v1', brainSecondaryModel: 'reviewer', brainFallbackEnabled: true };
const TASK = { purpose: 'sentinel' as const, system: 'read facts', context: 'facts', maxTokens: 100 };
const cfg: LlmConfig = { provider: 'openai', baseUrl: 'https://primary.example/v1', model: 'main', apiKey: PRIMARY_KEY };
const WEEKLY = '## 1 关卡状态\n还不知道。\n## 2 假设账本\n还不知道。\n## 3 失败账本\n无。\n## 4 对照重测\n无。\n## 5 本周唯一建议\n证据：样本不足。反例：后续数据。到期日：下周日。\n## 6 自检\n需要继续观察。\nACTION|PARAM|columnPostsPerDay|3|样本不足';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sf-reliability-'));
  const path = join(dir, 'test.db');
  const store = Store.open(path);
  setSecret(store, 'openaiApiKey', PRIMARY_KEY);
  setSecret(store, 'brainSecondaryApiKey', SECONDARY_KEY);
  saveSettings(store, SETTINGS);
  return { store, path, close: () => { if (store.db.open) store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
function reply(text = '收到', anthropic = false) {
  return json(anthropic ? { content: [{ type: 'text', text }], usage: { input_tokens: 12, output_tokens: 4 } }
    : { choices: [{ message: { content: text } }], usage: { prompt_tokens: 12, completion_tokens: 4 } });
}
async function stubFetch(fn: (url: string, init?: RequestInit) => Promise<Response> | Response, run: () => Promise<void>) {
  const prev = globalThis.fetch;
  globalThis.fetch = ((url, init) => Promise.resolve(fn(String(url), init))) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = prev; }
}

test('OpenAI reasoning models use completion token limits without unsupported temperature', async () => {
  await stubFetch((_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_completion_tokens, 1400);
    assert.ok(!('temperature' in body) && !('max_tokens' in body));
    return reply();
  }, async () => { assert.equal(await chat({ ...cfg, model: 'gpt-5-test', maxTokens: 1400 }, [{ role: 'user', content: 'test' }]), '收到'); });
});

test('OpenAI gateways can request completion token parameter within the shared two-attempt cap', async () => {
  let requests = 0;
  await stubFetch((_url, init) => {
    const body = JSON.parse(String(init?.body)); requests++;
    if (requests === 1) return json({ error: { message: 'max_tokens unsupported; use max_completion_tokens' } }, 400);
    assert.equal(body.max_completion_tokens, 1024);
    assert.ok(!('max_tokens' in body));
    return reply();
  }, async () => { await chat({ ...cfg, model: 'custom-token-test' }, [{ role: 'user', content: 'test' }]); });
  assert.equal(requests, 2);
});

test('invalid review contracts count as final failure even after HTTP success', async () => {
  const { store, close } = fixture();
  try {
    await stubFetch(() => reply('invalid review', true), async () => {
      const result = await brainFor(store, SETTINGS, { connection: 'secondary', allowFallback: false })!.ask({
        ...TASK, purpose: 'review', validate: text => { parseReview(text, buildSnapshot(store, SETTINGS)); },
      });
      assert.equal(result.ok, false);
    });
    const call = store.db.prepare('SELECT ok, error_kind, attempt_count FROM brain_calls').get() as any;
    assert.deepEqual(call, { ok: 0, error_kind: 'invalid_response', attempt_count: 1 });
  } finally { close(); }
});

test('delayed retries preserve a Retry-After longer than the ordinary queue delay', async () => {
  const { store, close } = fixture();
  try {
    const now = Date.now();
    await stubFetch(() => json({ error: { message: 'rate limit' } }, 429, { 'retry-after': '1800' }), async () => {
      const result = await brainFor(store, { ...SETTINGS, brainFallbackEnabled: false })!.ask(TASK);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.ok(result.retryAt! >= now + 1800_000);
      const queued = enqueueJob(store, 'sentinel', {}, { now });
      claimJob(store, queued.id, now);
      failJob(store, queued.id, result.error, now, result.retryAt);
      assert.equal(claimJob(store, queued.id, now + 5 * 60_000), null);
      assert.equal(pendingJob(store, 'sentinel')!.next_at, result.retryAt);
    });
  } finally { close(); }
});

test('existing databases migrate without changing historical calls, reports or secrets', () => {
  const { store, path, close } = fixture(); let reopened: Store | undefined;
  try {
    store.db.prepare("INSERT INTO brain_calls (at,purpose,provider,model,ok,ms,in_chars,out_chars) VALUES (1,'test','openai','old',1,10,1,1)").run();
    store.db.prepare("INSERT INTO brain_reports (kind,created_at,title,body) VALUES ('weekly',1,'old title','old report')").run();
    for (const col of ['call_key', 'connection', 'attempt_count', 'error_kind']) store.db.exec(`ALTER TABLE brain_calls DROP COLUMN ${col}`);
    store.db.exec('ALTER TABLE brain_reports DROP COLUMN review_json');
    store.db.exec('DROP TABLE brain_jobs; DROP TABLE brain_attempts');
    store.close(); reopened = Store.open(path);
    assert.equal(getSecret(reopened, 'openaiApiKey'), PRIMARY_KEY);
    assert.equal((reopened.db.prepare('SELECT model, attempt_count FROM brain_calls').get() as any).model, 'old');
    assert.equal((reopened.db.prepare('SELECT model, attempt_count FROM brain_calls').get() as any).attempt_count, null);
    assert.equal((reopened.db.prepare('SELECT body,review_json FROM brain_reports').get() as any).body, 'old report');
    assert.equal(reliability(reopened).jobs.length, 0);
  } finally { reopened?.close(); close(); }
});

test('primary and secondary configure atomically and never return either plaintext key', async () => {
  const { store, close } = fixture(); const app = Fastify(); registerBrainRoutes(app, store);
  try {
    const payload = { brainSecondaryProvider: 'openai', brainSecondaryBaseUrl: 'https://other.example/v1/', brainSecondaryModel: 'other', secondaryApiKey: 'another-secondary-key', brainReviewEnabled: true };
    const saved = await app.inject({ method: 'POST', url: '/api/brain/config', payload });
    assert.equal(saved.statusCode, 200);
    assert.equal(settingsFrom(store).llmBaseUrl, SETTINGS.llmBaseUrl);
    assert.equal(getSecret(store, 'openaiApiKey'), PRIMARY_KEY);
    assert.equal(getSecret(store, 'brainSecondaryApiKey'), payload.secondaryApiKey);
    const bad = await app.inject({ method: 'POST', url: '/api/brain/config', payload: { brainSecondaryBaseUrl: 'https://bad.example/v1/messages', secondaryApiKey: 'must-not-save' } });
    assert.equal(bad.statusCode, 400);
    assert.equal(getSecret(store, 'brainSecondaryApiKey'), payload.secondaryApiKey);
    const view = await app.inject({ method: 'GET', url: '/api/brain' });
    assert.equal(view.statusCode, 200);
    assert.ok(!view.body.includes(PRIMARY_KEY) && !view.body.includes(payload.secondaryApiKey));
    assert.equal(view.json().connections.primary.endpoint, 'https://primary.example/v1/chat/completions');
    assert.equal(view.json().connections.secondary.endpoint, 'https://other.example/v1/chat/completions');
    await app.inject({ method: 'POST', url: '/api/brain/key', payload: { connection: 'secondary', value: '' } });
    assert.equal(getSecret(store, 'brainSecondaryApiKey'), '');
    assert.equal(getSecret(store, 'openaiApiKey'), PRIMARY_KEY);
  } finally { await app.close(); close(); }
});

test('each model list and connection test uses its own protocol, URL and key without fallback', async () => {
  const { store, close } = fixture(); const app = Fastify(); registerBrainRoutes(app, store);
  const seen: { url: string; headers: Record<string, string> }[] = [];
  try {
    await stubFetch((url, init) => {
      seen.push({ url, headers: init?.headers as Record<string, string> });
      return url.endsWith('/models') ? json({ data: [{ id: url.includes('secondary') ? 'reviewer' : 'main' }] }) : reply('收到', url.includes('secondary'));
    }, async () => {
      for (const connection of ['primary', 'secondary']) {
        assert.equal((await app.inject({ method: 'POST', url: '/api/brain/models', payload: { connection } })).statusCode, 200);
        const result = await app.inject({ method: 'POST', url: '/api/brain/test', payload: { connection } });
        assert.equal(result.statusCode, 200, result.body);
        assert.equal(result.json().connection, connection);
      }
    });
    assert.equal(seen[0]!.headers.authorization, 'Bearer ' + PRIMARY_KEY);
    assert.equal(seen[2]!.headers['x-api-key'], SECONDARY_KEY);
    assert.ok(seen[3]!.url.endsWith('/v1/messages'));
    assert.equal(seen.length, 4);
    await stubFetch(() => json({ error: { message: 'bad key' } }, 401), async () => {
      const result = await app.inject({ method: 'POST', url: '/api/brain/test', payload: { connection: 'primary' } });
      assert.equal(result.statusCode, 502);
      const c = store.db.prepare('SELECT connection, attempt_count FROM brain_calls ORDER BY id DESC LIMIT 1').get() as any;
      assert.equal(c.connection, 'primary'); assert.equal(c.attempt_count, 1);
    });
  } finally { await app.close(); close(); }
});

test('HTML response is classified as a route problem, never blindly retried', async () => {
  let n = 0;
  await stubFetch(() => { n++; return new Response('<!doctype html><html><head>portal</head></html>', { headers: { 'content-type': 'text/html', 'x-request-id': 'test-id' } }); }, async () => {
    await assert.rejects(() => chat(cfg, [{ role: 'user', content: 'test' }]), (e: unknown) => e instanceof LlmError && e.kind === 'html' && e.meta.requestId === 'test-id' && /Base URL/.test(e.message));
  });
  assert.equal(n, 1);
});

test('redirects and unsafe or terminal base URLs fail without forwarding credentials', async () => {
  let n = 0;
  await stubFetch((_url, init) => { n++; assert.equal(init?.redirect, 'manual'); return new Response('', { status: 302, headers: { location: 'https://wrong.example/' } }); }, async () => {
    await assert.rejects(() => chat(cfg, [{ role: 'user', content: 'x' }]), /重定向/);
    for (const baseUrl of ['https://user:pass@x.example/v1', 'https://x.example/v1?key=foo', 'https://x.example/v1/messages']) {
      await assert.rejects(() => chat({ ...cfg, baseUrl }, [{ role: 'user', content: 'x' }]), LlmError);
    }
  });
  assert.equal(n, 1);
});

test('Retry-After exceeding the deadline defers instead of retrying early, while quota is not retried', async () => {
  let n = 0;
  await stubFetch(() => { n++; return json({ error: { message: 'slow down', code: 'slow_down' } }, 429, { 'retry-after': '60' }); }, async () => {
    await assert.rejects(() => chat(cfg, [{ role: 'user', content: 'x' }], { deadline: Date.now() + 5000 }), (e: unknown) => e instanceof LlmError && e.kind === 'rate_limit' && e.retryAfterMs === 60000);
  });
  assert.equal(n, 1);
  n = 0;
  await stubFetch(() => { n++; return json({ error: { message: 'credits exhausted', code: 'credit_balance_exhausted' } }, 429); }, async () => {
    await assert.rejects(() => chat(cfg, [{ role: 'user', content: 'x' }]), (e: unknown) => e instanceof LlmError && e.kind === 'quota');
  });
  assert.equal(n, 1);
});

test('parameter correction and transport recovery share a two-attempt limit', async () => {
  let n = 0;
  await stubFetch(() => { n++; return n === 1 ? json({ error: { message: 'does not support non-default temperature' } }, 400) : json({ error: { message: 'temporarily unavailable' } }, 503); }, async () => {
    await assert.rejects(() => chat({ ...cfg, model: 'bounded-temperature' }, [{ role: 'user', content: 'x' }]), (e: unknown) => e instanceof LlmError && e.status === 503);
  });
  assert.equal(n, 2);
});

test('primary retries twice then secondary runs once, recording usage and recovery without exposing keys', async () => {
  const { store, close } = fixture(); const seen: string[] = [];
  try {
    await stubFetch((url, init) => {
      seen.push(url);
      if (url.includes('primary')) return json({ error: { message: `upstream down ${PRIMARY_KEY}` } }, 503);
      assert.equal((init?.headers as any)['x-api-key'], SECONDARY_KEY);
      return reply('诊断已完成', true);
    }, async () => {
      const r = await brainFor(store, SETTINGS)!.ask(TASK);
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.connection, 'secondary');
    });
    assert.equal(seen.length, 3);
    const attempts = store.db.prepare('SELECT * FROM brain_attempts ORDER BY id').all() as any[];
    assert.deepEqual(attempts.map(a => a.connection), ['primary', 'primary', 'secondary']);
    assert.equal(attempts[2].input_tokens, 12);
    assert.ok(!JSON.stringify(attempts).includes(PRIMARY_KEY));
    const calls = store.db.prepare('SELECT * FROM brain_calls').all() as any[];
    assert.equal(calls.length, 1); assert.equal(calls[0].attempt_count, 3); assert.equal(calls[0].ok, 1);
    assert.equal((reliability(store).windows[0] as any).fallbackSuccess, 1);
  } finally { close(); }
});

test('daily attempt and token budgets cannot be bypassed by a retry or secondary fallback', async () => {
  const { store, close } = fixture(); let n = 0;
  try {
    await stubFetch(() => { n++; return json({ error: { message: 'temporary' } }, 503); }, async () => {
      const r = await brainFor(store, { ...SETTINGS, brainAttemptCapPerDay: 1 })!.ask(TASK);
      assert.equal(r.ok, false);
      assert.equal(n, 1);
      const r2 = await brainFor(store, { ...SETTINGS, brainTokenCapPerDay: 1 })!.ask(TASK);
      assert.equal(r2.ok, false);
      assert.equal(n, 1);
    });
    const final = store.db.prepare('SELECT error_kind FROM brain_calls ORDER BY id DESC LIMIT 1').get() as any;
    assert.equal(final.error_kind, 'budget');
  } finally { close(); }
});

test('empty generation output is a recorded unusable result, not a success', async () => {
  const { store, close } = fixture();
  try {
    await stubFetch(() => reply(''), async () => {
      const r = await brainFor(store, { ...SETTINGS, brainFallbackEnabled: false })!.ask(TASK);
      assert.equal(r.ok, false);
    });
    const attempt = store.db.prepare('SELECT ok,error_kind FROM brain_attempts').get() as any;
    assert.equal(attempt.ok, 0); assert.equal(attempt.error_kind, 'invalid_response');
  } finally { close(); }
});

test('jobs persist across restart, have exclusive leases and stop after three rounds', () => {
  const { store, path, close } = fixture(); let reopened: Store | undefined;
  try {
    const now = Date.now();
    const queued = enqueueJob(store, 'reflect', {}, { now });
    const first = claimJob(store, queued.id, now)!;
    assert.equal(first.runs, 1); assert.equal(claimJob(store, queued.id, now), null);
    failJob(store, queued.id, 'temporary', now);
    store.close(); reopened = Store.open(path);
    assert.equal(hasDueJob(reopened, 'reflect', now + 60_000), false);
    assert.equal(hasDueJob(reopened, 'reflect', now + 5 * 60_000), true);
    claimJob(reopened, queued.id, now + 5 * 60_000); failJob(reopened, queued.id, 'again', now + 5 * 60_000);
    claimJob(reopened, queued.id, now + 20 * 60_000); failJob(reopened, queued.id, 'final', now + 20 * 60_000);
    assert.equal(pendingJob(reopened, 'reflect', now + 21 * 60_000), null);
    assert.equal((reopened.db.prepare('SELECT status FROM brain_jobs').get() as any).status, 'failed');
  } finally { reopened?.close(); close(); }
});

test('failed sentinel analysis retries despite alert deduplication and does not create duplicate reports', async () => {
  const { store, close } = fixture(); let n = 0;
  const settings = { ...SETTINGS, brainFallbackEnabled: false, brainWakeCapPerDay: 1 };
  const now = Date.now();
  store.setSetting('breaker', { since: now - 9 * 86400000, trippedAt: now - 86400000 });
  try {
    await stubFetch(() => { n++; return n === 1 ? json({ error: { message: 'bad key' } }, 401) : reply('继续观察，等待数据。'); }, async () => {
      const first = await runSentinel(store, settings, now);
      assert.equal(first.woke, false); assert.equal(first.raised.length, 1);
      await runSentinel(store, settings, now + 60_000); assert.equal(n, 1);
      const retry = await runSentinel(store, settings, now + 6 * 60_000);
      assert.equal(retry.raised.length, 0); assert.equal(retry.woke, true);
      await runSentinel(store, settings, now + 7 * 60_000); assert.equal(n, 2);
    });
    assert.equal((store.db.prepare('SELECT COUNT(*) n FROM brain_reports').get() as any).n, 1);
    assert.equal((store.db.prepare('SELECT COUNT(*) n FROM brain_alarms').get() as any).n, 1);
  } finally { close(); }
});

test('review citations must match the snapshot including null, rejecting invented values and paths', () => {
  const { store, close } = fixture();
  try {
    const snap = buildSnapshot(store, SETTINGS);
    assert.equal(parseReview(JSON.stringify({ verdict: 'supported', reason: '样本不足，继续观察', evidence: [{ path: 'account.w7.medianViews', value: null }] }), snap).verdict, 'supported');
    for (const [path, value] of [['account.w7.medianViews', 0], ['account.w7.nonexistent', 0], ['__proto__.polluted', true]]) {
      assert.throws(() => parseReview(JSON.stringify({ verdict: 'supported', reason: 'wrong', evidence: [{ path, value }] }), snap));
    }
  } finally { close(); }
});

test('weekly independent review saves disagreement and withholds actions; repeated clicks are idempotent', async () => {
  const { store, close } = fixture(); let n = 0;
  const settings = { ...SETTINGS, brainReviewEnabled: true };
  try {
    await stubFetch(url => { n++; return url.includes('primary') ? reply(WEEKLY) : reply(JSON.stringify({ verdict: 'opposed', reason: '不能将未知当成零', evidence: [{ path: 'account.w7.medianViews', value: null }] }), true); }, async () => {
      const r = await runWeekly(store, settings, Date.now(), true);
      assert.equal(r.ok, true, r.note);
      const again = await runWeekly(store, settings, Date.now(), true);
      assert.equal(again.reportId, r.reportId); assert.equal(n, 2);
    });
    const report = store.db.prepare('SELECT actions_json,review_json,body FROM brain_reports').get() as any;
    assert.deepEqual(JSON.parse(report.actions_json), []);
    assert.equal(JSON.parse(report.review_json).verdict, 'opposed');
    assert.match(report.body, /独立审查/);
  } finally { close(); }
});

test('supported weekly review only holds a recommendation for later approval', async () => {
  const { store, close } = fixture();
  try {
    await stubFetch(url => url.includes('primary') ? reply(WEEKLY) : reply(JSON.stringify({ verdict: 'supported', reason: '继续观察，先由人工核对', evidence: [{ path: 'account.w7.posts', value: 0 }] }), true), async () => {
      assert.equal((await runWeekly(store, { ...SETTINGS, brainReviewEnabled: true }, Date.now(), true)).ok, true);
    });
    const report = store.db.prepare('SELECT actions_json,status,review_json FROM brain_reports').get() as any;
    assert.equal(JSON.parse(report.actions_json).length, 1);
    assert.equal(report.status, 'pending');
    assert.equal(JSON.parse(report.review_json).verdict, 'supported');
    assert.equal((store.db.prepare('SELECT COUNT(*) n FROM param_changes').get() as any).n, 0);
  } finally { close(); }
});

test('weekly review failure preserves the report; a failed primary draft never gets self-reviewed by the fallback', async () => {
  const { store, close } = fixture(); let n = 0;
  try {
    await stubFetch(url => { n++; return url.includes('primary') ? json({ error: { message: 'bad credentials' } }, 401) : reply(WEEKLY, true); }, async () => {
      const r = await runWeekly(store, { ...SETTINGS, brainReviewEnabled: true }, Date.now(), true);
      assert.equal(r.ok, true);
      assert.equal(n, 2, 'one fallback draft, no same-connection review');
    });
    const report = store.db.prepare('SELECT review_json,actions_json FROM brain_reports').get() as any;
    assert.equal(JSON.parse(report.review_json).verdict, 'unavailable');
    assert.deepEqual(JSON.parse(report.actions_json), []);
  } finally { close(); }
});
