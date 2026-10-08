import { fetchJson } from './http.ts';
import { resolveCrypto } from '../hot/aliases.ts';
import { makeMaterial, type Material } from '../material/types.ts';

/**
 * Chinese mainstream trending lists.
 *
 * Deliberate constraint: a trending topic only becomes a material when it names a
 * specific coin. Attaching `$CHZ` to a football story because it is "adjacent" is how
 * auto-posting tools start looking like spam, so we refuse to guess.
 */

interface ToutiaoResponse {
  data?: { Title?: string; title?: string; HotValue?: string; ClusterIdStr?: string }[];
}

interface BaiduResponse {
  data?: { cards?: { content?: { content?: { word?: string; hotScore?: string }[] }[] }[] };
}

interface BilibiliResponse {
  list?: { show_name?: string; heat_score?: number }[];
}

async function toutiao(limit: number): Promise<{ title: string; heat: number }[]> {
  const res = await fetchJson<ToutiaoResponse>('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', { timeoutMs: 10_000 });
  return (res.data ?? []).slice(0, limit).map(r => ({
    title: r.Title ?? r.title ?? '',
    heat: Number(r.HotValue ?? 0) || 0,
  }));
}

async function baidu(limit: number): Promise<{ title: string; heat: number }[]> {
  const res = await fetchJson<BaiduResponse>('https://top.baidu.com/api/board?platform=wise&tab=realtime', { timeoutMs: 10_000 });
  // The board nests one level deeper than it looks: cards[].content[].content[]
  const items = (res.data?.cards ?? []).flatMap(c => (c.content ?? []).flatMap(group => group.content ?? []));
  return items.slice(0, limit).map(r => ({ title: r.word ?? '', heat: Number(r.hotScore ?? 0) || 0 }));
}

async function bilibili(limit: number): Promise<{ title: string; heat: number }[]> {
  const res = await fetchJson<BilibiliResponse>('https://s.search.bilibili.com/main/hotword', { timeoutMs: 10_000 });
  return (res.list ?? []).slice(0, limit).map(r => ({ title: r.show_name ?? '', heat: Number(r.heat_score ?? 0) || 0 }));
}

const SOURCES = { 头条热榜: toutiao, 百度热搜: baidu, B站热搜: bilibili } as const;

export type HotSourceName = keyof typeof SOURCES;

export async function trendingMaterials(opts: { sources?: HotSourceName[]; perSource?: number } = {}): Promise<Material[]> {
  const names = opts.sources ?? (Object.keys(SOURCES) as HotSourceName[]);
  const now = Date.now();
  const out: Material[] = [];
  const seen = new Set<string>();

  for (const name of names) {
    let rows: { title: string; heat: number }[] = [];
    try {
      rows = await SOURCES[name](opts.perSource ?? 30);
    } catch {
      continue; // these endpoints are the most likely to change; never fail the cycle
    }
    for (const r of rows) {
      if (!r.title || seen.has(r.title)) continue;
      const symbol = resolveCrypto(r.title);
      if (!symbol) continue; // no forced cashtag
      seen.add(r.title);
      out.push(
        makeMaterial({
          category: 'trending',
          subType: 'hot_board',
          title: `热搜：${r.title}`,
          symbol: symbol === 'CRYPTO' ? null : symbol,
          symbols: symbol === 'CRYPTO' ? [] : [symbol],
          source: name,
          at: now,
          sentiment: 'neutral',
          score: Math.max(50, Math.min(88, 50 + Math.log10(Math.max(r.heat, 1)) * 4)),
          facts: { topic: r.title, heat: r.heat, boardName: name },
        }),
      );
    }
  }
  return out;
}
