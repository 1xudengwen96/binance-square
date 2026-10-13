import type { Store } from '../db/index.ts';
import { beijingDayStart } from '../schedule.ts';
import { buildInfo } from '../build.ts';

/**
 * postsInRolling24h —— 裁定八（PM seq=387）的观察列，不是护栏。
 *
 * 日界对齐之后，格子按北京日历日计（每号 4 条），但主护栏 ≤2/24h 仍是滚动窗口——两个口径
 * 的接缝最坏约 16 小时可达 8 条。这是从读数反推的**假设待验**，所以 PM 拍定的处理是观察而非
 * 改线：每日一次（北京日历日内首个 live tick）逐号记一条「过去 24 小时实发 + 当日实发」，
 * 进第 7 天 a 表。
 *
 * 触发线必须按号算，不能按全库算（北京 10-14 01:5x 与数据分析 §7.8 的「每号一行」对表后更正）：
 * `>4` 来自「每号 4 条/日」那条格子线，全库计数在三个健康号的日子会必然过线，那是要收紧的假
 * 信号。落库同时带两个口径，接缝是否真实存在由两列之差来判，不由单列判。
 *
 * 判据只有一条：某号 rolling24h > 4 ⇒ 按护栏缺陷当场再收紧。收紧允许，放宽禁止——本模块只读
 * 数、只报，不碰任何额度、间隔或租约。
 */

/** 触发「当场再收紧」的读数线：单号 >4 即报（定稿 v1.6 裁定八原文）。 */
export const ROLLING_SEAM_OBS_LIMIT = 4;

export interface AccountSeamRow {
  account_id: number;
  label: string;
  rolling24h: number;
  calendar_day: number;
  over: boolean;
}

export interface SeamObservation {
  day_start: number;
  at: number;
  /** 落样那一刻本进程在跑哪个 commit（'unknown' = git 读不出来）。 */
  running_commit: string;
  rows: AccountSeamRow[];
  over_count: number;
}

/**
 * 每日一样本：同一北京日历日内重复调用是 no-op（返回 null），跨日后的首个调用才落账。
 * 计数口径与日终对账一致（posts + studio_articles，status='published'），保证 a 表里两列可对照。
 */
export function observeRollingSeam(store: Store, now: number, limit = ROLLING_SEAM_OBS_LIMIT): SeamObservation | null {
  const dayStart = beijingDayStart(now);
  const wmKey = 'lastPostsRolling24hObsDay';
  if (store.getSetting<number>(wmKey, 0) >= dayStart) return null;
  store.setSetting(wmKey, dayStart);

  const rows: AccountSeamRow[] = store.activeAccounts(now).map(a => {
    const rolling = store.accountPostsToday(a.id, now - 24 * 3_600_000);
    const day = store.accountPostsToday(a.id, dayStart);
    return { account_id: a.id, label: a.label, rolling24h: rolling, calendar_day: day, over: rolling > limit };
  });

  // running_commit 只自证「这个观察者模块在跑」；a294518 的日历日语义是否也在同一进程里，
  // 由读侧比 commit 来判——模块自己不声称这件事。
  const obs: SeamObservation = {
    day_start: dayStart,
    at: now,
    running_commit: buildInfo().commit,
    rows,
    over_count: rows.filter(r => r.over).length,
  };
  store.setSetting('postsRolling24hObs', { ...obs });
  store.log('posts_rolling24h', obs);
  return obs;
}

