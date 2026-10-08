import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SquareClient, MAX_BODY_CHARS } from '../src/publisher/square.ts';

interface Call {
  url: string;
  init: RequestInit;
}

function stub(handler: (call: Call, n: number) => { status: number; body: unknown }): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const record = { url: String(url), init: init ?? {} };
    calls.push(record);
    const { status, body } = handler(record, calls.length);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const OK = { code: '000000', success: true, data: { id: '374654408911559', shareLink: 'https://www.binance.com/square/post/374654408911559' } };

test('successful publish returns the post id and link', async () => {
  const { calls, fetchImpl } = stub(() => ({ status: 200, body: OK }));
  const c = new SquareClient({ apiKey: 'sk_test', fetchImpl });
  const r = await c.publish('$SOL 拉升 5.2%');
  assert.equal(r.ok, true);
  assert.equal(r.postId, '374654408911559');
  assert.match(r.url ?? '', /binance\.com\/square\/post\//);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/content\/add$/);
});

test('auth uses a single static header and no signing parameters', async () => {
  const { calls, fetchImpl } = stub(() => ({ status: 200, body: OK }));
  await new SquareClient({ apiKey: 'sk_test', fetchImpl }).publish('hi');
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers['X-Square-OpenAPI-Key'], 'sk_test');
  assert.equal(headers.clienttype, 'binanceSkill');
  assert.doesNotMatch(calls[0]!.url, /signature|timestamp|recvWindow/);
});

test('a gateway timeout is reported as uncertain and never retried', async () => {
  const { calls, fetchImpl } = stub(() => ({ status: 504, body: 'gateway timeout' }));
  const c = new SquareClient({ apiKey: 'sk_test', fetchImpl });
  const r = await c.publish('hi');
  assert.equal(r.ok, false);
  assert.equal(r.uncertain, true);
  assert.equal(r.kind, 'uncertain');
  assert.equal(calls.length, 1, 'must not retry a timed-out publish — it would duplicate the post');
  assert.match(r.label ?? '', /切勿自动重试/);
});

test('daily post limit maps to the quota kind', async () => {
  const { fetchImpl } = stub(() => ({ status: 200, body: { code: '220009', message: 'limit' } }));
  const r = await new SquareClient({ apiKey: 'k', fetchImpl }).publish('hi');
  assert.equal(r.kind, 'quota');
  assert.match(r.label ?? '', /每日发帖上限/);
});

test('sensitive-word rejection maps to the content kind', async () => {
  const { fetchImpl } = stub(() => ({ status: 200, body: { code: '20002', message: 'no' } }));
  const r = await new SquareClient({ apiKey: 'k', fetchImpl }).publish('hi');
  assert.equal(r.kind, 'content');
});

test('account restriction is distinguishable so the scheduler can pause', async () => {
  const { fetchImpl } = stub(() => ({ status: 200, body: { code: '30008', message: 'restricted' } }));
  const r = await new SquareClient({ apiKey: 'k', fetchImpl }).publish('hi');
  assert.equal(r.kind, 'account_restricted');
});

test('unknown codes stay unknown rather than pretending to be benign', async () => {
  const { fetchImpl } = stub(() => ({ status: 200, body: { code: '999999', message: '???' } }));
  const r = await new SquareClient({ apiKey: 'k', fetchImpl }).publish('hi');
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'unknown');
  assert.equal(r.code, '999999');
});

test('dry-run performs no network call', async () => {
  const { calls, fetchImpl } = stub(() => ({ status: 200, body: OK }));
  const r = await new SquareClient({ apiKey: 'k', fetchImpl, dryRun: true }).publish('hello');
  assert.equal(r.ok, true);
  assert.equal(calls.length, 0);
});

test('the body carries only the fields Square honours', async () => {
  const { calls, fetchImpl } = stub(() => ({ status: 200, body: OK }));
  await new SquareClient({ apiKey: 'k', fetchImpl }).publish('$BTC 多空比 1.78');
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.contentType, 1);
  assert.equal(body.bodyTextOnly, '$BTC 多空比 1.78');
  // Sent on a live post and silently dropped by Square — do not send it again.
  assert.equal('tradeWidgets' in body, false);
  assert.equal('imageList' in body, false);
});

test('over-long bodies are rejected before hitting the network', async () => {
  const { calls, fetchImpl } = stub(() => ({ status: 200, body: OK }));
  const r = await new SquareClient({ apiKey: 'k', fetchImpl }).publish('字'.repeat(MAX_BODY_CHARS + 1));
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'content');
  assert.equal(calls.length, 0);
});

test('too many images are rejected locally', async () => {
  const { calls, fetchImpl } = stub(() => ({ status: 200, body: OK }));
  const r = await new SquareClient({ apiKey: 'k', fetchImpl }).publish('x', ['a', 'b', 'c', 'd', 'e']);
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});

test('network failure is classified as network, not uncertain', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const r = await new SquareClient({ apiKey: 'k', fetchImpl }).publish('hi');
  assert.equal(r.kind, 'network');
  assert.equal(r.uncertain, undefined);
});
