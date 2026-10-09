import type { MemoryRow, Store } from '../db/index.ts';

/**
 * Recall over the memory ledger.
 *
 * There is no embedding model here on purpose. The ledger holds a few hundred sentences, each
 * already tagged with what it is about, so the useful ranking is "does this apply to the post
 * being written, and how much do we actually believe it" — not semantic distance. Adding a
 * vector store would add a dependency and a failure mode without adding recall quality at this
 * size, and the day it does, this is the one function to swap.
 */

const STOP = new Set(['的', '了', '是', '在', '和', '与', '要', '会', '我们', '可以', 'this', 'the', 'and', 'for', 'with']);

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fa5]+/)) {
    if (!w || STOP.has(w)) continue;
    if (/^[a-z0-9_]+$/.test(w)) {
      out.add(w);
      continue;
    }
    // Chinese has no spaces; bigrams are the cheapest unit that keeps 「资金费率」 from becoming
    // four unrelated characters.
    for (let i = 0; i < w.length - 1; i++) out.add(w.slice(i, i + 2));
    if (w.length === 1) out.add(w);
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let hits = 0;
  for (const t of a) if (b.has(t)) hits++;
  return hits / a.size;
}

/** Age in days, used only as a tie-breaker — an old belief is not automatically wrong. */
const ageDays = (ms: number, now: number) => (now - ms) / 86_400_000;

export interface RecallOptions {
  kinds?: string[];
  /** The thing about to be written: a category, a style, a coin. Matched against the memory text. */
  about?: string;
  limit?: number;
  now?: number;
}

export function recall(store: Store, opts: RecallOptions = {}): MemoryRow[] {
  const now = opts.now ?? Date.now();
  const rows = store.activeMemory().filter(r => {
    if (opts.kinds?.length && !opts.kinds.includes(r.kind)) return false;
    if (r.expires_at && r.expires_at < now) return false;
    return true;
  });
  if (!rows.length) return [];
  const q = opts.about ? tokens(opts.about) : null;
  const scored = rows.map(r => {
    const relevance = q ? overlap(q, tokens(`${r.key} ${r.text}`)) : 0;
    const score =
      relevance * 3 +
      r.confidence * 1.5 +
      Math.min(1, r.evidence_n / 20) * 0.8 +
      Math.min(1, r.use_count / 10) * 0.3 +
      // A gentle recency nudge: between two equally good memories, prefer the newer evidence.
      Math.max(0, 0.4 - ageDays(r.created_at, now) / 365);
    return { r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const out = scored.slice(0, opts.limit ?? 8).map(x => x.r);
  store.touchMemory(out.map(r => r.id));
  return out;
}

const KIND_LABEL: Record<string, string> = {
  'rank-rule': '流量引擎',
  'content-lesson': '内容教训',
  'audience-fact': '读者事实',
  'engine-model': '引擎模型',
  instruction: '操作者指令',
};

/**
 * The briefing the writer reads before drafting. This is the difference between a generator that
 * re-derives everything from scratch and one that remembers: the same ledger, rendered into a
 * short list of things currently believed about this kind of post.
 */
export function briefFor(store: Store, opts: RecallOptions & { max?: number } = {}): string {
  return recallBrief(store, opts).text;
}

/** The same briefing, plus the rows behind it, so a caller does not have to recall twice. */
export function recallBrief(store: Store, opts: RecallOptions & { max?: number } = {}): { text: string; rows: MemoryRow[] } {
  const rows = recall(store, { ...opts, limit: opts.max ?? 6 });
  if (!rows.length) return { text: '', rows };
  const lines = rows.map(r => {
    const ev = r.evidence_n > 0 ? `（证据 ${r.evidence_n} 条）` : '';
    return `· 【${KIND_LABEL[r.kind] ?? r.kind}】${r.text}${ev} 置信 ${(r.confidence * 100).toFixed(0)}%`;
  });
  return {
    text: `写作前须知（来自本账号的长期记忆，可被更新的事实覆盖，不可覆盖事实校验与合规闸门）：\n${lines.join('\n')}`,
    rows,
  };
}

/** Expire what was only ever meant to be held for a while. Returns the count retired. */
export function expireMemories(store: Store, now = Date.now()): number {
  const rows = store.db
    .prepare("SELECT id, key FROM brain_memory WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?")
    .all(now) as { id: number; key: string }[];
  for (const r of rows) {
    store.db
      .prepare("UPDATE brain_memory SET status = 'expired', last_used_at = ? WHERE id = ?")
      .run(now, r.id);
  }
  return rows.length;
}

export function remember(store: Store, m: Parameters<Store['remember']>[0]): number {
  return store.remember(m);
}
