/**
 * Take a database backup now, rather than waiting for the nightly tick.
 * Run: npx tsx scripts/backup.ts
 */
import { Store } from '../src/db/index.ts';
import { backupDatabase } from '../src/backup.ts';

const store = Store.open(process.env.DB_PATH ?? './data/squareforge.db');
const r = backupDatabase(store, { minAgeMs: 0 });
console.log(r.made ? `已备份 → ${r.made}（保留 ${r.kept.length} 份，清掉 ${r.removed} 份）` : `跳过：${r.skipped}`);
store.close();
