import type { Store } from '../db/index.ts';
import type { Settings } from '../config.ts';
import { brainFor } from './brain.ts';
import { buildSnapshot, snapshotText } from './snapshot.ts';
import { WEEKLY_SYSTEM, withOperatorNotes } from './prompts.ts';
import { propose } from '../rank/registry.ts';
import { proposeChange } from '../rank/params.ts';
import { isSafeVariant, COLUMN_KINDS, type ColumnKind, type VariantSlot } from '../content/columns.ts';
import { remember } from './memory.ts';
import { fileFromReply, stripUpgrades } from './upgrades.ts';
import { enqueueJob, claimJob, failJob, finishJob } from './jobs.ts';
import { reviewWeekly, reviewText } from './review.ts';

/**
 * The weekly review and what happens to its recommendations.
 *
 * The report is text for the operator. Anything it recommends is parsed into a typed action and
 * *held*. Approving a report runs each action through the same gate a direct request would face:
 * the hypothesis registry's vocabulary check, the knob whitelist with its ±25% step, the variant
 * safety gate. The model cannot reach a lever that the gates do not already expose, and a refused
 * action is recorded (and read back by the next review) instead of silently dropped.
 */

const WEEK = 7 * 86_400_000;

export type BrainAction =
  | { type: 'TEST'; dimension: string; metric: string; mode: string; claim: string }
  | { type: 'PARAM'; key: string; to: number; reason: string }
  | { type: 'VARIANT_OFF'; id: number; reason: string }
  | { type: 'VARIANT_ADD'; kind: string; slot: string; text: string };

/** Parse `ACTION|…` lines. Anything malformed is dropped here; nothing malformed is ever held. */
export function parseActions(text: string): BrainAction[] {
  const out: BrainAction[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^[-·\d.、\s]+(?=ACTION)/i, '');
    if (!/^ACTION\|/i.test(line)) continue;
    const p = line.split('|').map(x => x.trim());
    const type = (p[1] ?? '').toUpperCase();
    if (type === 'TEST' && p.length >= 6) {
      out.push({ type: 'TEST', dimension: p[2]!, metric: p[3]!, mode: p[4]!.toLowerCase(), claim: p.slice(5).join('|') });
    } else if (type === 'PARAM' && p.length >= 5 && Number.isFinite(Number(p[3]))) {
      out.push({ type: 'PARAM', key: p[2]!, to: Number(p[3]), reason: p.slice(4).join('|') });
    } else if (type === 'VARIANT_OFF' && p.length >= 4 && Number.isInteger(Number(p[2]))) {
      out.push({ type: 'VARIANT_OFF', id: Number(p[2]), reason: p.slice(3).join('|') });
    } else if (type === 'VARIANT_ADD' && p.length >= 5) {
      out.push({ type: 'VARIANT_ADD', kind: p[2]!, slot: p[3]!, text: p.slice(4).join('|') });
    }
  }
  // One recommendation per week: more than one cannot be told apart when the window closes.
  return out.slice(0, 1);
}

/** The report body without the machine-readable lines. */
export function stripActions(text: string): string {
  return text.split('\n').filter(l => !/^\s*(?:[-·\d.、\s]+)?ACTION\|/i.test(l)).join('\n').trim();
}

/** Required sections, in order. A report missing one is stored but flagged. */
const SECTIONS = ['1 关卡状态', '2 假设账本', '3 失败账本', '4 对照重测', '5 本周唯一建议', '6 自检'];

export function missingSections(body: string): string[] {
  return SECTIONS.filter(s => !new RegExp(`^##\\s*${s.replace(' ', '\\s*')}`, 'm').test(body));
}

/**
 * Conclusions need evidence, a counter-example and a date. The recommendation section is checked
 * for all three; without them it is a feeling and is marked so rather than offered for approval.
 */
export function recommendationComplete(body: string): boolean {
  const sec = body.split(/^##\s*5/m)[1]?.split(/^##\s*6/m)[0] ?? '';
  if (/还不知道/.test(sec)) return true;
  return /证据[:：]/.test(sec) && /反例[:：]/.test(sec) && /到期日[:：]/.test(sec);
}

export interface WeeklyResult {
  ok: boolean;
  reportId: number | null;
  note: string;
}

export async function runWeekly(store: Store, settings: Settings, now = Date.now(), force = false): Promise<WeeklyResult> {
  if (!settings.brainWeekly && !force) return { ok: false, reportId: null, note: '周复盘在配置里已关闭' };
  const last = store.db.prepare("SELECT MAX(created_at) AS t FROM brain_reports WHERE kind = 'weekly'").get() as { t: number | null };
  if (!force && last.t && now - last.t < WEEK - 3600_000) return { ok: false, reportId: null, note: '距上一份周报不满一周' };
  const brain = brainFor(store, settings);
  if (!brain) return { ok: false, reportId: null, note: '大脑没有配置好（需要启用、Key 和模型）' };

  // A cycle begins Sunday 22:00 Beijing. Manual requests share the same idempotency key.
  const cycle = Math.floor((now - (3 * 86_400_000 + 14 * 3600_000)) / WEEK);
  const queued = enqueueJob(store, 'weekly', {}, { key: `weekly:${cycle}`, now });
  if (queued.status === 'done') return { ok: true, reportId: queued.report_id, note: '本期周报已经生成' };
  const job = claimJob(store, queued.id, now);
  if (!job) return { ok: false, reportId: null, note: '本期周报正在执行或等待有限补跑' };

  const snap = buildSnapshot(store, settings, now);
  const previous = store.db
    .prepare("SELECT created_at, body FROM brain_reports WHERE kind = 'weekly' ORDER BY id DESC LIMIT 1")
    .get() as { created_at: number; body: string } | undefined;
  const r = await brain.ask({
    purpose: 'weekly',
    system: withOperatorNotes(WEEKLY_SYSTEM, store.getSetting<string>('brainNotes', '')),
    context: `快照：\n${snapshotText(snap)}\n\n上一份周报（没有就是第一份）：\n${previous ? previous.body.slice(0, 3000) : '无'}`,
    maxTokens: settings.brainMaxTokensWeekly,
  });
  if (!r.ok) {
    failJob(store, job.id, r.error, now, r.retryAt);
    return { ok: false, reportId: null, note: `调用失败，已登记有限补跑：${r.error.slice(0, 160)}` };
  }

  const review = settings.brainReviewEnabled ? await reviewWeekly(store, settings, snap, r.text, r.connection) : null;

  return store.db.transaction(() => {
  const actions = parseActions(r.text);
  const body = stripUpgrades(stripActions(r.text));
  const gaps = missingSections(body);
  const incomplete = !recommendationComplete(body);
  const flags = [gaps.length ? `缺少章节：${gaps.join('、')}` : '', incomplete ? '第 5 节缺证据 / 反例 / 到期日' : ''].filter(Boolean);
  // A recommendation without its three parts is a feeling; it is shown but cannot be approved.
  const held = incomplete || gaps.includes('5 本周唯一建议') || (review && review.verdict !== 'supported') ? [] : actions;
  const rep = store.db
    .prepare("INSERT INTO brain_reports (kind, created_at, title, body, snapshot_json, actions_json, status, review_json) VALUES ('weekly', ?, ?, ?, ?, ?, 'pending', ?)")
    .run(now, `周复盘 ${new Date(now + 8 * 3600_000).toISOString().slice(0, 10)}${flags.length ? '（有缺项）' : ''}`, (flags.length ? `> 系统检查：${flags.join('；')}\n\n${body}` : body) + (review ? reviewText(review) : ''), JSON.stringify(snap), JSON.stringify(held), review ? JSON.stringify(review) : null);
  const reportId = Number(rep.lastInsertRowid);
  // Requests for a code change are filed whatever state the recommendation is in: they are records
  // for the operator, not actions, so there is nothing for the three-part check to protect.
  const filed = fileFromReply(store, r.text, { source: 'weekly', reportId, now });
  store.log('brain_weekly', { reportId, actions: held.length, flags, upgrades: filed.length });
  const extra = filed.length ? `；登记了 ${filed.length} 条需要改代码的事` : '';
  finishJob(store, job.id, reportId, now);
  return { ok: true, reportId, note: `${flags.length ? `已生成，但有缺项：${flags.join('；')}` : '已生成'}${extra}` };
  })();
}

export interface ApplyOutcome {
  action: BrainAction;
  ok: boolean;
  detail: string;
}

/** Run one held action through the gate that owns it. Never throws. */
export function applyAction(store: Store, a: BrainAction, now = Date.now()): ApplyOutcome {
  try {
    if (a.type === 'TEST') {
      const r = propose(store, { claim: a.claim, mode: a.mode, dimension: a.dimension, metric: a.metric, origin: 'brain', now });
      return { action: a, ok: r.ok, detail: r.ok ? (r.status === 'active' ? '假设已登记并生效' : '假设已登记，等待审批（会占用真实流量）') : r.reason };
    }
    if (a.type === 'PARAM') {
      const r = proposeChange(store, { key: a.key, to: a.to, reason: a.reason, origin: 'brain', now });
      return { action: a, ok: r.ok, detail: r.ok ? '参数改动已排队，下一轮开始验证' : r.reason };
    }
    if (a.type === 'VARIANT_OFF') {
      const row = store.db.prepare("SELECT id, status FROM column_variants WHERE id = ?").get(a.id) as { id: number; status: string } | undefined;
      if (!row) return { action: a, ok: false, detail: `没有编号 ${a.id} 的变体` };
      if (row.status !== 'active') return { action: a, ok: false, detail: '这个变体已经下线' };
      store.db.prepare("UPDATE column_variants SET status = 'off', off_reason = ?, off_at = ? WHERE id = ?").run(a.reason.slice(0, 200), now, a.id);
      remember(store, { kind: 'content-lesson', key: `variant:off:${a.id}`, text: `变体 #${a.id} 因「${a.reason.slice(0, 80)}」下线，别再加回同样的说法。`, confidence: 0.5, source: 'brain', ttlMinutes: 30 * 24 * 60 });
      return { action: a, ok: true, detail: `变体 #${a.id} 已下线` };
    }
    const kinds = Object.keys(COLUMN_KINDS);
    if (!kinds.includes(a.kind)) return { action: a, ok: false, detail: `栏目只能是 ${kinds.join(' / ')}` };
    if (!['ask', 'watch', 'close'].includes(a.slot)) return { action: a, ok: false, detail: '位置只能是 ask / watch / close' };
    const safe = isSafeVariant(a.text);
    if (!safe.ok) return { action: a, ok: false, detail: safe.why };
    const ins = store.db
      .prepare("INSERT OR IGNORE INTO column_variants (kind, slot, text, status, origin, created_at) VALUES (?,?,?,'active','operator',?)")
      .run(a.kind as ColumnKind, a.slot as VariantSlot, a.text.trim(), now);
    return { action: a, ok: ins.changes > 0, detail: ins.changes > 0 ? '变体已加入' : '已经有同样的变体' };
  } catch (err) {
    return { action: a, ok: false, detail: `执行出错：${String(err).slice(0, 120)}` };
  }
}

/** Approve a report: apply its held actions, record what each gate said, close the report. */
export function approveReport(store: Store, id: number, now = Date.now()): { ok: boolean; results: ApplyOutcome[]; error?: string } {
  const row = store.db.prepare('SELECT id, status, actions_json FROM brain_reports WHERE id = ?').get(id) as { id: number; status: string; actions_json: string } | undefined;
  if (!row) return { ok: false, results: [], error: '找不到这份报告' };
  if (row.status !== 'pending') return { ok: false, results: [], error: `这份报告已经是「${row.status}」` };
  const actions = JSON.parse(row.actions_json || '[]') as BrainAction[];
  const results = actions.map(a => applyAction(store, a, now));
  const anyOk = results.some(r => r.ok);
  store.db
    .prepare('UPDATE brain_reports SET status = ?, resolved_at = ?, result_json = ? WHERE id = ?')
    .run(actions.length && !anyOk ? 'failed' : 'approved', now, JSON.stringify(results), id);
  store.log('brain_report_approved', { id, results: results.map(r => ({ type: r.action.type, ok: r.ok })) });
  return { ok: true, results };
}

export function dismissReport(store: Store, id: number, now = Date.now()): boolean {
  return store.db.prepare("UPDATE brain_reports SET status = 'dismissed', resolved_at = ? WHERE id = ? AND status = 'pending'").run(now, id).changes > 0;
}
