import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './db/index.ts';

/**
 * A nightly copy of the database, because everything the robot has learned lives in one file.
 *
 * `VACUUM INTO` is used rather than a file copy: it writes a consistent snapshot while the loop
 * is still posting, without needing the WAL sidecars to line up. The destination is under
 * `data/`, which is already gitignored — a backup that lands outside it is a backup that
 * eventually gets committed to a public repository.
 */

const DAY = 86_400_000;

export interface BackupResult {
  made: string | null;
  skipped?: string;
  kept: string[];
  removed: number;
}

export function newestBackup(dir: string): { file: string; at: number } | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => f.endsWith('.db'));
  if (!files.length) return null;
  const stamped = files
    .map(f => ({ file: join(dir, f), at: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return stamped[0] ?? null;
}

export function backupDatabase(store: Store, opts: { dir?: string; keep?: number; minAgeMs?: number; now?: number } = {}): BackupResult {
  const dir = opts.dir ?? 'data/backup';
  const keep = opts.keep ?? 7;
  const now = opts.now ?? Date.now();
  mkdirSync(dir, { recursive: true });

  const existing = readdirSync(dir).filter(f => f.endsWith('.db')).sort();
  const last = newestBackup(dir);
  if (last && now - last.at < (opts.minAgeMs ?? 20 * 3600_000)) {
    return { made: null, skipped: `距上次备份 ${Math.round((now - last.at) / 3600_000)} 小时`, kept: existing, removed: 0 };
  }

  const d = new Date(now + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  const file = join(dir, `squareforge-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}.db`);
  store.db.prepare('VACUUM INTO ?').run(file);

  const all = readdirSync(dir).filter(f => f.endsWith('.db')).sort();
  let removed = 0;
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    rmSync(join(dir, old), { force: true });
    removed++;
  }
  return { made: file, kept: all.slice(Math.max(0, all.length - keep)), removed };
}

/** How stale the newest backup is, in hours. The panel warns on this rather than on a missing file. */
export function backupAgeHours(dir = 'data/backup', now = Date.now()): number | null {
  const last = newestBackup(dir);
  return last ? (now - last.at) / 3600_000 : null;
}

export const BACKUP_STALE_HOURS = 26;
export { DAY };
