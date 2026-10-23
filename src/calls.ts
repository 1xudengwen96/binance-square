import type { Store } from './db/index.ts';
import { binance } from './collectors/binance.ts';

/**
 * The call ledger behind 昨日对账.
 *
 * When a column post goes out it makes one checkable statement: «this side is paying, and it has
 * not stopped». That statement is written down here, with the numbers it was made against, and a
 * day later *code* looks at the funding rate again and rules on it. The model never judges its own
 * homework, and the recap post is assembled from these rows, so every figure in it has a source.
 *
 * What counts, deliberately simple and stated before the outcome is known:
 *   held     same side still pays, and the rate is at least half of what it was
 *   faded    same side still pays, but under half — the cost of the position has largely gone
 *   flipped  the other side pays now (or the rate is zero)
 *   void     the contract no longer lists a rate, or the check is older than three days
 *
 * That is the original `funding_persists` rule, and it was the wrong question: funding rates
 * revert by construction, so «still at least half a day later» held 3 times in 22 — and the
 * posts quoted that tally. What a post actually says is «this side is paying», so calls
 * registered from now on are `payer_persists`: held when the same side is still paying, flipped
 * when it is not. Rows already judged keep the rule they were registered under.
 */

export const CHECK_AFTER_MS = 24 * 3600_000;
export const VOID_AFTER_MS = 72 * 3600_000;
export const HOLD_FRACTION = 0.5;
export const FUNDING_PERSISTS = 'funding_persists';
export const PAYER_PERSISTS = 'payer_persists';

export interface CallInput {
  postId: number;
  symbol: string;
  reading: string;
  payer: '多头' | '空头';
  rate: number;
  annualized: number | null;
  intervalHours: number;
  price: number | null;
  now?: number;
}

export function registerCall(store: Store, c: CallInput): number | null {
  if (!Number.isFinite(c.rate) || c.rate === 0) return null;
  const now = c.now ?? Date.now();
  const res = store.db
    .prepare(
      `INSERT INTO column_calls (post_id, symbol, kind, reading, payer, rate_at, annualized_at, interval_hours, price_at, check_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(c.postId, c.symbol, PAYER_PERSISTS, c.reading, c.payer, c.rate, c.annualized, c.intervalHours, c.price, now + CHECK_AFTER_MS);
  return Number(res.lastInsertRowid);
}

export type Verdict = 'held' | 'faded' | 'flipped';

/** The ruling itself, pure so a test can pin it. */
export function ruling(rateAt: number, rateAfter: number): Verdict {
  if (!Number.isFinite(rateAfter) || rateAfter === 0 || Math.sign(rateAfter) !== Math.sign(rateAt)) return 'flipped';
  return Math.abs(rateAfter) >= Math.abs(rateAt) * HOLD_FRACTION ? 'held' : 'faded';
}

/** The ruling for a row, under the rule it was registered with. */
export function rulingFor(kind: string, rateAt: number, rateAfter: number): Verdict {
  const v = ruling(rateAt, rateAfter);
  return kind === PAYER_PERSISTS && v === 'faded' ? 'held' : v;
}

export interface RateBook {
  get(symbol: string): { rate: number; price: number | null } | undefined;
}

/** One request for the whole market; the caller injects it so tests never touch the network. */
export async function fetchRateBook(): Promise<RateBook> {
  const rows = await binance.premiumIndex();
  const m = new Map<string, { rate: number; price: number | null }>();
  for (const r of rows) {
    if (!r.symbol.endsWith('USDT')) continue;
    const rate = Number(r.lastFundingRate);
    const price = Number(r.markPrice);
    if (Number.isFinite(rate)) m.set(r.symbol.slice(0, -4), { rate, price: Number.isFinite(price) ? price : null });
  }
  return m;
}

export interface JudgeReport {
  judged: number;
  held: number;
  faded: number;
  flipped: number;
  voided: number;
}

/**
 * Rule on every open call whose time has come. A failed fetch leaves them open (a missing
 * measurement is not a verdict); a successful fetch that lacks the symbol voids it.
 */
export async function judgeCalls(
  store: Store,
  opts: { now?: number; book?: () => Promise<RateBook> } = {},
): Promise<JudgeReport> {
  const now = opts.now ?? Date.now();
  const report: JudgeReport = { judged: 0, held: 0, faded: 0, flipped: 0, voided: 0 };
  const due = store.db
    .prepare("SELECT id, symbol, kind, rate_at, check_at FROM column_calls WHERE status = 'open' AND check_at <= ?")
    .all(now) as { id: number; symbol: string; kind: string; rate_at: number; check_at: number }[];
  if (!due.length) return report;

  let book: RateBook;
  try {
    book = await (opts.book ?? fetchRateBook)();
  } catch {
    return report;
  }

  const upd = store.db.prepare(
    'UPDATE column_calls SET status = ?, outcome = ?, rate_after = ?, price_after = ?, judged_at = ? WHERE id = ?',
  );
  for (const c of due) {
    const now_ = book.get(c.symbol.toUpperCase());
    if (!now_) {
      upd.run('void', 'void', null, null, now, c.id);
      report.voided++;
      continue;
    }
    if (now - c.check_at > VOID_AFTER_MS) {
      // Judging a 24h statement three days late would be judging a different question.
      upd.run('void', 'late', null, null, now, c.id);
      report.voided++;
      continue;
    }
    const v = rulingFor(c.kind, c.rate_at, now_.rate);
    upd.run(v === 'held' ? 'held' : 'failed', v, now_.rate, now_.price, now, c.id);
    report[v]++;
    report.judged++;
  }
  store.log('column_calls_judged', report);
  return report;
}

export type { CallTally };
interface CallTally {
  total: number;
  held: number;
  faded: number;
  flipped: number;
  open: number;
}

/** Every ruling to date. `total` counts only rulings, never open or void rows. */
export function tally(store: Store): CallTally {
  const r = store.db
    .prepare(
      `SELECT SUM(outcome = 'held') AS held, SUM(outcome = 'faded') AS faded, SUM(outcome = 'flipped') AS flipped,
              SUM(status = 'open') AS open
       FROM column_calls`,
    )
    .get() as { held: number | null; faded: number | null; flipped: number | null; open: number | null };
  const held = r.held ?? 0;
  const faded = r.faded ?? 0;
  const flipped = r.flipped ?? 0;
  return { total: held + faded + flipped, held, faded, flipped, open: r.open ?? 0 };
}

export interface CallCohort extends CallTally {
  /** held / total; no rulings means unknown, not a success rate of zero. */
  heldRate: number | null;
  void: number;
  firstRegisteredAt: number | null;
  lastRegisteredAt: number | null;
}

export interface CallStats extends CallTally {
  currentKind: typeof PAYER_PERSISTS;
  byKind: Record<string, CallCohort>;
}

/** Separate the rules recorded on each call; never rejudge old outcomes or guess a cutover date. */
export function callStats(store: Store): CallStats {
  const empty = (): CallCohort => ({
    total: 0, held: 0, faded: 0, flipped: 0, open: 0, void: 0, heldRate: null,
    firstRegisteredAt: null, lastRegisteredAt: null,
  });
  const byKind: Record<string, CallCohort> = {
    [FUNDING_PERSISTS]: empty(),
    [PAYER_PERSISTS]: empty(),
  };
  const rows = store.db.prepare(`
    SELECT kind, COALESCE(SUM(outcome = 'held'), 0) AS held,
           COALESCE(SUM(outcome = 'faded'), 0) AS faded,
           COALESCE(SUM(outcome = 'flipped'), 0) AS flipped,
           COALESCE(SUM(status = 'open'), 0) AS open,
           COALESCE(SUM(status = 'void'), 0) AS void,
           MIN(check_at - ?) AS firstRegisteredAt, MAX(check_at - ?) AS lastRegisteredAt
    FROM column_calls GROUP BY kind
  `).all(CHECK_AFTER_MS, CHECK_AFTER_MS) as (Omit<CallCohort, 'total' | 'heldRate'> & { kind: string })[];
  const all: CallTally = { total: 0, held: 0, faded: 0, flipped: 0, open: 0 };
  for (const { kind, ...counts } of rows) {
    const total = counts.held + counts.faded + counts.flipped;
    // defineProperty also treats an unexpected kind such as "__proto__" as an ordinary key.
    Object.defineProperty(byKind, kind, {
      value: { ...counts, total, heldRate: total ? counts.held / total : null },
      enumerable: true, configurable: true, writable: true,
    });
    all.total += total;
    all.held += counts.held;
    all.faded += counts.faded;
    all.flipped += counts.flipped;
    all.open += counts.open;
  }
  return { ...all, currentKind: PAYER_PERSISTS, byKind };
}

export interface Unrecapped {
  id: number;
  symbol: string;
  payer: '多头' | '空头';
  rate_at: number;
  rate_after: number;
  outcome: Verdict;
}

export function unrecapped(store: Store, limit = 3): Unrecapped[] {
  return store.db
    .prepare(
      `SELECT id, symbol, payer, rate_at, rate_after, outcome FROM column_calls
       WHERE outcome IN ('held','faded','flipped') AND recapped_in IS NULL AND rate_after IS NOT NULL
       ORDER BY judged_at DESC LIMIT ?`,
    )
    .all(limit) as Unrecapped[];
}

export function markRecapped(store: Store, callIds: number[], postId: number): void {
  const upd = store.db.prepare('UPDATE column_calls SET recapped_in = ? WHERE id = ?');
  for (const id of callIds) upd.run(postId, id);
}

/**
 * One line that lets a post refer back to the record, so the column reads as something that has
 * been watching rather than something that fires fresh every time. Facts only: the coin's last
 * ruling if it has one, otherwise nothing. No cashtag; every figure comes from a ledger row.
 *
 * It used to fall back to the running tally (「核对过 22 条，成立 3 条」) on a third of posts, which
 * put the column's hit rate under every reading it made.
 */
export function memoryLineFor(store: Store, symbol: string, _seed: number, now = Date.now()): string {
  const last = store.db
    .prepare(
      `SELECT payer, outcome, check_at FROM column_calls
       WHERE symbol = ? AND outcome IN ('held','faded','flipped') ORDER BY judged_at DESC LIMIT 1`,
    )
    .get(symbol.toUpperCase()) as { payer: '多头' | '空头'; outcome: Verdict; check_at: number } | undefined;
  if (!last) return '';
  const days = Math.max(1, Math.round((now - (last.check_at - CHECK_AFTER_MS)) / 86_400_000));
  const other = last.payer === '多头' ? '空头' : '多头';
  const tail =
    last.outcome === 'held'
      ? `第二天还是${last.payer}在付`
      : last.outcome === 'faded'
        ? '第二天费率就降下来了'
        : `第二天就换成${other}在付了`;
  return `${days} 天前也聊过它，那时就是${last.payer}在付；${tail}。`;
}

/** A rate as a bare magnitude, the way the column posts say it; who pays is in the words. */
const hr = (r: number): string => {
  const p = Math.abs(r * 100);
  return `${p >= 0.1 ? p.toFixed(2) : p.toFixed(3)}%`;
};

/** One line per coin. Words are fixed; every number comes from the row. */
export function recapLineFor(c: Unrecapped): string {
  const other = c.payer === '多头' ? '空头' : '多头';
  const shrank = Math.abs(c.rate_after) < Math.abs(c.rate_at) * HOLD_FRACTION;
  const tail =
    c.rate_after === 0
      ? '第二天费率就回到了零，没人再付'
      : c.outcome === 'flipped'
        ? `第二天就换成${other}在付了，${hr(c.rate_after)}，风向变了`
        : shrank
          ? `第二天还是${c.payer}在付，不过只剩 ${hr(c.rate_after)}，压力基本散了`
          : `第二天还是${c.payer}在付，${hr(c.rate_after)}，没怎么松`;
  return `$${c.symbol}：当时${c.payer}在付 ${hr(c.rate_at)}，${tail}。`;
}
