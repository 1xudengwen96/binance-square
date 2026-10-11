import type { Settings } from '../config.ts';
import type { Store } from '../db/index.ts';
import { saveSettings, settingsFrom } from '../schedule.ts';
import { medianOutcome } from './score.ts';
import type { Metric } from './hypotheses.ts';
import { remember } from '../brain/memory.ts';

/**
 * The system proposing changes to its own knobs.
 *
 * This is the dangerous half of self-optimisation, so it is built as a protocol rather than a
 * settings write. Four guards, all enforced here rather than in a prompt:
 *
 * 1. **Whitelist.** Only knobs listed below may move at all. Cadence, daily caps and anything
 *    that changes how much gets published are excluded on purpose: those change the account's
 *    exposure to the platform, which is not a number the robot gets to decide alone.
 * 2. **Bounded step.** One proposal may move a knob at most ±25%, so no single change can be
 *    the reason everything got worse.
 * 3. **One in flight.** Two concurrent changes cannot be attributed to either, and the whole
 *    scheme rests on attribution. A second proposal is refused until the first resolves.
 * 4. **Auto-rollback, including on ignorance.** After the window the judging metric is compared
 *    against the value recorded at apply time. No improvement means revert — and "not enough
 *    samples to tell" means revert too, because a change we cannot evaluate is a change we
 *    cannot defend.
 *
 * Rejected and rolled-back rows are kept, and a repeat of an already-failed change is refused.
 * "We tried that and it did not help" is the only record that stops the same idea coming back
 * every week with the same confidence.
 */

export const MAX_STEP = 0.25;
/** Days a change must run before it can be judged. Shorter, and this measures one good day. */
export const EVAL_WINDOW_DAYS = 7;
/** Below this many measured posts the window cannot decide anything, only postpone. */
export const MIN_SAMPLES_TO_JUDGE = 5;
/** A change still undecided after twice the window is rolled back rather than left in place. */
const HARD_DEADLINE_FACTOR = 2;

interface Knob {
  key: string;
  label: string;
  min: number;
  max: number;
  judge: Metric;
  /** Why this knob is worth a machine touching, and what it is not allowed to be judged by. */
  purpose: string;
}

/**
 * `postsPerDay`, `dailyCap`, `minIntervalMinutes` and the active window are deliberately absent.
 * They set how much of the account's quota the robot spends and how the posting shape looks to
 * platform abuse detection. That is not a quantity to be tuned by gradient.
 */
export const KNOBS: Knob[] = [
  {
    key: 'coinSignalCooldownMinutes',
    label: '同币同信号冷却（分钟）',
    min: 120,
    max: 2880,
    judge: 'views24h',
    purpose: '隔多久再写同一个币还有观众。h_repeat_interval 测的就是它。',
  },
  { key: 'categoryWeights:attention', label: '赛道配比 · 热度跟进', min: 0.1, max: 3, judge: 'views24h', purpose: '队列里这类素材占多少。' },
  { key: 'categoryWeights:market_move', label: '赛道配比 · 行情异动', min: 0.1, max: 3, judge: 'views24h', purpose: '队列里这类素材占多少。' },
  { key: 'categoryWeights:funding', label: '赛道配比 · 资金费率', min: 0.1, max: 3, judge: 'views24h', purpose: '队列里这类素材占多少。' },
  { key: 'categoryWeights:onchain', label: '赛道配比 · 链上', min: 0.1, max: 3, judge: 'views24h', purpose: '队列里这类素材占多少。' },
  { key: 'categoryWeights:newsflash', label: '赛道配比 · 快讯', min: 0.1, max: 3, judge: 'views24h', purpose: '队列里这类素材占多少。' },
];

export const KNOB_KEYS = KNOBS.map(k => k.key);

export function knobByKey(key: string): Knob | undefined {
  return KNOBS.find(k => k.key === key);
}

/** The live value of a whitelisted knob, for the panel. Null if the key is not a known knob. */
export function currentKnob(store: Store, key: string): number | null {
  return readKnob(settingsFrom(store), key);
}

function readKnob(s: Settings, key: string): number | null {
  const spec = knobByKey(key);
  if (!spec) return null;
  if (key.startsWith('categoryWeights:')) {
    const cat = key.slice('categoryWeights:'.length);
    return s.categoryWeights[cat] ?? null;
  }
  const v = s[key as keyof Settings];
  return typeof v === 'number' ? v : null;
}

function withKnob(s: Settings, key: string, value: number): Settings {
  if (key.startsWith('categoryWeights:')) {
    const cat = key.slice('categoryWeights:'.length);
    return { ...s, categoryWeights: { ...s.categoryWeights, [cat]: value } };
  }
  return { ...s, [key]: value };
}

const round = (v: number): number => Math.round(v * 100) / 100;

export type ChangeResult = { ok: true; id: number } | { ok: false; reason: string };

/**
 * Record a proposed change without applying it.
 *
 * The refusal reasons are meant to be read back by the model on the next reflection, the same
 * way hypothesis rejections are, so an out-of-bounds idea is corrected rather than retried.
 */
export function proposeChange(
  store: Store,
  opts: { key: string; to: number; reason: string; origin: 'brain' | 'operator'; now?: number },
): ChangeResult {
  const now = opts.now ?? Date.now();
  const spec = knobByKey(opts.key);
  if (!spec) {
    return { ok: false, reason: `「${opts.key}」不在可自动调整的旋钮里。可动的是：${KNOB_KEYS.join('、')}。发帖量、日额度、间隔和时段不交给机器决定。` };
  }
  if (!opts.reason.trim()) return { ok: false, reason: '没有理由的参数改动无法复盘，也无法判断该不该回滚。' };

  const settings = settingsFrom(store);
  const current = readKnob(settings, opts.key);
  if (current == null) return { ok: false, reason: `读不到「${spec.label}」当前值` };

  const lo = current * (1 - MAX_STEP);
  const hi = current * (1 + MAX_STEP);
  if (opts.to < lo || opts.to > hi) {
    return { ok: false, reason: `「${spec.label}」现在是 ${round(current)}，单次最多动 ±${MAX_STEP * 100}%，也就是 ${round(lo)}–${round(hi)} 之间。` };
  }
  const clamped = Math.max(spec.min, Math.min(spec.max, opts.to));
  if (clamped === current) return { ok: false, reason: `目标值就是当前值，改了等于没改。` };
  if (clamped !== opts.to) return { ok: false, reason: `「${spec.label}」的合法区间是 ${spec.min}–${spec.max}，你要求的值得不到批准。` };

  const inFlight = (store.db
    .prepare("SELECT COUNT(*) AS n FROM param_changes WHERE status IN ('pending','applied')")
    .get() as { n: number }).n;
  if (inFlight > 0) {
    return { ok: false, reason: `已经有一个参数改动在途（${inFlight} 个）。同时只允许一个，否则窗口结束时不知道归功于谁。` };
  }

  const tried = store.db
    .prepare("SELECT from_value, to_value, reason FROM param_changes WHERE key = ? AND status IN ('rolled_back','no_effect') ORDER BY resolved_at DESC LIMIT 5")
    .all(opts.key) as { from_value: number; to_value: number; reason: string }[];
  const repeat = tried.find(t => Math.abs(t.to_value - opts.to) / Math.max(t.to_value, 1) < 0.05);
  if (repeat) return { ok: false, reason: `这个值刚试过且没有改善（当时：${repeat.reason.slice(0, 40)}）。换个理由或换个方向。` };

  const res = store.db
    .prepare('INSERT INTO param_changes (key, from_value, to_value, reason, metric, status, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(opts.key, round(current), round(clamped), opts.reason.trim(), spec.judge, 'pending', now);
  return { ok: true, id: Number(res.lastInsertRowid) };
}

export interface AppliedChange {
  id: number;
  key: string;
  label: string;
  from: number;
  to: number;
  reason: string;
}

/** Move every pending change into effect, recording the number it has to beat. */
export function applyPendingChanges(store: Store, now = Date.now()): AppliedChange[] {
  const rows = store.db
    .prepare("SELECT id, key, from_value, to_value, reason FROM param_changes WHERE status = 'pending' ORDER BY created_at")
    .all() as { id: number; key: string; from_value: number; to_value: number; reason: string }[];
  const applied: AppliedChange[] = [];
  for (const r of rows) {
    const spec = knobByKey(r.key);
    if (!spec) {
      store.db.prepare("UPDATE param_changes SET status = 'rejected', reject_reason = ?, resolved_at = ? WHERE id = ?")
        .run('旋钮已不在白名单内', now, r.id);
      continue;
    }
    // Re-read rather than trust the queued value: the operator may have moved it by hand since
    // the proposal, and re-applying a stale baseline would silently undo their edit.
    const current = readKnob(settingsFrom(store), r.key);
    if (current == null) continue;
    if (Math.abs(current - r.from_value) / Math.max(r.from_value, 1) > 0.02) {
      store.db.prepare("UPDATE param_changes SET status = 'rejected', reject_reason = ?, resolved_at = ? WHERE id = ?")
        .run(`操作者已手动改为 ${round(current)}，不覆盖人的改动`, now, r.id);
      continue;
    }
    const before = medianOutcome(store, spec.judge, now - EVAL_WINDOW_DAYS * 86_400_000, now, now);
    if (before == null) {
      store.db.prepare("UPDATE param_changes SET status = 'rejected', reject_reason = ?, resolved_at = ? WHERE id = ?")
        .run('改动前没有可比的历史样本，应用之后也无从判断有没有用', now, r.id);
      continue;
    }
    saveSettings(store, withKnob(settingsFrom(store), r.key, r.to_value));
    store.db
      .prepare("UPDATE param_changes SET status = 'applied', applied_at = ?, evaluate_at = ?, before_median = ? WHERE id = ?")
      .run(now, now + EVAL_WINDOW_DAYS * 86_400_000, round(before), r.id);
    store.log('param_apply', { id: r.id, key: r.key, from: r.from_value, to: r.to_value, before: round(before), reason: r.reason });
    applied.push({ id: r.id, key: r.key, label: spec.label, from: r.from_value, to: r.to_value, reason: r.reason });
  }
  return applied;
}

export interface EvaluationResult {
  improved: string[];
  rolledBack: string[];
  deferred: string[];
}

/**
 * Decide every change whose window has closed.
 *
 * The metric is judged on posts published *after* the change took effect, against the value
 * recorded at apply time — not against "whatever the number is now", which would drift with the
 * coin rather than with the knob.
 */
export function evaluateChanges(store: Store, now = Date.now()): EvaluationResult {
  const out: EvaluationResult = { improved: [], rolledBack: [], deferred: [] };
  const rows = store.db
    .prepare("SELECT id, key, from_value, to_value, reason, applied_at, before_median FROM param_changes WHERE status = 'applied' AND evaluate_at <= ?")
    .all(now) as { id: number; key: string; from_value: number; to_value: number; reason: string; applied_at: number; before_median: number }[];

  for (const r of rows) {
    const spec = knobByKey(r.key);
    if (!spec) continue;
    const after = medianOutcome(store, spec.judge, r.applied_at, now, now);
    const n = store.db
      .prepare('SELECT COUNT(*) AS n FROM post_distribution d JOIN posts p ON p.id = d.post_id WHERE p.published_at >= ? AND p.status = \'published\'')
      .get(r.applied_at) as { n: number };

    if (after == null || n.n < MIN_SAMPLES_TO_JUDGE) {
      const overdue = now - r.applied_at >= HARD_DEADLINE_FACTOR * EVAL_WINDOW_DAYS * 86_400_000;
      if (!overdue) {
        out.deferred.push(r.key);
        continue;
      }
      // Not enough evidence either way. The default is to revert: a knob we cannot show helped is
      // a knob the operator has no reason to have lost their previous value over.
      rollback(store, r, `窗口内只有 ${n.n} 条可测帖子，样本不足以判断 —— 按未知处理即回滚。`, now);
      out.rolledBack.push(r.key);
      continue;
    }

    const delta = (after - r.before_median) / Math.max(Math.abs(r.before_median), 1);
    if (delta > 0.02) {
      store.db
        .prepare("UPDATE param_changes SET status = 'improved', after_median = ?, resolved_at = ? WHERE id = ?")
        .run(round(after), now, r.id);
      remember(store, {
        kind: 'audience-fact',
        key: `param:${r.key}:${r.to_value}`,
        text: `把「${spec.label}」从 ${r.from_value} 调到 ${r.to_value} 之后，${spec.judge} 中位数从 ${round(r.before_median)} 到 ${round(after)}（+${(delta * 100).toFixed(0)}%，${n.n} 条）。理由：${r.reason}`,
        confidence: Math.min(0.8, 0.55 + delta),
        evidenceN: n.n,
        source: 'param-loop',
      });
      store.log('param_improve', { id: r.id, key: r.key, delta: round(delta), n: n.n });
      out.improved.push(r.key);
    } else {
      rollback(store, r, `窗口内 ${spec.judge} 中位数 ${round(r.before_median)} → ${round(after)}（${n.n} 条），没有改善。`, now);
      out.rolledBack.push(r.key);
    }
  }
  return out;
}

function rollback(
  store: Store,
  r: { id: number; key: string; from_value: number; to_value: number; reason: string },
  why: string,
  now: number,
): void {
  saveSettings(store, withKnob(settingsFrom(store), r.key, r.from_value));
  store.db
    .prepare("UPDATE param_changes SET status = 'rolled_back', resolved_at = ?, after_median = NULL, reject_reason = ? WHERE id = ?")
    .run(now, why, r.id);
  const spec = knobByKey(r.key);
  remember(store, {
    kind: 'audience-fact',
    key: `param:${r.key}:${r.to_value}`,
    text: `试过把「${spec?.label ?? r.key}」调到 ${r.to_value}：${why}已自动改回 ${r.from_value}，别再提同一个值。`,
    confidence: 0.6,
    source: 'param-loop',
  });
  store.log('param_rollback', { id: r.id, key: r.key, restored: r.from_value, why });
}

/** What the panel shows: everything in flight or recently resolved. */
export function changeLedger(store: Store, limit = 20) {
  return store.db
    .prepare('SELECT * FROM param_changes ORDER BY created_at DESC LIMIT ?')
    .all(limit) as {
      id: number; key: string; from_value: number; to_value: number; reason: string; metric: string;
      status: string; reject_reason: string | null; created_at: number; applied_at: number | null;
      evaluate_at: number | null; resolved_at: number | null; before_median: number | null; after_median: number | null;
    }[];
}
