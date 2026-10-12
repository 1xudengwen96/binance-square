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
 */

export const CHECK_AFTER_MS = 24 * 3600_000;
export const VOID_AFTER_MS = 72 * 3600_000;
export const HOLD_FRACTION = 0.5;

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
    .run(c.postId, c.symbol, 'funding_persists', c.reading, c.payer, c.rate, c.annualized, c.intervalHours, c.price, now + CHECK_AFTER_MS);
  return Number(res.lastInsertRowid);
}

export type Verdict = 'held' | 'faded' | 'flipped';

/** The ruling itself, pure so a test can pin it. */
export function ruling(rateAt: number, rateAfter: number): Verdict {
  if (!Number.isFinite(rateAfter) || rateAfter === 0 || Math.sign(rateAfter) !== Math.sign(rateAt)) return 'flipped';
  return Math.abs(rateAfter) >= Math.abs(rateAt) * HOLD_FRACTION ? 'held' : 'faded';
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
    .prepare("SELECT id, symbol, rate_at, check_at FROM column_calls WHERE status = 'open' AND check_at <= ?")
    .all(now) as { id: number; symbol: string; rate_at: number; check_at: number }[];
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
    const v = ruling(c.rate_at, now_.rate);
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
 * ruling if it has one, otherwise now and then the running tally. No cashtag and no first person;
 * every figure comes from a ledger row.
 */
export function memoryLineFor(store: Store, symbol: string, seed: number, now = Date.now()): string {
  const last = store.db
    .prepare(
      `SELECT payer, outcome, check_at FROM column_calls
       WHERE symbol = ? AND outcome IN ('held','faded','flipped') ORDER BY judged_at DESC LIMIT 1`,
    )
    .get(symbol.toUpperCase()) as { payer: '多头' | '空头'; outcome: Verdict; check_at: number } | undefined;
  if (last) {
    const days = Math.max(1, Math.round((now - (last.check_at - CHECK_AFTER_MS)) / 86_400_000));
    const other = last.payer === '多头' ? '空头' : '多头';
    const tail =
      last.outcome === 'held'
        ? `隔天仍是${last.payer}在付，当时的判断成立`
        : last.outcome === 'faded'
          ? `隔天费率只剩不到一半，按不成立记`
          : `隔天已经换成${other}在付，按不成立记`;
    return `上一次提到它是 ${days} 天前，当时${last.payer}在付；${tail}。`;
  }
  const t = tally(store);
  if (t.total >= 3 && Math.abs(seed) % 3 === 0) {
    return `这个栏目到目前核对过 ${t.total} 条判断，成立 ${t.held} 条。`;
  }
  return '';
}

const pct = (r: number): string => `${r >= 0 ? '' : '-'}${Math.abs(r * 100).toFixed(3)}%`;

/** One line per call. Words are fixed; every number comes from the row. No first person. */
export function recapLineFor(c: Unrecapped): string {
  const other = c.payer === '多头' ? '空头' : '多头';
  const tail =
    c.outcome === 'held'
      ? `仍是${c.payer}在付，费率 ${pct(c.rate_after)}，成立`
      : c.outcome === 'faded'
        ? `还是${c.payer}在付，但费率只剩 ${pct(c.rate_after)}，不足一半，按不成立记`
        : `已经变成${other}在付，费率 ${pct(c.rate_after)}，不成立`;
  return `$${c.symbol}：当时${c.payer}在付，费率 ${pct(c.rate_at)}；隔天${tail}。`;
}
