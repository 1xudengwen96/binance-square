import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import * as tar from 'tar';
import { Store } from '../src/db/index.ts';
import { BackupManager } from '../src/backup/manager.ts';
import { configPath, loadConfig, publicConfig, validateConfig, writePrivateJson, type BackupConfig } from '../src/backup/config.ts';
import { extractAndVerify, sha256File } from '../src/backup/archive.ts';
import { assertBackupKey, type BackupStorage } from '../src/backup/storage.ts';
import { settingsFrom } from '../src/schedule.ts';
import { registerBackupRoutes } from '../src/server/backupRoutes.ts';
import { registerAccessGuard } from '../src/server/access.ts';

class MemoryStorage implements BackupStorage {
  objects = new Map<string, { bytes: Buffer; sha256: string }>();
  puts = 0;
  failPut = false;
  async put(key: string, file: string, sha256: string) {
    if (this.failPut) throw new Error('simulated upload failure');
    this.puts++;
    this.objects.set(key, { bytes: readFileSync(file), sha256 });
  }
  async get(key: string, file: string) {
    const item = this.objects.get(key);
    if (!item) throw new Error('backup not found');
    writeFileSync(file, item.bytes);
    return { sha256: item.sha256 };
  }
  async list() { return [...this.objects].map(([key, v]) => ({ key, bytes: v.bytes.length, createdAt: new Date().toISOString() })); }
  async check() { return { retentionDays: 30 }; }
  close() {}
}

function fixture(canRestore?: () => boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-s3-test-'));
  const charts = join(dir, 'charts');
  mkdirSync(charts);
  const store = Store.open(join(dir, 'squareforge.db'));
  const storage = new MemoryStorage();
  const config: BackupConfig = { bucket: 'test-backups', region: 'ap-northeast-1', prefix: 'backups', enabled: true, intervalHours: 6, accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key', sessionToken: '' };
  writePrivateJson(configPath(dir), config);
  const manager = new BackupManager(store, { dataDir: dir, storage: () => storage, canRestore });
  return { dir, charts, store, storage, manager, config, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('S3 round trip restores business data and images while preserving destination credentials and pausing publishing', async t => {
  const f = fixture(); t.after(f.cleanup);
  const image = 'BTC-1h-test.png';
  writeFileSync(join(f.charts, image), 'original image');
  f.store.setSetting('important', { memory: 'keep me' });
  f.store.setSetting('settings', { autoRun: true, autoPublish: true });
  f.store.addPost({ materialId: null, templateId: null, text: 'original post', status: 'published', scheduledAt: null, images: [`/old/server/data/charts/${image}`] });
  f.store.db.prepare("INSERT INTO studio_articles (track_id,concept_id,title,body,status,created_at,cover_path) VALUES ('track','concept','title','body','draft',?,?)").run(Date.now(), `/old/server/data/charts/${image}`);
  const backup = await f.manager.backup();
  assert.equal(backup.charts, 1);
  assert.equal(backup.counts.posts, 1);
  f.store.setSetting('important', { memory: 'changed after backup' });
  f.store.addPost({ materialId: null, templateId: null, text: 'later post', status: 'draft', scheduledAt: null });
  writeFileSync(join(f.charts, image), 'later image');
  f.manager.saveConfig({ secretAccessKey: 'destination-secret-key' });
  const restored = await f.manager.restore(backup.key);
  assert.deepEqual(f.store.getSetting('important', null), { memory: 'keep me' });
  assert.equal((f.store.db.prepare('SELECT COUNT(*) n FROM posts').get() as { n: number }).n, 1);
  assert.equal(readFileSync(join(f.charts, image), 'utf8'), 'original image');
  assert.equal((f.store.db.prepare('SELECT images_json FROM posts').get() as { images_json: string }).images_json, JSON.stringify([join(f.charts, image)]));
  assert.equal((f.store.db.prepare('SELECT cover_path FROM studio_articles').get() as { cover_path: string }).cover_path, join(f.charts, image));
  assert.equal(settingsFrom(f.store).autoRun, false);
  assert.equal(settingsFrom(f.store).autoPublish, false);
  assert.ok(f.store.getSetting('paused', null));
  assert.equal(loadConfig(f.dir).secretAccessKey, 'destination-secret-key');
  const rollback = new Database(join(restored.rollbackDir, 'squareforge.db'), { readonly: true });
  assert.equal((rollback.prepare('SELECT COUNT(*) n FROM posts').get() as { n: number }).n, 2); rollback.close();
  assert.equal(readFileSync(join(restored.rollbackDir, 'charts', image), 'utf8'), 'later image');
  assert.deepEqual(readdirSync(join(f.dir, 'backup-work')), []);
});

test('tampered S3 archive is rejected before changing database or images', async t => {
  const f = fixture(); t.after(f.cleanup);
  f.store.setSetting('important', 'untouched');
  writeFileSync(join(f.charts, 'BTC.png'), 'untouched');
  const b = await f.manager.backup();
  const corrupt = f.storage.objects.get(b.key)!.bytes;
  corrupt[10] = corrupt[10]! ^ 1;
  await assert.rejects(f.manager.restore(b.key), /SHA-256/);
  assert.equal(f.store.getSetting('important', ''), 'untouched');
  assert.equal(readFileSync(join(f.charts, 'BTC.png'), 'utf8'), 'untouched');
  assert.equal(existsSync(join(f.dir, 'restore-history')), false);
});

test('automatic backup runs while business is paused, survives manager restart, and follows interval', async t => {
  const f = fixture(); t.after(f.cleanup);
  f.store.setSetting('paused', { reason: 'business paused' });
  f.store.setSetting('settings', { autoRun: false });
  await f.manager.runDue();
  assert.equal(f.storage.puts, 1);
  const restarted = new BackupManager(f.store, { dataDir: f.dir, storage: () => f.storage });
  await restarted.runDue();
  assert.equal(f.storage.puts, 1);
  const last = restarted.status().lastSuccess!.at;
  await restarted.runDue(last + 6 * 3_600_000);
  assert.equal(f.storage.puts, 2);
});

test('failed upload does not advance success state, retries after cooldown, and cleans staging files', async t => {
  const f = fixture(); t.after(f.cleanup);
  f.storage.failPut = true;
  await assert.rejects(f.manager.runDue(), /simulated upload failure/);
  assert.equal(f.manager.status().lastSuccess, null);
  assert.match(f.manager.status().lastError!, /upload failure/);
  assert.deepEqual(readdirSync(join(f.dir, 'backup-work')), []);
  f.storage.failPut = false;
  await f.manager.runDue();
  assert.equal(f.storage.puts, 0);
  await f.manager.runDue(Date.now() + 16 * 60_000);
  assert.equal(f.storage.puts, 1);
  assert.equal(f.manager.status().lastError, null);
});

test('restore refuses an active business task and excludes concurrent backup/config writes', async t => {
  let allowed = false;
  const f = fixture(() => allowed); t.after(f.cleanup);
  const b = await f.manager.backup();
  await assert.rejects(f.manager.restore(b.key), /当前有采集/);
  allowed = true;
  let release!: () => void;
  const blocked = new Promise<void>(r => { release = r; });
  const get = f.storage.get.bind(f.storage);
  f.storage.get = async (...args) => { await blocked; return get(...args); };
  const restoring = f.manager.restore(b.key);
  assert.equal(f.manager.restoring, true);
  await assert.rejects(f.manager.backup(), /正在运行/);
  assert.throws(() => f.manager.saveConfig({ intervalHours: 12 }), /正在运行/);
  release(); await restoring;
});

test('archives exclude AWS credentials, local state and rollback files, and never follow image symlinks', async t => {
  const f = fixture(); t.after(f.cleanup);
  const privateFile = join(f.dir, 'private-token.txt');
  writeFileSync(privateFile, 'do not back up');
  symlinkSync(privateFile, join(f.charts, 'secret.png'));
  mkdirSync(join(f.dir, 'restore-history')); writeFileSync(join(f.dir, 'restore-history', 'old.db'), 'old');
  const b = await f.manager.backup();
  const archive = join(f.dir, 'check.tar.gz'); writeFileSync(archive, f.storage.objects.get(b.key)!.bytes);
  const entries: string[] = [];
  await tar.t({ file: archive, onReadEntry: e => { entries.push(e.path); } });
  assert.deepEqual(entries.sort(), ['charts/', 'manifest.json', 'squareforge.db']);
});

test('restore rejects symlinks and validly checksummed archives with corrupt databases', async t => {
  const f = fixture(); t.after(f.cleanup);
  const input = join(f.dir, 'malicious'); mkdirSync(input);
  symlinkSync('/etc/passwd', join(input, 'squareforge.db'));
  writeFileSync(join(input, 'manifest.json'), '{}');
  const archive = join(f.dir, 'malicious.tar.gz');
  await tar.c({ cwd: input, file: archive, gzip: true }, ['manifest.json', 'squareforge.db']);
  await assert.rejects(extractAndVerify(archive, join(f.dir, 'extract'), await sha256File(archive)), /不允许/);
  assert.equal(existsSync(join(f.dir, 'extract', 'squareforge.db')), false);
  rmSync(join(input, 'squareforge.db'));
  writeFileSync(join(input, 'squareforge.db'), 'not sqlite');
  writeFileSync(join(input, 'manifest.json'), JSON.stringify({ format: 1, application: 'squareforge', database: { name: 'squareforge.db', bytes: 10, sha256: await sha256File(join(input, 'squareforge.db')) }, charts: [], counts: {} }));
  await tar.c({ cwd: input, file: archive, gzip: true }, ['manifest.json', 'squareforge.db']);
  await assert.rejects(extractAndVerify(archive, join(f.dir, 'extract2'), await sha256File(archive)), /database|file is not/i);
});

test('credential responses are masked, empty edits preserve secrets, and config files are private', t => {
  const f = fixture(); t.after(f.cleanup);
  const saved = f.manager.saveConfig({ accessKeyId: '', secretAccessKey: '', intervalHours: 12 });
  assert.equal(saved.intervalHours, 12);
  assert.equal(loadConfig(f.dir).secretAccessKey, f.config.secretAccessKey);
  assert.equal(statSync(configPath(f.dir)).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(publicConfig(f.config)).includes(f.config.secretAccessKey), false);
  assert.equal(JSON.stringify(f.manager.status()).includes(f.config.accessKeyId), false);
  assert.throws(() => validateConfig({ intervalHours: 0 }, f.config));
  assert.throws(() => validateConfig({ prefix: '../other' }, f.config));
  assert.throws(() => assertBackupKey('other/snapshot.tar.gz', f.config));
  assert.throws(() => assertBackupKey('backups/../snapshot.tar.gz', f.config));
});

test('a failed database replacement reopens the original Store without losing data', t => {
  const f = fixture(); t.after(f.cleanup);
  f.store.setSetting('important', 'original');
  const rollback = join(f.dir, 'rollback.db');
  assert.throws(() => f.store.replaceDatabase(join(f.dir, 'missing.db'), rollback));
  assert.equal(f.store.getSetting('important', ''), 'original');
  assert.equal(existsSync(rollback), false);
  assert.equal((f.store.db.pragma('integrity_check') as { integrity_check: string }[])[0]?.integrity_check, 'ok');
});

test('backup API requires login and UI header, and restore requires explicit confirmation', async t => {
  const f = fixture(); t.after(f.cleanup);
  const app = Fastify(); t.after(() => app.close());
  registerAccessGuard(app, false, { username: 'admin', password: 'test-panel-password' });
  registerBackupRoutes(app, f.manager, new Set());
  assert.equal((await app.inject('/api/backups/status')).statusCode, 401);
  const authorization = 'Basic ' + Buffer.from('admin:test-panel-password').toString('base64');
  const status = await app.inject({ url: '/api/backups/status', headers: { authorization } });
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.includes(f.config.secretAccessKey), false);
  assert.equal((await app.inject({ method: 'POST', url: '/api/backups/run', headers: { authorization } })).statusCode, 403);
  const headers = { authorization, 'x-squareforge': 'ui' };
  assert.equal((await app.inject({ method: 'POST', url: '/api/backups/restore', headers, payload: { key: 'backups/file.tar.gz' } })).statusCode, 400);
});
