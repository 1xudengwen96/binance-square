import { randomUUID } from 'node:crypto';
import type { Store } from '../db/index.ts';

export type JobPurpose = 'reflect' | 'sentinel' | 'weekly';
export interface BrainJob {
  id: number; job_key: string; purpose: JobPurpose; status: string; created_at: number; expires_at: number;
  next_at: number; lease_until: number | null; runs: number; payload_json: string;
  report_id: number | null; error: string | null;
}
const MINUTE = 60_000;
const MAX_RUNS = 3;

export function pendingJob(store: Store, purpose: JobPurpose, now = Date.now()): BrainJob | null {
  store.db.prepare(`UPDATE brain_jobs SET status='expired', resolved_at=?
    WHERE status IN ('pending','running') AND expires_at <= ?`).run(now, now);
  return store.db.prepare(`SELECT * FROM brain_jobs WHERE purpose=? AND status IN ('pending','running')
    ORDER BY id ASC LIMIT 1`).get(purpose) as BrainJob | undefined ?? null;
}

export function enqueueJob(store: Store, purpose: JobPurpose, payload: unknown = {}, opts: { key?: string; now?: number; ttl?: number } = {}): BrainJob {
  const now = opts.now ?? Date.now();
  const key = opts.key ?? `${purpose}:${randomUUID()}`;
  store.db.prepare(`INSERT INTO brain_jobs (job_key,purpose,created_at,expires_at,next_at,payload_json)
    VALUES (?,?,?,?,?,?) ON CONFLICT(job_key) DO NOTHING`).run(key, purpose, now,
      now + (opts.ttl ?? (purpose === 'weekly' ? 3 * 86_400_000 : purpose === 'sentinel' ? 6 * 3600_000 : 20 * 3600_000)), now, JSON.stringify(payload));
  return store.db.prepare('SELECT * FROM brain_jobs WHERE job_key=?').get(key) as BrainJob;
}

/** One process owns the lease; a restart can reclaim it after ten minutes. */
export function claimJob(store: Store, id: number, now = Date.now()): BrainJob | null {
  return store.db.transaction(() => {
    const res = store.db.prepare(`UPDATE brain_jobs SET status='running', runs=runs+1, lease_until=?
      WHERE id=? AND status IN ('pending','running') AND next_at <= ? AND expires_at > ?
        AND (lease_until IS NULL OR lease_until <= ?) AND runs < ?`).run(now + 10 * MINUTE, id, now, now, now, MAX_RUNS);
    if (res.changes) return store.db.prepare('SELECT * FROM brain_jobs WHERE id=?').get(id) as BrainJob;
    store.db.prepare(`UPDATE brain_jobs SET status='failed', resolved_at=? WHERE id=? AND status='running'
      AND lease_until <= ? AND runs >= ?`).run(now, id, now, MAX_RUNS);
    return null;
  })();
}

export function finishJob(store: Store, id: number, reportId: number | null = null, now = Date.now()): void {
  store.db.prepare(`UPDATE brain_jobs SET status='done', lease_until=NULL, resolved_at=?, report_id=?, error=NULL WHERE id=?`).run(now, reportId, id);
}

export function failJob(store: Store, id: number, error: string, now = Date.now(), retryAt?: number): void {
  const job = store.db.prepare('SELECT * FROM brain_jobs WHERE id=?').get(id) as BrainJob;
  const delay = (job.runs === 1 ? 5 : 15) * MINUTE;
  const next = Math.max(now + delay, Number.isFinite(retryAt) ? retryAt! : 0);
  const failed = job.runs >= MAX_RUNS || next >= job.expires_at;
  store.db.prepare(`UPDATE brain_jobs SET status=?, lease_until=NULL, next_at=?, error=?, resolved_at=? WHERE id=?`)
    .run(failed ? 'failed' : 'pending', next, error.slice(0, 300), failed ? now : null, id);
}

export function hasDueJob(store: Store, purpose: JobPurpose, now = Date.now()): boolean {
  const job = pendingJob(store, purpose, now);
  return Boolean(job && job.next_at <= now && (job.lease_until == null || job.lease_until <= now));
}
