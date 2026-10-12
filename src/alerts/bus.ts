import type { Store } from '../db/index.ts';

/**
 * The expectation-driven alert bus (定稿 §3-P0-3, 契约 shared/告警总线契约v1.md v1.1).
 *
 * The rule the whole module serves: 读不到 ≠ 是零, and 无因由码的「没发」本身即故障.
 * So a raise() never carries a defaulted severity, dedup happens on kind+key only,
 * and an acked alert silences *the same key* for 24h — not the kind globally, because
 * one operator acknowledging zhang's stall must not mute forwhat's.
 */

export type Severity = 'info' | 'warning' | 'fault' | 'breach';
export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, fault: 2, breach: 3 };

export interface AlertInput {
  kind: string;
  severity: Severity;
  key: string;
  reasonCode?: string | null;
  samplesInWindow?: number | null;
  subreason?: string | null;
  extra?: Record<string, unknown>;
  now?: number;
}

export interface AlertEnvelope {
  kind: string;
  severity: Severity;
  key: string;
  firstAt: number;
  lastAt: number;
  count: number;
  ageHours: number;
  reasonCode: string | null;
  samplesInWindow: number | null;
  subreason: string | null;
  acked: boolean;
  ackedBy: string | null;
  ackedAt: number | null;
  extra?: Record<string, unknown>;
}

interface LedgerEntry extends AlertEnvelope {}
type Ledger = Record<string, LedgerEntry>;

const LEDGER_KEY = 'alertLedger';
const ACK_SILENCE_MS = 24 * 3_600_000;

const entryId = (kind: string, key: string) => `${kind}|${key}`;

function toEnvelope(e: LedgerEntry, now: number): AlertEnvelope {
  const { ...rest } = e;
  return { ...rest, ageHours: Math.round(((now - e.firstAt) / 3_600_000) * 10) / 10 };
}

/**
 * Raise (or merge into) an alert. Returns whether anything was published:
 * a same-or-lower-severity re-raise only moves lastAt/count forward without a new
 * event row, an escalation writes the event again. Contract: severity 单调升档，升档即重发.
 */
export function raise(store: Store, input: AlertInput): { fired: 'raised' | 'escalated' | null; envelope: AlertEnvelope } {
  const now = input.now ?? Date.now();
  const ledger = store.getSetting<Ledger>(LEDGER_KEY, {});
  const id = entryId(input.kind, input.key);
  const prev = ledger[id];
  if (prev) {
    // An acknowledged alert is silent for 24h on the same kind+key. The entry stays
    // (the panel still shows it as acked); only the re-raise is suppressed.
    if (prev.acked && now - (prev.ackedAt ?? 0) < ACK_SILENCE_MS) {
      return { fired: null, envelope: toEnvelope(prev, now) };
    }
    const escalate = SEVERITY_RANK[input.severity] > SEVERITY_RANK[prev.severity];
    prev.lastAt = now;
    prev.count += 1;
    if (escalate) prev.severity = input.severity;
    if (input.reasonCode !== undefined) prev.reasonCode = input.reasonCode;
    if (input.samplesInWindow !== undefined) prev.samplesInWindow = input.samplesInWindow;
    if (input.subreason && input.subreason !== prev.subreason) {
      // loop_stalled 一条活动告警折叠四态：subreason 记最新，extra.subreasons 记分态集合，
      // 合并后前端才能还原「哪些态同时成立」而不是只看到最后一个。
      const seen = new Set<string>((prev.extra?.subreasons as string[] | undefined) ?? []);
      if (prev.subreason) seen.add(prev.subreason);
      seen.add(input.subreason);
      prev.extra = { ...(prev.extra ?? {}), subreasons: [...seen] };
      prev.subreason = input.subreason;
    }
    if (input.extra) prev.extra = { ...(prev.extra ?? {}), ...input.extra };
    prev.acked = false; // re-fire after silence window = a new occurrence, needs attention again
    ledger[id] = prev;
    store.setSetting(LEDGER_KEY, ledger);
    if (escalate) {
      store.log(input.kind, { ...toEnvelope(prev, now), event: 'escalated' });
      return { fired: 'escalated', envelope: toEnvelope(prev, now) };
    }
    return { fired: null, envelope: toEnvelope(prev, now) };
  }
  const fresh: LedgerEntry = {
    kind: input.kind,
    severity: input.severity,
    key: input.key,
    firstAt: now,
    lastAt: now,
    count: 1,
    ageHours: 0,
    reasonCode: input.reasonCode ?? null,
    samplesInWindow: input.samplesInWindow ?? null,
    subreason: input.subreason ?? null,
    acked: false,
    ackedBy: null,
    ackedAt: null,
    extra: input.extra,
  };
  ledger[id] = fresh;
  store.setSetting(LEDGER_KEY, ledger);
  store.log(input.kind, { ...toEnvelope(fresh, now), event: 'raised' });
  return { fired: 'raised', envelope: toEnvelope(fresh, now) };
}

/** Condition met again — clear the entry so the panel stops lighting it and record the关档 event. */
export function clear(store: Store, kind: string, key: string, now = Date.now()): AlertEnvelope | null {
  const ledger = store.getSetting<Ledger>(LEDGER_KEY, {});
  const id = entryId(kind, key);
  const prev = ledger[id];
  if (!prev) return null;
  delete ledger[id];
  store.setSetting(LEDGER_KEY, ledger);
  store.log(`${kind}_clear`, { ...toEnvelope(prev, now), event: 'cleared' });
  return toEnvelope(prev, now);
}

export function ack(store: Store, kind: string, key: string, by: string, now = Date.now()): boolean {
  const ledger = store.getSetting<Ledger>(LEDGER_KEY, {});
  const prev = ledger[entryId(kind, key)];
  if (!prev) return false;
  prev.acked = true;
  prev.ackedBy = by;
  prev.ackedAt = now;
  ledger[entryId(kind, key)] = prev;
  store.setSetting(LEDGER_KEY, ledger);
  store.log(kind, { ...toEnvelope(prev, now), event: 'acked' });
  return true;
}

/** Active alerts, worst first — the payload of `/api/status.alerts` (契约 §1). */
export function activeAlerts(store: Store, now = Date.now()): AlertEnvelope[] {
  const ledger = store.getSetting<Ledger>(LEDGER_KEY, {});
  return Object.values(ledger)
    .map(e => toEnvelope(e, now))
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.lastAt - a.lastAt);
}

export function findActive(store: Store, kind: string, key: string, now = Date.now()): AlertEnvelope | null {
  const ledger = store.getSetting<Ledger>(LEDGER_KEY, {});
  const e = ledger[entryId(kind, key)];
  return e ? toEnvelope(e, now) : null;
}

/** Any un-acked alert of this kind — the publish gate asks 「今天有没有单条即切的旗标」. */
export function hasActiveUnacked(store: Store, kind: string): boolean {
  const ledger = store.getSetting<Ledger>(LEDGER_KEY, {});
  return Object.values(ledger).some(e => e.kind === kind && !e.acked);
}

/* ------------------------------------------------------------------ kinds --- */
// 契约 v1.1 的 kind 常量：生产者只用这些名字，拼错 kind 比不写更难查。
export const ALERT_KINDS = {
  collectGap: 'collect_gap',
  collectGapClear: 'collect_gap_clear',
  stallWarning: 'publish_stall_warning',
  stallFault: 'publish_stall_fault',
  stallBreach: 'publish_stall_breach',
  expectedGap: 'expected_gap',
  accountPoolEmpty: 'account_pool_empty',
  breakerTripped: 'breaker_tripped',
  receiptMismatch: 'receipt_mismatch',
  degradeDeclared: 'degrade_declared',
  imageMissing: 'image_missing',
  fontSubsetMissing: 'font_subset_missing',
  surgeBlocked: 'surge_blocked',
  loopStalled: 'loop_stalled',
  credentialMissing: 'credential_missing',
} as const;

export const PLANNED_GAP_CODES = ['no_material', 'quota_spent', 'breaker_on', 'human_pause'] as const;
export type PlannedGapCode = (typeof PLANNED_GAP_CODES)[number];

/**
 * 计划内空档必须落因由码 + 窗内样本数（定稿 §2 告警分级）；stall 阶梯只计「没码的没发」。
 * The day's observed reason codes live in a settings map keyed by 北京日界 so the日终对账
 * can tell a quiet market (no_material ×N) from a故障.
 */
export function noteGapReason(store: Store, dayStart: number, code: PlannedGapCode, samples: number, now = Date.now()): void {
  const all = store.getSetting<Record<string, { code: PlannedGapCode; samples: number; at: number }>>('gapReasons', {});
  const prev = all[String(dayStart)];
  // Same day, worst sample count wins; first code wins ties — one day, one attributable verdict.
  if (!prev || prev.code === code) all[String(dayStart)] = { code, samples: (prev?.samples ?? 0) + samples, at: now };
  store.setSetting('gapReasons', all);
}

export function dayGapReason(store: Store, dayStart: number): { code: PlannedGapCode; samples: number; at: number } | undefined {
  return store.getSetting<Record<string, { code: PlannedGapCode; samples: number; at: number }>>('gapReasons', {})[String(dayStart)];
}
