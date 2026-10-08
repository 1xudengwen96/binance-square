/**
 * Shared "does this text name a coin, and which one" resolution.
 *
 * Used by both the trending boards and the newswires. Deliberately conservative:
 * returning null is preferred to guessing, because an invented cashtag is both
 * wrong and the kind of thing readers notice.
 */

const COIN_KEYWORDS: { pattern: RegExp; symbol: string }[] = [
  { pattern: /比特币|bitcoin|\bbtc\b/i, symbol: 'BTC' },
  { pattern: /以太坊|ethereum|\beth\b/i, symbol: 'ETH' },
  { pattern: /币安|binance|\bbnb\b/i, symbol: 'BNB' },
  { pattern: /狗狗币|dogecoin|\bdoge\b/i, symbol: 'DOGE' },
  { pattern: /solana|\bsol\b/i, symbol: 'SOL' },
  { pattern: /ripple|\bxrp\b/i, symbol: 'XRP' },
  { pattern: /toncoin|\bton\b/i, symbol: 'TON' },
  { pattern: /shib\s?inu|\bshib\b/i, symbol: 'SHIB' },
  { pattern: /cardano|\bada\b|艾达/i, symbol: 'ADA' },
  { pattern: /pepe/i, symbol: 'PEPE' },
  { pattern: /莱特币|litecoin|\bltc\b/i, symbol: 'LTC' },
  { pattern: /polkadot|\bdot\b|波卡/i, symbol: 'DOT' },
  { pattern: /avalanche|\bavax\b/i, symbol: 'AVAX' },
  { pattern: /稳定币|stablecoin|\busdt?\b|\busdc\b/i, symbol: 'USDT' },
  { pattern: /加密货币|数字货币|虚拟货币|virtual ?currency/i, symbol: 'CRYPTO' },
];

export function resolveCrypto(text: string): string | null {
  for (const k of COIN_KEYWORDS) if (k.pattern.test(text)) return k.symbol;
  return null;
}
