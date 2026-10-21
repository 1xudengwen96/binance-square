import 'dotenv/config';
import { Store } from '../db/index.ts';
import { BackupManager } from './manager.ts';

const [action = 'backup', key, confirm] = process.argv.slice(2);
const store = Store.open(process.env.DB_PATH ?? './data/squareforge.db');
const manager = new BackupManager(store);
try {
  if (action === 'backup') console.log(JSON.stringify(await manager.backup(), null, 2));
  else if (action === 'list') console.log(JSON.stringify(await manager.list(), null, 2));
  else if (action === 'status') console.log(JSON.stringify(manager.status(), null, 2));
  else if (action === 'restore' && key && confirm === '--confirm') console.log(JSON.stringify(await manager.restore(key), null, 2));
  else throw new Error('用法：backup/cli.ts backup | list | status | restore <S3 key> --confirm（恢复前停止其他应用进程）');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'S3 备份操作失败');
  process.exitCode = 1;
} finally { store.close(); }
