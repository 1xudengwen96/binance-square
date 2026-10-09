import 'dotenv/config';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../db/index.ts';
import { collect, generate, generateFromPool, publishDue, pauseState, reroll } from '../pipeline.ts';
import { pool, refreshPool } from '../hot/pool.ts';
import { nextSlot, nextSlotFor, settingsFrom, beijingDayStart } from '../schedule.ts';
import { templates as builtinTemplates } from '../content/templates.ts';
import { DEFAULT_SETTINGS, STYLE_LABELS, type Settings } from '../config.ts';
import { isStructuralDuplicate } from '../engine/guard.ts';
import { line, tick, type TickResult } from '../daemon.ts';
import { analyze, CATEGORY_LABELS, signalLabel } from '../stats/insight.ts';
import { dashboard } from '../stats/dashboard.ts';
import { TRACKS, UNIMPLEMENTED_TRACKS, trackById } from '../studio/tracks.ts';
import { CONCEPTS } from '../studio/concepts.ts';
import { conceptPerformance, nextTopics, summarize } from '../studio/evidence.ts';
import { assertTextOnTrack, trackForAccount } from '../studio/lock.ts';
import { nextArticleSlot, polishArticleDraft, runStudio } from '../studio/runner.ts';

import { SquareClient } from '../publisher/square.ts';
import { accountSecretView, getAccountSecret, getSecret, secretViews, setAccountSecret, setSecret, SECRET_NAMES, type SecretName } from '../secrets.ts';
import { DEFAULT_BASE, listModels, testChat, type LlmConfig, type ProviderKind } from '../llm/providers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? './data/squareforge.db';
const PORT = Number(process.env.PORT ?? 8787);
/**
 * Loopback by default: this panel holds posting credentials and can push content to a
 * live account. In a container the loopback address is unreachable from outside, so the
 * image sets HOST=0.0.0.0 — and docker-compose then publishes to 127.0.0.1:<port> only,
 * which keeps the exposure identical to running it on the host. Widening that mapping is
 * a deliberate decision, so it announces itself in the log.
 */
const HOST = process.env.HOST ?? '127.0.0.1';

const store = Store.open(DB_PATH);
store.syncTemplates(builtinTemplates);

const app = Fastify({ logger: false });
const ui = readFileSync(join(here, 'public', 'index.html'), 'utf8');

/**
 * The panel binds to loopback only, but that alone is not enough: any page the user
 * visits could POST to 127.0.0.1:8787 and, say, flip autoPublish or overwrite a key.
 * Loopback hosts must be explicit, cross-origin mutations are refused, and every
 * mutation carries a custom header — which a browser cannot forge cross-origin
 * without a CORS preflight this server never grants.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

app.addHook('preHandler', (req, reply, done) => {
  if (req.method === 'GET' || req.method === 'HEAD') return done();

  const host = ((req.headers.host ?? '').split(':')[0] ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!LOOPBACK.has(host)) return reply.code(403).send({ error: '只允许从本机访问' });

  const origin = req.headers.origin;
  if (origin) {
    let oh = '';
    try {
      oh = new URL(origin).hostname.toLowerCase();
    } catch {
      return reply.code(400).send({ error: 'bad origin' });
    }
    if (!LOOPBACK.has(oh)) return reply.code(403).send({ error: '跨站请求被拒绝' });
  }

  if (req.headers['x-squareforge'] !== 'ui') return reply.code(403).send({ error: '缺少 X-Squareforge: ui 请求头' });
  done();
});

function llmConfigFrom(s: Settings, override?: Partial<LlmConfig>): LlmConfig {
  const provider = (override?.provider ?? s.llmProvider) as ProviderKind;
  const keyName: SecretName = provider === 'anthropic' ? 'anthropicApiKey' : 'openaiApiKey';
  return {
    provider,
    baseUrl: override?.baseUrl ?? s.llmBaseUrl ?? DEFAULT_BASE[provider],
    model: override?.model ?? s.llmModel ?? '',
    apiKey: override?.apiKey ?? getSecret(store, keyName),
    maxTokens: override?.maxTokens ?? s.llmMaxTokens,
    temperature: override?.temperature ?? s.llmTemperature,
  };
}

app.get('/', (_req, reply) => reply.type('text/html').send(ui));

/**
 * Stylesheet and script, read once at boot like the HTML. An allowlist rather than a static
 * handler: this directory also sits next to nothing user-supplied, but a route that resolves a
 * caller-provided filename inside a folder holding the posting keys is a mistake waiting to be
 * found, and there are exactly two files to serve.
 */
const ASSETS: Record<string, { file: string; type: string }> = {
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
};
for (const [route, a] of Object.entries(ASSETS)) {
  const body = readFileSync(join(here, 'public', a.file), 'utf8');
  app.get(route, (_req, reply) => reply.type(a.type).header('cache-control', 'no-cache').send(body));
}

/** Cheap liveness probe for Docker's HEALTHCHECK and any reverse proxy. No DB writes. */
app.get('/healthz', (_req, reply) => {
  const s = settingsFrom(store);
  return reply.send({ ok: true, autoRun: s.autoRun, accounts: store.activeAccounts().length });
});

app.get('/api/status', (_req, reply) => {
  const s = settingsFrom(store);
  const slot = nextSlot(store, s);
  const pause = pauseState(store);
  const bindings = store.studioAccounts();
  return reply.send({
    settings: { ...DEFAULT_SETTINGS, ...s },
    styleLabels: STYLE_LABELS,
    // The account page needs these to offer "跑长文 / 跑短帖" without a second round trip to
    // the studio endpoint, which pulls concept performance for every binding.
    availableTracks: TRACKS.map(t => ({ id: t.id, label: t.label, summary: t.summary })),
    publishedToday: store.publishedToday(beijingDayStart()),
    pending: store.pendingQueueCount(),
    // Approved work with no account is queued in name only. The overview has to say so, or the
    // queue number reads like capacity instead of a dead end.
    orphanPending: (store.db
      .prepare("SELECT COUNT(*) AS n FROM posts WHERE status IN ('draft','approved') AND account_id IS NULL")
      .get() as { n: number }).n,
    templateCount: store.allTemplates().length,
    next: slot,
    pause,
    hasKey: Boolean(getSecret(store, 'squareApiKey')),
    llm: { enabled: settingsFrom(store).llmEnabled, provider: settingsFrom(store).llmProvider, model: settingsFrom(store).llmModel },
    materials: store.materialCounts(),
    unused: store.unusedCount(),
    performance: store.templatePerformance(),
    accounts: store.allAccounts().map(a => {
      const b = bindings.find(x => x.account_id === a.id);
      const track = b ? trackById(b.track_id) : undefined;
      return {
        ...a,
        key: accountSecretView(store, a.id),
        today: store.accountPostsToday(a.id, beijingDayStart()),
        // Same reason as on the board: the matrix clock is not this account's clock any more.
        next: track ? { allowed: true, at: nextArticleSlot(store, a.id, track), reason: `长文 · 每 ${track.cadence.minGapHours} 小时最多一篇` } : nextSlotFor(store, settingsFrom(store), a),
        // What this account is *for*. Binding lives in the studio table and cadence lives in the
        // accounts table, and an operator who has to open two pages to know which account does
        // which job will end up with two accounts doing the same job.
        pending: store.pendingQueueCount(a.id),
        trackId: b?.track_id ?? null,
        trackLabel: b ? (track?.label ?? b.track_id) : null,
        // A studio account's quota is measured in articles, so "0 / 24" would be nonsense on
        // the card that says what it actually does.
        articlesPerDay: track && b ? (b.articles_per_day ?? track.cadence.articlesPerDay) : null,
      };
    }),
    loop: { lastTick },
    warnings: queueWarnings(store),
  });
});

/**
 * States that are invisible in the queue but decide whether an approved post ever goes out.
 *
 * A post carries the account that will publish it. Since the matrix landed, the account
 * path only selects posts tagged with that account, so an approved post with no account can
 * be published solely by the fallback path — and that one reads the key from the environment,
 * not from the key stored in the panel. Approving such a post looks like progress and is
 * actually a dead end, which is worth saying out loud.
 *
 * The second case is newer and was created by the studio itself: binding an account to a
 * track removes it from the mixed-style matrix, so everything already approved on that
 * account stops being reachable. That is the persona lock working as designed, but a
 * designed dead end is still a dead end if nobody tells you about it.
 */
function queueWarnings(db: Store): string[] {
  const out: string[] = [];
  const orphans = db.db
    .prepare("SELECT COUNT(*) AS n FROM posts WHERE status = 'approved' AND account_id IS NULL")
    .get() as { n: number };
  if (orphans.n > 0 && !process.env.SQUARE_API_KEY) {
    out.push(
      `${orphans.n} 条已通过的帖子没有归属账号，任何账号都不会去发它们。要让自动循环发出去，需要把 .env 里的 SQUARE_API_KEY 配上；` +
        '否则请驳回后在有启用账号的情况下重新生成，新草稿才会带上账号。',
    );
  }

  const bound = db.studioAccounts().filter(b => b.enabled && b.pause_matrix);
  for (const b of bound) {
    const stranded = db.db
      .prepare("SELECT COUNT(*) AS n FROM posts WHERE status = 'approved' AND account_id = ?")
      .get(b.account_id) as { n: number };
    if (!stranded.n) continue;
    const label = (db.accountById(b.account_id)?.label ?? String(b.account_id));
    out.push(
      `${stranded.n} 条已通过帖子属于「${label}」，但该账号已绑定「${trackById(b.track_id)?.label ?? b.track_id}」赛道，` +
        '按人设隔离规则它不再从短帖矩阵取稿，这些帖子因此不会发出。' +
        '要它们照发：在工作室页解除绑定；要深耕赛道：另开一个号做教学号，这个号回到短帖流（矩阵的正确用法）。',
    );
  }
  return out;
}

app.get('/api/materials', (req, reply) => {
  const q = req.query as { limit?: string };
  // The label travels with the row: `open_interest/oi_shift` is a database key, and every page
  // that lists material would otherwise have to keep its own translation table.
  return reply.send(
    store.recentMaterials(Number(q.limit ?? 60)).map(m => ({
      ...m,
      categoryCn: CATEGORY_LABELS[m.category] ?? m.category,
      signalCn: signalLabel(m.category, m.subType),
    })),
  );
});

/** Serve a generated chart. The filename is whitelisted so this cannot read arbitrary paths. */
app.get('/charts/:file', (req, reply) => {
  const file = (req.params as { file: string }).file;
  if (!/^[A-Z0-9][A-Z0-9._-]{0,60}\.png$/i.test(file)) return reply.code(400).send({ error: 'bad name' });
  const abs = resolve(process.cwd(), 'data/charts', file);
  if (!abs.startsWith(resolve(process.cwd(), 'data/charts'))) return reply.code(400).send({ error: 'bad path' });
  try {
    return reply.type('image/png').send(readFileSync(abs));
  } catch {
    return reply.code(404).send({ error: 'not found' });
  }
});

app.get('/api/posts', (req, reply) => {
  const q = req.query as { status?: string; sort?: string; limit?: string };
  const ALL = ['draft', 'approved', 'published', 'uncertain', 'failed', 'rejected'];
  const statuses = q.status && ALL.includes(q.status) ? [q.status] : ALL;
  const sort = q.sort === 'views' ? 'views' : 'recent';
  const rows = store.postsForList({ statuses, sort, limit: Math.min(500, Number(q.limit) > 0 ? Number(q.limit) : 150) });
  // Surfacing is reported separately from views because the two have different fixes; a post
  // that appeared on a public board is a different outcome than one that only got read.
  const surfaced = store.surfacedPostIds(rows.map(p => p.square_post_id).filter((x): x is string => Boolean(x)));
  return reply.send(
    rows.map(p => ({
      ...p,
      signalCn: signalLabel(p.category, p.sub_type),
      categoryCn: p.category ? (CATEGORY_LABELS[p.category] ?? p.category) : null,
      styleCn: p.style ? (STYLE_LABELS[p.style as keyof typeof STYLE_LABELS] ?? p.style) : null,
      images: (JSON.parse(p.images_json ?? '[]') as string[]).map(p2 => `/charts/${p2.split(/[\\/]/).pop()}`),
      stats: p.views == null ? null : { views: p.views, likes: p.likes, comments: p.comments, shares: p.shares, reactions: p.reactions, checked_at: p.checked_at },
      onBoard: p.square_post_id ? surfaced.has(p.square_post_id) : false,
    })),
  );
});

/** Full provenance for one post: what material, which template, which branches. */
app.get('/api/posts/:id', (req, reply) => {
  const p = store.postById(Number((req.params as { id: string }).id));
  if (!p) return reply.code(404).send({ error: 'not found' });
  const parse = (v: string | null): unknown => {
    try {
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  };
  const material = p.material_id ? store.materialById(p.material_id) : undefined;
  const template = p.template_id
    ? (store.db.prepare('SELECT id, name, style, category, sub_type, weight, body FROM templates WHERE id = ?').get(p.template_id) as Record<string, unknown> | undefined)
    : undefined;
  return reply.send({
    ...p,
    images: (JSON.parse(p.images_json ?? '[]') as string[]).map(f => `/charts/${f.split(/[\\/]/).pop()}`),
    curve: store.statCurve(p.id),
    trace: parse(p.trace_json),
    factLedger: parse(p.facts_json),
    material: material
      ? { id: material.id, title: material.title, category: material.category, subType: material.subType, score: material.score, source: material.source, at: material.at, facts: material.facts }
      : null,
    template: template ?? null,
    alternatives: material
      ? (store.db
          .prepare('SELECT id, name, style FROM templates WHERE enabled = 1 AND category = ? ORDER BY style')
          .all(material.category) as { id: string; name: string; style: string }[]).filter(t => t.id !== p.template_id)
      : [],
  });
});

/**
 * The 效果分析 page: aggregate numbers, the platform comparison, and the generated
 * conclusions. `days` is bounded because the window is user-supplied and a 10-year request
 * would just be a slow way to ask for everything.
 */
app.get('/api/stats/summary', (req, reply) => {
  const q = req.query as { days?: string };
  const days = Math.max(1, Math.min(90, Number(q.days) > 0 ? Number(q.days) : 14));
  return reply.send(analyze(store, { days }));
});

/** The operational board: what went out, when, on which account. No sample-size floor. */
app.get('/api/dashboard', (req, reply) => {
  const q = req.query as { days?: string };
  return reply.send(dashboard(store, { days: Number(q.days) > 0 ? Number(q.days) : 14 }));
});

/** The comparison pool itself, so the numbers behind a conclusion can be inspected. */
app.get('/api/benchmarks', (_req, reply) => {
  return reply.send({ pool: store.boardCount(), rows: store.boardRows(40) });
});

/* ------------------------------------------------------------------ studio --- */

/** Everything the 工作室 page needs in one round trip. */
app.get('/api/studio', (_req, reply) => {
  const bindings = store.studioAccounts();
  const tracks = bindings.map(b => {
    const perf = conceptPerformance(store, b.track_id);
    return {
      accountId: b.account_id,
      label: b.label,
      trackId: b.track_id,
      trackLabel: trackById(b.track_id)?.label ?? b.track_id,
      enabled: b.enabled,
      pauseMatrix: b.pause_matrix,
      articlesPerDay: b.articles_per_day,
      performance: perf,
      next: nextTopics(store, b.track_id, { limit: 4 }),
      summary: summarize(store, b.track_id),
    };
  });
  const articles = store.studioArticles('all', 40);
  const stats = store.studioLatestStats(articles.map(a => a.id));
  return reply.send({
    tracks,
    // The refusal list is shown before binding, not after a draft gets rejected for it.
    availableTracks: TRACKS.map(t => ({ id: t.id, label: t.label, summary: t.summary, refusals: t.refusals.map(r => r.why), tradeoffs: t.tradeoffs, cadence: t.cadence })),
    unimplemented: UNIMPLEMENTED_TRACKS,
    unboundAccounts: store.allAccounts().filter(a => a.enabled && !bindings.some(b => b.account_id === a.id))
      .map(a => ({ id: a.id, label: a.label })),
    articles: articles.map(a => ({
      ...a,
      stats: stats.get(a.id) ?? null,
      sections: (() => {
        try {
          return JSON.parse(a.sections_json ?? '[]');
        } catch {
          return [];
        }
      })(),
    })),
    lessons: store.lessons(20),
  });
});

app.post('/api/studio/bind', (req, reply) => {
  const b = (req.body ?? {}) as { accountId?: number; trackId?: string; pauseMatrix?: boolean };
  const account = b.accountId ? store.accountById(b.accountId) : null;
  if (!account) return reply.code(400).send({ error: '账号不存在' });
  const track = trackById(b.trackId ?? '');
  if (!track) return reply.code(400).send({ error: '这条赛道本工具还不能实现，原因见页面上的说明' });
  store.ensureConceptRows(track.id, CONCEPTS.filter(c => c.trackId === track.id).map(c => c.id));
  store.bindStudioTrack(account.id, track.id, { pauseMatrix: b.pauseMatrix !== false });
  store.log('studio_bind', { accountId: account.id, trackId: track.id });
  return reply.send({ ok: true, accountId: account.id, trackId: track.id });
});

app.post('/api/studio/unbind', (req, reply) => {
  const b = (req.body ?? {}) as { accountId?: number };
  if (!b.accountId) return reply.code(400).send({ error: '缺少 accountId' });
  store.unbindStudioTrack(b.accountId);
  store.log('studio_unbind', { accountId: b.accountId });
  return reply.send({ ok: true });
});

/** One studio pass: compose drafts, and publish only when explicitly live. */
app.post('/api/studio/run', async (req, reply) => {
  const b = (req.body ?? {}) as { live?: boolean };
  try {
    return reply.send(await runStudio(store, settingsFrom(store), { live: Boolean(b.live) }));
  } catch (err) {
    return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/studio/articles/:id/:act', async (req, reply) => {
  const { id, act } = req.params as { id: string; act: string };
  const article = store.studioArticle(Number(id));
  if (!article) return reply.code(404).send({ error: 'not found' });
  if (act === 'approve') {
    // The lock runs again at approval, not only at compose time: the body may have been
    // edited in the panel since it was drafted.
    const track = article.account_id ? trackForAccount(store, article.account_id) : undefined;
    if (!track) return reply.code(400).send({ error: '该文章没有赛道绑定，无法判断人设边界' });
    const gate = assertTextOnTrack(track, `${article.title}\n${article.body}`, 'compose');
    if (!gate.ok) return reply.code(400).send({ error: `越出赛道边界：${gate.reasons.join('；')}` });
    store.updateStudioArticle(article.id, { status: 'approved', scheduledAt: Date.now() });
    return reply.send({ ok: true });
  }
  if (act === 'reject') {
    store.updateStudioArticle(article.id, { status: 'rejected' });
    return reply.send({ ok: true });
  }
  if (act === 'polish') {
    return reply.send(await polishArticleDraft(store, settingsFrom(store), article.id));
  }
  return reply.code(400).send({ error: `未知操作 ${act}` });
});

app.get('/api/pool', async (req, reply) => {
  const q = req.query as { refresh?: string };
  const s = settingsFrom(store);
  try {
    if (q.refresh === '1') await refreshPool(store, s);
    const { entries, square, errors } = await pool(store, s);
    return reply.send({
      entries,
      topics: square.topics.slice(0, 10),
      squareCoins: square.coins.slice(0, 12),
      errors,
      threshold: s.attentionThreshold,
      matureMinutes: s.matureMinutes,
    });
  } catch (err) {
    return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/generate-pool', async (req, reply) => {
  const body = (req.body ?? {}) as { count?: number };
  return reply.send(await generateFromPool(store, settingsFrom(store), { count: Math.min(5, Number(body.count ?? 2)) }));
});

app.post('/api/collect', async (_req, reply) => reply.send(await collect(store, settingsFrom(store))));

app.post('/api/generate', async (req, reply) => {
  const body = (req.body ?? {}) as { n?: number };
  return reply.send(await generate(store, settingsFrom(store), Math.min(20, Number(body.n ?? 3))));
});

app.post('/api/posts/:id/:action', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const action = (req.params as { action: string }).action;
  const p = store.postById(id);
  if (!p) return reply.code(404).send({ error: 'not found' });

  if (action === 'reroll') {
    const body = (req.body ?? {}) as { templateId?: string };
    const r = await reroll(store, settingsFrom(store), id, { templateId: body.templateId });
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return reply.send({ ...store.postById(id), note: r.note });
  }

  if (action === 'approve') {
    // Drafts no longer block each other during generation, so surface duplication at
    // the moment the post is committed to going out.
    const dup = isStructuralDuplicate(p.text, store.recentPostTexts(40, ['published', 'uncertain']));
    if (dup) {
      return reply.code(409).send({
        error: '与已发布的帖子结构重复（换了币但句子一样）。确定要发就在队列里驳回其中一条，或点溯源换模版重写。',
        duplicateOf: dup.slice(0, 120),
      });
    }
    store.updatePost(id, { status: 'approved' });
  } else if (action === 'reject') store.updatePost(id, { status: 'rejected' });
  else if (action === 'unapprove') store.updatePost(id, { status: 'draft' });
  else return reply.code(400).send({ error: `unknown action ${action}` });
  return reply.send(store.postById(id));
});

app.patch('/api/posts/:id', (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const body = (req.body ?? {}) as { text?: string };
  if (!body.text?.trim()) return reply.code(400).send({ error: 'text required' });
  if (body.text.length > 2000) return reply.code(400).send({ error: '正文超过 2000 字' });
  store.updatePostText(id, body.text.trim());
  return reply.send(store.postById(id));
});

app.post('/api/publish', async (req, reply) => {
  const body = (req.body ?? {}) as { live?: boolean };
  return reply.send(await publishDue(store, settingsFrom(store), { live: Boolean(body.live), apiKey: getSecret(store, 'squareApiKey') }));
});

/* --------------------------------------------------------------- secrets --- */

app.get('/api/secrets', (_req, reply) => reply.send({ items: secretViews(store) }));

app.post('/api/secrets', (req, reply) => {
  const body = (req.body ?? {}) as { name?: SecretName; value?: string };
  if (!body.name || !SECRET_NAMES.includes(body.name)) return reply.code(400).send({ error: '未知的密钥项' });
  setSecret(store, body.name, String(body.value ?? ''));
  store.log('secret', { name: body.name, cleared: !body.value?.trim() });
  return reply.send({ items: secretViews(store) });
});

app.post('/api/secrets/square/test', async (_req, reply) => {
  const key = getSecret(store, 'squareApiKey');
  if (!key) return reply.code(400).send({ error: '还没有填写广场 Key' });
  const client = new SquareClient({ apiKey: key });
  const r = await client.validateKey();
  store.log('square_key_test', r);
  return reply.send(r);
});

/* ------------------------------------------------------------------- llm --- */

app.post('/api/llm/config', (req, reply) => {
  const body = (req.body ?? {}) as Partial<Pick<Settings, 'llmEnabled' | 'llmProvider' | 'llmBaseUrl' | 'llmModel' | 'llmMaxTokens' | 'llmTemperature'>>;
  const cur = settingsFrom(store);
  const next = { ...cur, ...body };
  if (!['openai', 'anthropic'].includes(next.llmProvider)) return reply.code(400).send({ error: 'provider 只能是 openai 或 anthropic' });
  store.setSetting('settings', next);
  return reply.send({ ...DEFAULT_SETTINGS, ...next });
});

/** Store the provider key without echoing it back. */
app.post('/api/llm/key', (req, reply) => {
  const body = (req.body ?? {}) as { provider?: ProviderKind; value?: string };
  const name: SecretName = body.provider === 'anthropic' ? 'anthropicApiKey' : 'openaiApiKey';
  setSecret(store, name, String(body.value ?? ''));
  return reply.send({ items: secretViews(store) });
});

/** Auto-discover models from whatever endpoint the user configured. */
app.post('/api/llm/models', async (req, reply) => {
  const body = (req.body ?? {}) as { provider?: ProviderKind; baseUrl?: string; apiKey?: string };
  const s = settingsFrom(store);
  const cfg = llmConfigFrom(s, { ...body, apiKey: body.apiKey?.trim() || undefined });
  try {
    const models = await listModels(cfg);
    return reply.send({ models, count: models.length });
  } catch (err) {
    return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/llm/test', async (req, reply) => {
  const body = (req.body ?? {}) as { apiKey?: string };
  const s = settingsFrom(store);
  const cfg = llmConfigFrom(s, { apiKey: body.apiKey?.trim() || undefined });
  if (!cfg.model) return reply.code(400).send({ error: '先选一个模型（可点「拉取模型」）' });
  try {
    return reply.send(await testChat(cfg));
  } catch (err) {
    return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/templates', (_req, reply) => {
  const rows = store.db.prepare('SELECT * FROM templates ORDER BY category, id').all() as (Record<string, unknown> & { category: string | null; sub_type: string | null; style: string | null })[];
  return reply.send(rows.map(t => ({
    ...t,
    categoryCn: t.category ? (CATEGORY_LABELS[t.category] ?? t.category) : null,
    signalCn: t.sub_type ? signalLabel(t.category, t.sub_type) : null,
    styleCn: t.style ? (STYLE_LABELS[t.style as keyof typeof STYLE_LABELS] ?? t.style) : null,
  })));
});

app.patch('/api/templates/:id', (req, reply) => {
  const id = (req.params as { id: string }).id;
  const body = (req.body ?? {}) as { weight?: number; enabled?: boolean };
  if (typeof body.weight === 'number') store.setTemplateWeight(id, Math.max(0, Math.min(5, body.weight)));
  if (typeof body.enabled === 'boolean') store.setTemplateEnabled(id, body.enabled);
  return reply.send({ ok: true });
});

app.patch('/api/settings', (req, reply) => {
  const patch = (req.body ?? {}) as Partial<Settings>;
  const cur = settingsFrom(store);
  const next = { ...cur, ...patch };
  // Guard the values that would otherwise let the tool hurt the account.
  next.dailyCap = Math.min(100, Math.max(1, Math.round(next.dailyCap)));
  next.postsPerDay = Math.min(next.dailyCap, Math.max(1, Math.round(next.postsPerDay)));
  next.minIntervalMinutes = Math.max(5, Math.round(next.minIntervalMinutes));
  // Typed as a union in Settings, but this route accepts arbitrary JSON.
  if (!['1h', '4h', '1d'].includes(next.chartInterval)) next.chartInterval = DEFAULT_SETTINGS.chartInterval;
  store.setSetting('settings', next);
  return reply.send({ ...DEFAULT_SETTINGS, ...next });
});

/*
 * The loop runs inside the panel process so "open the page and it collects" is true
 * without a second command. Live publishing is still gated by `autoPublish` inside
 * tick(), which defaults to off — a panel left open cannot post on its own.
 */
let loopTimer: NodeJS.Timeout | null = null;
let running = false;

async function runTick(store: Store, opts: { force?: boolean; live?: boolean } = {}): Promise<TickResult | null> {
  const s = settingsFrom(store);
  // One tick at a time: two overlapping passes read the same unused-material list and
  // draft the same event twice, which is exactly the duplication the matrix forbids.
  if (running || (!s.autoRun && !opts.force)) return null;
  running = true;
  try {
    const r = await tick(store, { live: opts.live ?? true, tickNo: ++tickNo });
    lastTick = r;
    console.log(line(r));
    return r;
  } catch (err) {
    console.log(`tick 异常：${String(err).slice(0, 200)}`);
    return null;
  } finally {
    running = false;
  }
}

let tickNo = 0;
let lastTick: TickResult | null = null;

function startLoop(store: Store): void {
  const s = settingsFrom(store);
  const minutes = Math.max(3, Math.min(240, s.tickMinutes));
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = setInterval(() => void runTick(store), minutes * 60_000);
  loopTimer.unref();
  console.log(`  自动循环：每 ${minutes} 分钟一轮 · ${s.autoPublish ? '含真实发布' : '不自动发布（人工审核）'}`);
  // A tick on boot so the first view is never empty, but not before the port is up.
  setTimeout(() => void runTick(store), 3_000).unref();
}

/* ---------------------------------------------------------------- accounts --- */

const ACCOUNT_STYLES = new Set(['mixed', ...Object.keys(STYLE_LABELS)]);

function jsonList(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const items = v.map(s => String(s).trim()).filter(Boolean);
  return items.length ? JSON.stringify(items.slice(0, 60)) : '[]';
}

function accountPatchFrom(body: Record<string, unknown>) {
  const p: Record<string, unknown> = {};
  if (typeof body.label === 'string' && body.label.trim()) p.label = body.label.trim().slice(0, 40);
  if (typeof body.owner === 'string') p.owner = body.owner.trim().slice(0, 40);
  if (typeof body.style === 'string' && ACCOUNT_STYLES.has(body.style)) p.style = body.style;
  if (Array.isArray(body.styles)) p.stylesJson = jsonList(body.styles.filter(s => ACCOUNT_STYLES.has(String(s))));
  if (body.lang === 'zh-CN' || body.lang === 'zh-TW') p.lang = body.lang;
  // Explicit null means "follow the global switch", which is different from "not sent".
  if ('autoPublish' in body) p.autoPublish = body.autoPublish === null ? null : body.autoPublish ? 1 : 0;
  if (typeof body.personaNote === 'string') p.personaNote = body.personaNote.slice(0, 300);
  if (typeof body.proxyUrl === 'string') p.proxyUrl = body.proxyUrl.trim().slice(0, 200);
  if (Array.isArray(body.categories)) p.categoriesJson = jsonList(body.categories);
  if (Array.isArray(body.symbols)) p.symbolsJson = jsonList(body.symbols.map(s => String(s).toUpperCase()));
  if (Array.isArray(body.blockedSymbols)) p.blockedSymbolsJson = jsonList(body.blockedSymbols.map(s => String(s).toUpperCase()));
  if (Array.isArray(body.blockedTemplates)) p.blockedTemplatesJson = jsonList(body.blockedTemplates);
  for (const [bodyKey, col, min, max] of [
    ['postsPerDay', 'postsPerDay', 1, 100],
    ['minIntervalMinutes', 'minIntervalMinutes', 5, 720],
    ['phaseMinutes', 'phaseMinutes', 0, 1439],
    ['activeStartHour', 'activeStartHour', 0, 24],
    ['activeEndHour', 'activeEndHour', 0, 24],
  ] as const) {
    const v = body[bodyKey];
    if (typeof v === 'number' && Number.isFinite(v)) p[col] = Math.max(min, Math.min(max, Math.round(v)));
  }
  return p;
}

app.post('/api/accounts', (req, reply) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const label = typeof b.label === 'string' ? b.label.trim().slice(0, 40) : '';
  if (!label) return reply.code(400).send({ error: '要给这个号起个备注名' });
  const id = store.createAccount({
    label,
    owner: typeof b.owner === 'string' ? b.owner : '',
    style: typeof b.style === 'string' && ACCOUNT_STYLES.has(b.style) ? b.style : 'mixed',
    personaNote: typeof b.personaNote === 'string' ? b.personaNote : '',
    proxyUrl: typeof b.proxyUrl === 'string' ? b.proxyUrl : '',
    postsPerDay: typeof b.postsPerDay === 'number' ? b.postsPerDay : null,
    symbols: Array.isArray(b.symbols) ? b.symbols.map(String) : null,
    enabled: false,
  });
  store.log('account_create', { id, label });
  return reply.send({ id });
});

app.patch('/api/accounts/:id', (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  if (!store.accountById(id)) return reply.code(404).send({ error: 'not found' });
  const b = (req.body ?? {}) as Record<string, unknown>;
  const patch = accountPatchFrom(b);
  if (typeof b.enabled === 'boolean') {
    patch.enabled = b.enabled ? 1 : 0;
    // Switching an account back on clears an earlier auto-pause; leaving it on would
    // silently resume posting under a state the user already thought they fixed.
    if (b.enabled) patch.pausedUntil = null;
  }
  store.updateAccount(id, patch);
  store.log('account_update', { id, keys: Object.keys(patch) });
  return reply.send({ ok: true });
});

app.post('/api/accounts/:id/key', (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  if (!store.accountById(id)) return reply.code(404).send({ error: 'not found' });
  const b = (req.body ?? {}) as { value?: string };
  setAccountSecret(store, id, String(b.value ?? ''));
  store.log('account_key', { id, set: Boolean(String(b.value ?? '').trim()) });
  return reply.send(accountSecretView(store, id));
});

/** Header-only auth is evaluated before content validation, so this posts nothing. */
app.post('/api/accounts/:id/test', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const a = store.accountById(id);
  if (!a) return reply.code(404).send({ error: 'not found' });
  const key = getAccountSecret(store, id);
  if (!key) return reply.code(400).send({ error: `${a.label} 还没有填广场 Key` });
  const client = new SquareClient({ apiKey: key, proxyUrl: a.proxy_url });
  const r = await client.validateKey();
  store.updateAccount(id, { lastError: r.ok ? null : (r.label ?? '验证失败')?.slice(0, 200) });
  store.log('account_key_test', { id, ok: r.ok });
  return reply.send(r);
});

/**
 * What would this account post right now? Runs the real generation path — persona, style
 * set, template blocks, coin blocklist, the cross-account gate — but persists nothing, so
 * looking at a preview cannot change what gets posted.
 */
app.post('/api/accounts/:id/preview', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const a = store.accountById(id);
  if (!a) return reply.code(404).send({ error: 'not found' });
  const settings = settingsFrom(store);
  const n = Math.max(1, Math.min(5, Number((req.body as { count?: unknown })?.count ?? 3)));
  const r = await generate(store, settings, n, { account: a, dryRun: true });
  return reply.send({ created: r.created, skipped: r.skipped });
});

app.delete('/api/accounts/:id', (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  if (!store.accountById(id)) return reply.code(404).send({ error: 'not found' });
  setAccountSecret(store, id, '');
  store.deleteAccount(id);
  store.log('account_delete', { id });
  return reply.send({ ok: true });
});

/** Run one loop pass immediately, through the same lock the timer uses. */
app.post('/api/run-tick', async (req, reply) => {
  const body = (req.body ?? {}) as { live?: boolean };
  const r = await runTick(store, { force: true, live: body.live ?? false });
  if (!r) return reply.code(409).send({ error: '上一轮还没跑完（或自动循环已关闭），请稍后再试' });
  return reply.send(r);
});

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    console.log(`\n  squareforge 本地面板  →  http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}\n`);
    if (!LOOPBACK.has(HOST)) {
      console.log(
        `  ⚠ 正在监听 ${HOST}：任何能访问到这个端口的主机都能操作面板（改排期、覆盖 Key、触发发布）。\n` +
          '    面板只校验 Host / Origin / 自定义头，没有登录。若必须跨机访问，请只映射到宿主 127.0.0.1，或挡一层反代。\n',
      );
    }
    startLoop(store);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
