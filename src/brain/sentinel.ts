import { pendingJob, enqueueJob, claimJob, failJob, finishJob } from './jobs.ts';
import type { Store } from '../db/index.ts';
import type { Settings } from '../config.ts';
import { brainFor } from './brain.ts';
import { buildSnapshot, snapshotText, type BrainSnapshot } from './snapshot.ts';
import { SENTINEL_SYSTEM, withOperatorNotes } from './prompts.ts';
import { fileFromReply, stripUpgrades } from './upgrades.ts';

/**
 * The sentinel: code watches, the model is woken only when something happens.
 *
 * Most days nothing happens, and asking a model for three suggestions on a day with nothing to
 * say only teaches it to make something up. So the checks below are plain arithmetic, a fired
 * alarm is written down whether or not the model is called, and the model is called at most
 * `brainWakeCapPerDay` times a day however many alarms fire.
 */

const DAY = 86_400_000;
/** An alarm of the same kind is not raised again inside this window. */
const REPEAT_QUIET_MS = 20 * 3600_000;

export interface Alarm {
  code: string;
  detail: string;
}

/** Pure: which alarms does this snapshot justify? Order is by importance. */
export function detectAlarms(s: BrainSnapshot, settings: Settings): Alarm[] {
  const out: Alarm[] = [];

  if (s.breaker.tripped) {
    out.push({
      code: 'breaker',
      detail: `熔断已触发：最近 ${s.breaker.window} 条的浏览中位数 ${Math.round(s.breaker.median ?? 0)}，低于 ${s.breaker.floor}。自动发布已停，需要操作者恢复。`,
    });
  }

  // Judged on gate B's own cohort (a day old, read at 24h): w14 also holds posts a few hours old,
  // and an alarm that names gate B must count the posts gate B counts.
  const B = s.gates.B;
  if (B.posts >= 10 && B.commentsPer1k === 0 && !B.passed) {
    out.push({ code: 'no_comments', detail: `近 ${B.windowDays} 天 ${B.posts} 条满 24 小时的帖子（${B.views} 次 24h 浏览），评论一条都没有（合并评论率 0）。关卡 B 没有任何进展。` });
  }

  const med = s.account.w7.medianViews;
  const best = bestRecent(s);
  if (med != null && med > 0 && best && best.views >= 5 * med && best.views >= 300) {
    out.push({ code: 'outlier_good', detail: `有一条帖子读数 ${best.views}，是 7 天中位数 ${Math.round(med)} 的 ${(best.views / med).toFixed(1)} 倍（${best.what}）。要判断是运气还是能复制。` });
  }

  if (s.gates.A.passed && s.mission.targetMode === 'auto' && s.mission.target === 'engagement') {
    out.push({ code: 'gate_a_cleared', detail: `关卡 A 连续 ${s.gates.A.streakDays} 天过线，优化目标已自动切到互动质量。请确认这个切换合理。` });
  }

  const currentCalls = s.calls.byKind[s.calls.currentKind];
  if (currentCalls && currentCalls.total >= 5 && currentCalls.heldRate != null && currentCalls.heldRate < 0.3) {
    out.push({ code: 'calls_failing', detail: `当前口径 ${s.calls.currentKind}（隔天仍是同一边付费即成立）已裁决 ${currentCalls.total} 条判断，只有 ${currentCalls.held} 条成立；历史旧口径未计入。栏目的判断方式可能有问题。` });
  }

  if (settings.llmEnabled === false) return out.filter(a => a.code === 'breaker');
  return out;
}

/**
 * Is the machine itself still running? The alarms above read the account; these read the loop.
 * A run of days with no post, with the brain failing every call, or with stats never read back
 * looked exactly like a quiet market on the panel. Arithmetic over our own tables, no model.
 */
export function detectStalls(store: Store, settings: Settings, now = Date.now()): Alarm[] {
  const out: Alarm[] = [];
  const one = <T>(sql: string, ...a: unknown[]): T => store.db.prepare(sql).get(...a) as T;
  const started = one<{ t: number | null }>("SELECT MIN(at) AS t FROM events WHERE kind = 'tick'").t;
  // A fresh install has had no chance to post; give it a day before calling silence a fault.
  if (!started || now - started < DAY) return out;

  if (settings.autoPublish) {
    const last = one<{ t: number | null }>("SELECT MAX(published_at) AS t FROM posts WHERE status = 'published'").t;
    if (!last || now - last >= 12 * 3600_000) {
      out.push({ code: 'no_posts', detail: `自动发布开着，但已经 ${last ? Math.round((now - last) / 3600_000) : '很多'} 小时没有发出一条帖子。看一下熔断、暂停、账号和发布日志。` });
    }
  }
  const calls = store.db
    .prepare('SELECT ok FROM brain_calls WHERE at >= ? ORDER BY at DESC LIMIT 5')
    .all(now - DAY) as { ok: number }[];
  if (calls.length >= 3 && calls.every(c => !c.ok)) {
    out.push({ code: 'brain_failing', detail: `大脑最近 ${calls.length} 次调用全部失败。检查 Key、Base URL、模型名和余额。` });
  }
  const recentPosts = one<{ n: number }>("SELECT COUNT(*) AS n FROM posts WHERE status = 'published' AND published_at BETWEEN ? AND ?", now - 3 * DAY, now - 3600_000).n;
  const lastStat = one<{ t: number | null }>('SELECT MAX(checked_at) AS t FROM post_stats').t;
  if (recentPosts > 0 && (!lastStat || now - lastStat >= 6 * 3600_000)) {
    out.push({ code: 'stats_stalled', detail: `已经 ${lastStat ? Math.round((now - lastStat) / 3600_000) : '很多'} 小时没有回抓到任何帖子数据，学习回路在读空气。` });
  }
  return out;
}

/** Push an alarm to the operator's webhook, if one is set. Never throws; a failure is logged. */
export async function pushAlarm(store: Store, settings: Settings, a: Alarm, now = Date.now()): Promise<boolean> {
  const url = settings.alertWebhook?.trim();
  if (!url || !/^https:\/\//i.test(url)) return false;
  const text = `[SquareForge] ${a.code}：${a.detail}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `msg_type`/`content` is the Feishu robot shape, `text` covers Slack and most others.
      body: JSON.stringify({ text, code: a.code, detail: a.detail, at: now, msg_type: 'text', content: { text } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) store.log('alarm_push_failed', { code: a.code, status: res.status });
    return res.ok;
  } catch (err) {
    store.log('alarm_push_failed', { code: a.code, error: String(err).slice(0, 120) });
    return false;
  }
}

function bestRecent(s: BrainSnapshot): { views: number; what: string } | null {
  const c = s.columns.filter(x => x.medianViews != null).sort((a, b) => (b.medianViews ?? 0) - (a.medianViews ?? 0))[0];
  if (!c || c.medianViews == null) return null;
  return { views: Math.round(c.medianViews), what: `栏目「${c.kind}」中位数` };
}

export interface SentinelReport {
  raised: Alarm[];
  woke: boolean;
  skippedWhy: string | null;
  reportId: number | null;
}

/**
 * Raise what is new, and wake the brain for the most important one if the cap allows.
 * Every alarm is persisted so the panel can show it; waking is separate and rationed.
 */
export async function runSentinel(store: Store, settings: Settings, now = Date.now()): Promise<SentinelReport> {
  const snap = buildSnapshot(store, settings, now);
  const all = [...detectAlarms(snap, settings), ...detectStalls(store, settings, now)];
  const fresh = all.filter(a => {
    const last = store.db.prepare('SELECT MAX(at) AS t FROM brain_alarms WHERE code = ?').get(a.code) as { t: number | null };
    return !last.t || now - last.t >= REPEAT_QUIET_MS;
  });
  const report: SentinelReport = { raised: fresh, woke: false, skippedWhy: null, reportId: null };

  const ins = store.db.prepare('INSERT INTO brain_alarms (at, code, detail, woke) VALUES (?,?,?,0)');
  const ids = fresh.map(a => Number(ins.run(now, a.code, a.detail).lastInsertRowid));
  // The panel only helps an operator who opens it. A webhook reaches one who does not.
  for (const a of fresh) await pushAlarm(store, settings, a, now);

  if (fresh.length) enqueueJob(store, 'sentinel', { alarmIds: ids }, { key: `sentinel:${ids.join(',')}`, now });
  if (!settings.brainSentinel) { report.skippedWhy = '哨兵唤醒已在配置里关闭'; return report; }
  const queued = pendingJob(store, 'sentinel', now);
  if (!queued) return report;
  const payload = JSON.parse(queued.payload_json) as { alarmIds: number[] };
  const alarms = payload.alarmIds.map(id => store.db.prepare('SELECT id, code FROM brain_alarms WHERE id=? AND report_id IS NULL').get(id) as { id: number; code: string } | undefined)
    .filter((a): a is { id: number; code: string } => Boolean(a));
  const active = all.filter(a => alarms.some(old => old.code === a.code));
  if (!active.length) {
    store.db.prepare("UPDATE brain_jobs SET status='expired', resolved_at=? WHERE id=?").run(now, queued.id);
    report.skippedWhy = '警报条件已消失，取消过期分析';
    return report;
  }
  const brain = brainFor(store, settings);
  if (!brain) { report.skippedWhy = '大脑没有配置好'; return report; }
  // One logical wake may have up to two delayed retries; transport attempts have a separate cap.
  const wakes = (store.db.prepare("SELECT COUNT(*) AS n FROM brain_jobs WHERE purpose='sentinel' AND created_at>=? AND runs>0 AND id<>?")
    .get(now - DAY, queued.id) as { n: number }).n;
  const legacy = (store.db.prepare("SELECT COUNT(*) AS n FROM brain_calls WHERE purpose='sentinel' AND at>=? AND call_key IS NULL").get(now - DAY) as { n: number }).n;
  if (queued.runs === 0 && wakes + legacy >= settings.brainWakeCapPerDay) {
    report.skippedWhy = `今天已达到 ${settings.brainWakeCapPerDay} 次唤醒上限`;
    return report;
  }
  const job = claimJob(store, queued.id, now);
  if (!job) { report.skippedWhy = '分析正在执行或等待补跑时间'; return report; }
  const head = active[0]!;
  const r = await brain.ask({
    purpose: 'sentinel',
    system: withOperatorNotes(SENTINEL_SYSTEM, store.getSetting<string>('brainNotes', '')),
    context: `警报：\n${active.map(a => `- [${a.code}] ${a.detail}`).join('\n')}\n\n快照：\n${snapshotText(snap)}`,
    maxTokens: settings.brainMaxTokensSentinel,
  });
  if (!r.ok) { failJob(store, job.id, r.error, now, r.retryAt); report.skippedWhy = `调用失败，已登记有限补跑：${r.error.slice(0, 120)}`; return report; }

  return store.db.transaction(() => {

  const rep = store.db
    .prepare("INSERT INTO brain_reports (kind, created_at, title, body, snapshot_json, actions_json, status) VALUES ('sentinel', ?, ?, ?, ?, '[]', 'pending')")
    .run(now, `哨兵：${head.code}`, stripUpgrades(r.text), JSON.stringify(snap));
  report.reportId = Number(rep.lastInsertRowid);
  report.woke = true;
  const mark = store.db.prepare('UPDATE brain_alarms SET woke = 1, report_id = ? WHERE id = ?');
  for (const a of alarms) if (active.some(current => current.code === a.code)) mark.run(report.reportId, a.id);
  fileFromReply(store, r.text, { source: 'sentinel', reportId: report.reportId, now });
  finishJob(store, job.id, report.reportId, now);
  store.log('brain_sentinel', { codes: active.map(a => a.code), reportId: report.reportId });
  return report;
  })();
}
