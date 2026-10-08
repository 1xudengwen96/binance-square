import { fetchJson } from './http.ts';
import { makeMaterial, type Material } from '../material/types.ts';

/** Market-wide sentiment and macro flows. All free, no key. */

interface FngResponse {
  data: { value: string; value_classification: string; timestamp: string; timespan: string }[];
}

const FNG_LABEL_CN: Record<string, string> = {
  'Extreme Fear': '极度恐惧',
  Fear: '恐惧',
  Neutral: '中性',
  Greed: '贪婪',
  'Extreme Greed': '极度贪婪',
};

export async function fearAndGreed(): Promise<Material[]> {
  const res = await fetchJson<FngResponse>('https://api.alternative.me/fng/?limit=3', { timeoutMs: 10_000 });
  const cur = res.data?.[0];
  const prev = res.data?.[1];
  if (!cur) return [];
  const value = Number(cur.value);
  if (!Number.isFinite(value)) return [];
  const label = FNG_LABEL_CN[cur.value_classification] ?? cur.value_classification;
  return [
    makeMaterial({
      category: 'sentiment',
      subType: 'fear_greed',
      title: `恐惧贪婪指数 ${value}（${label}）`,
      source: '恐惧贪婪指数',
      at: Number(cur.timestamp) * 1000 || Date.now(),
      sentiment: value >= 60 ? 'bull' : value <= 40 ? 'bear' : 'neutral',
      score: 50 + Math.abs(value - 50) * 0.5,
      facts: { value, label, prev: prev ? Number(prev.value) : null },
    }),
  ];
}

interface LlamaStablecoins {
  peggedAssets: { symbol: string; circulating: number | string; circulatingPrevDay: number | string }[];
}

/** Daily mint/burn delta for the majors — a real liquidity signal, not a vibe. */
export async function stablecoinShifts(minAbsUsd = 400_000_000): Promise<Material[]> {
  const res = await fetchJson<LlamaStablecoins>('https://stablecoins.llama.fi/stablecoins', { timeoutMs: 20_000 });
  const now = Date.now();
  const out: Material[] = [];
  for (const a of res.peggedAssets ?? []) {
    if (!['USDT', 'USDC'].includes(a.symbol)) continue;
    const cur = Number(a.circulating);
    const prev = Number(a.circulatingPrevDay);
    if (!Number.isFinite(cur) || !Number.isFinite(prev)) continue;
    const delta = cur - prev;
    if (Math.abs(delta) < minAbsUsd) continue;
    const up = delta > 0;
    out.push(
      makeMaterial({
        category: 'stablecoin',
        subType: 'daily_delta',
        title: `${a.symbol} 24小时${up ? '增发' : '销毁'} ${Math.abs(delta).toLocaleString('en-US')} 枚`,
        symbol: a.symbol,
        source: '稳定币增发销毁',
        at: now,
        sentiment: up ? 'bull' : 'bear',
        score: Math.min(85, 55 + Math.abs(delta) / 2e8),
        facts: { delta, direction: up ? '增发' : '销毁', total: cur, assetName: a.symbol },
      }),
    );
  }
  return out;
}
