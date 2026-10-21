import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from '../db/index.ts';
import { createArchive, extractAndVerify, installRestore, prepareRestore } from './archive.ts';
import { configPath, loadConfig, publicConfig, readJson, safeError, targetOf, validateConfig, writePrivateJson, type BackupConfig } from './config.ts';
import { assertBackupKey, S3BackupStorage, type BackupStorage } from './storage.ts';

interface BackupSuccess { at: number; target: string; key: string; bytes: number; sha256: string; charts: number; counts: Record<string, number>; }
interface BackupState {
  lastSuccess?: BackupSuccess;
  lastAttemptAt?: number;
  lastError?: string | null;
  lastRestore?: { at: number; key: string; rollbackDir: string; counts: Record<string, number> };
}
export interface BackupJob { kind: 'backup' | 'restore' | 'check'; startedAt: number; stage: string; }

export class BackupManager {
  readonly dataDir: string;
  readonly chartsDir: string;
  private state: BackupState;
  private job: BackupJob | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<unknown> | null = null;
  private drained: Promise<void> | null = null;
  constructor(
    private store: Store,
    private options: {
      dataDir?: string; chartsDir?: string;
      storage?: (config: BackupConfig) => BackupStorage;
      canRestore?: () => boolean;
      onRestored?: () => void;
    } = {},
  ) {
    this.dataDir = resolve(options.dataDir ?? dirname(store.db.name));
    this.chartsDir = resolve(options.chartsDir ?? join(this.dataDir, 'charts'));
    this.state = readJson<BackupState>(join(this.dataDir, 'backup-state.json'), {});
  }

  get busy(): boolean { return this.job !== null; }
  get restoring(): boolean { return this.job?.kind === 'restore'; }
  get config(): BackupConfig { return loadConfig(this.dataDir); }
  status() {
    const config = this.config;
    const success = this.state.lastSuccess?.target === targetOf(config) ? this.state.lastSuccess : null;
    const nextAt = config.enabled ? (success ? success.at + config.intervalHours * 3_600_000 : Date.now()) : null;
    return {
      config: publicConfig(config), job: this.job, lastSuccess: success,
      lastError: this.state.lastError ?? null, lastRestore: this.state.lastRestore ?? null,
      nextAt, overdue: Boolean(config.enabled && (!success || Date.now() - success.at > (config.intervalHours + 1) * 3_600_000)),
    };
  }

  saveConfig(body: Record<string, unknown>) {
    if (this.busy) throw new Error('备份任务正在运行，请完成后再修改配置');
    const next = validateConfig(body, this.config);
    writePrivateJson(configPath(this.dataDir), next);
    return publicConfig(next);
  }

  private storage(config: BackupConfig): BackupStorage {
    validateConfig({}, config);
    return this.options.storage?.(config) ?? new S3BackupStorage(config);
  }

  async list() {
    const storage = this.storage(this.config);
    try { return await storage.list(); } finally { storage.close(); }
  }

  private async execute<T>(kind: BackupJob['kind'], action: (storage: BackupStorage, config: BackupConfig) => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('已有备份或导入任务正在运行');
    const config = this.config;
    this.job = { kind, startedAt: Date.now(), stage: '连接 S3' };
    let finish!: () => void;
    this.drained = new Promise<void>(resolve => { finish = resolve; });
    let storage: BackupStorage | undefined;
    try {
      storage = this.storage(config);
      const result = await action(storage, config);
      this.state.lastError = null;
      return result;
    } catch (error) {
      const message = safeError(error, config);
      this.state.lastError = message;
      this.store.log(`s3_${kind}_failed`, { error: message });
      throw new Error(message);
    } finally {
      try {
        storage?.close();
        writePrivateJson(join(this.dataDir, 'backup-state.json'), this.state);
      } finally { this.job = null; this.drained = null; finish(); }
    }
  }

  async check() { return this.execute('check', storage => storage.check()); }

  async backup(): Promise<BackupSuccess> {
    return this.execute('backup', async (storage, config) => {
      this.state.lastAttemptAt = Date.now();
      const work = this.workDir();
      try {
        await storage.check();
        this.job!.stage = '生成数据库一致性快照与图片归档';
        const archive = await createArchive(this.store, work, this.chartsDir);
        const stamp = archive.manifest.createdAt.replace(/[:.]/g, '-');
        const key = `${config.prefix}/${stamp.slice(0, 10)}/squareforge-${stamp}-${randomUUID()}.tar.gz`;
        this.job!.stage = '上传 S3 并校验';
        await storage.put(key, archive.file, archive.sha256);
        const success: BackupSuccess = {
          at: Date.now(), target: targetOf(config), key, bytes: statSync(archive.file).size, sha256: archive.sha256,
          charts: archive.manifest.charts.length, counts: archive.manifest.counts,
        };
        this.state.lastSuccess = success;
        this.store.log('s3_backup', { key, bytes: success.bytes, charts: success.charts });
        return success;
      } finally { rmSync(work, { recursive: true, force: true }); }
    });
  }

  async restore(key: string) {
    if (this.options.canRestore && !this.options.canRestore()) throw new Error('当前有采集、发布或其他写入任务，请完成后再导入');
    assertBackupKey(key, this.config);
    return this.execute('restore', async storage => {
      const work = this.workDir();
      try {
        this.job!.stage = '从 S3 下载备份';
        const file = join(work, 'download.tar.gz');
        const remote = await storage.get(key, file);
        this.job!.stage = '校验归档、数据库与图片';
        const dir = join(work, 'restore');
        const manifest = await extractAndVerify(file, dir, remote.sha256);
        prepareRestore(dir, this.chartsDir);
        this.job!.stage = '保存当前数据并导入';
        const rollbackDir = join(this.dataDir, 'restore-history', `${Date.now()}-${randomUUID()}`);
        installRestore(this.store, dir, this.chartsDir, rollbackDir);
        this.state.lastRestore = { at: Date.now(), key, rollbackDir, counts: manifest.counts };
        this.store.log('s3_restore', { key, rollbackDir, counts: manifest.counts });
        this.options.onRestored?.();
        return this.state.lastRestore;
      } finally { rmSync(work, { recursive: true, force: true }); }
    });
  }

  private workDir(): string {
    const root = join(this.dataDir, 'backup-work');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return mkdtempSync(join(root, 'job-'));
  }

  /** The scheduler is independent of autoRun, publishing, and paused state. */
  async runDue(now = Date.now()): Promise<void> {
    const config = this.config;
    if (this.busy || !config.enabled || !config.bucket || !config.accessKeyId || !config.secretAccessKey) return;
    const success = this.state.lastSuccess;
    if (success?.target === targetOf(config) && now - success.at < config.intervalHours * 3_600_000) return;
    if (this.state.lastError && now - (this.state.lastAttemptAt ?? 0) < 15 * 60_000) return;
    await this.backup();
  }

  start(): void {
    if (this.timer) return;
    const run = () => {
      if (this.pending) return;
      this.pending = this.runDue().catch(error => {
        // execute() persists the failure; avoid leaking raw SDK request configuration.
        console.error(`S3 自动备份失败：${safeError(error, this.config)}`);
      }).finally(() => { this.pending = null; });
    };
    this.timer = setInterval(run, 60_000);
    this.timer.unref();
    run();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending;
    await this.drained;
  }
}
