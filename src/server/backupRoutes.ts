import type { FastifyInstance } from 'fastify';
import type { BackupManager } from '../backup/manager.ts';
import { safeError } from '../backup/config.ts';

/** Registered behind the same login, same-origin and UI-header guards as all panel mutations. */
export function registerBackupRoutes(app: FastifyInstance, manager: BackupManager, writers: Set<string>): void {
  app.get('/api/backups/status', () => manager.status());
  app.put('/api/backups/config', { bodyLimit: 8192 }, async (req, reply) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reply.code(400).send({ error: '配置格式不正确' });
      return { config: manager.saveConfig(body as Record<string, unknown>) };
    } catch (error) { return reply.code(400).send({ error: safeError(error, manager.config) }); }
  });
  app.post('/api/backups/check', async (_req, reply) => {
    try { return { ok: true, ...await manager.check() }; }
    catch (error) { return reply.code(400).send({ error: safeError(error, manager.config) }); }
  });
  app.get('/api/backups', async (_req, reply) => {
    try { return { backups: await manager.list() }; }
    catch (error) { return reply.code(400).send({ error: safeError(error, manager.config) }); }
  });
  app.post('/api/backups/run', async (_req, reply) => {
    if (manager.busy) return reply.code(409).send({ error: '已有备份或导入任务正在运行' });
    void manager.backup().catch(() => {}); // Status endpoint reports progress and durable failure.
    return reply.code(202).send({ accepted: true });
  });
  app.post('/api/backups/restore', { bodyLimit: 4096 }, async (req, reply) => {
    const body = req.body as { key?: unknown; confirm?: unknown } | undefined;
    if (body?.confirm !== true || typeof body.key !== 'string') return reply.code(400).send({ error: '请选定备份并确认覆盖导入' });
    if (manager.busy || writers.size > 1) return reply.code(409).send({ error: '当前有其他任务正在运行，请完成后再导入' });
    // restore() acquires its exclusion before its first await, so new writers cannot race it.
    try {
      const task = manager.restore(body.key);
      if (!manager.restoring) { await task; return reply.code(409).send({ error: '导入未开始' }); }
      void task.catch(() => {});
      return reply.code(202).send({ accepted: true });
    } catch (error) { return reply.code(400).send({ error: safeError(error, manager.config) }); }
  });
}
