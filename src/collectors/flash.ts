import { makeMaterial, type Material } from '../material/types.ts';
import { resolveCoins } from '../hot/coins.ts';

/**
 * Chinese crypto newswire, read from 吴说区块链's Atom feed.
 *
 * Jin10 was tried first and dropped: its public flash blob is dominated by macro
 * and geopolitics, so a crypto-strict filter leaves almost nothing while a loose
 * one floods the feed with real-estate contract sales. A crypto-native feed with a
 * documented format is worth more than a bigger feed that needs guessing.
 */

const FEED = 'https://www.wublock123.com/feed';

interface Entry {
  title: string;
  link: string;
  updated: number;
  summary: string;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseEntries(xml: string): Entry[] {
  const out: Entry[] = [];
  for (const block of xml.match(/<entry[\s\S]*?<\/entry>/g) ?? []) {
    const title = decode(block.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? '');
    if (!title) continue;
    const link = block.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? '';
    const stamp = decode(block.match(/<(?:updated|published)>([\s\S]*?)<\/(?:updated|published)>/)?.[1] ?? '');
    const summary = decode(block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] ?? '');
    const at = Date.parse(stamp);
    out.push({ title, link, updated: Number.isFinite(at) ? at : Date.now(), summary });
  }
  return out;
}

function classify(text: string): string {
  if (/监管|证监会|SEC|CFTC|起诉|判决|禁令|合规|批准|审批|罚款|法案/.test(text)) return 'regulation';
  if (/机构|基金|ETF|增持|减持|持仓|公司|企业购/.test(text)) return 'institution';
  if (/上线|上架|开通|交易对|上所|挂牌/.test(text)) return 'exchange';
  if (/黑客|漏洞|攻击|被盗|exploit|安全/.test(text)) return 'security';
  if (/升级|主网|分叉|上线协议|协议|融资/.test(text)) return 'project';
  return 'general';
}

function sentimentOf(text: string): 'bull' | 'bear' | 'neutral' {
  if (/涨|新高|增持|流入|批准|上线|突破|采纳|增长/.test(text)) return 'bull';
  if (/跌|爆仓|清算|流出|减持|下架|黑客|被盗|诉讼|违规|破产/.test(text)) return 'bear';
  return 'neutral';
}

const SCORE: Record<string, number> = {
  regulation: 68,
  institution: 64,
  exchange: 66,
  security: 70,
  project: 58,
  general: 55,
};

export async function newsflashes(limit = 20): Promise<Material[]> {
  let xml = '';
  try {
    const res = await fetch(FEED, {
      headers: { accept: 'application/atom+xml,application/xml,*/*', 'user-agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    xml = await res.text();
  } catch {
    return [];
  }

  const now = Date.now();
  const out: Material[] = [];
  for (const e of parseEntries(xml).slice(0, limit * 2)) {
    const text = `${e.title} ${e.summary}`;
    const subType = classify(text);
    const symbols = await resolveCoins(text);
    out.push(
      makeMaterial({
        category: 'newsflash',
        subType,
        title: e.title.length > 120 ? `${e.title.slice(0, 118)}…` : e.title,
        symbol: symbols[0] ?? null,
        symbols,
        sentiment: sentimentOf(text),
        score: SCORE[subType] ?? 55,
        source: '吴说区块链',
        at: e.updated,
        facts: {
          body: e.summary || e.title,
          wire: 'wublock',
          source_name: '吴说区块链',
          source_count: 1,
          link: e.link,
          ageMinutes: Math.round((now - e.updated) / 60_000),
        },
      }),
    );
    if (out.length >= limit) break;
  }
  return out;
}
