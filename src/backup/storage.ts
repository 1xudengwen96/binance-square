import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand, GetBucketLifecycleConfigurationCommand, GetObjectCommand,
  HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutBucketLifecycleConfigurationCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import type { LifecycleRule } from '@aws-sdk/client-s3';
import type { BackupConfig } from './config.ts';

export interface RemoteBackup { key: string; bytes: number; createdAt: string; }
export interface BackupStorage {
  put(key: string, file: string, sha256: string): Promise<void>;
  get(key: string, file: string): Promise<{ sha256: string }>;
  list(): Promise<RemoteBackup[]>;
  check(): Promise<{ retentionDays: number | null }>;
  close(): void;
}

export const MAX_ARCHIVE_BYTES = 4 * 1024 ** 3;

export function assertBackupKey(key: string, config: BackupConfig): void {
  if (!key.startsWith(`${config.prefix}/`) || !key.endsWith('.tar.gz') || key.includes('..') || !/^[a-zA-Z0-9/_:.\-]+$/.test(key)) {
    throw new Error('只能恢复当前备份目录下的归档');
  }
}

export class S3BackupStorage implements BackupStorage {
  private client: S3Client;
  constructor(private config: BackupConfig) {
    this.client = new S3Client({
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}) },
      maxAttempts: 3, requestHandler: { connectionTimeout: 10_000, requestTimeout: 120_000 },
    });
  }

  async put(key: string, file: string, sha256: string): Promise<void> {
    const bytes = statSync(file).size;
    if (bytes > MAX_ARCHIVE_BYTES) throw new Error('备份超过 4 GiB，需先调整备份方案');
    const body = createReadStream(file);
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.config.bucket, Key: key, Body: body, ContentLength: bytes,
        ContentType: 'application/gzip', ServerSideEncryption: 'AES256', StorageClass: 'STANDARD',
        ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'), IfNoneMatch: '*',
        Metadata: { sha256, format: 'squareforge-v1' },
      }));
    } finally { body.destroy(); }
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
    if (head.ContentLength !== bytes || head.Metadata?.sha256 !== sha256 || head.ServerSideEncryption !== 'AES256') throw new Error('S3 上传后的完整性校验失败');
  }

  async get(key: string, file: string): Promise<{ sha256: string }> {
    assertBackupKey(key, this.config);
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key, ChecksumMode: 'ENABLED' }));
    const body = r.Body as Readable | undefined;
    if (!body) throw new Error('S3 备份内容为空');
    if (!r.ContentLength || r.ContentLength > MAX_ARCHIVE_BYTES || !/^[a-f0-9]{64}$/.test(r.Metadata?.sha256 ?? '')) {
      body.destroy();
      throw new Error('备份大小或校验信息无效');
    }
    await pipeline(body, createWriteStream(file, { mode: 0o600, flags: 'wx' }));
    return { sha256: r.Metadata!.sha256! };
  }

  async list(): Promise<RemoteBackup[]> {
    const out: RemoteBackup[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: `${this.config.prefix}/`, ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key?.endsWith('.tar.gz')) out.push({ key: o.Key, bytes: o.Size ?? 0, createdAt: o.LastModified?.toISOString() ?? '' });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async check(): Promise<{ retentionDays: number | null }> {
    const Bucket = this.config.bucket;
    await this.client.send(new HeadBucketCommand({ Bucket }));
    // Prove both write and read access, without leaving test data behind.
    const Key = `${this.config.prefix}/.checks/${randomUUID()}`;
    try {
      await this.client.send(new PutObjectCommand({ Bucket, Key, Body: 'squareforge connection check', ServerSideEncryption: 'AES256' }));
      const read = await this.client.send(new GetObjectCommand({ Bucket, Key }));
      if (await read.Body?.transformToString() !== 'squareforge connection check') throw new Error('S3 读写测试失败');
    } finally { await this.client.send(new DeleteObjectCommand({ Bucket, Key })); }
    let rules: LifecycleRule[];
    try { rules = (await this.client.send(new GetBucketLifecycleConfigurationCommand({ Bucket }))).Rules ?? []; }
    catch (error) {
      if ((error as Error).name !== 'NoSuchLifecycleConfiguration') throw error;
      rules = [];
    }
    const prefix = `${this.config.prefix}/`;
    const exact = (r: (typeof rules)[number]) => r.Filter?.Prefix === prefix || r.Prefix === prefix;
    if (!rules.some(r => exact(r) && r.Status === 'Enabled' && r.Expiration?.Days === 30)) {
      // Keep rules for other directories in shared buckets.
      await this.client.send(new PutBucketLifecycleConfigurationCommand({ Bucket, LifecycleConfiguration: {
        Rules: [...rules.filter(r => !exact(r)), { ID: `Squareforge30Days-${this.config.prefix.replace(/\//g, '-')}`, Status: 'Enabled', Filter: { Prefix: prefix }, Expiration: { Days: 30 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }],
      } }));
    }
    return { retentionDays: 30 };
  }

  close(): void { this.client.destroy(); }
}
