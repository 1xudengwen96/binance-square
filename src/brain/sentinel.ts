import type { Store } from '../db/index.ts';
import type { Settings } from '../config.ts';
import { brainFor, callsSince } from './brain.ts';
import { buildSnapshot, snapshotText, type BrainSnapshot } from './snapshot.ts';
import { SENTINEL_SYSTEM, withOperatorNotes } from './prompts.ts';

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

  const w14 = s.account.w14;
  if (w14.measured >= 10 && w14.commentsPer1k === 0 && !s.gates.B.passed) {
    out.push({ code: 'no_comments', detail: `近 14 天 ${w14.measured} 条有读数的帖子，评论一条都没有（合并评论率 0）。关卡 B 没有任何进展。` });
  }

  const med = s.account.w7.medianViews;
  const best = bestRecent(s);
  if (med != null && med > 0 && best && best.views >= 5 * med && best.views >= 300) {
    out.push({ code: 'outlier_good', detail: `有一条帖子读数 ${best.views}，是 7 天中位数 ${Math.round(med)} 的 ${(best.views / med).toFixed(1)} 倍（${best.what}）。要判断是运气还是能复制。` });
  }

  if (s.gates.A.passed && s.mission.targetMode === 'auto' && s.mission.target === 'engagement') {
    out.push({ code: 'gate_a_cleared', detail: `关卡 A 连续 ${s.gates.A.streakDays} 天过线，优化目标已自动切到互动质量。请确认这个切换合理。` });
  }

  const flipped = s.calls.total >= 5 && s.calls.held / Math.max(1, s.calls.total) < 0.3;
  if (flipped) out.push({ code: 'calls_failing', detail: `已裁决 ${s.calls.total} 条判断，只有 ${s.calls.held} 条成立。栏目的判断方式可能有问题。` });

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
  if (!fresh.length) return report;

  const ins = store.db.prepare('INSERT INTO brain_alarms (at, code, detail, woke) VALUES (?,?,?,0)');
  const ids = fresh.map(a => Number(ins.run(now, a.code, a.detail).lastInsertRowid));
  // The panel only helps an operator who opens it. A webhook reaches one who does not.
  for (const a of fresh) await pushAlarm(store, settings, a, now);

  if (!settings.brainSentinel) { report.skippedWhy = '哨兵唤醒已在配置里关闭'; return report; }
  const brain = brainFor(store, settings);
  if (!brain) { report.skippedWhy = '大脑没有配置好'; return report; }
  if (callsSince(store, now - DAY, ['sentinel']) >= settings.brainWakeCapPerDay) {
    report.skippedWhy = `今天已唤醒 ${settings.brainWakeCapPerDay} 次，达到上限`;
    return report;
  }

  const head = fresh[0]!;
  const r = await brain.ask({
    purpose: 'sentinel',
    system: withOperatorNotes(SENTINEL_SYSTEM, store.getSetting<string>('brainNotes', '')),
    context: `警报：\n${fresh.map(a => `- [${a.code}] ${a.detail}`).join('\n')}\n\n快照：\n${snapshotText(snap)}`,
    maxTokens: settings.brainMaxTokensSentinel,
  });
  if (!r.ok) { report.skippedWhy = `调用失败：${r.error.slice(0, 120)}`; return report; }

  const rep = store.db
    .prepare("INSERT INTO brain_reports (kind, created_at, title, body, snapshot_json, actions_json, status) VALUES ('sentinel', ?, ?, ?, ?, '[]', 'pending')")
    .run(now, `哨兵：${head.code}`, r.text, JSON.stringify(snap));
  report.reportId = Number(rep.lastInsertRowid);
  report.woke = true;
  const mark = store.db.prepare('UPDATE brain_alarms SET woke = 1, report_id = ? WHERE id = ?');
  for (const id of ids) mark.run(report.reportId, id);
  store.log('brain_sentinel', { codes: fresh.map(a => a.code), reportId: report.reportId });
  return report;
}
