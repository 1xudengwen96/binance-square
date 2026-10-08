import { Store, type AccountRow } from './db/index.ts';
import { DEFAULT_SETTINGS, type Settings } from './config.ts';

const BJ_OFFSET_MS = 8 * 3600_000;

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

export interface SlotDecision {
  allowed: boolean;
  at: number;
  reason: string;
}

/**
 * When may the next post go out? Honours the daily cap, the minimum gap between
 * posts, the active window, and the hard Binance ceiling.
 */
export function nextSlot(store: Store, s: Settings, now = Date.now()): SlotDecision {
  const publishedToday = store.publishedToday(beijingDayStart(now));
  if (publishedToday >= s.dailyCap) {
    return { allowed: false, at: now, reason: `今日已发 ${publishedToday}/${s.dailyCap}，达到自设上限` };
  }
  if (publishedToday >= 100) {
    return { allowed: false, at: now, reason: '已达币安官方 100 帖/天硬上限' };
  }

  const last = store.lastEvent('published');
  const gapMs = nominalIntervalMinutes(s) * 60_000;
  let at = Math.max(now, (last?.at ?? 0) + gapMs);

  const minGapMs = s.minIntervalMinutes * 60_000;
  if (last && at - last.at < minGapMs) at = last.at + minGapMs;

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
    postsPerDay: a.posts_per_day ?? base.postsPerDay,
    minIntervalMinutes: a.min_interval_minutes ?? base.minIntervalMinutes,
    activeStartHour: a.active_start_hour ?? base.activeStartHour,
    activeEndHour: a.active_end_hour ?? base.activeEndHour,
    // The 100/day ceiling is per key, so this account's own cap is the one that binds.
    dailyCap: Math.min(100, a.posts_per_day ?? base.dailyCap),
  };
}

/**
 * When may *this* account post next?
 *
 * Two clocks have to agree. The account's own cadence keeps its feed from looking
 * spammy; the matrix-wide gap keeps ten accounts from firing in one recognisable
 * burst, which is the shape platform abuse detection looks for.
 */
export function nextSlotFor(store: Store, base: Settings, a: AccountRow, now = Date.now()): SlotDecision {
  const s = settingsForAccount(base, a);
  const mine = store.accountPostsToday(a.id, beijingDayStart(now));
  if (mine >= s.dailyCap) {
    return { allowed: false, at: now, reason: `${a.label} 今日已发 ${mine}/${s.dailyCap}，达到该号上限` };
  }
  if (mine >= 100) {
    return { allowed: false, at: now, reason: `${a.label} 达到币安单号 100 帖/天硬上限` };
  }

  const gapMs = nominalIntervalMinutes(s) * 60_000;
  const atOwn = store.lastPublishAt(a.id, now) + Math.max(gapMs, s.minIntervalMinutes * 60_000);
  // The shared clock counts every account, including this one.
  const atMatrix = store.lastPublishAt(null, now) + base.crossAccountGapMinutes * 60_000;
  let at = Math.max(now, atOwn, atMatrix);

  if (!insideActiveWindow(s, at)) {
    return { allowed: true, at: rollIntoWindow(s, at), reason: `${a.label} 当前不在该号发帖时段，已顺延` };
  }
  return { allowed: true, at, reason: 'ok' };
}
