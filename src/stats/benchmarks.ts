import { fetchJson } from '../collectors/http.ts';
import type { BoardSample, Store } from '../db/index.ts';

/**
 * Square's public boards, sampled as a comparison pool.
 *
 * Our own post gets one number — 43 views — and on its own that number means nothing.
 * Against a pool of what the platform actually shows, it means something: 43 views is a
 * normal outcome for a post that never surfaced, and a bad one for a post that did.
 *
 * The pool is read from the same open `bapi` routes the attention collector uses (no
 * auth — the WAF gates HTML, not JSON).
 *
 * Read the bias before reading the numbers: everything on 热榜 already won an algorithmic
 * selection step, so its median is the waterline *after* surfacing, not what an ordinary
 * post earns. That is exactly why 上榜率 is reported separately from views — the two need
 * different fixes, and conflating them would tell the operator to write better copy when
 * the actual problem is reach.
 */

const B = 'https://www.binance.com/bapi/composite';

interface RawTradingPair {
  code?: string;
}

interface RawVo {
  id?: string | number;
  title?: string;
  content?: string;
  authorName?: string;
  nickName?: string;
  cardType?: string;
  contentType?: number;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  totalReactionCount?: number;
  date?: number;
  detectedLanguage?: string;
  images?: unknown[];
  coverMeta?: unknown;
  tradingPairs?: RawTradingPair[];
  coinPairList?: string[];
}

/**
 * Both routes default to the English board. Comparing a Chinese account with it was a category
 * error (317 of the first 319 samples were English), so the sweep asks for `lang=zh-CN`. Rows
 * sampled before that keep their own `lang` and are shown apart, never mixed into the same median.
 */
const BOARD_LANG = 'zh-CN';
const BOARDS = [
  { name: 'trend', url: (p: number) => `${B}/v3/friendly/pgc/content/article/list?pageIndex=${p}&pageSize=20&type=1&lang=${BOARD_LANG}` },
  { name: 'news', url: (p: number) => `${B}/v4/friendly/pgc/feed/news/list?pageIndex=${p}&pageSize=20&lang=${BOARD_LANG}` },
];

export interface BenchmarkReport {
  fetched: number;
  stored: number;
  oursOnBoard: number;
  perBoard: Record<string, number>;
  errors: string[];
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/**
 * `hashtagList` is empty on the list routes — the tags sit inline in the text — so they are
 * read back out of it. Only Square's grammar counts: letters/digits/underscore, no spaces.
 */
function hashtagsOf(text: string): string[] {
  return [...new Set([...text.matchAll(/#[\p{L}\p{N}_]{2,60}/gu)].map(m => m[0].toUpperCase()))].slice(0, 6);
}

function coinsOf(vo: RawVo): string[] {
  const out = new Set<string>();
  for (const p of vo.tradingPairs ?? []) if (p.code) out.add(p.code.toUpperCase());
  for (const c of vo.coinPairList ?? []) if (c) out.add(String(c).toUpperCase());
  return [...out].slice(0, 6);
}

function toSample(vo: RawVo, board: string, sampledAt: number, ours: Set<string>): BoardSample | null {
  const contentId = String(vo.id ?? '');
  if (!/^\d{6,}$/.test(contentId)) return null;
  const title = (vo.title || vo.content || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!title) return null;
  const coins = coinsOf(vo);
  const body = `${vo.title ?? ''} ${vo.content ?? ''}`;
  return {
    content_id: contentId,
    board,
    title,
    author: vo.authorName || vo.nickName || null,
    coin: coins[0] ?? null,
    coins_json: JSON.stringify(coins),
    hashtags_json: JSON.stringify(hashtagsOf(body)),
    card_type: vo.cardType ?? null,
    // An attached image is one of the few format choices the operator controls directly,
    // so it is kept as its own dimension rather than being buried in the text.
    has_image: (vo.images ?? []).length > 0 || vo.coverMeta != null ? 1 : 0,
    lang: vo.detectedLanguage ?? null,
    chars: body.trim().length,
    views: n(vo.viewCount),
    likes: n(vo.likeCount),
    comments: n(vo.commentCount),
    shares: n(vo.shareCount),
    reactions: n(vo.totalReactionCount),
    // The API reports seconds. Treating it as ms puts every post 50 years in the past.
    posted_at: n(vo.date) > 1e11 ? n(vo.date) : n(vo.date) * 1000,
    sampled_at: sampledAt,
    is_ours: ours.has(contentId) ? 1 : 0,
  };
}

export async function sampleSquareBoards(store: Store, opts: { pages?: number } = {}): Promise<BenchmarkReport> {
  const pages = Math.max(1, Math.min(6, opts.pages ?? 3));
  const report: BenchmarkReport = { fetched: 0, stored: 0, oursOnBoard: 0, perBoard: {}, errors: [] };

  // Known up front: a post of ours that appears in the sweep is both a benchmark row and
  // evidence that it surfaced, and the pool has to exclude it to stay honest.
  const ours = new Set(store.publishedWithSquareId(200).map(p => p.square_post_id));
  const sampledAt = Date.now();
  const rows: BoardSample[] = [];

  for (const board of BOARDS) {
    let count = 0;
    for (let p = 1; p <= pages; p++) {
      try {
        const d = await fetchJson<{ data?: { vos?: RawVo[] } }>(board.url(p), { timeoutMs: 15_000, retries: 1 });
        const vos = d?.data?.vos ?? [];
        if (!vos.length) break;
        for (const vo of vos) {
          const s = toSample(vo, board.name, sampledAt, ours);
          if (!s) continue;
          rows.push(s);
          count++;
        }
        if (vos.length < 20) break;
      } catch (err) {
        report.errors.push(`${board.name} p${p}: ${String(err).slice(0, 90)}`);
        break;
      }
    }
    report.perBoard[board.name] = count;
    report.fetched += count;
  }

  report.stored = store.upsertBoardSamples(rows);
  report.oursOnBoard = rows.filter(r => r.is_ours === 1).length;
  if (report.stored || report.errors.length) store.log('benchmark', report);
  return report;
}

export interface BoardComposition {
  /** Rows the shares were computed from: Chinese-language, not ours. */
  n: number;
  sampledAt: number | null;
  medianViews: number | null;
  shares: { question: number; firstPerson: number; pricePoint: number; news: number; image: number };
  medianViewsImage: number | null;
  medianViewsNoImage: number | null;
  /** Per 1,000 views, pooled (sum / sum), because comments are sparse and a median is always 0. */
  likesPer1k: number | null;
  commentsPer1k: number | null;
  /** The shape tests are text heuristics on a 300-character title, so they are approximate. */
  caveat: string;
}

const QUESTION = /[?？]|吗|怎么|如何|多少|还是|会不会|能不能|是不是|你们|大家/;
const FIRST_PERSON = /我(?!们)|本人|个人/;
const PRICE_POINT = /$s?d|d[d,.]*s*(?:美元|刀|USDT|U|万|k|K)|(?:突破|跌破|站上|跌至|涨至|回踩)s*d/;

const med = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
};

/** What the Chinese boards are made of, recomputed from whatever is in the table right now. */
export function boardComposition(store: Store): BoardComposition {
  const rows = store.db
    .prepare("SELECT title, board, has_image, views, likes, comments, sampled_at FROM square_board_samples WHERE is_ours = 0 AND lang LIKE 'zh%'")
    .all() as { title: string | null; board: string; has_image: number; views: number; likes: number; comments: number; sampled_at: number }[];
  const n = rows.length;
  const share = (f: (r: (typeof rows)[number]) => boolean): number => (n ? Number((rows.filter(f).length / n).toFixed(3)) : 0);
  const sumViews = rows.reduce((s, r) => s + r.views, 0);
  return {
    n,
    sampledAt: n ? Math.max(...rows.map(r => r.sampled_at)) : null,
    medianViews: med(rows.map(r => r.views)),
    shares: {
      question: share(r => QUESTION.test(r.title ?? '')),
      firstPerson: share(r => FIRST_PERSON.test(r.title ?? '')),
      pricePoint: share(r => PRICE_POINT.test(r.title ?? '')),
      news: share(r => r.board === 'news'),
      image: share(r => r.has_image === 1),
    },
    medianViewsImage: med(rows.filter(r => r.has_image === 1).map(r => r.views)),
    medianViewsNoImage: med(rows.filter(r => r.has_image !== 1).map(r => r.views)),
    likesPer1k: sumViews > 0 ? Number(((rows.reduce((s, r) => s + r.likes, 0) / sumViews) * 1000).toFixed(2)) : null,
    commentsPer1k: sumViews > 0 ? Number(((rows.reduce((s, r) => s + r.comments, 0) / sumViews) * 1000).toFixed(2)) : null,
    caveat: '形态占比是对标题前 300 字做的关键词判断，只能当近似值；榜上的帖子是已经被分发之后才采到的，不代表「这样写就会被分发」。',
  };
}
