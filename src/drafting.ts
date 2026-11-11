import type { Store } from './db/index.ts';
import type { Settings } from './config.ts';
import { evaluateBreaker } from './rank/gates.ts';
import { ALERT_KINDS, hasActiveUnacked } from './alerts/bus.ts';

/** Automatic drafts have no useful shelf life while delivery is blocked.
 * Review drafts and previews are still available for deliberate operator work.
 */
export function automaticDraftBlockReason(store: Store, base: Settings, effective: Settings, now = Date.now()): string | null {
  if (!effective.autoPublish) return null;
  if (!base.autoPublish) return '自动发布总开关已关闭，暂停自动短帖生成，恢复后再按最新行情写稿';
  if (evaluateBreaker(store, base, now).tripped || hasActiveUnacked(store, ALERT_KINDS.breakerTripped)) {
    return '熔断中：暂停自动短帖生成，恢复后再按最新行情写稿';
  }
  return null;
}
