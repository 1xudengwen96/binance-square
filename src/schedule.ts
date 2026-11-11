import { Store, type AccountRow } from './db/index.ts';
import { DEFAULT_SETTINGS, type Settings } from './config.ts';

const BJ_OFFSET_MS = 8 * 3600_000;

/**
 * How far ahead a new draft may reserve a minute. One day is deliberately wider than the
 * active window: the queue-depth cap in `generate` is what stops drafts piling up, not this.
 */
export const QUEUE_LOOKAHEAD_MS = 86_400_000;

/** Start of the current Beijing calendar day, as a UTC epoch. */
export function beijingDayStart(now = Date.now()): number {
  return Math.floor((now + BJ_OFFSET_MS) / 86_400_000) * 86_400_000 - BJ_OFFSET_MS;
}

/** Minutes since Beijing midnight, used to test whether we are inside the posting window. */
function beijingMinutes(now: number): number {
  const ms = (((now + BJ_OFFSET_MS) % 86_400_000) + 86_400_000) % 86_400_000;
  return ms / 60_000;
}

function windowBounds(s: Settings): { start: number; end: number } {
  const start = s.activeStartHour * 60;
  // endHour 24 means "through midnight", and a start after end means the window wraps.
  const end = s.activeEndHour === 24 ? 1440 : s.activeEndHour * 60;
  return { start, end };
}

export function insideActiveWindow(s: Settings, now = Date.now()): boolean {
  const m = beijingMinutes(now);
  const { start, end } = windowBounds(s);
  return end > start ? m >= start && m < end : m >= start || m < end;
}

/** Even spacing across the active window, with jitter so the cadence is not machine-recognisable. */
export function nominalIntervalMinutes(s: Settings): number {
  const { start, end } = windowBounds(s);
  const spanMinutes = end > start ? end - start : 1440 - start + end;
  return Math.max(s.minIntervalMinutes, Math.floor(spanMinutes / Math.max(1, s.postsPerDay)));
}

/** Recover missed slots within the remaining window, without crossing the minimum gap. */
export function recoveryIntervalMinutes(s: Settings, published: number, now = Date.now()): number {
  const nominal = nominalIntervalMinutes(s);
  if (!insideActiveWindow(s, now)) return nominal;
  const { start, end } = windowBounds(s);
  const minute = beijingMinutes(now);
  const remaining = end > start || minute < end ? end - minute : 1440 - minute + end;
  const wanted = Math.max(1, s.postsPerDay - published);
  return Math.max(s.minIntervalMinutes, Math.min(nominal, Math.floor(remaining / wanted)));
}

export interface SlotClaim { id: number; account_id: number | null; at: number }

/** Find a free hole, rather than appending every account after the matrix's furthest booking. */
function reserveSlot(s: Settings, from: number, claims: readonly SlotClaim[], accountId: number, ownGap: number, matrixGap: number): number {
  let at = insideActiveWindow(s, from) ? from : rollIntoWindow(s, from);
  const sorted = [...claims].sort((a, b) => a.at - b.at);
  for (const claim of sorted) {
    const gap = claim.account_id === accountId ? Math.max(ownGap, matrixGap) : matrixGap;
    if (at >= claim.at + gap || at + gap <= claim.at) continue;
    at = claim.at + gap;
    if (!insideActiveWindow(s, at)) at = rollIntoWindow(s, at);
  }
  return at;
}

/**
 * How many posts a cadence can actually fit: the active window divided by the minimum gap.
 *
 * A quota above this number is unreachable, and pretending otherwise costs two things at once —
 * the day ends with the target unmet for a reason nobody wrote down, and the panel advertises a
 * spacing tighter than the floor it is also enforcing (24 posts over 8:00–24:00 reads as «one
 * every 40 minutes» next to a 45-minute minimum). The reachable number is what a quota is
 * checked against, so the promise and the floor cannot disagree.
 */
export function reachablePostsPerDay(s: Settings): number {
  const { start, end } = windowBounds(s);
  const spanMinutes = end > start ? end - start : 1440 - start + end;
  return Math.max(1, Math.floor(spanMinutes / Math.max(1, s.minIntervalMinutes)));
}

export interface SlotDecision {
  allowed: boolean;
  at: number;
  reason: string;
}

/**
 * When may the next post go out? Honours the daily cap, the minimum gap between
 * posts, the active window, and the hard Binance ceiling.
 *
 * `queueAhead` is for the generation side. A draft is written now but published later, so it
 * has to reserve a minute that nobody else has taken — which means it must look at slots the
 * queue already claims. The publish gate must NOT do that: a future draft is not evidence that
 * the post in front of it is late, and spacing on those claims starved the queue for seven
 * hours on the day the burst was found.
 */
export function nextSlot(
  store: Store,
  s: Settings,
  now = Date.now(),
  candidate?: { id: number; at: number } | null,
  queueAhead = false,
): SlotDecision {
  const publishedToday = store.publishedToday(beijingDayStart(now));
  if (publishedToday >= s.dailyCap) {
    return { allowed: false, at: now, reason: `今日已发 ${publishedToday}/${s.dailyCap}，达到自设上限` };
  }
  if (publishedToday >= 100) {
    return { allowed: false, at: now, reason: '已达币安官方 100 帖/天硬上限' };
  }

  // Spacing reads the post table, not the event log. The two drift apart whenever a post is
  // published without an event, and neither used to see drafts already sitting in the queue —
  // which is how a whole batch ended up scheduled at the same minute.
  const last = store.lastSlotClaimedAt(null, queueAhead ? now + QUEUE_LOOKAHEAD_MS : now, candidate);
  const gapMs = nominalIntervalMinutes(s) * 60_000;
  let at = Math.max(now, last + gapMs);

  const minGapMs = s.minIntervalMinutes * 60_000;
  if (last && at - last < minGapMs) at = last + minGapMs;

  if (!insideActiveWindow(s, at)) {
    const rolled = rollIntoWindow(s, at);
    return { allowed: true, at: rolled, reason: '当前不在发帖时段，已顺延' };
  }
  return { allowed: true, at, reason: 'ok' };
}

function rollIntoWindow(s: Settings, from: number): number {
  const { start } = windowBounds(s);
  const bj = new Date(from + BJ_OFFSET_MS);
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const delta = (start - minutes + 1440) % 1440;
  return from + delta * 60_000;
}

export function settingsFrom(store: Store): Settings {
  return { ...DEFAULT_SETTINGS, ...store.getSetting<Partial<Settings>>('settings', {}) };
}

export function saveSettings(store: Store, s: Settings): void {
  store.setSetting('settings', s);
}

/* ------------------------------------------------------------ accounts --- */

/**
 * One account's effective settings. Anything it overrides wins; anything left NULL
 * inherits the global. Still a `Settings`, so every existing call site works untouched.
 */
export function settingsForAccount(base: Settings, a: AccountRow): Settings {
  return {
    ...base,
    style: a.style || base.style,
    // Per-account publish mode, so "start these three, keep the rest on review" works
    // without flipping a global switch that would affect every account.
    autoPublish: a.auto_publish === null ? base.autoPublish : a.auto_publish === 1,
    // The target is this account's own promise: how many posts it aims to spread across its
    // window. The cap stays the global ceiling every account shares. They used to be one number
    // (`dailyCap = posts_per_day`), which is why the panel showed «今日 7 / 30» at the top and
    // 「上限 24」 on the account card and both read as that account's quota.
    postsPerDay: a.posts_per_day ?? base.postsPerDay,
    minIntervalMinutes: a.min_interval_minutes ?? base.minIntervalMinutes,
    activeStartHour: a.active_start_hour ?? base.activeStartHour,
    activeEndHour: a.active_end_hour ?? base.activeEndHour,
    // The 100/day ceiling is per key, so it still binds below the global figure.
    dailyCap: Math.min(100, base.dailyCap),
  };
}

/**
 * When may *this* account post next?
 *
 * Two clocks have to agree. The account's own cadence keeps its feed from looking
 * spammy; the matrix-wide gap keeps ten accounts from firing in one recognisable
 * burst, which is the shape platform abuse detection looks for.
 */
export function nextSlotFor(
  store: Store,
  base: Settings,
  a: AccountRow,
  now = Date.now(),
  candidate?: { id: number; at: number } | null,
  queueAhead = false,
  reservations?: readonly SlotClaim[],
): SlotDecision {
  const s = settingsForAccount(base, a);
  const mine = store.accountPostsToday(a.id, beijingDayStart(now));
  // Two different ceilings, two different sentences. The cap is the global figure shared by every
  // account; the target is what this account promised itself, and reaching it is a normal end of
  // day rather than a limit being hit.
  if (mine >= s.dailyCap) {
    return { allowed: false, at: now, reason: `${a.label} 今日已发 ${mine}/${s.dailyCap}，达到全局硬上限` };
  }
  if (mine >= s.postsPerDay) {
    return { allowed: false, at: now, reason: `${a.label} 今日已发 ${mine}/${s.postsPerDay}，达到该号目标帖数` };
  }
  if (mine >= 100) {
    return { allowed: false, at: now, reason: `${a.label} 达到币安单号 100 帖/天硬上限` };
  }

  const gapMs = recoveryIntervalMinutes(s, mine, now) * 60_000;
  const atOwn = store.lastPublishAt(a.id, now) + gapMs;
  const matrixGap = base.crossAccountGapMinutes * 60_000;
  const atMatrix = store.lastPublishAt(null, now) + matrixGap;
  let at = Math.max(now, atOwn, atMatrix);

  // Reservations constrain drafting, never delivery. A review draft is not a real publish.
  if (queueAhead) {
    const claims = reservations ?? store.slotClaims(now + QUEUE_LOOKAHEAD_MS);
    at = reserveSlot(s, at, claims.filter(c => c.id !== candidate?.id), a.id, gapMs, matrixGap);
    if (beijingDayStart(at) > beijingDayStart(now)) {
      return { allowed: true, at, reason: `${a.label} 今日时段已满，已顺延到明天` };
    }
  }

  if (!insideActiveWindow(s, at)) {
    return { allowed: true, at: rollIntoWindow(s, at), reason: `${a.label} 当前不在该号发帖时段，已顺延` };
  }
  return { allowed: true, at, reason: 'ok' };
}

/** Reclaim holes left by expired/rejected automatic drafts. Human review schedules stay put. */
export function reflowApproved(store: Store, base: Settings, now = Date.now()): number {
  const accounts = store.activeAccounts(now).filter(a => settingsForAccount(base, a).autoPublish);
  const byId = new Map(accounts.map(a => [a.id, a]));
  const end = beijingDayStart(now) + 86_400_000;
  const rows = (store.db.prepare(`SELECT id, account_id, scheduled_at FROM posts
    WHERE status = 'approved' AND scheduled_at < ? AND json_extract(trace_json, '$.account') IS NOT NULL
    ORDER BY scheduled_at, id`).all(end) as { id: number; account_id: number; scheduled_at: number }[])
    .filter(p => byId.has(p.account_id));
  const ids = new Set(rows.map(p => p.id));
  const claims = store.slotClaims(now + QUEUE_LOOKAHEAD_MS).filter(c => !ids.has(c.id));
  let moved = 0;
  store.db.transaction(() => {
    for (const row of rows) {
      const slot = nextSlotFor(store, base, byId.get(row.account_id)!, now, null, true, claims);
      // Only automatic drafts selected above move; tomorrow's reservations stay untouched.
      const at = slot.allowed ? slot.at : row.scheduled_at;
      if (at !== row.scheduled_at) {
        store.db.prepare('UPDATE posts SET scheduled_at = ? WHERE id = ?').run(at, row.id);
        moved++;
      }
      claims.push({ id: row.id, account_id: row.account_id, at });
    }
    if (moved) store.log('queue_reflow', { moved });
  })();
  return moved;
}
