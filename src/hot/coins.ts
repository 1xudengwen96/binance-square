import { binance } from '../collectors/binance.ts';
import { resolveCrypto } from './aliases.ts';

/**
 * Which tickers mentioned in a headline are actually coins we can post about.
 *
 * The previous resolver was a hand-typed list of fifteen majors, so roughly half of all
 * newswire items came out with no symbol at all — and a material without a symbol cannot
 * be enriched, cannot be merged across wires, and cannot be written by five of the seven
 * styles. This builds the dictionary from Binance's own listing instead, which is both
 * wider and self-updating.
 *
 * Still deliberately conservative: only tokens that are an exact listed base asset, long
 * enough not to collide with ordinary English, and written in caps in the source text.
 * A wrong cashtag is worse than no cashtag.
 */

/** Tickers that are also common English/finance words. Ambiguous enough to skip. */
const AMBIGUOUS = new Set([
  'AND', 'FOR', 'NOT', 'ALL', 'ARE', 'WAS', 'THE', 'YOU', 'HOT', 'NEW', 'RUN', 'PAY', 'BUY', 'SALE', 'TAX',
  'OIL', 'GAS', 'BIT', 'KEY', 'BOX', 'CAR', 'DOG', 'CAT', 'RED', 'BAD', 'SAD', 'TOP', 'END', 'AGE', 'DAY',
  'EAR', 'EYE', 'FAR', 'FIT', 'FLAT', 'GOT', 'HAS', 'HER', 'HIM', 'HIS', 'ICE', 'ITS', 'LET', 'LIE', 'LOT',
  'MAN', 'MAY', 'OUR', 'OUT', 'OWN', 'PER', 'SAY', 'SEE', 'SET', 'SHE', 'SIT', 'SKY', 'SUN', 'TEN', 'TWO',
  'USE', 'WON', 'TOO', 'ONE', 'ZERO', 'ON', 'IN', 'IF', 'NO', 'OR', 'AI', 'IT', 'IS', 'AS', 'AT', 'BE', 'BY',
  'OF', 'TO', 'WE', 'HE', 'ME', 'MY', 'SO', 'UP', 'DO', 'GO', 'TV', 'PC', 'US', 'UK', 'EU', 'ID', 'PG',
]);

const MIN_LEN = 3;

let cache: { at: number; bases: Set<string> } | null = null;
const TTL_MS = 6 * 3_600_000;

/** Every USDT base asset Binance actually lists, spot plus futures. */
export async function listedBases(ttlMs = TTL_MS): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < ttlMs) return cache.bases;
  const bases = new Set<string>();
  const add = (symbol: string) => {
    const base = symbol.replace(/USDT$/, '');
    if (!base) return;
    bases.add(base);
    // Futures quote leveraged wrappers as 1000X/100X; the coin itself is X.
    const stripped = base.replace(/^(?:1000|100|10)(?=[A-Z]{3,})/, '');
    if (stripped !== base) bases.add(stripped);
  };
  try {
    for (const r of await binance.futuresTickers()) add(r.symbol);
  } catch {
    /* futures down; spot alone is still useful */
  }
  try {
    for (const r of await binance.spotTickers()) add(r.symbol);
  } catch {
    /* spot down; futures alone is still useful */
  }
  if (bases.size < 50) return cache?.bases ?? bases; // never replace a good cache with an empty one
  cache = { at: Date.now(), bases };
  return bases;
}

/**
 * Coins named in a piece of text, strongest first. `text` is scanned for all-caps tokens
 * so a headline about "AI models" does not become a post about the AI token, while
 * "$STRK breaks out" does.
 */
export function matchListedCoins(text: string, bases: Set<string>, limit = 4): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]{2,9})\b/g)) {
    const tok = m[1]!;
    if (AMBIGUOUS.has(tok) || tok.length < MIN_LEN) continue;
    if (!bases.has(tok)) continue;
    if (!found.includes(tok)) found.push(tok);
    if (found.length >= limit) break;
  }
  return found;
}

/**
 * Ticker matching misses full names ("Chainlink", "以太坊"), so the keyword table still
 * runs as well. Keyword hits go last: an explicit ticker in the headline is the stronger
 * signal of what the item is actually about.
 *
 * `keywords: false` is for announcements, where "币安将支持股票交易服务升级" would otherwise
 * be tagged BNB by the keyword table and then enriched with BNB's funding rate — turning a
 * maintenance notice into a post that quotes a price number it has nothing to do with.
 */
export async function resolveCoins(text: string, limit = 4, opts: { keywords?: boolean } = {}): Promise<string[]> {
  const listed = matchListedCoins(text, await listedBases(), limit);
  if (opts.keywords === false) return listed.slice(0, limit);
  const keyword = resolveCrypto(text);
  if (keyword && !listed.includes(keyword) && keyword !== 'CRYPTO') listed.push(keyword);
  return listed.slice(0, limit);
}

/** Test hook: forget the cached listing. */
export function resetCoinCache(): void {
  cache = null;
}
