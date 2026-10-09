import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './db/index.ts';
import type { Settings } from './config.ts';

/**
 * Data lifecycle.
 *
 * A market feed is perishable: a long/short ratio from three hours ago is not old news,
 * it is misinformation, because the number has moved. Without deliberate expiry the
 * queue fills with drafts that would publish stale facts, and the database only grows.
 * So every category carries how long it stays worth posting.
 */
export const TTL_MINUTES: Record<string, number> = {
  market_move: 90,
  long_short: 120,
  leaderboard: 180,
  funding: 180,
  attention: 240,
  onchain: 240,
  dex: 240,
  // The detector measures a five-hour OI window, so past four hours the statement about
  // "持仓量增加 X%" is no longer about the market as it stands.
  open_interest: 240,
  newsflash: 360,
  announcement: 720,
  stablecoin: 720,
  sentiment: 720,
};

export const DEFAULT_TTL_MINUTES = 180;

/** How long a public-board sample stays in the comparison pool. */
export const BOARD_BENCHMARK_DAYS = 7;

export function ttlFor(category: string): number {
  return TTL_MINUTES[category] ?? DEFAULT_TTL_MINUTES;
}

export interface RetireReport {
  discarded: number;
  staleDrafts: number;
  deletedMaterials: number;
  deletedSamples: number;
  deletedEvents: number;
  deletedCharts: number;
  deletedBoardRows: number;
}

/** Material that is past its shelf life and has never been turned into a post. */
export function retireMaterials(store: Store, now = Date.now()): number {
  let total = 0;
  for (const [category, minutes] of Object.entries(TTL_MINUTES)) {
    total += store.db
      .prepare('UPDATE materials SET discarded = 1 WHERE discarded = 0 AND used_count = 0 AND category = ? AND occurred_at < ?')
      .run(category, now - minutes * 60_000).changes;
  }
  const known = new Set(Object.keys(TTL_MINUTES));
  total += store.db
    .prepare(
      `UPDATE materials SET discarded = 1
       WHERE discarded = 0 AND used_count = 0 AND occurred_at < ? AND category NOT IN (${[...known].map(() => '?').join(',')})`,
    )
    .run(now - DEFAULT_TTL_MINUTES * 60_000, ...known).changes;
  return total;
}

/**
 * Charts are regenerable at any time, so an orphan PNG is pure disk noise. Only files no
 * live post references and that have been sitting for a while are removed — a draft
 * awaiting approval still points at its chart.
 */
export function pruneOrphanCharts(store: Store, chartsDir: string, settings: Settings, now = Date.now()): number {
  let files: string[];
  try {
    files = readdirSync(chartsDir);
  } catch {
    return 0;
  }
  const referenced = new Set(store.referencedChartFiles().map(f => f.split(/[\\/]/).pop() ?? ''));
  const cutoff = now - settings.chartRetentionHours * 3_600_000;
  let removed = 0;
  for (const name of files) {
    if (referenced.has(name)) continue;
    const full = join(chartsDir, name);
    try {
      if (statSync(full).mtimeMs > cutoff) continue;
      rmSync(full, { force: true });
      removed++;
    } catch {
      // A file we cannot stat or delete is not worth failing the sweep over.
    }
  }
  return removed;
}

/**
 * Drafts age out on the same clock as the material they were written from: a long/short
 * ratio drafted at 3h ago is not a post waiting for review, it is a wrong statement about
 * the market waiting to be approved. They are rejected rather than deleted so the record
 * of what was generated survives.
 *
 * `approved` must be included. With autoPublish on, a draft is created already approved and
 * never sits in `draft` long enough to be swept — so expiring drafts only left the stale
 * backlog alive on the path that matters most, and 120 hours-old market claims were queued
 * to go out over the following four days.
 */
const RETIRABLE = "'draft','approved'";

export function retireStaleDrafts(store: Store, now = Date.now()): number {
  let total = 0;
  for (const [category, minutes] of Object.entries(TTL_MINUTES)) {
    total += store.db
      .prepare(
        `UPDATE posts SET status = 'rejected', error = '素材过期，草稿自动作废（' || ? || ' 类保质期已过）'
         FROM materials m
         WHERE posts.material_id = m.id AND posts.status IN (${RETIRABLE}) AND m.category = ? AND m.occurred_at < ?`,
      )
      .run(category, category, now - minutes * 60_000).changes;
  }
  const known = new Set(Object.keys(TTL_MINUTES));
  total += store.db
    .prepare(
      `UPDATE posts SET status = 'rejected', error = '素材过期，草稿自动作废'
       FROM materials m
       WHERE posts.material_id = m.id AND posts.status IN (${RETIRABLE}) AND m.category NOT IN (${[...known].map(() => '?').join(',')})
         AND m.occurred_at < ?`,
    )
    .run(...known, now - DEFAULT_TTL_MINUTES * 60_000).changes;
  // Drafts with no resolvable material cannot be checked against a TTL; leave them.
  return total;
}

/**
 * The whole retention pass. Cheap enough to run every tick.
 */
export function retire(store: Store, settings: Settings, chartsDir = 'data/charts', now = Date.now()): RetireReport {
  const horizon = now - settings.dataRetentionDays * 86_400_000;
  const report: RetireReport = {
    discarded: retireMaterials(store, now),
    staleDrafts: retireStaleDrafts(store, now),
    deletedMaterials: store.db.prepare('DELETE FROM materials WHERE collected_at < ?').run(horizon).changes,
    deletedSamples: store.pruneSamples(horizon),
    deletedEvents: store.db.prepare('DELETE FROM events WHERE at < ?').run(horizon).changes,
    deletedCharts: pruneOrphanCharts(store, chartsDir, settings, now),
    // A shorter window than the material retention on purpose: the benchmark is the answer
    // to "what is the feed rewarding this week", and a pool that keeps last month's posts in
    // it quietly compares current posts against a platform that no longer exists. A row ages
    // out once the boards stop showing it, because nothing re-reads it.
    deletedBoardRows: store.pruneBoardSamples(now - BOARD_BENCHMARK_DAYS * 86_400_000),
  };
  if (report.discarded || report.staleDrafts || report.deletedMaterials || report.deletedCharts || report.deletedBoardRows) {
    store.log('retire', report);
  }
  return report;
}
