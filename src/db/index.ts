import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Material } from '../material/types.ts';
import type { TemplateDef } from '../engine/types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS materials (
  id            TEXT PRIMARY KEY,
  category      TEXT NOT NULL,
  sub_type      TEXT NOT NULL,
  title         TEXT NOT NULL,
  symbol        TEXT,
  sentiment     TEXT NOT NULL,
  score         REAL NOT NULL,
  source        TEXT NOT NULL,
  occurred_at   INTEGER NOT NULL,
  collected_at  INTEGER NOT NULL,
  fingerprint   TEXT NOT NULL,
  facts_json    TEXT NOT NULL,
  used_count    INTEGER NOT NULL DEFAULT 0,
  discarded     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_materials_score ON materials(category, score DESC, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_materials_fp ON materials(fingerprint, occurred_at DESC);

CREATE TABLE IF NOT EXISTS templates (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,
  sub_type      TEXT,
  style         TEXT NOT NULL,
  body          TEXT NOT NULL,
  requires_json TEXT,
  weight        REAL NOT NULL DEFAULT 1,
  enabled       INTEGER NOT NULL DEFAULT 1,
  source        TEXT NOT NULL DEFAULT 'builtin'
);

CREATE TABLE IF NOT EXISTS posts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id    TEXT REFERENCES materials(id),
  template_id    TEXT,
  text           TEXT NOT NULL,
  status         TEXT NOT NULL,               -- draft | approved | published | failed | uncertain
  created_at     INTEGER NOT NULL,
  scheduled_at   INTEGER,
  published_at   INTEGER,
  account_id     INTEGER,
  square_post_id TEXT,
  url            TEXT,
  error          TEXT,
  facts_json     TEXT,
  trace_json     TEXT,
  images_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);

-- Performance is backfilled out-of-band: the Square OpenAPI is create-only.
CREATE TABLE IF NOT EXISTS post_stats (
  post_id     INTEGER PRIMARY KEY REFERENCES posts(id),
  checked_at  INTEGER NOT NULL,
  views       INTEGER,
  likes       INTEGER,
  comments    INTEGER,
  shares      INTEGER,
  reactions   INTEGER,
  raw_json    TEXT
);

/*
 * One row per measured checkpoint rather than a JSON blob: the point of the sweep is
 * the growth curve (did this post keep pulling views after hour one?), and reading a
 * curve out of a column we rewrite wholesale means re-parsing and re-merging in JS
 * what the database can just key on.
 */
CREATE TABLE IF NOT EXISTS post_stat_checks (
  post_id    INTEGER NOT NULL REFERENCES posts(id),
  checkpoint INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  views      INTEGER,
  likes      INTEGER,
  comments   INTEGER,
  shares     INTEGER,
  reactions  INTEGER,
  PRIMARY KEY (post_id, checkpoint)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Square's own public boards, sampled whole. This is the comparison pool: our posts are
-- measured against what content of the same kind actually earns on the platform, and a
-- post of ours appearing here is itself the signal that it surfaced.
-- is_ours keeps our own rows out of the benchmark so we never grade ourselves against
-- ourselves.
CREATE TABLE IF NOT EXISTS square_board_samples (
  content_id   TEXT PRIMARY KEY,
  board        TEXT NOT NULL,
  title        TEXT,
  author       TEXT,
  coin         TEXT,
  coins_json   TEXT,
  hashtags_json TEXT,
  card_type    TEXT,
  has_image    INTEGER DEFAULT 0,
  lang         TEXT,
  chars        INTEGER DEFAULT 0,
  views        INTEGER DEFAULT 0,
  likes        INTEGER DEFAULT 0,
  comments     INTEGER DEFAULT 0,
  shares       INTEGER DEFAULT 0,
  reactions    INTEGER DEFAULT 0,
  posted_at    INTEGER,
  sampled_at   INTEGER,
  seen_count   INTEGER DEFAULT 1,
  is_ours      INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_board_sampled ON square_board_samples(sampled_at DESC);
CREATE INDEX IF NOT EXISTS idx_board_coin ON square_board_samples(coin);

CREATE TABLE IF NOT EXISTS events (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  at    INTEGER NOT NULL,
  kind  TEXT NOT NULL,
  detail TEXT
);

-- Rolling attention history. This is what lets a post say "连续第 3 个小时放量"
-- instead of only ever describing one instant.
CREATE TABLE IF NOT EXISTS attention_samples (
  symbol     TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  score      REAL NOT NULL,
  price      REAL,
  parts_json TEXT,
  PRIMARY KEY (symbol, ts)
);
CREATE INDEX IF NOT EXISTS idx_attention_symbol_ts ON attention_samples(symbol, ts DESC);

-- One authoritative post per attention rise, so a hot coin is not milked hourly.
-- account_id makes it an exclusive lock across the matrix: while one account holds a
-- symbol, no other account may publish that same coin.
CREATE TABLE IF NOT EXISTS attention_claims (
  symbol     TEXT PRIMARY KEY,
  claimed_at INTEGER NOT NULL,
  post_id    INTEGER,
  peak_score REAL,
  account_id INTEGER
);

/*
 * The account matrix. One row per Binance Square account: its own persona, cadence and
 * optionally its own egress proxy. The key is deliberately NOT stored here — it lives in
 * the secret store under an account-scoped name, so a dump of this table is harmless and
 * the API can list accounts without ever touching plaintext credentials.
 */
CREATE TABLE IF NOT EXISTS accounts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  label                TEXT NOT NULL,
  owner                TEXT NOT NULL DEFAULT '',
  enabled              INTEGER NOT NULL DEFAULT 0,
  proxy_url            TEXT NOT NULL DEFAULT '',
  style                TEXT NOT NULL DEFAULT 'mixed',
  -- Their drawer lets one account own several voices and pick per post. For a matrix
  -- this is the cheapest real variety lever, so it is stored as a list.
  styles_json          TEXT,
  -- Stored and editable, but nothing converts output yet. Either wire it or drop it;
  -- do not treat it as a working setting.
  lang                 TEXT NOT NULL DEFAULT 'zh-CN',
  auto_publish         INTEGER,                    -- NULL = inherit the global switch
  blocked_symbols_json   TEXT,                     -- never post these coins on this account
  blocked_templates_json TEXT,                     -- this account may not use these templates
  persona_note         TEXT NOT NULL DEFAULT '',
  categories_json      TEXT,                        -- NULL = every category
  symbols_json         TEXT,                        -- NULL = whatever the pool assigns
  posts_per_day        INTEGER,                     -- NULL = inherit the global cadence
  min_interval_minutes INTEGER,
  active_start_hour    INTEGER,
  active_end_hour      INTEGER,
  -- Accounts share a day but must not share a minute: this offsets their timeline so a
  -- ten-account matrix interleaves instead of firing in one recognisable burst.
  phase_minutes        INTEGER NOT NULL DEFAULT 0,
  paused_until         INTEGER,
  last_error           TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
`;

export class Store {
  constructor(readonly db: Database.Database) {}

  static open(path: string): Store {
    const abs = resolve(path);
    mkdirSync(dirname(abs), { recursive: true });
    const db = new Database(abs);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    const s = new Store(db);
    s.migrate();
    return s;
  }

  /**
   * `CREATE TABLE IF NOT EXISTS` cannot evolve a table that already exists, so
   * columns added after the first release are patched in here.
   */
  private migrate(): void {
    const has = (table: string, column: string): boolean =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === column);
    if (!has('posts', 'images_json')) this.db.exec('ALTER TABLE posts ADD COLUMN images_json TEXT');
    if (!has('posts', 'account_id')) this.db.exec('ALTER TABLE posts ADD COLUMN account_id INTEGER');
    if (!has('attention_claims', 'account_id')) this.db.exec('ALTER TABLE attention_claims ADD COLUMN account_id INTEGER');
    for (const [col, decl] of [
      ['styles_json', 'TEXT'],
      ['lang', "TEXT NOT NULL DEFAULT 'zh-CN'"],
      ['auto_publish', 'INTEGER'],
      ['blocked_symbols_json', 'TEXT'],
      ['blocked_templates_json', 'TEXT'],
    ] as const) {
      if (!has('accounts', col)) this.db.exec(`ALTER TABLE accounts ADD COLUMN ${col} ${decl}`);
    }
    // CREATE TABLE IF NOT EXISTS never evolves a table that already exists, so both
    // stats tables need the columns listed here as well as in SCHEMA.
    for (const col of ['shares', 'reactions']) {
      if (!has('post_stats', col)) this.db.exec(`ALTER TABLE post_stats ADD COLUMN ${col} INTEGER`);
      if (!has('post_stat_checks', col)) this.db.exec(`ALTER TABLE post_stat_checks ADD COLUMN ${col} INTEGER`);
    }
  }

  close(): void {
    this.db.close();
  }

  /* ------------------------------------------------------------ materials */

  insertMaterial(m: Material): boolean {
    const exists = this.db.prepare('SELECT 1 FROM materials WHERE id = ?').get(m.id);
    if (exists) return false;
    this.db
      .prepare(
        `INSERT INTO materials (id, category, sub_type, title, symbol, sentiment, score, source, occurred_at, collected_at, fingerprint, facts_json)
         VALUES (@id, @category, @subType, @title, @symbol, @sentiment, @score, @source, @occurredAt, @collectedAt, @fingerprint, @facts)`,
      )
      .run({
        id: m.id,
        category: m.category,
        subType: m.subType,
        title: m.title,
        symbol: m.symbol,
        sentiment: m.sentiment,
        score: m.score,
        source: m.source,
        occurredAt: m.at,
        collectedAt: m.collectedAt,
        fingerprint: m.fingerprint,
        facts: JSON.stringify(m.facts),
      });
    return true;
  }

  hasRecentFingerprint(fingerprint: string, sinceMs: number): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM materials WHERE fingerprint = ? AND occurred_at >= ? LIMIT 1')
      .get(fingerprint, sinceMs);
    return Boolean(row);
  }

  recentMaterials(limit = 100): Material[] {
    const rows = this.db
      .prepare('SELECT * FROM materials WHERE discarded = 0 ORDER BY occurred_at DESC LIMIT ?')
      .all(limit) as MaterialRow[];
    return rows.map(rowToMaterial);
  }

  /** Needed to re-render a post from its original material. */
  materialById(id: string): Material | undefined {
    const row = this.db.prepare('SELECT * FROM materials WHERE id = ?').get(id) as MaterialRow | undefined;
    return row ? rowToMaterial(row) : undefined;
  }

  /** Materials that have never been turned into a post yet, best first. */
  unusedMaterials(limit = 20): Material[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM materials m
         WHERE m.discarded = 0 AND m.used_count = 0
           AND m.occurred_at >= ?
         ORDER BY m.score DESC, m.occurred_at DESC LIMIT ?`,
      )
      .all(Date.now() - 6 * 3600_000, limit) as MaterialRow[];
    return rows.map(rowToMaterial);
  }

  markMaterialUsed(id: string): void {
    this.db.prepare('UPDATE materials SET used_count = used_count + 1 WHERE id = ?').run(id);
  }

  /**
   * The list view's query: posts joined to what they were about and how they did.
   *
   * Attribution happens in SQL rather than in the browser because the same join backs both
   * the list labels and the analysis; two implementations would drift, and the drift would
   * show up as the page and the summary disagreeing about what a post was.
   */
  postsForList(opts: { statuses: string[]; sort?: 'recent' | 'views'; limit?: number }): (PostRow & ListAttribution)[] {
    const marks = opts.statuses.map(() => '?').join(',');
    // A post with no reading must not be treated as zero views — sorted next to a real 0 it
    // would read as "measured and nobody watched", which is a different fact.
    const order =
      opts.sort === 'views'
        ? 'ORDER BY (s.views IS NULL) ASC, s.views DESC, p.id DESC'
        : 'ORDER BY p.id DESC';
    return this.db
      .prepare(
        `SELECT p.*, m.category, m.sub_type, m.symbol, t.name AS template_name, t.style,
                a.label AS account_label, s.views, s.likes, s.comments, s.shares, s.reactions, s.checked_at
         FROM posts p
         LEFT JOIN materials m ON m.id = p.material_id
         LEFT JOIN templates t ON t.id = p.template_id
         LEFT JOIN accounts a ON a.id = p.account_id
         LEFT JOIN post_stats s ON s.post_id = p.id
         WHERE p.status IN (${marks})
         ${order}
         LIMIT ?`,
      )
      .all(...opts.statuses, opts.limit ?? 150) as (PostRow & ListAttribution)[];
  }

  /* ------------------------------------------------------------ templates */

  /** Upsert built-in templates without clobbering a tuned weight or a disable flag. */
  syncTemplates(defs: TemplateDef[]): void {
    const tx = this.db.transaction(() => {
      for (const t of defs) {
        this.db
          .prepare(
            `INSERT INTO templates (id, name, category, sub_type, style, body, requires_json, weight, enabled, source)
             VALUES (@id, @name, @category, @subType, @style, @body, @requires, 1, 1, 'builtin')
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name, body = excluded.body, category = excluded.category,
               sub_type = excluded.sub_type, style = excluded.style, requires_json = excluded.requires_json`,
          )
          .run({
            id: t.id,
            name: t.name,
            category: t.category,
            subType: t.subType ?? null,
            style: t.style,
            body: t.body,
            requires: JSON.stringify(t.requires ?? []),
          });
      }
    });
    tx();
  }

  allTemplates(): (TemplateDef & { weight: number; enabled: boolean })[] {
    const rows = this.db.prepare('SELECT * FROM templates WHERE enabled = 1').all() as TemplateRow[];
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      category: r.category,
      subType: r.sub_type ?? undefined,
      style: r.style,
      body: r.body,
      requires: r.requires_json ? (JSON.parse(r.requires_json) as TemplateDef['requires']) : [],
      weight: r.weight,
      enabled: true,
    }));
  }

  setTemplateWeight(id: string, weight: number): void {
    this.db.prepare('UPDATE templates SET weight = ? WHERE id = ?').run(weight, id);
  }

  setTemplateEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE templates SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  /* ----------------------------------------------------------------- posts */

  addPost(p: {
    materialId: string | null;
    templateId: string | null;
    text: string;
    status: string;
    scheduledAt: number | null;
    facts?: unknown;
    trace?: unknown;
    images?: string[];
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO posts (material_id, template_id, text, status, created_at, scheduled_at, facts_json, trace_json, images_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.materialId,
        p.templateId,
        p.text,
        p.status,
        Date.now(),
        p.scheduledAt,
        JSON.stringify(p.facts ?? null),
        JSON.stringify(p.trace ?? null),
        JSON.stringify(p.images ?? []),
      );
    return Number(res.lastInsertRowid);
  }

  /** Chart file paths still pointed at by a live post — anything else is reclaimable. */
  referencedChartFiles(): string[] {
    const out = new Set<string>();
    const rows = this.db
      .prepare("SELECT images_json FROM posts WHERE images_json IS NOT NULL AND images_json != '[]' AND status != 'rejected'")
      .all() as { images_json: string }[];
    for (const r of rows) {
      try {
        for (const f of JSON.parse(r.images_json) as string[]) if (f) out.add(f);
      } catch {
        /* a malformed row must not abort the sweep */
      }
    }
    return [...out];
  }

  /** Approved posts waiting on one account's next slot. */
  approvedForAccount(accountId: number, limit = 20): PostRow[] {
    return this.db
      .prepare("SELECT * FROM posts WHERE status = 'approved' AND account_id = ? ORDER BY scheduled_at ASC, id ASC LIMIT ?")
      .all(accountId, limit) as PostRow[];
  }

  postsByStatus(status: string, limit = 50) {
    return this.db.prepare('SELECT * FROM posts WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit) as PostRow[];
  }

  postById(id: number): PostRow | undefined {
    return this.db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as PostRow | undefined;
  }

  updatePostText(id: number, text: string): void {
    this.db.prepare('UPDATE posts SET text = ? WHERE id = ?').run(text, id);
  }

  materialCounts(): { category: string; n: number; best: number }[] {
    return this.db
      .prepare('SELECT category, COUNT(*) AS n, MAX(score) AS best FROM materials WHERE discarded = 0 GROUP BY category ORDER BY n DESC')
      .all() as { category: string; n: number; best: number }[];
  }

  unusedCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM materials WHERE discarded = 0 AND used_count = 0 AND occurred_at >= ?')
      .get(Date.now() - 6 * 3600_000) as { n: number };
    return row.n;
  }

  updatePost(
    id: number,
    patch: Partial<
      { status: string; squarePostId: string | null; url: string | null; error: string | null; publishedAt: number; accountId: number | null }
    >,
  ): void {
    const sets: string[] = [];
    const args: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${camelToSnake(k)} = @${k}`);
      args[k] = v;
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = @id`).run(args);
  }

  /**
   * Texts to deduplicate against. Defaults to the posts that will actually reach a
   * reader — published, queued, or in the uncertain pile. Drafts are candidates under
   * review; letting them block each other turns a growing backlog into a mute button.
   */
  recentPostTexts(limit = 40, statuses: string[] = ['published', 'approved', 'uncertain'], accountId: number | null = null): string[] {
    const marks = statuses.map(() => '?').join(',');
    // Scoped to one account when given: an account's own cooldown is about repetition,
    // which is a different question from what the rest of the matrix has already said.
    const scope = accountId === null ? '' : `AND account_id = ${Number(accountId)}`;
    return (
      this.db
        .prepare(`SELECT text FROM posts WHERE status IN (${marks}) ${scope} ORDER BY id DESC LIMIT ?`)
        .all(...statuses, limit) as { text: string }[]
    ).map(r => r.text);
  }

  publishedToday(sinceUtcMs: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM posts WHERE status = 'published' AND published_at >= ?`)
      .get(sinceUtcMs) as { n: number };
    return row.n;
  }

  /* ------------------------------------------------------------- stats */

  upsertPostStats(postId: number, s: StatSample): void {
    this.db
      .prepare(
        `INSERT INTO post_stats (post_id, checked_at, views, likes, comments, shares, reactions, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(post_id) DO UPDATE SET checked_at = excluded.checked_at, views = excluded.views,
           likes = excluded.likes, comments = excluded.comments, shares = excluded.shares,
           reactions = excluded.reactions, raw_json = excluded.raw_json`,
      )
      .run(postId, Date.now(), s.views, s.likes, s.comments, s.shares ?? null, s.reactions ?? null, JSON.stringify(s.raw ?? null));
  }

  /**
   * Record a checkpoint sample. `post_stats` keeps the newest read for cheap display;
   * `post_stat_checks` keeps the curve and doubles as the "which checkpoints are done"
   * set that the scheduler reads.
   */
  recordPostStats(postId: number, checkpoint: number, s: StatSample): void {
    this.upsertPostStats(postId, s);
    this.db
      .prepare(
        `INSERT INTO post_stat_checks (post_id, checkpoint, at, views, likes, comments, shares, reactions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(post_id, checkpoint) DO UPDATE SET at = excluded.at, views = excluded.views,
           likes = excluded.likes, comments = excluded.comments, shares = excluded.shares,
           reactions = excluded.reactions`,
      )
      .run(postId, checkpoint, Date.now(), s.views, s.likes, s.comments, s.shares ?? null, s.reactions ?? null);
  }

  /** Which checkpoints have already been measured for a post. */
  statCheckpoints(postId: number): number[] {
    return (
      this.db.prepare('SELECT checkpoint FROM post_stat_checks WHERE post_id = ? ORDER BY checkpoint').all(postId) as {
        checkpoint: number;
      }[]
    ).map(r => r.checkpoint);
  }

  /** The measured growth curve, oldest checkpoint first. */
  statCurve(postId: number): (StatSample & { checkpoint: number; at: number })[] {
    return this.db
      .prepare('SELECT checkpoint, at, views, likes, comments, shares, reactions FROM post_stat_checks WHERE post_id = ? ORDER BY checkpoint')
      .all(postId) as (StatSample & { checkpoint: number; at: number })[];
  }

  /** Latest numbers for a batch of posts, so a list view costs one query instead of N. */
  statsByPost(ids: number[]): Map<number, StatSample & { checked_at: number }> {
    const out = new Map<number, StatSample & { checked_at: number }>();
    if (!ids.length) return out;
    const rows = this.db
      .prepare(`SELECT post_id, views, likes, comments, shares, reactions, checked_at FROM post_stats WHERE post_id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as (StatSample & { post_id: number; checked_at: number })[];
    for (const r of rows) out.set(r.post_id, { views: r.views, likes: r.likes, comments: r.comments, shares: r.shares, reactions: r.reactions, checked_at: r.checked_at });
    return out;
  }

  /** Published posts whose Square id we know, for the stats sweep. */
  publishedWithSquareId(limit = 50) {
    return this.db
      .prepare(
        `SELECT id, square_post_id, COALESCE(published_at, created_at) AS posted_at
         FROM posts WHERE status = 'published' AND square_post_id IS NOT NULL
         ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as { id: number; square_post_id: string; posted_at: number }[];
  }

  /** Per-template performance, used to nudge weights toward what actually reads well. */
  templatePerformance(): { template_id: string; name: string | null; weight: number; posts: number; avg_views: number }[] {
    return this.db
      .prepare(
        `SELECT p.template_id, t.name, COALESCE(t.weight, 1) AS weight, COUNT(*) AS posts, AVG(s.views) AS avg_views
         FROM posts p JOIN post_stats s ON s.post_id = p.id
         LEFT JOIN templates t ON t.id = p.template_id
         WHERE p.template_id IS NOT NULL AND s.views IS NOT NULL
         GROUP BY p.template_id
         ORDER BY avg_views DESC`,
      )
      .all() as { template_id: string; name: string | null; weight: number; posts: number; avg_views: number }[];
  }

  /* --------------------------------------------------------- board benchmarks */

  /**
   * Store a board sweep. A post that shows up twice updates in place and increments
   * seen_count rather than becoming two rows — otherwise the benchmark pool is a count of
   * our polling, not a count of posts.
   */
  upsertBoardSamples(rows: BoardSample[]): number {
    const stmt = this.db.prepare(
      `INSERT INTO square_board_samples
       (content_id, board, title, author, coin, coins_json, hashtags_json, card_type, has_image, lang, chars,
        views, likes, comments, shares, reactions, posted_at, sampled_at, seen_count, is_ours)
       VALUES (@content_id, @board, @title, @author, @coin, @coins_json, @hashtags_json, @card_type, @has_image, @lang, @chars,
               @views, @likes, @comments, @shares, @reactions, @posted_at, @sampled_at, 1, @is_ours)
       ON CONFLICT(content_id) DO UPDATE SET
         board = excluded.board, title = excluded.title, author = excluded.author,
         coin = excluded.coin, coins_json = excluded.coins_json, hashtags_json = excluded.hashtags_json,
         card_type = excluded.card_type, has_image = excluded.has_image, lang = excluded.lang,
         chars = excluded.chars, views = excluded.views, likes = excluded.likes, comments = excluded.comments,
         shares = excluded.shares, reactions = excluded.reactions, posted_at = excluded.posted_at,
         sampled_at = excluded.sampled_at, is_ours = excluded.is_ours,
         seen_count = square_board_samples.seen_count + 1`,
    );
    let n = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        stmt.run(r);
        n++;
      }
    })();
    return n;
  }

  /**
   * View counts of the comparison pool. Our own posts are excluded: measuring ourselves
   * against ourselves would flatter every number downstream.
   */
  boardViewPool(filter: { coin?: string | null; cardType?: string | null; board?: string | null } = {}): number[] {
    const where: string[] = ['is_ours = 0'];
    const args: (string | number)[] = [];
    for (const [col, val] of [['coin', filter.coin], ['card_type', filter.cardType], ['board', filter.board]] as const) {
      if (val) {
        where.push(`${col} = ?`);
        args.push(val);
      }
    }
    return (this.db.prepare(`SELECT views FROM square_board_samples WHERE ${where.join(' AND ')}`).all(...args) as { views: number }[]).map(r => r.views);
  }

  boardCount(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM square_board_samples').get() as { c: number }).c;
  }

  /** Top board rows for the panel, newest sweep first. */
  boardRows(limit = 30): BoardRow[] {
    return this.db
      .prepare('SELECT * FROM square_board_samples ORDER BY sampled_at DESC, views DESC LIMIT ?')
      .all(limit) as BoardRow[];
  }

  /**
   * Whether a post of ours ever appeared on a public board. Surfacing is the outcome the
   * feed controls, so this is reported separately from raw views: a post that never
   * surfaces can still earn views, and the two need different fixes.
   */
  surfacedPostIds(ids: string[]): Set<string> {
    if (!ids.length) return new Set();
    const rows = this.db
      .prepare(`SELECT content_id FROM square_board_samples WHERE content_id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as { content_id: string }[];
    return new Set(rows.map(r => r.content_id));
  }

  pruneBoardSamples(horizon: number): number {
    return this.db.prepare('DELETE FROM square_board_samples WHERE sampled_at < ?').run(horizon).changes;
  }

  /**
   * Published posts joined to what they were about and how they did — the single dataset
   * every aggregate and every conclusion is computed from. `post_stats` holds the latest
   * reading, so a number here is the most recent measurement, not a lifetime total.
   */
  performanceRows(days = 30): PerformanceRow[] {
    return this.db
      .prepare(
        `SELECT p.id, COALESCE(p.published_at, p.created_at) AS published_at, p.account_id, a.label AS account_label,
                p.template_id, t.name AS template_name, t.style,
                m.category, m.sub_type, m.symbol, p.text,
                CASE WHEN p.images_json IS NOT NULL AND p.images_json NOT IN ('', '[]') THEN 1 ELSE 0 END AS has_chart,
                LENGTH(p.text) AS chars,
                s.views, s.likes, s.comments, s.shares, s.reactions, p.square_post_id
         FROM posts p
         LEFT JOIN materials m ON m.id = p.material_id
         LEFT JOIN templates t ON t.id = p.template_id
         LEFT JOIN accounts a ON a.id = p.account_id
         LEFT JOIN post_stats s ON s.post_id = p.id
         WHERE p.status = 'published' AND COALESCE(p.published_at, p.created_at) >= ?
         ORDER BY published_at DESC`,
      )
      .all(Date.now() - days * 86_400_000) as PerformanceRow[];
  }

  /* ------------------------------------------------------------- settings */
  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  log(kind: string, detail: unknown): void {
    this.db.prepare('INSERT INTO events (at, kind, detail) VALUES (?, ?, ?)').run(Date.now(), kind, JSON.stringify(detail));
  }

  /** Most recent publish timestamp, optionally for one account only. */
  lastPublishAt(accountId: number | null = null, now = Date.now()): number {
    const row = accountId === null
      ? this.db
          .prepare("SELECT MAX(published_at) AS t FROM posts WHERE status IN ('published','uncertain') AND published_at <= ?")
          .get(now)
      : this.db
          .prepare("SELECT MAX(published_at) AS t FROM posts WHERE account_id = ? AND status IN ('published','uncertain') AND published_at <= ?")
          .get(accountId, now);
    return (row as { t: number | null }).t ?? 0;
  }

  lastEvent(kind: string) {
    return this.db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind) as { at: number; detail: string } | undefined;
  }

  /* ----------------------------------------------------------- attention */

  recordSample(s: { symbol: string; ts: number; score: number; price: number | null; parts: Record<string, unknown> }): void {
    this.db
      .prepare(
        `INSERT INTO attention_samples (symbol, ts, score, price, parts_json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(symbol, ts) DO UPDATE SET score = excluded.score, price = excluded.price, parts_json = excluded.parts_json`,
      )
      .run(s.symbol, s.ts, s.score, s.price, JSON.stringify(s.parts));
  }

  samplesFor(symbol: string, sinceMs: number): { ts: number; score: number; price: number | null; parts: Record<string, unknown> }[] {
    const rows = this.db
      .prepare('SELECT ts, score, price, parts_json FROM attention_samples WHERE symbol = ? AND ts >= ? ORDER BY ts ASC')
      .all(symbol, sinceMs) as { ts: number; score: number; price: number | null; parts_json: string }[];
    return rows.map(r => ({ ts: r.ts, score: r.score, price: r.price, parts: JSON.parse(r.parts_json || '{}') }));
  }

  latestSample(symbol: string) {
    return this.db
      .prepare('SELECT ts, score, price FROM attention_samples WHERE symbol = ? ORDER BY ts DESC LIMIT 1')
      .get(symbol) as { ts: number; score: number; price: number | null } | undefined;
  }

  distinctSymbolsSince(sinceMs: number): string[] {
    return (this.db.prepare('SELECT DISTINCT symbol FROM attention_samples WHERE ts >= ?').all(sinceMs) as { symbol: string }[]).map(r => r.symbol);
  }

  pruneSamples(olderThanMs: number): number {
    return this.db.prepare('DELETE FROM attention_samples WHERE ts < ?').run(olderThanMs).changes;
  }

  claim(symbol: string, postId: number, peakScore: number, accountId: number | null = null): void {
    this.db
      .prepare(
        `INSERT INTO attention_claims (symbol, claimed_at, post_id, peak_score, account_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET claimed_at = excluded.claimed_at, post_id = excluded.post_id,
           peak_score = excluded.peak_score, account_id = excluded.account_id`,
      )
      .run(symbol, Date.now(), postId, peakScore, accountId);
  }

  getClaim(symbol: string): { claimed_at: number; post_id: number | null; peak_score: number; account_id: number | null } | undefined {
    return this.db
      .prepare('SELECT claimed_at, post_id, peak_score, account_id FROM attention_claims WHERE symbol = ?')
      .get(symbol) as
      | { claimed_at: number; post_id: number | null; peak_score: number; account_id: number | null }
      | undefined;
  }

  releaseClaimsForAccount(accountId: number): number {
    return this.db.prepare('DELETE FROM attention_claims WHERE account_id = ?').run(accountId).changes;
  }

  /* ------------------------------------------------------------- accounts */

  createAccount(a: {
    label: string;
    owner?: string;
    style?: string;
    styles?: string[] | null;
    lang?: string;
    autoPublish?: boolean | null;
    personaNote?: string;
    proxyUrl?: string;
    postsPerDay?: number | null;
    minIntervalMinutes?: number | null;
    activeStartHour?: number | null;
    activeEndHour?: number | null;
    categories?: string[] | null;
    symbols?: string[] | null;
    blockedSymbols?: string[] | null;
    blockedTemplates?: string[] | null;
    phaseMinutes?: number;
    enabled?: boolean;
  }): number {
    const now = Date.now();
    const res = this.db
      .prepare(
        `INSERT INTO accounts (label, owner, enabled, proxy_url, style, styles_json, lang, auto_publish, persona_note,
           categories_json, symbols_json, blocked_symbols_json, blocked_templates_json,
           posts_per_day, min_interval_minutes, active_start_hour, active_end_hour, phase_minutes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.label.trim(),
        (a.owner ?? '').trim(),
        a.enabled ? 1 : 0,
        (a.proxyUrl ?? '').trim(),
        a.style ?? 'mixed',
        a.styles?.length ? JSON.stringify(a.styles) : null,
        a.lang === 'zh-TW' ? 'zh-TW' : 'zh-CN',
        a.autoPublish === undefined || a.autoPublish === null ? null : a.autoPublish ? 1 : 0,
        (a.personaNote ?? '').trim(),
        a.categories?.length ? JSON.stringify(a.categories) : null,
        a.symbols?.length ? JSON.stringify(a.symbols) : null,
        a.blockedSymbols?.length ? JSON.stringify(a.blockedSymbols) : null,
        a.blockedTemplates?.length ? JSON.stringify(a.blockedTemplates) : null,
        a.postsPerDay ?? null,
        a.minIntervalMinutes ?? null,
        a.activeStartHour ?? null,
        a.activeEndHour ?? null,
        Math.max(0, Math.min(1439, Math.round(a.phaseMinutes ?? 0))),
        now,
        now,
      );
    return Number(res.lastInsertRowid);
  }

  updateAccount(
    id: number,
    patch: Partial<{
      label: string;
      owner: string;
      enabled: number;
      proxyUrl: string;
      style: string;
      stylesJson: string | null;
      lang: string;
      autoPublish: number | null;
      personaNote: string;
      categoriesJson: string | null;
      symbolsJson: string | null;
      blockedSymbolsJson: string | null;
      blockedTemplatesJson: string | null;
      postsPerDay: number | null;
      minIntervalMinutes: number | null;
      activeStartHour: number | null;
      activeEndHour: number | null;
      phaseMinutes: number;
      pausedUntil: number | null;
      lastError: string | null;
    }>,
  ): void {
    const cols: string[] = [];
    const args: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${camelToSnake(k)} = @${k}`);
      args[k] = v;
    }
    if (!cols.length) return;
    cols.push('updated_at = @now');
    args.now = Date.now();
    this.db.prepare(`UPDATE accounts SET ${cols.join(', ')} WHERE id = @id`).run(args);
  }

  deleteAccount(id: number): void {
    this.db.prepare('DELETE FROM attention_claims WHERE account_id = ?').run(id);
    this.db.prepare('UPDATE posts SET account_id = NULL WHERE account_id = ?').run(id);
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  }

  allAccounts(): AccountRow[] {
    return this.db.prepare('SELECT * FROM accounts ORDER BY enabled DESC, id ASC').all() as AccountRow[];
  }

  accountById(id: number): AccountRow | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
  }

  /** Accounts that should actually be driven: switched on, and not auto-paused. */
  activeAccounts(now = Date.now()): AccountRow[] {
    return this.db
      .prepare('SELECT * FROM accounts WHERE enabled = 1 AND (paused_until IS NULL OR paused_until < ?) ORDER BY id')
      .all(now) as AccountRow[];
  }

  /** Posts already committed to an account today, for its own quota. */
  accountPostsToday(accountId: number, sinceUtcMs: number): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'published' AND published_at >= ?")
        .get(accountId, sinceUtcMs) as { n: number }
    ).n;
  }

  /**
   * Recent posts from every account *except* one — the cross-account difference gate
   * reads this. The caller's own history is left out because it is governed by its own
   * cooldown, and blending the two would hide which rule rejected a draft.
   */
  recentPostsFromOthers(
    excludeAccountId: number | null,
    sinceMs: number,
    limit = 80,
    statuses: string[] = ['published', 'approved', 'uncertain', 'draft'],
  ): { text: string; account_id: number | null; label: string | null }[] {
    const placeholders = statuses.map(() => '?').join(',');
    // "Other accounts" means accounts. Rows with no account predate the matrix (or came
    // from the CLI) and must not silently block every account from a whole template.
    const scope =
      excludeAccountId === null
        ? 'AND account_id IS NOT NULL'
        : `AND account_id IS NOT NULL AND account_id != ${Number(excludeAccountId)}`;
    return this.db
      .prepare(
        `SELECT p.text, p.account_id, a.label
         FROM posts p LEFT JOIN accounts a ON a.id = p.account_id
         WHERE p.status IN (${placeholders}) ${scope} AND p.created_at >= ?
         ORDER BY p.id DESC LIMIT ?`,
      )
      .all(...statuses, sinceMs, limit) as { text: string; account_id: number | null; label: string | null }[];
  }
}

export interface AccountRow {
  id: number;
  label: string;
  owner: string;
  enabled: number;
  proxy_url: string;
  style: string;
  styles_json: string | null;
  lang: string;
  auto_publish: number | null;
  persona_note: string;
  categories_json: string | null;
  symbols_json: string | null;
  blocked_symbols_json: string | null;
  blocked_templates_json: string | null;
  posts_per_day: number | null;
  min_interval_minutes: number | null;
  active_start_hour: number | null;
  active_end_hour: number | null;
  phase_minutes: number;
  paused_until: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface MaterialRow {
  id: string;
  category: string;
  sub_type: string;
  title: string;
  symbol: string | null;
  sentiment: Material['sentiment'];
  score: number;
  source: string;
  occurred_at: number;
  collected_at: number;
  fingerprint: string;
  facts_json: string;
}

interface TemplateRow {
  id: string;
  name: string;
  category: string;
  sub_type: string | null;
  style: string;
  body: string;
  requires_json: string | null;
  weight: number;
  enabled: number;
}

/** One read of a published post's counters, taken at a checkpoint. */
export interface StatSample {
  views: number;
  likes: number;
  comments: number;
  shares?: number | null;
  reactions?: number | null;
  raw?: unknown;
}

export interface PostRow {
  id: number;
  material_id: string | null;
  template_id: string | null;
  text: string;
  status: string;
  created_at: number;
  scheduled_at: number | null;
  published_at: number | null;
  square_post_id: string | null;
  account_id: number | null;
  url: string | null;
  error: string | null;
  images_json: string | null;
  facts_json: string | null;
  trace_json: string | null;
}

/** One row of the public-board sweep. Column names match the table for the upsert. */
export interface BoardSample {
  content_id: string;
  board: string;
  title: string;
  author: string | null;
  coin: string | null;
  coins_json: string;
  hashtags_json: string;
  card_type: string | null;
  has_image: number;
  lang: string | null;
  chars: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  reactions: number;
  posted_at: number;
  sampled_at: number;
  is_ours: number;
}

export type BoardRow = BoardSample & { seen_count: number };

/** What the list view adds on top of a post row: attribution and the latest reading. */
export interface ListAttribution {
  category: string | null;
  sub_type: string | null;
  symbol: string | null;
  template_name: string | null;
  style: string | null;
  account_label: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  reactions: number | null;
  checked_at: number | null;
}

/** A published post with everything an analysis needs to attribute its performance. */
export interface PerformanceRow {
  id: number;
  published_at: number | null;
  account_id: number | null;
  account_label: string | null;
  template_id: string | null;
  template_name: string | null;
  style: string | null;
  category: string | null;
  sub_type: string | null;
  symbol: string | null;
  text: string;
  has_chart: number;
  chars: number;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  reactions: number | null;
  square_post_id: string | null;
}

function rowToMaterial(r: MaterialRow): Material {
  return {
    id: r.id,
    category: r.category as Material['category'],
    subType: r.sub_type,
    title: r.title,
    symbol: r.symbol,
    symbols: r.symbol ? [r.symbol] : [],
    sentiment: r.sentiment,
    score: r.score,
    source: r.source,
    at: r.occurred_at,
    facts: JSON.parse(r.facts_json),
    fingerprint: r.fingerprint,
    collectedAt: r.collected_at,
  };
}

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
}
