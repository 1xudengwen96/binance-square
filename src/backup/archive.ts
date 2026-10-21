import { createReadStream, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import * as tar from 'tar';
import { Store } from '../db/index.ts';
import { buildInfo } from '../build.ts';
import { settingsFrom } from '../schedule.ts';

interface FileRecord { name: string; bytes: number; sha256: string; }
export interface BackupManifest {
  format: 1;
  application: 'squareforge';
  createdAt: string;
  build: string;
  database: FileRecord;
  charts: FileRecord[];
  counts: Record<string, number>;
}

const CHART_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(?:png|svg|jpg|jpeg|webp)$/i;
const REQUIRED_TABLES = ['settings', 'accounts', 'materials', 'posts', 'brain_memory', 'studio_articles'];
const COUNT_TABLES = [...REQUIRED_TABLES, 'post_stats', 'post_stat_checks', 'post_arms', 'conversion_daily'];

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function inspectDatabase(path: string): Record<string, number> {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check') as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('备份数据库完整性检查失败');
    if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('备份数据库存在外键错误');
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(r => r.name));
    if (REQUIRED_TABLES.some(t => !tables.has(t))) throw new Error('文件不是兼容的 squareforge 数据库');
    return Object.fromEntries(COUNT_TABLES.filter(t => tables.has(t)).map(t => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
  } finally { db.close(); }
}

export async function createArchive(store: Store, workDir: string, chartsDir: string, now = Date.now()): Promise<{ file: string; manifest: BackupManifest; sha256: string }> {
  const snapshot = join(workDir, 'snapshot');
  mkdirSync(join(snapshot, 'charts'), { recursive: true, mode: 0o700 });
  const database = join(snapshot, 'squareforge.db');
  // SQLite's online backup API takes a consistent snapshot, including committed WAL data.
  await store.db.backup(database);
  const counts = inspectDatabase(database);
  const charts: FileRecord[] = [];
  if (existsSync(chartsDir)) {
    for (const name of readdirSync(chartsDir).sort()) {
      if (!CHART_NAME.test(name)) continue;
      const source = join(chartsDir, name);
      // Never follow a symlink out of the managed image directory.
      if (!lstatSync(source).isFile()) continue;
      const dest = join(snapshot, 'charts', name);
      try { copyFileSync(source, dest); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      charts.push({ name, bytes: statSync(dest).size, sha256: await sha256File(dest) });
    }
  }
  const manifest: BackupManifest = {
    format: 1, application: 'squareforge', createdAt: new Date(now).toISOString(), build: buildInfo().commit,
    database: { name: 'squareforge.db', bytes: statSync(database).size, sha256: await sha256File(database) }, charts, counts,
  };
  writeFileSync(join(snapshot, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const file = join(workDir, 'backup.tar.gz');
  await tar.c({ cwd: snapshot, file, gzip: true, portable: true, strict: true }, ['manifest.json', 'squareforge.db', 'charts']);
  return { file, manifest, sha256: await sha256File(file) };
}

export async function extractAndVerify(file: string, dest: string, expectedSha256: string): Promise<BackupManifest> {
  if (await sha256File(file) !== expectedSha256) throw new Error('S3 备份 SHA-256 校验失败，未修改当前数据');
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const files = new Set<string>();
  let total = 0;
  let entries = 0;
  let violation: string | null = null;
  const rejectEntry = (message: string): false => {
    violation = message;
    queueMicrotask(() => unpack.abort(new Error(message)));
    return false;
  };
  const unpack = new tar.Unpack({
    cwd: dest, strict: true,
    filter(path, entry) {
      if (violation) return false;
      const name = path.replace(/^\.\//, '');
      if (!('type' in entry)) return rejectEntry('归档条目格式不正确');
      if (++entries > 100_000 || !['File', 'Directory'].includes(entry.type) || name.includes('..') || name.startsWith('/')) return rejectEntry('归档包含不允许的文件');
      if (entry.type === 'Directory') {
        if (name !== 'charts/' && name !== 'charts') return rejectEntry('归档目录无效');
        return true;
      }
      if (name !== 'squareforge.db' && name !== 'manifest.json' && !(name.startsWith('charts/') && CHART_NAME.test(name.slice(7)))) return rejectEntry('归档文件路径无效');
      if (files.has(name)) return rejectEntry('归档存在重复文件');
      files.add(name);
      total += entry.size;
      if (total > 20 * 1024 ** 3 || (name === 'manifest.json' && entry.size > 2 * 1024 ** 2)) return rejectEntry('解压后的备份超过安全大小限制');
      return true;
    },
  });
  await pipeline(createReadStream(file), unpack);
  if (violation) throw new Error(violation);
  if (!files.has('manifest.json') || !files.has('squareforge.db')) throw new Error('备份缺少数据库或清单');
  const m = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8')) as BackupManifest;
  if (m.format !== 1 || m.application !== 'squareforge' || m.database?.name !== 'squareforge.db' || !Array.isArray(m.charts)) throw new Error('备份格式不兼容');
  const declared = new Set(['manifest.json', 'squareforge.db']);
  for (const record of [m.database, ...m.charts]) {
    const name = record === m.database ? 'squareforge.db' : `charts/${record.name}`;
    if (record !== m.database && (!CHART_NAME.test(record.name) || declared.has(name))) throw new Error('图片清单格式不正确');
    declared.add(name);
    if (!files.has(name) || !/^[a-f0-9]{64}$/.test(record.sha256) || statSync(join(dest, name)).size !== record.bytes || await sha256File(join(dest, name)) !== record.sha256) throw new Error(`备份文件校验失败：${name}`);
  }
  if (files.size !== declared.size) throw new Error('归档包含清单之外的文件');
  const actual = inspectDatabase(join(dest, 'squareforge.db'));
  for (const [table, count] of Object.entries(m.counts ?? {})) if (actual[table] !== count) throw new Error('数据库行数与备份清单不一致');
  return m;
}

/** Prepare using current migrations, remap image paths, and leave restored publishing stopped. */
export function prepareRestore(dir: string, chartsDir: string): void {
  const staged = Store.open(join(dir, 'squareforge.db'));
  try {
    const settings = settingsFrom(staged);
    staged.setSetting('settings', { ...settings, autoRun: false, autoPublish: false });
    staged.setSetting('paused', { at: Date.now(), reason: '数据已从 S3 导入，请确认旧服务器已停止，再恢复自动发布' });
    staged.setSetting('lastTickAt', 0);
    staged.setSetting('tickFailStreak', 0);
    const remap = (path: string) => {
      if (/^https?:\/\//i.test(path)) return path;
      const name = basename(path.replace(/\\/g, '/'));
      if (!CHART_NAME.test(name)) throw new Error('数据库中的图片路径无效');
      return join(resolve(chartsDir), name);
    };
    const posts = staged.db.prepare("SELECT id, images_json FROM posts WHERE images_json IS NOT NULL AND images_json != '[]'").all() as { id: number; images_json: string }[];
    const update = staged.db.prepare('UPDATE posts SET images_json = ? WHERE id = ?');
    for (const p of posts) {
      const paths = JSON.parse(p.images_json) as unknown;
      if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string')) throw new Error('数据库中的图片列表无效');
      update.run(JSON.stringify(paths.map(remap)), p.id);
    }
    const covers = staged.db.prepare("SELECT id, cover_path FROM studio_articles WHERE cover_path IS NOT NULL AND cover_path != ''").all() as { id: number; cover_path: string }[];
    for (const c of covers) staged.db.prepare('UPDATE studio_articles SET cover_path = ? WHERE id = ?').run(remap(c.cover_path), c.id);
    staged.db.pragma('wal_checkpoint(TRUNCATE)');
  } finally { staged.close(); }
}

/** Called synchronously after writers have been excluded. The old DB and images remain recoverable. */
export function installRestore(store: Store, dir: string, chartsDir: string, rollbackDir: string): void {
  mkdirSync(rollbackDir, { recursive: true, mode: 0o700 });
  const oldCharts = join(rollbackDir, 'charts');
  const hadCharts = existsSync(chartsDir);
  mkdirSync(join(dir, 'charts'), { recursive: true });
  if (hadCharts) renameSync(chartsDir, oldCharts);
  try {
    renameSync(join(dir, 'charts'), chartsDir);
    store.replaceDatabase(join(dir, 'squareforge.db'), join(rollbackDir, 'squareforge.db'));
  } catch (error) {
    rmSync(chartsDir, { recursive: true, force: true });
    if (hadCharts) renameSync(oldCharts, chartsDir);
    throw error;
  }
}
