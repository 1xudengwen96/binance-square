import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const RETENTION_DAYS = 30;
export interface BackupConfig {
  bucket: string;
  region: string;
  prefix: string;
  intervalHours: number;
  enabled: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function configPath(dataDir: string): string { return join(dataDir, 'backup-config.json'); }

export function loadConfig(dataDir: string): BackupConfig {
  return {
    bucket: process.env.S3_BACKUP_BUCKET ?? '',
    region: process.env.AWS_REGION ?? 'ap-northeast-1',
    prefix: 'backups', intervalHours: 6, enabled: false,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
    sessionToken: process.env.AWS_SESSION_TOKEN ?? '',
    ...readJson<Partial<BackupConfig>>(configPath(dataDir), {}),
  };
}

export function validateConfig(input: Record<string, unknown>, current: BackupConfig): BackupConfig {
  const next = { ...current };
  for (const key of ['bucket', 'region', 'prefix'] as const) {
    if (key in input) {
      if (typeof input[key] !== 'string') throw new Error('S3 连接配置格式不正确');
      next[key] = input[key].trim();
    }
  }
  next.prefix = next.prefix.replace(/^\/+|\/+$/g, '');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(next.bucket) || next.bucket.includes('..')) throw new Error('请输入有效的 S3 桶名');
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(next.region)) throw new Error('AWS 地区格式不正确');
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(next.prefix) || next.prefix.length > 120) throw new Error('备份目录只允许字母、数字、横线、下划线和目录分隔符');
  if ('intervalHours' in input) {
    const n = input.intervalHours;
    if (typeof n !== 'number' || ![1, 3, 6, 12, 24].includes(n)) throw new Error('备份周期请选择 1、3、6、12 或 24 小时');
    next.intervalHours = n;
  }
  if ('enabled' in input) {
    if (typeof input.enabled !== 'boolean') throw new Error('自动备份开关格式不正确');
    next.enabled = input.enabled;
  }
  // Empty fields mean "keep the saved credential". No secret is ever returned to the UI.
  for (const key of ['accessKeyId', 'secretAccessKey', 'sessionToken'] as const) {
    if (key in input && typeof input[key] !== 'string') throw new Error('AWS 凭据格式不正确');
    if (typeof input[key] === 'string' && input[key].trim()) next[key] = input[key].trim();
  }
  if (input.clearSessionToken === true) next.sessionToken = '';
  if (!next.accessKeyId || !next.secretAccessKey) throw new Error('请填写 AWS Access Key ID 和 Secret Access Key');
  return next;
}

export function publicConfig(c: BackupConfig) {
  return {
    bucket: c.bucket, region: c.region, prefix: c.prefix, enabled: c.enabled,
    intervalHours: c.intervalHours, retentionDays: RETENTION_DAYS,
    accessKeyHint: c.accessKeyId ? `••••${c.accessKeyId.slice(-4)}` : '',
    hasCredentials: Boolean(c.accessKeyId && c.secretAccessKey), hasSessionToken: Boolean(c.sessionToken),
  };
}

export function targetOf(c: BackupConfig): string { return `${c.region}/${c.bucket}/${c.prefix}`; }

export function safeError(error: unknown, config: BackupConfig): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [config.accessKeyId, config.secretAccessKey, config.sessionToken]) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message.slice(0, 400);
}
