import { fetchJson } from './http.ts';
import { makeMaterial, type Material } from '../material/types.ts';

/** DEX trending pools — free, no key, 30 req/min from GeckoTerminal. */

const NETWORKS: { id: string; label: string }[] = [
  { id: 'solana', label: 'Solana' },
  { id: 'bsc', label: 'BSC' },
  { id: 'base', label: 'Base' },
  { id: 'eth', label: 'Ethereum' },
];

interface GTPool {
  attributes?: {
    name?: string;
    address?: string;
    volume_usd_h24?: string;
    price_change_percentage?: { h1?: string; h24?: string };
    reserve_in_usd?: string;
  };
}

/** `WIF / SOL` → the base token symbol. */
function baseToken(poolName: string): string {
  return poolName.split('/')[0]?.trim().toUpperCase() ?? '';
}

export async function dexTrending(opts: { networks?: string[]; top?: number; minReserveUsd?: number } = {}): Promise<Material[]> {
  const wanted = NETWORKS.filter(n => !opts.networks || opts.networks.includes(n.id));
  const minReserve = opts.minReserveUsd ?? 150_000;
  const now = Date.now();
  const out: Material[] = [];

  for (const net of wanted) {
    let data: GTPool[] = [];
    try {
      const res = await fetchJson<{ data?: GTPool[] }>(
        `https://api.geckoterminal.com/api/v2/networks/${net.id}/trending_pools`,
        { timeoutMs: 12_000 },
      );
      data = res.data ?? [];
    } catch {
      continue;
    }
    for (const pool of data.slice(0, opts.top ?? 5)) {
      const a = pool.attributes;
      if (!a?.name) continue;
      const reserve = Number(a.reserve_in_usd ?? 0);
      if (reserve > 0 && reserve < minReserve) continue; // illiquid pools are how you shill a scam
      const symbol = baseToken(a.name);
      if (!symbol || symbol.length > 12) continue;
      const h24 = Number(a.price_change_percentage?.h24 ?? NaN);
      out.push(
        makeMaterial({
          category: 'dex',
          subType: 'trending_pool',
          title: `${symbol} 登上 ${net.label} 链 DEX 热门榜`,
          symbol,
          source: 'DEX 热门榜',
          at: now,
          sentiment: Number.isFinite(h24) && h24 < 0 ? 'bear' : 'bull',
          score: Math.max(48, Math.min(80, 55 + Math.log10(Math.max(Number(a.volume_usd_h24 ?? 0), 1)) * 2)),
          facts: {
            chain: net.label,
            poolName: a.name,
            volume24h: Number(a.volume_usd_h24 ?? 0),
            chg24h: Number.isFinite(h24) ? Number(h24.toFixed(2)) : null,
            reserveUsd: reserve,
          },
        }),
      );
    }
  }
  return out;
}
