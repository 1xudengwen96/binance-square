import type { Store } from '../db/index.ts';
import { beijingDayStart } from '../schedule.ts';

/**
 * postsInRolling24h —— 裁定八（PM seq=387）的观察列，不是护栏。
 *
 * 日界对齐之后，格子按北京日历日计（每号 4 条），但主护栏 ≤2/24h 仍是滚动窗口——两个口径
 * 的接缝最坏约 16 小时可达 8 条。这是从读数反推的**假设待验**，所以 PM 拍定的处理是观察而非
 * 改线：每日一次（北京日历日内首个 live tick）记一条「过去 24 小时实际发布数」，进第 7 天 a 表。
 *
 * 判据只有一条：读数 > 4 ⇒ 按护栏缺陷当场再收紧。收紧允许，放宽禁止——本模块只读数、只报，
 * 不碰任何额度、间隔或租约。
 */

/** 触发「当场再收紧」的读数线：>4 即报（定稿 v1.6 裁定八原文）。 */
export const ROLLING_SEAM_OBS_LIMIT = 4;

export interface SeamObservation {
  day_start: number;
  at: number;
  count: number;
  over: boolean;
}

/**
 * 每日一样本：同一北京日历日内重复调用是 no-op（返回 null），跨日后的首个调用才落账。
 * 读数与日终对账同口径（posts + studio_articles，status='published'），保证 a 表里两列可对照。
 */
export function observeRollingSeam(store: Store, now: number, limit = ROLLING_SEAM_OBS_LIMIT): SeamObservation | null {
  const dayStart = beijingDayStart(now);
  const wmKey = 'lastPostsRolling24hObsDay';
  if (store.getSetting<number>(wmKey, 0) >= dayStart) return null;
  store.setSetting(wmKey, dayStart);

  const n = store.db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM posts WHERE status = 'published' AND published_at >= ?)
             + (SELECT COUNT(*) FROM studio_articles WHERE status = 'published' AND published_at >= ?) AS c`,
    )
    .get(now - 24 * 3_600_000, now - 24 * 3_600_000) as { c: number };

  const obs: SeamObservation = { day_start: dayStart, at: now, count: n.c, over: n.c > limit };
  store.setSetting('postsRolling24hObs', { ...obs });
  store.log('posts_rolling24h', obs);
  return obs;
}
