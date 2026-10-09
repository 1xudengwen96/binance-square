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

/* ============================================================================
 * Studio — the 赛道 workspace.
 *
 * Deliberately its own tables rather than columns on posts. The main pipeline
 * optimises for variety (seven voices over one event); a 赛道 optimises for the
 * opposite (one voice, recognisable in three seconds). Sharing storage would let
 * each quietly redefine the other's rows, and the first symptom would be a teaching
 * account inheriting a mixed-style cadence it never asked for.
 * ========================================================================== */

-- One account, one track. The binding is what the persona lock enforces against.
CREATE TABLE IF NOT EXISTS studio_accounts (
  account_id   INTEGER PRIMARY KEY REFERENCES accounts(id),
  track_id     TEXT NOT NULL,
  bound_at     INTEGER NOT NULL,
  -- The account stops producing for the main matrix while studio owns it, so a single
  -- account cannot serve two contradictory personas on the same day.
  pause_matrix INTEGER NOT NULL DEFAULT 1,
  articles_per_day INTEGER,
  enabled      INTEGER NOT NULL DEFAULT 1
);

-- Curriculum state. The definition lives in code; this table holds what has been done
-- and how it went, so a restart never loses the account's accumulated course.
CREATE TABLE IF NOT EXISTS studio_concepts (
  concept_id   TEXT NOT NULL,
  track_id     TEXT NOT NULL,
  written      INTEGER NOT NULL DEFAULT 0,
  written_at   INTEGER,
  publish_count INTEGER NOT NULL DEFAULT 0,
  median_views INTEGER NOT NULL DEFAULT 0,
  samples      INTEGER NOT NULL DEFAULT 0,
  -- A concept can go stale (the example it used no longer holds). The scheduler re-offers
  -- these instead of treating written as permanently done.
  needs_update INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  PRIMARY KEY (concept_id, track_id)
);

CREATE TABLE IF NOT EXISTS studio_articles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id     TEXT NOT NULL,
  concept_id   TEXT NOT NULL,
  account_id   INTEGER REFERENCES accounts(id),
  -- The claim re-checker needs this: "持仓还在增加" is only falsifiable against the same
  -- coin's current data, not against anything in the article text.
  symbol       TEXT,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  sections_json TEXT,
  facts_json   TEXT,
  cover_path   TEXT,
  cover_url    TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',   -- draft|approved|published|rejected|uncertain|failed
  created_at   INTEGER NOT NULL,
  scheduled_at INTEGER,
  published_at INTEGER,
  square_post_id TEXT,
  url          TEXT,
  expires_at   INTEGER,      -- claims with a time window stop being safe to cite after this
  window_claims_json TEXT,   -- the falsifiable statements evidence.ts watches
  refusal_hits TEXT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_studio_article_status ON studio_articles(status, scheduled_at);

-- Measured outcomes per article, same checkpoint idea as post_stat_checks but with the
-- article-only fields. Views alone cannot tell a good article from a lucky coin.
CREATE TABLE IF NOT EXISTS studio_observations (
  article_id   INTEGER NOT NULL REFERENCES studio_articles(id),
  checkpoint   INTEGER NOT NULL,
  at           INTEGER NOT NULL,
  views        INTEGER,
  likes        INTEGER,
  comments     INTEGER,
  shares       INTEGER,
  reactions    INTEGER,
  subscribers  INTEGER,
  on_board     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (article_id, checkpoint)
);

-- What the module learned about itself. A published claim cannot be edited (the API is
-- create-only), so a contradicted claim is recorded and the phrasing is tightened going
-- forward — the only honest form of self-correction available.
CREATE TABLE IF NOT EXISTS studio_lessons (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id   INTEGER,
  concept_id   TEXT,
  kind         TEXT NOT NULL,       -- contradicted|confirmed|underperformed|overperformed
  detail       TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

/*
 * The robot's long-term memory. One ledger for every durable belief — what the distribution
 * engine rewards, what an audience responded to, what the operator said once and meant.
 *
 * Append-then-supersede rather than UPDATE: a belief that changed must leave behind the belief
 * it replaced, because "we used to think posting at 23:00 worked" is itself the kind of thing
 * that stops a system from repeating a mistake it already made once.
 */
CREATE TABLE IF NOT EXISTS brain_memory (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,             -- rank-rule|content-lesson|audience-fact|engine-model|instruction
  key          TEXT NOT NULL,             -- stable identity; a new finding on the same key retires the old one
  text         TEXT NOT NULL,
  confidence   REAL NOT NULL DEFAULT 0.5,
  evidence_n   INTEGER NOT NULL DEFAULT 0,
  source       TEXT NOT NULL,             -- rank-score|studio-evidence|brain|operator|audit
  status       TEXT NOT NULL DEFAULT 'active',   -- active|superseded|rejected|expired
  supersedes   INTEGER,
  superseded_by INTEGER,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  use_count    INTEGER NOT NULL DEFAULT 0,
  expires_at   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS brain_memory_active_key ON brain_memory(key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS brain_memory_kind ON brain_memory(kind, status);

/*
 * What the distribution engine did with a post, derived from the checkpoint curve.
 *
 * The absolute view count is the least informative number here: it mixes the coin's own heat
 * with the algorithm's decision. The *shape* is the decision — a post shown only to followers
 * stops growing within an hour, one that gets picked up keeps accruing, and the delay before it
 * first appears on a public board is the engine's own latency, measured rather than guessed.
 */
CREATE TABLE IF NOT EXISTS post_distribution (
  post_id      INTEGER PRIMARY KEY REFERENCES posts(id),
  first_read   INTEGER,
  v1h          INTEGER,
  v3h          INTEGER,
  v8h          INTEGER,
  v24h         INTEGER,
  growth_1h    REAL,
  late_share   REAL,
  surfaced     INTEGER NOT NULL DEFAULT 0,
  board_kind   TEXT,
  hours_to_board REAL,
  computed_at  INTEGER NOT NULL
);

/* Which arm of which experiment each post was written under. Without this the comparisons are
 * folklore — the assignment has to be on record before the outcome is known. */
CREATE TABLE IF NOT EXISTS post_arms (
  post_id     INTEGER NOT NULL REFERENCES posts(id),
  experiment  TEXT NOT NULL,
  arm         TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, experiment)
);

/*
 * The numbers Binance shows the operator but no public API returns: clicks, new followers,
 * rebate. Entered by hand, once a day, thirty seconds. Everything downstream is an apportionment
 * of these against view counts, which is a reasonable guess and not an accounting statement —
 * the panel says so wherever it uses them.
 */
CREATE TABLE IF NOT EXISTS conversion_daily (
  day        TEXT PRIMARY KEY,          -- Beijing date the operator read the dashboard
  clicks     INTEGER,
  followers  INTEGER,
  rebate_usd REAL,
  note       TEXT,
  entered_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS post_conversion (
  post_id     INTEGER PRIMARY KEY REFERENCES posts(id),
  rebate_usd  REAL NOT NULL DEFAULT 0,
  clicks      REAL NOT NULL DEFAULT 0,
  attributed_at INTEGER NOT NULL
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
    // The studio tables shipped first without `symbol`, and the panel created them before
    // the claim re-checker needed it. Same trap as above, so it is patched the same way.
    for (const [col, decl] of [
      ['symbol', 'TEXT'],
      ['refusal_hits', 'TEXT'],
      ['expires_at', 'INTEGER'],
      ['window_claims_json', 'TEXT'],
    ] as const) {
      if (!has('studio_articles', col)) this.db.exec(`ALTER TABLE studio_articles ADD COLUMN ${col} ${decl}`);
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
    // Articles count. The 100/day ceiling is per key, and a studio article spends it exactly
    // like a short post — a counter that ignored them let one account send 30 posts and 10
    // articles while reporting 30/30.
    const posts = this.db
      .prepare(`SELECT COUNT(*) AS n FROM posts WHERE status = 'published' AND published_at >= ?`)
      .get(sinceUtcMs) as { n: number };
    const articles = this.db
      .prepare(`SELECT COUNT(*) AS n FROM studio_articles WHERE status = 'published' AND published_at >= ?`)
      .get(sinceUtcMs) as { n: number };
    return posts.n + articles.n;
  }

  /** Drafts waiting for review plus approved posts waiting for their minute. */
  pendingQueueCount(accountId: number | null = null): number {
    const scope = accountId === null ? '' : 'AND account_id = @a';
    const params = accountId === null ? {} : { a: accountId };
    const rows = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM posts WHERE status IN ('draft','approved') ${scope}
         UNION ALL
         SELECT COUNT(*) AS n FROM studio_articles WHERE status IN ('draft','approved') ${scope}`,
      )
      .all(params) as { n: number }[];
    return rows.reduce((sum, r) => sum + r.n, 0);
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

  /**
   * Published articles shaped like `performanceRows`, so the time and account axes can treat
   * one content stream instead of two. The two tables will stay separate — an article carries a
   * concept, a tier and a claim-check that a post has no use for — but "what went out and when"
   * is the same question for both.
   */
  articleRows(days = 30): PerformanceRow[] {
    return this.db
      .prepare(
        `SELECT a.id, COALESCE(a.published_at, a.created_at) AS published_at, a.account_id, ac.label AS account_label,
                NULL AS template_id, a.concept_id AS template_name, '教学' AS style,
                a.concept_id AS category, NULL AS sub_type, a.symbol, a.title AS text,
                1 AS has_chart, LENGTH(a.body) AS chars,
                o.views, o.likes, o.comments, o.shares, o.reactions, a.square_post_id,
                o.subscribers, o.on_board AS surfaced
         FROM studio_articles a
         LEFT JOIN accounts ac ON ac.id = a.account_id
         LEFT JOIN studio_observations o ON o.article_id = a.id
           AND o.checkpoint = (SELECT MAX(checkpoint) FROM studio_observations WHERE article_id = a.id)
         WHERE a.status = 'published' AND COALESCE(a.published_at, a.created_at) >= ?
         ORDER BY published_at DESC`,
      )
      .all(Date.now() - days * 86_400_000) as PerformanceRow[];
  }

  /* ------------------------------------------------------------------ studio */

  studioBinding(accountId: number): StudioBinding | undefined {
    return this.db.prepare('SELECT * FROM studio_accounts WHERE account_id = ?').get(accountId) as StudioBinding | undefined;
  }

  /** Which accounts the studio owns. `pause_matrix` ones are excluded from the main feed. */
  studioAccounts(): (StudioBinding & { label: string; enabled_main: number })[] {
    return this.db
      .prepare('SELECT sa.*, a.label, a.enabled AS enabled_main FROM studio_accounts sa JOIN accounts a ON a.id = sa.account_id')
      .all() as (StudioBinding & { label: string; enabled_main: number })[];
  }

  bindStudioTrack(accountId: number, trackId: string, opts: { pauseMatrix?: boolean; articlesPerDay?: number | null } = {}): void {
    this.db
      .prepare(
        `INSERT INTO studio_accounts (account_id, track_id, bound_at, pause_matrix, articles_per_day, enabled)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(account_id) DO UPDATE SET
           track_id = excluded.track_id,
           pause_matrix = excluded.pause_matrix,
           articles_per_day = excluded.articles_per_day`,
      )
      .run(accountId, trackId, Date.now(), opts.pauseMatrix === false ? 0 : 1, opts.articlesPerDay ?? null);
  }

  unbindStudioTrack(accountId: number): void {
    this.db.prepare('DELETE FROM studio_accounts WHERE account_id = ?').run(accountId);
  }

  conceptStates(trackId: string): StudioConceptState[] {
    return this.db.prepare('SELECT * FROM studio_concepts WHERE track_id = ?').all(trackId) as StudioConceptState[];
  }

  /** Read the curriculum in, creating a row for any concept added since the last run. */
  ensureConceptRows(trackId: string, conceptIds: string[]): number {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO studio_concepts (concept_id, track_id, written) VALUES (?, ?, 0)',
    );
    let added = 0;
    this.db.transaction(() => {
      for (const id of conceptIds) added += stmt.run(id, trackId).changes;
    })();
    return added;
  }

  recordConceptWritten(conceptId: string, trackId: string, medianViews: number, samples: number): void {
    this.db
      .prepare(
        `UPDATE studio_concepts
         SET written = 1, written_at = ?, publish_count = publish_count + 1, median_views = ?, samples = ?, needs_update = 0
         WHERE concept_id = ? AND track_id = ?`,
      )
      .run(Date.now(), Math.round(medianViews), samples, conceptId, trackId);
  }

  markConceptStale(conceptId: string, trackId: string): void {
    this.db.prepare('UPDATE studio_concepts SET needs_update = 1 WHERE concept_id = ? AND track_id = ?').run(conceptId, trackId);
  }

  addArticle(a: {
    trackId: string;
    conceptId: string;
    accountId: number | null;
    symbol?: string | null;
    title: string;
    body: string;
    sections?: unknown;
    facts?: unknown;
    coverPath?: string | null;
    scheduledAt?: number | null;
    expiresAt?: number | null;
    windowClaims?: unknown;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO studio_articles
         (track_id, concept_id, account_id, symbol, title, body, sections_json, facts_json, cover_path, status, created_at, scheduled_at, expires_at, window_claims_json)
         VALUES (?,?,?,?,?,?,?,?,?,'draft',?,?,?,?)`,
      )
      .run(
        a.trackId, a.conceptId, a.accountId, a.symbol ?? null, a.title, a.body,
        JSON.stringify(a.sections ?? null), JSON.stringify(a.facts ?? null), a.coverPath ?? null,
        Date.now(), a.scheduledAt ?? null, a.expiresAt ?? null, JSON.stringify(a.windowClaims ?? null),
      );
    return Number(res.lastInsertRowid);
  }

  updateStudioArticle(id: number, patch: Partial<Record<string, unknown>> & { status?: string }): void {
    const map: Record<string, unknown> = {};
    const cols: Record<string, string> = {
      status: 'status', title: 'title', body: 'body', coverUrl: 'cover_url', coverPath: 'cover_path',
      scheduledAt: 'scheduled_at', publishedAt: 'published_at', squarePostId: 'square_post_id',
      url: 'url', error: 'error', refusalHits: 'refusal_hits', expiresAt: 'expires_at',
    };
    for (const [k, col] of Object.entries(cols)) {
      if (k in patch) map[col] = patch[k as keyof typeof patch];
    }
    if (!Object.keys(map).length) return;
    const keys = Object.keys(map);
    this.db
      .prepare(`UPDATE studio_articles SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @__id`)
      .run({ ...map, __id: id });
  }

  studioArticle(id: number): StudioArticle | undefined {
    return this.db.prepare('SELECT * FROM studio_articles WHERE id = ?').get(id) as StudioArticle | undefined;
  }

  /**
   * The latest minute an article for this account already owns — published, queued, or drafted.
   * Articles need their own clock: they live in a separate table, and a long post published two
   * minutes after another one costs the account reach it cannot get back.
   */
  lastArticleClaimAt(accountId: number, horizon = Date.now() + 7 * 86_400_000): number {
    const row = this.db
      .prepare(
        `SELECT MAX(COALESCE(published_at, scheduled_at, created_at)) AS t FROM studio_articles
         WHERE account_id = @a AND status IN ('draft','approved','published') AND COALESCE(scheduled_at, created_at) <= @h`,
      )
      .get({ a: accountId, h: horizon }) as { t: number | null };
    return row.t ?? 0;
  }

  studioArticles(status: string[] | 'all' = 'all', limit = 60): StudioArticle[] {
    if (status === 'all') {
      return this.db.prepare('SELECT * FROM studio_articles ORDER BY id DESC LIMIT ?').all(limit) as StudioArticle[];
    }
    const marks = status.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM studio_articles WHERE status IN (${marks}) ORDER BY id DESC LIMIT ?`).all(...status, limit) as StudioArticle[];
  }

  recordStudioObservation(articleId: number, checkpoint: number, s: StudioStatSample & { onBoard?: boolean }): void {
    this.db
      .prepare(
        `INSERT INTO studio_observations (article_id, checkpoint, at, views, likes, comments, shares, reactions, subscribers, on_board)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(article_id, checkpoint) DO UPDATE SET
           at = excluded.at, views = excluded.views, likes = excluded.likes, comments = excluded.comments,
           shares = excluded.shares, reactions = excluded.reactions, subscribers = excluded.subscribers,
           on_board = excluded.on_board`,
      )
      .run(articleId, checkpoint, Date.now(), s.views ?? null, s.likes ?? null, s.comments ?? null, s.shares ?? null, s.reactions ?? null, s.subscribers ?? null, s.onBoard ? 1 : 0);
  }

  studioObservations(articleId: number): (StudioStatSample & { checkpoint: number; at: number; on_board: number })[] {
    return this.db
      .prepare('SELECT checkpoint, at, views, likes, comments, shares, reactions, subscribers, on_board FROM studio_observations WHERE article_id = ? ORDER BY checkpoint')
      .all(articleId) as (StudioStatSample & { checkpoint: number; at: number; on_board: number })[];
  }

  /** Latest reading per article — the list view must not issue one query per row. */
  studioLatestStats(ids: number[]): Map<number, StudioStatSample & { at: number; on_board: number }> {
    const out = new Map<number, StudioStatSample & { at: number; on_board: number }>();
    if (!ids.length) return out;
    const rows = this.db
      .prepare(
        `SELECT o.article_id, o.at, o.views, o.likes, o.comments, o.shares, o.reactions, o.subscribers, o.on_board
         FROM studio_observations o
         JOIN (SELECT article_id, MAX(checkpoint) cp FROM studio_observations GROUP BY article_id) m
           ON m.article_id = o.article_id AND m.cp = o.checkpoint
         WHERE o.article_id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(...ids) as (StudioStatSample & { article_id: number; at: number; on_board: number })[];
    for (const r of rows) out.set(r.article_id, { at: r.at, views: r.views, likes: r.likes, comments: r.comments, shares: r.shares, reactions: r.reactions, subscribers: r.subscribers, on_board: r.on_board });
    return out;
  }

  addLesson(l: { articleId?: number | null; conceptId?: string | null; kind: string; detail: string }): void {
    this.db
      .prepare('INSERT INTO studio_lessons (article_id, concept_id, kind, detail, created_at) VALUES (?,?,?,?,?)')
      .run(l.articleId ?? null, l.conceptId ?? null, l.kind, l.detail, Date.now());
  }

  lessons(limit = 40): { id: number; article_id: number | null; concept_id: string | null; kind: string; detail: string; created_at: number }[] {
    return this.db.prepare('SELECT * FROM studio_lessons ORDER BY id DESC LIMIT ?').all(limit) as never;
  }

  /* ---------------------------------------------------------------- memory */

  /**
   * Record a durable belief. Same key + same sentence refreshes confidence and evidence; same key
   * with a different sentence retires the old one instead of overwriting it, so the history of
   * what we believed and stopped believing survives.
   */
  remember(m: {
    kind: string; key: string; text: string; confidence?: number; evidenceN?: number; source: string; ttlMinutes?: number;
  }): number {
    const now = Date.now();
    const existing = this.db
      .prepare("SELECT id, text, confidence, evidence_n FROM brain_memory WHERE key = ? AND status = 'active'")
      .get(m.key) as { id: number; text: string; confidence: number; evidence_n: number } | undefined;
    if (existing && existing.text === m.text) {
      this.db
        .prepare('UPDATE brain_memory SET confidence = ?, evidence_n = ?, last_used_at = ? WHERE id = ?')
        .run(m.confidence ?? existing.confidence, Math.max(existing.evidence_n, m.evidenceN ?? 0), now, existing.id);
      return existing.id;
    }
    if (existing) {
      this.db.prepare('UPDATE brain_memory SET status = ?, superseded_by = NULL, last_used_at = ? WHERE id = ?')
        .run('superseded', now, existing.id);
    }
    const res = this.db
      .prepare(
        `INSERT INTO brain_memory (kind, key, text, confidence, evidence_n, source, created_at, supersedes, expires_at)
         VALUES (@k, @ke, @t, @c, @n, @s, @at, @sup, @exp)`,
      )
      .run({
        k: m.kind, ke: m.key, t: m.text, c: m.confidence ?? 0.5, n: m.evidenceN ?? 0, s: m.source, at: now,
        sup: existing?.id ?? null, exp: m.ttlMinutes ? now + m.ttlMinutes * 60_000 : null,
      });
    if (existing) this.db.prepare('UPDATE brain_memory SET superseded_by = ? WHERE id = ?').run(Number(res.lastInsertRowid), existing.id);
    return Number(res.lastInsertRowid);
  }

  activeMemory(kind?: string): MemoryRow[] {
    const sql = kind
      ? "SELECT * FROM brain_memory WHERE status = 'active' AND kind = ? ORDER BY confidence DESC, evidence_n DESC, id DESC"
      : "SELECT * FROM brain_memory WHERE status = 'active' ORDER BY confidence DESC, evidence_n DESC, id DESC";
    return (kind ? this.db.prepare(sql).all(kind) : this.db.prepare(sql).all()) as MemoryRow[];
  }

  touchMemory(ids: number[]): void {
    if (!ids.length) return;
    this.db
      .prepare(`UPDATE brain_memory SET last_used_at = ?, use_count = use_count + 1 WHERE id IN (${ids.map(() => '?').join(',')})`)
      .run(Date.now(), ...ids);
  }

  forgetMemory(key: string, reason: string): void {
    this.db
      .prepare("UPDATE brain_memory SET status = 'rejected', text = text || ' —— 已撤销：' || ? WHERE key = ? AND status = 'active'")
      .run(reason, key);
  }

  memoryLedger(limit = 200): (MemoryRow & { history_n: number })[] {
    return this.db
      .prepare(
        `SELECT b.*, (SELECT COUNT(*) FROM brain_memory h WHERE h.key = b.key) AS history_n
         FROM brain_memory b WHERE b.status = 'active' ORDER BY b.kind, b.confidence DESC LIMIT ?`,
      )
      .all(limit) as (MemoryRow & { history_n: number })[];
  }

  /* ----------------------------------------------------------- conversion */

  putConversion(day: string, v: { clicks?: number | null; followers?: number | null; rebateUsd?: number | null; note?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO conversion_daily (day, clicks, followers, rebate_usd, note, entered_at)
         VALUES (@d, @c, @f, @r, @n, @e)
         ON CONFLICT(day) DO UPDATE SET clicks = COALESCE(excluded.clicks, clicks), followers = COALESCE(excluded.followers, followers),
           rebate_usd = COALESCE(excluded.rebate_usd, rebate_usd), note = COALESCE(excluded.note, note), entered_at = excluded.entered_at`,
      )
      .run({ d: day, c: v.clicks ?? null, f: v.followers ?? null, r: v.rebateUsd ?? null, n: v.note ?? null, e: Date.now() });
  }

  conversions(days = 30): { day: string; clicks: number | null; followers: number | null; rebate_usd: number | null; note: string | null; entered_at: number }[] {
    return this.db.prepare('SELECT * FROM conversion_daily ORDER BY day DESC LIMIT ?').all(days) as never;
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

  /**
   * The latest moment already claimed by this account — published *or* merely scheduled.
   *
   * `lastPublishAt` alone cannot space a batch: during one tick nothing has gone out yet,
   * so every draft computes the same next slot and they all fire in the same minute. The
   * queue has to be part of the clock for the interval to mean anything.
   *
   * `beforeId` excludes one post from its own clock. Without it a draft scheduled for now
   * would see its own slot as a prior claim and push itself an interval into the future,
   * so nothing could ever be published — a self-block that looks identical to correct
   * spacing until you try it.
   */
  lastSlotClaimedAt(accountId: number | null = null, horizon = Date.now() + 86_400_000, before?: { id: number; at: number } | null): number {
    const published = this.lastPublishAt(accountId, horizon);
    // Only claims that sort strictly before the candidate count as "previous". Ties on the
    // same scheduled minute are broken by id, so a batch collapsed onto one slot releases
    // exactly one post instead of either all of them (the original bug) or none of them.
    const prior = before ? 'AND (COALESCE(scheduled_at, created_at) < @bAt OR (COALESCE(scheduled_at, created_at) = @bAt AND id < @bId))' : '';
    const params: Record<string, unknown> = accountId === null ? { h: horizon } : { a: accountId, h: horizon };
    if (before) {
      params.bAt = before.at;
      params.bId = before.id;
    }
    const scoped = accountId === null ? '' : 'account_id = @a AND';
    const row = this.db
      .prepare(
        `SELECT MAX(COALESCE(scheduled_at, created_at)) AS t FROM posts
         WHERE ${scoped} status IN ('draft','approved') AND COALESCE(scheduled_at, created_at) <= @h ${prior}`,
      )
      .get(params) as { t: number | null } | undefined;
    return Math.max(published, row?.t ?? 0);
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

  /**
   * Has this account already said something about this coin's this signal recently?
   *
   * The template fingerprint cannot catch it: four posts about one coin's funding rate were
   * written from four different templates over six hours, each technically fresh, together
   * reading as one person shouting about one number. The cooldown is per (coin, category)
   * because a coin's funding rate and its listing news are genuinely different subjects.
   */
  recentCoinSignal(accountId: number | null, symbol: string, category: string, sinceMs: number): number {
    const scope = accountId === null ? 'p.account_id IS NULL' : 'p.account_id = @a';
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM posts p JOIN materials m ON m.id = p.material_id
           WHERE ${scope} AND m.symbol = @s AND m.category = @c
             AND p.status IN ('draft','approved','published') AND COALESCE(p.published_at, p.created_at) >= @t`,
        )
        .get({ a: accountId, s: symbol, c: category, t: sinceMs }) as { n: number }
    ).n;
  }

  /** Posts already committed to an account today, for its own quota. */
  accountPostsToday(accountId: number, sinceUtcMs: number): number {
    const rows = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM posts WHERE account_id = @a AND status = 'published' AND published_at >= @s
         UNION ALL
         SELECT COUNT(*) AS n FROM studio_articles WHERE account_id = @a AND status = 'published' AND published_at >= @s`,
      )
      .all({ a: accountId, s: sinceUtcMs }) as { n: number }[];
    return rows.reduce((sum, r) => sum + r.n, 0);
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

/** An account's 赛道 binding. One track per account — that is the point of the table. */
export interface StudioBinding {
  account_id: number;
  track_id: string;
  bound_at: number;
  pause_matrix: number;
  articles_per_day: number | null;
  enabled: number;
}

export interface StudioConceptState {
  concept_id: string;
  track_id: string;
  written: number;
  written_at: number | null;
  publish_count: number;
  median_views: number;
  samples: number;
  needs_update: number;
  last_error: string | null;
}

export interface StudioArticle {
  id: number;
  track_id: string;
  concept_id: string;
  account_id: number | null;
  symbol: string | null;
  title: string;
  body: string;
  sections_json: string | null;
  facts_json: string | null;
  cover_path: string | null;
  cover_url: string | null;
  status: string;
  created_at: number;
  scheduled_at: number | null;
  published_at: number | null;
  square_post_id: string | null;
  url: string | null;
  expires_at: number | null;
  window_claims_json: string | null;
  refusal_hits: string | null;
  error: string | null;
}

export interface StudioStatSample {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  reactions: number | null;
  subscribers: number | null;
}

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

export interface MemoryRow {
  id: number;
  kind: string;
  key: string;
  text: string;
  confidence: number;
  evidence_n: number;
  source: string;
  status: string;
  supersedes: number | null;
  superseded_by: number | null;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
  expires_at: number | null;
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
  // Articles only: a post has no subscriber count, and "surfaced" for a post is answered by the
  // board-sample table rather than by a column on the row.
  subscribers?: number | null;
  surfaced?: number | null;
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
