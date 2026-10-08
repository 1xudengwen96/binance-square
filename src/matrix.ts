import type { AccountRow, Store } from './db/index.ts';
import { similarity, structuralSignature } from './engine/guard.ts';
import type { Settings } from './config.ts';

/**
 * The account matrix: who gets which coin, and how their copy is kept apart.
 *
 * Two guarantees matter more than anything else here. First, one coin belongs to one
 * account for a window — two accounts covering the same coin minutes apart is the single
 * most obvious coordinated-behaviour signal. Second, no two accounts may ship the same
 * sentence with the coin name swapped out, which is what a shared template produces.
 */

export interface SymbolCandidate {
  symbol: string;
  score: number;
}

/** Structural similarity between two posts that no account may cross. */
export const CROSS_ACCOUNT_THRESHOLD = 0.62;

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** The voices this account may write in. Empty or `mixed` means no restriction. */
export function accountStyles(a: AccountRow): string[] {
  const list = parseList(a.styles_json);
  if (!list.length) return [a.style || 'mixed'];
  return list.includes('mixed') ? ['mixed'] : list;
}

export function accountBlockedTemplates(a: AccountRow): Set<string> {
  return new Set(parseList(a.blocked_templates_json));
}

/** Coins this account must never touch — scam tickers, delistings, whatever the owner decides. */
export function accountBlockedSymbols(a: AccountRow): Set<string> {
  return new Set(parseList(a.blocked_symbols_json).map(s => s.toUpperCase()));
}

/** The material categories this account covers; null means everything. */
export function accountCategories(a: AccountRow): string[] | null {
  const list = parseList(a.categories_json);
  return list.length ? list : null;
}

/** Whether a material is in this account's scope at all. */
export function materialAllowedForAccount(m: { category: string; symbol: string | null }, a: AccountRow): boolean {
  const cats = accountCategories(a);
  if (cats && !cats.includes(m.category)) return false;
  if (m.symbol && accountBlockedSymbols(a).has(m.symbol.toUpperCase())) return false;
  return true;
}

/**
 * Hand the hot symbols out. Accounts that pinned specific coins get those first; the
 * rest take the strongest unclaimed symbol in score order, one pass at a time so no
 * account hoards the whole board while another sits idle.
 */
export function allocate<T extends SymbolCandidate>(
  candidates: T[],
  accounts: AccountRow[],
  store: Store,
  settings: Settings,
  now = Date.now(),
): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const a of accounts) out.set(a.id, []);

  const expiryMs = settings.crossAccountCoinExclusionMinutes * 60_000;
  /** Symbols already promised to another account inside the exclusion window. */
  const heldByOther = (symbol: string, accountId: number): boolean => {
    const claim = store.getClaim(symbol.toUpperCase());
    if (!claim || claim.account_id === null || claim.account_id === accountId) return false;
    return now - claim.claimed_at < expiryMs;
  };
  /**
   * Symbols handed out during this pass. Exclusivity has to be global: two accounts
   * receiving the same coin here is precisely the thing the whole module exists to stop.
   */
  const givenAway = new Set<string>();

  const pinned = new Map(accounts.map(a => [a.id, new Set(parseList(a.symbols_json).map(s => s.toUpperCase()))]));
  const blocked = new Map(accounts.map(a => [a.id, accountBlockedSymbols(a)]));
  // Pinned accounts pick first. Otherwise an unpinned account evaluated earlier in the
  // round would hand itself the coin a pinned account exists to cover, and the pinned
  // account would end the pass with nothing.
  const order = [...accounts].sort((x, y) => (pinned.get(y.id)!.size ? 1 : 0) - (pinned.get(x.id)!.size ? 1 : 0));

  const maxWant = Math.max(1, ...accounts.map(a => a.posts_per_day ?? settings.postsPerDay));
  for (let round = 0; round < maxWant; round++) {
    let anyoneMoved = false;
    for (const a of order) {
      const bucket = out.get(a.id)!;
      if (bucket.length >= (a.posts_per_day ?? settings.postsPerDay)) continue;
      const want = pinned.get(a.id);
      const deny = blocked.get(a.id)!;

      const pick = candidates.find(c => {
        const key = c.symbol.toUpperCase();
        if (deny.has(key)) return false;
        if (givenAway.has(key)) return false;
        if (want?.size && !want.has(key)) return false;
        return !heldByOther(key, a.id);
      });
      if (!pick) continue;
      bucket.push(pick);
      givenAway.add(pick.symbol.toUpperCase());
      anyoneMoved = true;
    }
    if (!anyoneMoved) break;
  }
  return out;
}

/** The account whose recent post this candidate is too close to, or null when it is clear. */
export function collidesWithMatrix(
  store: Store,
  settings: Settings,
  accountId: number | null,
  text: string,
  now = Date.now(),
): { ownerLabel: string; signature: number } | null {
  const since = now - settings.crossAccountCoinExclusionMinutes * 60_000;
  const rows = store.recentPostsFromOthers(accountId, since, 80);
  const sig = structuralSignature(text);
  for (const r of rows) {
    const score = similarity(sig, structuralSignature(r.text));
    if (score >= CROSS_ACCOUNT_THRESHOLD) return { ownerLabel: r.label ?? `账号 #${r.account_id ?? '?'}`, signature: score };
  }
  return null;
}

/**
 * A seed that differs per account so synonym pools and branch choices diverge even when
 * two accounts are legitimately writing about the same coin.
 */
export function personaSeed(materialId: string, accountId: number, slotAt: number): string {
  return `${materialId}#${accountId}@${slotAt}`;
}
