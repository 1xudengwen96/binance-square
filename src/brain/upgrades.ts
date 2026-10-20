import type { Store } from '../db/index.ts';

/**
 * The brain's upgrade backlog: what it found that only a code change can fix.
 *
 * The brain may propose a hypothesis, a bounded parameter step or a wording variant, and each of
 * those has a gate. Everything else it notices — «the snapshot cannot tell coin heat from wording»,
 * «two tables disagree on the same count», «comments read 0 for two weeks, check the collector» —
 * is outside every gate, and until now it was a sentence in a report that nobody re-read. Here it
 * is a row: the operator (or whoever writes the code) picks it up, marks it done or refuses it, and
 * the next snapshot hands the row back, so the brain neither files a solved problem again nor keeps
 * asking for something the operator already declined.
 *
 * The brain writes these lines; it cannot act on them. Filing is a record, not a permission.
 */

export const UPGRADE_AREAS = {
  data: '数据与统计',
  experiment: '实验设计',
  content: '内容与模板',
  publish: '发布与调度',
  panel: '面板',
  other: '其他',
} as const;
export type UpgradeArea = keyof typeof UPGRADE_AREAS;
export type UpgradeStatus = 'open' | 'doing' | 'done' | 'wontfix';
export type UpgradeSource = 'weekly' | 'sentinel' | 'reflect' | 'operator';

export interface UpgradeInput {
  area: string;
  title: string;
  why: string;
}

export interface UpgradeRow {
  id: number;
  key: string;
  area: UpgradeArea;
  title: string;
  why: string;
  source: UpgradeSource;
  report_id: number | null;
  status: UpgradeStatus;
  times: number;
  created_at: number;
  last_seen_at: number;
  resolved_at: number | null;
  resolution: string | null;
}

/** How many lines one model reply may file. A model that has five «needs» has one real one. */
export const MAX_PER_CALL = 3;
/** Past this many open rows, new ones are refused until the operator works through the list. */
export const MAX_OPEN = 15;
/** A title this similar to a filed one is the same request in different words. */
const SAME_REQUEST = 0.5;

const isArea = (x: string): x is UpgradeArea => Object.prototype.hasOwnProperty.call(UPGRADE_AREAS, x);

/**
 * `UPGRADE|领域|标题|证据` lines, wherever they sit in a reply. `ACTION|UPGRADE|…` is accepted too,
 * because a model that has just been shown the ACTION grammar will reach for it.
 */
export function parseUpgrades(text: string): UpgradeInput[] {
  const out: UpgradeInput[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^[-·*\d.、\s]+(?=(ACTION\|)?UPGRADE)/i, '').replace(/^ACTION\|(?=UPGRADE\|)/i, '');
    if (!/^UPGRADE\|/i.test(line)) continue;
    const p = line.split('|').map(x => x.trim());
    if (p.length < 4) continue;
    const area = (p[1] ?? '').toLowerCase();
    const title = (p[2] ?? '').replace(/\s+/g, ' ');
    const why = p.slice(3).join('|').replace(/\s+/g, ' ');
    if (title.length < 6 || title.length > 60 || why.length < 6) continue;
    out.push({ area: isArea(area) ? area : 'other', title, why: why.slice(0, 400) });
  }
  return out.slice(0, MAX_PER_CALL);
}

/** The reply without its UPGRADE lines, for the report body. */
export function stripUpgrades(text: string): string {
  return text.split('\n').filter(l => !/^\s*(?:[-·*\d.、\s]+)?(?:ACTION\|)?UPGRADE\|/i.test(l)).join('\n').trim();
}

const norm = (s: string): string => s.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

function grams(s: string): Set<string> {
  const t = norm(s);
  const g = new Set<string>();
  if (t.length === 1) g.add(t);
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
  return g;
}

/** Character-bigram Jaccard: wording drifts week to week, the nouns of a request do not. */
export function similarity(a: string, b: string): number {
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export type FileResult =
  | { kind: 'new'; id: number }
  | { kind: 'repeat'; id: number; status: UpgradeStatus }
  | { kind: 'refused'; why: string };

/**
 * File one request. A repeat of a filed one bumps its count and refreshes the evidence instead of
 * adding a row: «raised four times in four weeks» is the information. A repeat of a refused one is
 * counted and left refused; a repeat of a done one is counted and left done — the snapshot shows the
 * brain what was done so it can judge whether it helped, which is a different statement from
 * asking for it again.
 */
export function fileUpgrade(
  store: Store,
  u: UpgradeInput,
  meta: { source: UpgradeSource; reportId?: number | null; now?: number },
): FileResult {
  const now = meta.now ?? Date.now();
  const title = u.title.trim();
  const why = u.why.trim();
  if (title.length < 6) return { kind: 'refused', why: '标题太短，写不清楚的需求也做不清楚' };
  const area: UpgradeArea = isArea(u.area) ? u.area : 'other';
  const rows = store.db.prepare('SELECT id, title, status FROM upgrade_requests').all() as { id: number; title: string; status: UpgradeStatus }[];
  let best: { id: number; status: UpgradeStatus; s: number } | null = null;
  for (const r of rows) {
    const s = similarity(r.title, title);
    if (s >= SAME_REQUEST && (!best || s > best.s)) best = { id: r.id, status: r.status, s };
  }
  if (best) {
    store.db
      .prepare('UPDATE upgrade_requests SET times = times + 1, last_seen_at = ?, why = ?, report_id = COALESCE(?, report_id) WHERE id = ?')
      .run(now, why.slice(0, 400), meta.reportId ?? null, best.id);
    return { kind: 'repeat', id: best.id, status: best.status };
  }
  const open = (store.db.prepare("SELECT COUNT(*) AS n FROM upgrade_requests WHERE status IN ('open','doing')").get() as { n: number }).n;
  if (open >= MAX_OPEN) return { kind: 'refused', why: `待办已有 ${open} 条，先等操作者处理` };
  const res = store.db
    .prepare(
      `INSERT INTO upgrade_requests (key, area, title, why, source, report_id, status, times, created_at, last_seen_at)
       VALUES (?,?,?,?,?,?, 'open', 1, ?, ?) ON CONFLICT(key) DO NOTHING`,
    )
    .run(norm(title).slice(0, 80), area, title, why.slice(0, 400), meta.source, meta.reportId ?? null, now, now);
  if (!res.changes) return { kind: 'refused', why: '同样的标题已经登记过' };
  return { kind: 'new', id: Number(res.lastInsertRowid) };
}

/** File every UPGRADE line in a reply. Returns one short line per outcome, for logs and notes. */
export function fileFromReply(store: Store, text: string, meta: { source: UpgradeSource; reportId?: number | null; now?: number }): string[] {
  const out: string[] = [];
  for (const u of parseUpgrades(text)) {
    const r = fileUpgrade(store, u, meta);
    out.push(r.kind === 'new' ? `新登记 #${r.id}：${u.title}` : r.kind === 'repeat' ? `#${r.id} 再次被提出：${u.title}` : `未登记（${r.why}）：${u.title}`);
  }
  if (out.length) store.log('upgrade_filed', { source: meta.source, reportId: meta.reportId ?? null, lines: out });
  return out;
}

export function listUpgrades(store: Store, opts: { statuses?: UpgradeStatus[]; limit?: number } = {}): UpgradeRow[] {
  const statuses = opts.statuses ?? ['open', 'doing', 'done', 'wontfix'];
  return store.db
    .prepare(
      `SELECT * FROM upgrade_requests WHERE status IN (${statuses.map(() => '?').join(',')})
       ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'open' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, times DESC, last_seen_at DESC
       LIMIT ?`,
    )
    .all(...statuses, opts.limit ?? 50) as UpgradeRow[];
}

/** Move a request along. Done and refused need a note: «why» is what the brain reads next week. */
export function resolveUpgrade(store: Store, id: number, status: UpgradeStatus, note = '', now = Date.now()): { ok: boolean; error?: string } {
  if (!['open', 'doing', 'done', 'wontfix'].includes(status)) return { ok: false, error: '状态只能是 open / doing / done / wontfix' };
  const text = note.trim().slice(0, 300);
  if ((status === 'done' || status === 'wontfix') && !text) return { ok: false, error: status === 'done' ? '写一句做了什么，大脑下次才能判断有没有用' : '写一句为什么不做，大脑才不会再提' };
  const closed = status === 'done' || status === 'wontfix';
  const res = store.db
    .prepare('UPDATE upgrade_requests SET status = ?, resolution = CASE WHEN ? = \'\' THEN resolution ELSE ? END, resolved_at = ? WHERE id = ?')
    .run(status, text, text, closed ? now : null, id);
  if (!res.changes) return { ok: false, error: '找不到这条需求' };
  store.log('upgrade_resolved', { id, status, note: text });
  return { ok: true };
}

/** What the brain is shown: what is already filed, and what was done or refused and why. */
export function upgradesForSnapshot(store: Store, now = Date.now()): {
  open: { id: number; area: string; title: string; status: string; times: number; since: number }[];
  resolved: { id: number; title: string; status: string; resolution: string | null; at: number | null }[];
} {
  const open = listUpgrades(store, { statuses: ['open', 'doing'], limit: MAX_OPEN })
    .map(r => ({ id: r.id, area: r.area, title: r.title, status: r.status, times: r.times, since: r.created_at }));
  const resolved = (store.db
    .prepare("SELECT id, title, status, resolution, resolved_at FROM upgrade_requests WHERE status IN ('done','wontfix') AND resolved_at >= ? ORDER BY resolved_at DESC LIMIT 10")
    .all(now - 30 * 86_400_000) as { id: number; title: string; status: string; resolution: string | null; resolved_at: number | null }[])
    .map(r => ({ id: r.id, title: r.title, status: r.status, resolution: r.resolution, at: r.resolved_at }));
  return { open, resolved };
}

const bj = (t: number): string => new Date(t + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
const STATUS_CN: Record<UpgradeStatus, string> = { open: '待处理', doing: '处理中', done: '已完成', wontfix: '不做' };

/**
 * The open list as a brief for whoever writes the code: paste it into a chat with a coding agent
 * and it has the evidence, the history and the done-criteria in one place.
 */
export function upgradesMarkdown(store: Store, ids?: number[]): string {
  const rows = listUpgrades(store, { statuses: ['doing', 'open'] }).filter(r => !ids?.length || ids.includes(r.id));
  if (!rows.length) return '# SquareForge 升级需求\n\n目前没有待处理的需求。';
  const parts = rows.map(r => [
    `## #${r.id} ${r.title}`,
    `- 领域：${UPGRADE_AREAS[r.area] ?? r.area}　状态：${STATUS_CN[r.status]}　被提出 ${r.times} 次（首次 ${bj(r.created_at)}，最近 ${bj(r.last_seen_at)}）`,
    `- 来源：${r.source}${r.report_id ? `（报告 #${r.report_id}）` : ''}`,
    `- 大脑给的证据：${r.why}`,
  ].join('\n'));
  return [
    '# SquareForge 升级需求（AI 大脑登记，需要改代码）',
    '做完一条，到面板「AI 大脑 → 要改代码的事」里标「已完成」并写一句做了什么；下周复盘会读到它，判断改动有没有用。',
    ...parts,
  ].join('\n\n');
}
