import { fetchJson } from './http.ts';
import { makeMaterial, type Material } from '../material/types.ts';
import { resolveCoins } from '../hot/coins.ts';

/**
 * Binance official announcements via the CMS endpoint the help/announcement pages
 * use. Unofficial path, but stable for years and needs no key — this is where
 * listing / delisting / campaign material comes from.
 */

const BASE = 'https://www.binance.com/bapi/composite/v1/public/cms/article/catalog/list/query';

/** Verified catalog ids. */
export const CATALOGS = {
  listing: { id: 48, label: '新上线' },
  news: { id: 49, label: '公告' },
  campaign: { id: 93, label: '活动' },
  maintenance: { id: 157, label: '维护' },
  delisting: { id: 161, label: '下架' },
} as const;

type CatalogKey = keyof typeof CATALOGS;

interface CmsArticle {
  id?: number;
  title?: string;
  releaseDate?: number;
  url?: string;
  catalogId?: number;
}

interface CmsResponse {
  code?: string;
  data?: { articles?: CmsArticle[]; total?: number };
}

/**
 * Announcement titles name coins three ways: `XXXUSDT`, `$XXX`, or bare `XXX`. The bare
 * form is the common one and needs the listing to tell it apart from ordinary capitals,
 * so it uses the ticker dictionary — but NOT the prose alias table. Almost every
 * announcement says 币安, and the alias table maps that to BNB, which tagged a routine
 * maintenance notice with a BNB price and then a funding rate. An announcement only earns
 * a symbol when it names a real listed ticker.
 */
async function coinsFromTitle(title: string): Promise<string[]> {
  const out = new Set<string>();
  for (const m of title.matchAll(/\b([A-Z0-9]{2,10})USDT?\b/g)) out.add(m[1] as string);
  for (const m of title.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,9})\b/g)) out.add(m[1]!.toUpperCase());
  for (const c of await resolveCoins(title, 5, { keywords: false })) out.add(c);
  return [...out].slice(0, 5);
}

const SENTIMENT: Record<CatalogKey, 'bull' | 'bear' | 'neutral'> = {
  listing: 'bull',
  news: 'neutral',
  campaign: 'bull',
  maintenance: 'neutral',
  delisting: 'bear',
};

const SCORE: Record<CatalogKey, number> = {
  listing: 72,
  news: 55,
  campaign: 58,
  maintenance: 48,
  delisting: 70,
};

export async function announcements(opts: { catalogs?: CatalogKey[]; pageSize?: number } = {}): Promise<Material[]> {
  const keys = opts.catalogs ?? (Object.keys(CATALOGS) as CatalogKey[]);
  const out: Material[] = [];
  const seen = new Set<string>();

  for (const key of keys) {
    const cat = CATALOGS[key];
    let articles: CmsArticle[] = [];
    try {
      const res = await fetchJson<CmsResponse>(
        `${BASE}?catalogId=${cat.id}&pageNo=1&pageSize=${opts.pageSize ?? 10}`,
        { timeoutMs: 12_000, headers: { lang: 'zh-CN' } },
      );
      articles = res?.code === '000000' ? (res.data?.articles ?? []) : [];
    } catch {
      continue; // one dead catalog must not lose the others
    }

    for (const a of articles) {
      const title = (a.title ?? '').replace(/\s+/g, ' ').trim();
      if (!title || seen.has(title)) continue;
      seen.add(title);
      const coins = await coinsFromTitle(title);
      out.push(
        makeMaterial({
          category: 'announcement',
          subType: key,
          title,
          symbol: coins[0] ?? null,
          symbols: coins,
          sentiment: SENTIMENT[key],
          score: SCORE[key],
          source: `币安公告·${cat.label}`,
          at: a.releaseDate ?? Date.now(),
          facts: {
            catalogLabel: cat.label,
            source_name: `币安公告·${cat.label}`,
            source_count: 1,
            coins: [...coins],
            coinCount: coins.length,
            url: a.url ?? '',
          },
        }),
      );
    }
  }
  return out.sort((a, b) => b.at - a.at);
}
