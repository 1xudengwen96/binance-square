import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const COOKIE = 'sf_session';
const LOGIN_WINDOW = 15 * 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest();
const cookieToken = (cookie = '') => cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';

/** Public access is opt-in; mutations still require the UI header and a matching origin. */
export function registerAccessGuard(app: FastifyInstance, allowRemoteAccess = false, auth?: { username: string; password: string }): void {
  const enabled = allowRemoteAccess || Boolean(auth?.password);
  const sessions = new Map<string, number>();
  const failures = new Map<string, { count: number; until: number }>();
  const expected = hash(JSON.stringify([auth?.username, auth?.password]));
  const sessionKey = (cookie?: string) => hash(cookieToken(cookie)).toString('hex');
  const sessionValid = (cookie?: string) => (sessions.get(sessionKey(cookie)) ?? 0) > Date.now();
  if (enabled) {
    if (!auth?.username || !auth.password) throw new Error('公网访问需要设置 PUBLIC_AUTH_USERNAME 和 PUBLIC_AUTH_PASSWORD');
    app.addHook('onRequest', (req, reply, done) => {
      reply.header('cache-control', 'no-store');
      const path = req.url.split('?')[0] ?? '/';
      if (['GET', 'HEAD'].includes(req.method) && ['/healthz', '/login', '/login.css', '/login.js', '/favicon.svg'].includes(path)) return done();
      if (req.method === 'POST' && path === '/api/auth/login') return done();
      if (sessionValid(req.headers.cookie)) return done();
      // Keep explicit Basic headers usable for scripts, without a browser password popup.
      const header = req.headers.authorization ?? '';
      const supplied = header.startsWith('Basic ')
        ? Buffer.from(header.slice(6), 'base64').toString('utf8')
        : '';
      const colon = supplied.indexOf(':');
      const actual = hash(JSON.stringify([supplied.slice(0, colon), supplied.slice(colon + 1)]));
      if (!header.startsWith('Basic ') || colon < 0 || !timingSafeEqual(actual, expected)) {
        if (['GET', 'HEAD'].includes(req.method) && !path.startsWith('/api/') && (path === '/' || req.headers.accept?.includes('text/html'))) {
          return reply.redirect('/login');
        }
        return reply.code(401).send({ error: '请先登录', loginRequired: true });
      }
      done();
    });
  }

  app.addHook('preHandler', (req, reply, done) => {
    if (req.method === 'GET' || req.method === 'HEAD') return done();

    let target: URL;
    try {
      if (!req.headers.host) throw new Error('missing host');
      target = new URL(`${req.protocol}://${req.headers.host}`);
    } catch {
      return reply.code(400).send({ error: 'bad host' });
    }
    if (!allowRemoteAccess && !LOOPBACK.has(target.hostname)) {
      return reply.code(403).send({ error: '只允许从本机访问' });
    }

    const origin = req.headers.origin;
    if (origin) {
      let source: URL;
      try {
        source = new URL(origin);
      } catch {
        return reply.code(400).send({ error: 'bad origin' });
      }
      const allowed = allowRemoteAccess
        ? source.origin === target.origin
        : LOOPBACK.has(source.hostname) && ['http:', 'https:'].includes(source.protocol);
      if (!allowed) return reply.code(403).send({ error: '跨站请求被拒绝' });
    }

    if (req.headers['x-squareforge'] !== 'ui') {
      return reply.code(403).send({ error: '缺少 X-Squareforge: ui 请求头' });
    }
    done();
  });

  app.get('/api/auth/session', (req, reply) => reply.header('cache-control', 'no-store').send({
    enabled, username: enabled ? auth!.username : null,
  }));

  app.post('/api/auth/login', { bodyLimit: 4096 }, (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!enabled) return reply.send({ ok: true });
    const now = Date.now();
    // Keep failed login attempts bounded and throttled per IP.
    for (const [ip, value] of failures) if (value.until <= now) failures.delete(ip);
    const attempts = failures.get(req.ip);
    if (attempts && attempts.count >= 8) {
      return reply.header('retry-after', Math.ceil((attempts.until - now) / 1000)).code(429).send({ error: '尝试次数过多，请 15 分钟后再试' });
    }
    const body = req.body as { username?: unknown; password?: unknown; remember?: unknown } | null;
    if (typeof body?.username !== 'string' || typeof body?.password !== 'string') {
      return reply.code(400).send({ error: '请输入账号和密码' });
    }
    if (!timingSafeEqual(hash(JSON.stringify([body.username, body.password])), expected)) {
      if (!attempts && failures.size >= 2048) failures.delete(failures.keys().next().value!);
      failures.set(req.ip, { count: (attempts?.count ?? 0) + 1, until: attempts?.until ?? now + LOGIN_WINDOW });
      return reply.code(401).send({ error: '账号或密码不正确，请重新输入' });
    }
    failures.delete(req.ip);
    for (const [key, expires] of sessions) if (expires <= now) sessions.delete(key);
    sessions.delete(sessionKey(req.headers.cookie));
    if (sessions.size >= 1024) sessions.delete(sessions.keys().next().value!);
    const remember = body.remember === true;
    const lifetime = (remember ? 7 * 24 : 12) * 3600;
    const token = randomBytes(32).toString('hex');
    sessions.set(hash(token).toString('hex'), now + lifetime * 1000);
    const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
    return reply.header('set-cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${remember ? `; Max-Age=${lifetime}` : ''}${secure ? '; Secure' : ''}`).send({ ok: true });
  });

  app.post('/api/auth/logout', (req, reply) => {
    sessions.delete(sessionKey(req.headers.cookie));
    return reply.header('cache-control', 'no-store').header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`).send({ ok: true });
  });
}
