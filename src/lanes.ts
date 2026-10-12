import type { Store } from './db/index.ts';
import type { Settings } from './config.ts';
import { beijingDayStart } from './schedule.ts';
import { trackById } from './studio/tracks.ts';

/**
 * Lane leases (定稿 §3-P0-2) — the replacement for the studio's static lock.
 *
 * The old rule was ownership: studio binds an account ⇒ the mixed matrix may not use it
 * at all. The measured consequence: 「启用了 zhang 短帖还是发不出」 — one predicate
 * (studio owns ⇒ matrix blocked) starved the short lane for days, silently.
 *
 * The new rule is quota per lane: 短帖 lane = 每号承诺 4 条/日 (期望 = 告警分母),
 * 长文 lane = ≤2/日 硬上限. Both lanes may be open on the same account the same day,
 * because the same primary label is what keeps the timeline coherent — not module
 * segregation. Leases are append-only audit rows; the cap is enforced against the
 * drafts themselves, so a crash between compose and insert cannot leak capacity.
 */

export type Lane = 'short' | 'long';

/** 定稿 §2: 长文 ≤2 — a config drift upward is refused here, the one place the cap is written. */
export const LONG_LANE_MAX = 2;

export function laneCap(store: Store, settings: Settings, accountId: number, lane: Lane): number {
  if (lane === 'long') {
    const binding = store.studioBinding(accountId);
    if (!binding || !binding.enabled) return 0;
    const track = trackById(binding.track_id);
    const wanted = binding.articles_per_day ?? track?.cadence.articlesPerDay ?? LONG_LANE_MAX;
    return Math.min(wanted, LONG_LANE_MAX);
  }
  const acct = store.accountById(accountId);
  if (!acct) return 0;
  return acct.posts_per_day ?? settings.postsPerDay;
}

export function laneRoom(store: Store, settings: Settings, accountId: number, lane: Lane, now = Date.now()): number {
  return laneCap(store, settings, accountId, lane) - store.laneUsage(accountId, lane, beijingDayStart(now));
}

export interface LaneGrant {
  ok: boolean;
  lane: Lane;
  cap: number;
  used: number;
  reason?: string;
}

/** Check the daily cap and record the audit row. Held capacity = drafts, so this is a
 *  grant-at-draft-time call; publish does not re-spend it. */
export function tryAcquireLaneLease(
  store: Store,
  settings: Settings,
  accountId: number,
  lane: Lane,
  heldBy: 'matrix' | 'studio' | 'surge' | 'manual',
  slotAt: number | null = null,
  now = Date.now(),
): LaneGrant {
  const cap = laneCap(store, settings, accountId, lane);
  const used = store.laneUsage(accountId, lane, beijingDayStart(now));
  if (used >= cap) {
    return { ok: false, lane, cap, used, reason: `${lane === 'long' ? '长文' : '短帖'}通道今日额度 ${used}/${cap} 已满` };
  }
  store.recordLaneLease(accountId, lane, beijingDayStart(now), slotAt, heldBy);
  return { ok: true, lane, cap, used };
}

/**
 * Accounts the short lane may serve today: enabled, not paused, lease room left.
 * Studio bindings no longer exclude an account — that exclusion was the static lock,
 * and it is exactly what starved zhang's short lane. The persona invariant moved to
 * the label (one primary label per account) and the lane caps above.
 */
export function laneEligibleAccounts(store: Store, settings: Settings, now = Date.now()) {
  return store.activeAccounts(now).filter(a => laneRoom(store, settings, a.id, 'short', now) > 0);
}

/**
 * Why the pool is empty — 计划内 must carry a code; 无码的「没发」 is itself the故障.
 * human_pause 只有在账号 enabled=0（PATCH 审计路径写的）时成立。
 */
export function poolEmptyReason(store: Store, settings: Settings, now = Date.now()): 'human_pause' | 'quota_spent' | 'no_enabled' {
  const all = store.db
    .prepare('SELECT id, enabled, paused_until FROM accounts')
    .all() as { id: number; enabled: number; paused_until: number | null }[];
  if (!all.some(a => a.enabled === 1)) return 'human_pause';
  return 'quota_spent';
}
