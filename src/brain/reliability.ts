import type { Store } from '../db/index.ts';

export function reliability(store: Store, now = Date.now()) {
  return {
    windows: [1, 7].map(days => ({ days, ...store.db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(ok=0),0) AS failed, COALESCE(SUM(attempt_count IS NULL),0) AS legacy,
      COALESCE(SUM(ok=1 AND attempt_count=1 AND connection='primary'),0) AS firstSuccess,
      COALESCE(SUM(ok=1 AND attempt_count>1 AND connection='primary'),0) AS retrySuccess,
      COALESCE(SUM(ok=1 AND connection='secondary'),0) AS fallbackSuccess
      FROM brain_calls WHERE at>=? AND purpose NOT IN ('test','review')`).get(now - days * 86_400_000) as object })),
    attempts: store.db.prepare('SELECT * FROM brain_attempts ORDER BY id DESC LIMIT 25').all(),
    budget: store.db.prepare(`SELECT COUNT(*) AS attempts,
      COALESCE(SUM(CASE WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN input_tokens+output_tokens ELSE reserved_tokens END),0) AS tokens,
      COALESCE(SUM(input_tokens IS NULL OR output_tokens IS NULL),0) AS estimated
      FROM brain_attempts WHERE at>=?`).get(now - 86_400_000),
    jobs: store.db.prepare('SELECT id,purpose,status,runs,next_at,expires_at,error,report_id FROM brain_jobs ORDER BY id DESC LIMIT 20').all(),
  };
}
