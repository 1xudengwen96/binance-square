import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listModels, chat, testChat, LlmError, type LlmConfig } from '../src/llm/providers.ts';

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function stub(handler: (s: Seen) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const s: Seen = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(s);
    const { status, body } = handler(s);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { seen, fetchImpl };
}

const openai: LlmConfig = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-test' };
const claude: LlmConfig = { provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', apiKey: 'sk-ant-test' };

test('openai chat posts to /chat/completions with a bearer token', async () => {
  const prev = globalThis.fetch;
  const { seen, fetchImpl } = stub(() => ({ status: 200, body: { choices: [{ message: { content: '收到' } }] } }));
  globalThis.fetch = fetchImpl as unknown as typeof fetch;
  try {
    const out = await chat(openai, [{ role: 'user', content: 'hi' }]);
    assert.equal(out, '收到');
    assert.equal(seen[0]!.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(seen[0]!.headers.authorization, 'Bearer sk-test');
    const body = seen[0]!.body as Record<string, unknown>;
    assert.equal(body.model, 'gpt-4o-mini');
    assert.ok(Array.isArray(body.messages));
  } finally {
    globalThis.fetch = prev;
  }
});

test('anthropic chat posts to /messages with version header and hoisted system', async () => {
  const prev = globalThis.fetch;
  const { seen, fetchImpl } = stub(() => ({ status: 200, body: { content: [{ type: 'text', text: '收到' }] } }));
  globalThis.fetch = fetchImpl as unknown as typeof fetch;
  try {
    const out = await chat(claude, [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }]);
    assert.equal(out, '收到');
    assert.equal(seen[0]!.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(seen[0]!.headers['x-api-key'], 'sk-ant-test');
    assert.equal(seen[0]!.headers['anthropic-version'], '2023-06-01');
    const body = seen[0]!.body as Record<string, unknown>;
    assert.equal(body.system, 'be brief');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
    // max_tokens is mandatory on this API; omitting it is a 400.
    assert.equal(typeof body.max_tokens, 'number');
  } finally {
    globalThis.fetch = prev;
  }
});

test('listModels reads both response shapes', async () => {
  const prev = globalThis.fetch;
  const oa = stub(() => ({ status: 200, body: { data: [{ id: 'gpt-4o' }, { id: 'o3' }] } }));
  const an = stub(() => ({ status: 200, body: { data: [{ id: 'claude-x', display_name: 'Claude X' }] } }));
  globalThis.fetch = oa.fetchImpl as unknown as typeof fetch;
  try {
    assert.deepEqual((await listModels(openai)).map(m => m.id), ['gpt-4o', 'o3']);
  } finally {
    globalThis.fetch = prev;
  }
  globalThis.fetch = an.fetchImpl as unknown as typeof fetch;
  try {
    const m = (await listModels(claude))[0]!;
    assert.equal(m.id, 'claude-x');
    assert.equal(m.name, 'Claude X');
  } finally {
    globalThis.fetch = prev;
  }
});

test('a trailing slash in baseUrl does not produce a double slash', async () => {
  const prev = globalThis.fetch;
  const { seen, fetchImpl } = stub(() => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } }));
  globalThis.fetch = fetchImpl as unknown as typeof fetch;
  try {
    await chat({ ...openai, baseUrl: 'https://gw.internal/v1/' }, [{ role: 'user', content: 'x' }]);
    assert.equal(seen[0]!.url, 'https://gw.internal/v1/chat/completions');
  } finally {
    globalThis.fetch = prev;
  }
});

test('non-http base URLs are refused before any request', async () => {
  await assert.rejects(() => chat({ ...openai, baseUrl: 'file:///etc' }, [{ role: 'user', content: 'x' }]), LlmError);
  await assert.rejects(() => chat({ ...openai, baseUrl: 'javascript:alert(1)' }, [{ role: 'user', content: 'x' }]), /http\(s\)/);
});

test('missing key or model fails loudly instead of sending an anonymous call', async () => {
  await assert.rejects(() => chat({ ...openai, apiKey: '' }, [{ role: 'user', content: 'x' }]), /API Key/);
  await assert.rejects(() => chat({ ...openai, model: '' }, [{ role: 'user', content: 'x' }]), /模型/);
});

test('provider error messages are surfaced, not swallowed', async () => {
  const prev = globalThis.fetch;
  const { fetchImpl } = stub(() => ({ status: 401, body: { error: { message: 'Incorrect API key provided' } } }));
  globalThis.fetch = fetchImpl as unknown as typeof fetch;
  try {
    await assert.rejects(
      () => chat(openai, [{ role: 'user', content: 'x' }]),
      (e: unknown) => e instanceof LlmError && /Incorrect API key/.test(e.message) && e.status === 401,
    );
  } finally {
    globalThis.fetch = prev;
  }
});

test('testChat returns the trimmed reply', async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = stub(() => ({ status: 200, body: { choices: [{ message: { content: ' 收到 ' } }] } })).fetchImpl as unknown as typeof fetch;
  try {
    const r = await testChat(openai);
    assert.equal(r.reply, '收到');
    assert.equal(r.model, 'gpt-4o-mini');
  } finally {
    globalThis.fetch = prev;
  }
});
