/** Content guards applied before anything is allowed near the publish queue. */

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s　]+/g, '');
}

/** Sensitive-word scan. Words are matched case- and whitespace-insensitively. */
export function findSensitive(text: string, words: readonly string[]): string[] {
  const hay = normalize(text);
  return words.filter(w => w && hay.includes(normalize(w)));
}

/** Dice coefficient over character bigrams; 0..1. Good enough for near-duplicate detection. */
export function similarity(a: string, b: string): number {
  const A = bigrams(normalize(a));
  const B = bigrams(normalize(b));
  if (!A.size || !B.size) return 0;
  let hits = 0;
  for (const [gram, count] of A) {
    const other = B.get(gram);
    if (other) hits += Math.min(count, other);
  }
  return (2 * hits) / (A.size + B.size || 1);
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** True when `candidate` is too close to any recent post to publish again. */
export function isDuplicate(candidate: string, recent: readonly string[], threshold = 0.72): string | null {
  for (const prev of recent) {
    if (similarity(candidate, prev) >= threshold) return prev;
  }
  return null;
}

/**
 * Strip the parts that legitimately vary — tickers, hashtags, numbers — so two posts
 * that are the same sentence with a different coin collapse to one signature.
 * Without this, "$XRP …" and "$BNB …" read as distinct and the feed repeats itself.
 */
export function structuralSignature(text: string): string {
  return normalize(text)
    .replace(/\$[a-z0-9_.]{1,14}/gi, '§')
    .replace(/#[a-z0-9_\u4e00-\u9fff]{1,20}/gi, '§')
    .replace(/-?\d[\d,]*(?:\.\d+)?/g, '#');
}

/** Same sentence, different coin. */
export function isStructuralDuplicate(candidate: string, recent: readonly string[], threshold = 0.85): string | null {
  const a = structuralSignature(candidate);
  for (const prev of recent) {
    if (similarity(a, structuralSignature(prev)) >= threshold) return prev;
  }
  return null;
}

/**
 * A material fingerprint is what makes "same event, four outlets" collapse into
 * one post instead of four near-identical ones.
 */
export function materialFingerprint(fields: { category: string; symbol?: string | null; title: string; at: number }): string {
  const core = fields.title
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[^0-9a-z一-鿿]/g, '')
    .slice(0, 40);
  return `${fields.category}|${fields.symbol ?? '-'}|${core}`;
}

export const MAX_POST_CHARS = 2000;

export interface GuardVerdict {
  ok: boolean;
  reasons: string[];
}

export function guardPost(
  text: string,
  opts: { sensitiveWords: readonly string[]; recent: readonly string[]; minLength?: number },
): GuardVerdict {
  const reasons: string[] = [];
  const trimmed = text.trim();
  if (trimmed.length < (opts.minLength ?? 20)) reasons.push(`too short (${trimmed.length} chars)`);
  if (trimmed.length > MAX_POST_CHARS) reasons.push(`exceeds ${MAX_POST_CHARS} chars (${trimmed.length})`);
  const hit = findSensitive(trimmed, opts.sensitiveWords);
  if (hit.length) reasons.push(`sensitive words: ${hit.join(', ')}`);
  const dup = isDuplicate(trimmed, opts.recent);
  if (dup) reasons.push('near-duplicate of a recent post');
  else if (isStructuralDuplicate(trimmed, opts.recent)) reasons.push('same sentence as a recent post, different coin');
  return { ok: reasons.length === 0, reasons };
}
