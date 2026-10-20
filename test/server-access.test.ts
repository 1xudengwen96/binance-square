import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerAccessGuard } from '../src/server/access.ts';

for (const remote of [false, true]) {
  test(`request access guard (remote=${remote})`, async t => {
    const app = Fastify();
    registerAccessGuard(app, remote, { username: 'admin', password: 'test-only-password' });
    const credentials = { authorization: 'Basic ' + Buffer.from('admin:test-only-password').toString('base64') };
    app.get('/', async () => ({ ok: true }));
    app.get('/healthz', async () => ({ ok: true }));
    app.post('/', async () => ({ ok: true }));
    t.after(() => app.close());

    const cases = [
      { name: 'local UI', host: 'localhost:8787', origin: 'http://localhost:8787', status: 200 },
      { name: 'IPv6 local UI', host: '[::1]:8787', origin: 'http://[::1]:8787', status: 200 },
      { name: 'public IP UI', host: '203.0.113.8:8787', origin: 'http://203.0.113.8:8787', status: remote ? 200 : 403 },
      { name: 'public domain UI', host: 'panel.example.com:8787', origin: 'http://panel.example.com:8787', status: remote ? 200 : 403 },
      { name: 'cross-site request', host: 'localhost:8787', origin: 'http://evil.example', status: 403 },
      { name: 'different port', host: 'localhost:8787', origin: 'http://localhost:9000', status: remote ? 403 : 200 },
      { name: 'different scheme', host: 'localhost:8787', origin: 'https://localhost:8787', status: remote ? 403 : 200 },
      { name: 'malformed origin', host: 'localhost:8787', origin: 'null', status: 400 },
    ];
    for (const c of cases) {
      await t.test(c.name, async () => {
        const res = await app.inject({ method: 'POST', url: '/', headers: { ...credentials, host: c.host, origin: c.origin, 'x-squareforge': 'ui' } });
        assert.equal(res.statusCode, c.status);
      });
    }
    assert.equal((await app.inject({ method: 'POST', url: '/', headers: { ...credentials, host: 'localhost:8787', origin: 'http://localhost:8787' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/', headers: { ...credentials, host: 'localhost:8787', 'x-squareforge': 'ui' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/', headers: { ...credentials, host: 'panel.example.com:8787' } })).statusCode, 200);
    assert.equal((await app.inject('/healthz')).statusCode, 200);
    {
      for (const method of ['GET', 'POST'] as const) {
        const denied = await app.inject({ method, url: '/', headers: { host: 'panel.example.com:8787', 'x-squareforge': 'ui' } });
        assert.equal(denied.statusCode, method === 'GET' ? 302 : 401);
        assert.equal(denied.headers['www-authenticate'], undefined);
        assert.equal((await app.inject({ method, url: '/api/auth/session', headers: { authorization: 'Basic ' + Buffer.from('admin:wrong-password').toString('base64') } })).statusCode, 401);
      }
    }
  });
}

test('public access refuses to start without a password', async () => {
  const app = Fastify();
  try {
    assert.throws(() => registerAccessGuard(app, true), /PUBLIC_AUTH_PASSWORD/);
  } finally {
    await app.close();
  }
});

function authApp() {
  const app = Fastify();
  registerAccessGuard(app, true, { username: '创作者', password: 'test-only-password' });
  app.get('/', async () => ({ private: true }));
  app.get('/login', async () => 'login page');
  app.get('/login.css', async () => 'css');
  app.get('/login.js', async () => 'js');
  app.get('/favicon.svg', async () => 'icon');
  app.get('/healthz', async () => ({ ok: true }));
  return app;
}
const uiHeaders = { host: 'panel.example.com', origin: 'http://panel.example.com', 'x-squareforge': 'ui' };
const loginBody = { username: '创作者', password: 'test-only-password' };

test('login page assets are public; workspace and API require authentication', async t => {
  const app = authApp();
  t.after(() => app.close());
  for (const url of ['/login', '/login.css?v=1', '/login.js', '/favicon.svg', '/healthz']) {
    assert.equal((await app.inject(url)).statusCode, 200);
  }
  const page = await app.inject({ url: '/', headers: { accept: 'text/html' } });
  assert.equal(page.statusCode, 302);
  assert.equal(page.headers.location, '/login');
  const api = await app.inject('/api/auth/session');
  assert.equal(api.statusCode, 401);
  assert.equal(api.json().loginRequired, true);
  assert.equal(api.headers['www-authenticate'], undefined);
});

test('form login uses a revocable HttpOnly cookie without returning credentials', async t => {
  const app = authApp();
  t.after(() => app.close());
  const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', headers: uiHeaders, payload: { ...loginBody, password: 'wrong' } });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.headers['set-cookie'], undefined);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: uiHeaders, payload: loginBody });
  assert.equal(login.statusCode, 200);
  assert.deepEqual(login.json(), { ok: true });
  const cookie = login.headers['set-cookie'] as string;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /Max-Age|test-only-password/);
  assert.equal(login.headers['cache-control'], 'no-store');
  const headers = { ...uiHeaders, cookie: cookie.split(';')[0] };
  assert.equal((await app.inject({ url: '/', headers })).statusCode, 200);
  const session = await app.inject({ url: '/api/auth/session', headers });
  assert.deepEqual(session.json(), { enabled: true, username: '创作者' });
  assert.equal((await app.inject({ url: '/api/auth/session', headers: { cookie: 'sf_session=forged' } })).statusCode, 401);
  const renewed = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { ...loginBody, remember: true } });
  assert.match(renewed.headers['set-cookie'] as string, /Max-Age=604800/);
  assert.equal((await app.inject({ url: '/api/auth/session', headers })).statusCode, 401);
  const currentHeaders = { ...uiHeaders, cookie: (renewed.headers['set-cookie'] as string).split(';')[0] };
  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: currentHeaders });
  assert.equal(logout.statusCode, 200);
  assert.match(logout.headers['set-cookie'] as string, /Max-Age=0/);
  assert.equal((await app.inject({ url: '/api/auth/session', headers: currentHeaders })).statusCode, 401);
});

test('login and logout retain origin and UI header checks', async t => {
  const app = authApp();
  t.after(() => app.close());
  const post = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: loginBody });
  assert.equal((await post({ ...uiHeaders, origin: 'http://evil.example' })).statusCode, 403);
  assert.equal((await post({ host: uiHeaders.host, origin: uiHeaders.origin })).statusCode, 403);
  assert.equal((await post({ ...uiHeaders, origin: 'null' })).statusCode, 400);
  const login = await post(uiHeaders);
  const cookie = (login.headers['set-cookie'] as string).split(';')[0];
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...uiHeaders, cookie, origin: 'http://evil.example' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/auth/session', headers: { cookie } })).statusCode, 200);
});

test('failed logins are throttled per IP and unlock after the window', async t => {
  const app = authApp();
  t.after(() => app.close());
  const start = Date.now();
  for (let i = 0; i < 8; i++) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers: uiHeaders, payload: { ...loginBody, password: 'wrong' } })).statusCode, 401);
  }
  const blocked = await app.inject({ method: 'POST', url: '/api/auth/login', headers: uiHeaders, payload: loginBody });
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '192.0.2.2', headers: uiHeaders, payload: loginBody })).statusCode, 200);
  t.mock.method(Date, 'now', () => start + 16 * 60_000);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', headers: uiHeaders, payload: loginBody })).statusCode, 200);
});

test('session expiry is enforced and HTTPS sets a Secure cookie', async t => {
  const app = authApp();
  t.after(() => app.close());
  const start = Date.now();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...uiHeaders, 'x-forwarded-proto': 'https' }, payload: loginBody });
  assert.match(login.headers['set-cookie'] as string, /; Secure/);
  const cookie = (login.headers['set-cookie'] as string).split(';')[0];
  t.mock.method(Date, 'now', () => start + 13 * 3600_000);
  assert.equal((await app.inject({ url: '/api/auth/session', headers: { cookie } })).statusCode, 401);
});

test('local mode without a configured password remains usable', async t => {
  const app = Fastify();
  registerAccessGuard(app, false);
  app.get('/', async () => ({ ok: true }));
  t.after(() => app.close());
  assert.equal((await app.inject('/')).statusCode, 200);
  assert.deepEqual((await app.inject('/api/auth/session')).json(), { enabled: false, username: null });
});
