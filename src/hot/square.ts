import { fetchJson } from '../collectors/http.ts';

/**
 * Reader for Binance Square's own attention signals.
 *
 * The WAF on binance.com gates HTML pages but not these `bapi` JSON routes — they
 * return full data to a bare HTTP client with no headers at all. Verified live.
 * The official Square OpenAPI is create-only, so this is the read side.
 */

const B = 'https://www.binance.com/bapi/composite';

interface RawHashtag {
  hashtag?: string;
  hashtagNormalized?: string;
  viewCount?: number;
  contentCount?: number;
  contentCount7days?: number;
  contentCount30days?: number;
  hashtagId?: number;
  tradingPairDTOList?: { code?: string }[];
}

interface RawTradingPair {
  code?: string;
  symbol?: string;
  market?: string;
  priceChange?: number | string | null;
  discussNumbers?: number | null;
}

interface RawPost {
  id?: string;
  title?: string;
  content?: string;
  authorName?: string;
  nickName?: string;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  date?: number;
  releasedTime?: number;
  webLink?: string;
  cardType?: string;
  contentType?: number;
  hashtagList?: { tag?: string; hashtag?: string }[];
  tradingPairs?: RawTradingPair[];
  coinPairList?: string[];
}

export interface SquareTopic {
  tag: string;
  views: number;
  posts: number;
  coins: string[];
  /** How many times this tag appears in the posts we just read. The hot-list's own
   *  `contentCount7days` field is always 0, so recency is measured from the stream instead. */
  recentUses: number;
}

export interface SquarePost {
  id: string;
  title: string;
  author: string;
  views: number;
  likes: number;
  comments: number;
  coins: string[];
  tags: string[];
  at: number;
  url: string;
}

export interface SquareCoinHeat {
  symbol: string;
  /** Sum of view counts across trending posts that reference this coin. */
  views: number;
  posts: number;
  discuss: number;
  /** Which tag those posts are using — lets us join the existing conversation. */
  bestTag: string | null;
}

export interface SquareSnapshot {
  at: number;
  topics: SquareTopic[];
  posts: SquarePost[];
  coins: SquareCoinHeat[];
  errors: string[];
}

function n(v: unknown): number {
  const x = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(x) ? x : 0;
}

/** Some Square timestamps arrive in seconds; normalise to ms so age maths is right. */
function toMs(v: unknown): number {
  const x = n(v);
  if (x <= 0) return 0;
  return x < 1e12 ? x * 1000 : x;
}

const TAG_RE = /#[\p{L}\p{N}_]{2,60}/gu;

/** Hashtags are not in `hashtagList` on these endpoints — they are inline in the text. */
function extractTags(...texts: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.match(TAG_RE) ?? []) out.add(m);
  }
  return [...out];
}

async function envelope<T>(url: string): Promise<T | null> {
  const res = await fetchJson<{ code?: string; data?: T }>(url, { retries: 1, timeoutMs: 15_000 });
  return res?.code === '000000' ? (res.data ?? null) : null;
}

function normPost(p: RawPost): SquarePost {
  const coins = new Set<string>();
  for (const tp of p.tradingPairs ?? []) if (tp.code) coins.add(tp.code.toUpperCase());
  for (const c of p.coinPairList ?? []) {
    const m = /\$?([A-Z]{2,10})/.exec(String(c).toUpperCase());
    if (m?.[1]) coins.add(m[1]);
  }
  const tags = [...new Set([...(p.hashtagList ?? []).map(h => h.tag ?? h.hashtag ?? '').filter(Boolean), ...extractTags(p.title, p.content)])];
  return {
    id: String(p.id ?? ''),
    title: (p.title ?? (p.content ?? '').slice(0, 80)).replace(/\s+/g, ' ').trim(),
    author: p.authorName ?? p.nickName ?? '',
    views: n(p.viewCount),
    likes: n(p.likeCount),
    comments: n(p.commentCount),
    coins: [...coins],
    tags,
    at: toMs(p.date ?? p.releasedTime),
    url: p.webLink ?? '',
  };
}

/**
 * A tag may only be attributed to a coin when it actually names that coin.
 * Without this, a campaign tag used across many coins gets claimed by all of them
 * and the post asserts a relevance that does not exist.
 */
const COIN_ALIASES: Record<string, string[]> = {
  BTC: ['BITCOIN'],
  ETH: ['ETHEREUM'],
  SOL: ['SOLANA'],
  XRP: ['RIPPLE'],
  DOGE: ['DOGECOIN'],
  ADA: ['CARDANO'],
  LTC: ['LITECOIN'],
  DOT: ['POLKADOT'],
  AVAX: ['AVALANCHE'],
  USDT: ['TETHER'],
};

function tagNamesCoin(tag: string, coin: string): boolean {
  const t = tag.toUpperCase();
  if (t.includes(coin)) return true;
  return (COIN_ALIASES[coin] ?? []).some(a => t.includes(a));
}

function aggregateCoins(posts: SquarePost[]): SquareCoinHeat[] {
  const tagCoins = new Map<string, Set<string>>();
  for (const p of posts) {
    for (const tag of p.tags) {
      const set = tagCoins.get(tag) ?? new Set<string>();
      for (const c of p.coins) set.add(c);
      tagCoins.set(tag, set);
    }
  }

  const heat = new Map<string, SquareCoinHeat & { tagViews: number }>();
  for (const p of posts) {
    for (const coin of p.coins) {
      const cur = heat.get(coin) ?? { symbol: coin, views: 0, posts: 0, discuss: 0, bestTag: null, tagViews: -1 };
      cur.views += p.views;
      cur.posts += 1;
      cur.discuss += p.comments + p.likes;
      // Skip tags shared by more than two coins — those are events, not this coin's story.
      const own = p.tags.find(t => tagNamesCoin(t, coin) && (tagCoins.get(t)?.size ?? 99) <= 2);
      if (own && p.views > cur.tagViews) {
        cur.tagViews = p.views;
        cur.bestTag = own;
      }
      heat.set(coin, cur);
    }
  }
  return [...heat.values()].map(({ tagViews: _t, ...c }) => c).sort((a, b) => b.views - a.views || b.posts - a.posts);
}

/**
 * Read the trending article board, the hot-topic sidebar and the news stream.
 * Any single failure degrades the snapshot rather than aborting the cycle —
 * these are undocumented internal routes and will change without notice.
 */
export async function readSquare(opts: { pages?: number } = {}): Promise<SquareSnapshot> {
  const errors: string[] = [];
  const pages = Math.max(1, Math.min(3, opts.pages ?? 2));

  const postSets: SquarePost[][] = [];
  const topicRaw: RawHashtag[] = [];

  for (let i = 1; i <= pages; i++) {
    try {
      const d = await envelope<{ vos?: RawPost[] }>(`${B}/v3/friendly/pgc/content/article/list?pageIndex=${i}&pageSize=20&type=1`);
      postSets.push((d?.vos ?? []).map(normPost));
    } catch (e) {
      errors.push(`article/list p${i}: ${String(e).slice(0, 80)}`);
    }
  }

  try {
    const d = await envelope<{ data?: RawHashtag[] }>(`${B}/v2/public/pgc/hashtag/hot-list`);
    topicRaw.push(...(d?.data ?? []));
  } catch (e) {
    errors.push(`hashtag/hot-list: ${String(e).slice(0, 80)}`);
  }

  try {
    const d = await envelope<{ vos?: RawPost[] }>(`${B}/v4/friendly/pgc/feed/news/list?pageIndex=1&pageSize=20`);
    postSets.push((d?.vos ?? []).map(normPost));
  } catch (e) {
    errors.push(`news/list: ${String(e).slice(0, 80)}`);
  }

  const seen = new Set<string>();
  const posts = postSets.flat().filter(p => {
    if (!p.id || seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  const topics: SquareTopic[] = topicRaw
    .map(t => {
      const tag = (t.hashtag ?? '').trim();
      return {
        tag,
        views: n(t.viewCount),
        posts: n(t.contentCount),
        recentUses: posts.filter(p => p.tags.some(x => x.toLowerCase() === tag.toLowerCase())).length,
        coins: (t.tradingPairDTOList ?? []).map(x => (x.code ?? '').toUpperCase()).filter(Boolean),
      };
    })
    .filter(t => t.tag)
    .sort((a, b) => b.views - a.views);

  const coins = aggregateCoins(posts);

  return { at: Date.now(), topics, posts, coins, errors };
}
