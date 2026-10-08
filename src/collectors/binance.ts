import { fetchJson } from './http.ts';

/**
 * Binance public market data. No auth, no key.
 * Paths verified against binance-spot-api-docs and the futures docs; `data-api.binance.vision`
 * is the documented mirror for regions where api.binance.com is geo-blocked.
 */
const SPOT = process.env.BINANCE_SPOT_BASE ?? 'https://api.binance.com';
const FUT = process.env.BINANCE_FUTURES_BASE ?? 'https://fapi.binance.com';
const FUT_DATA = `${FUT}/futures/data`;

export interface SpotTicker24h {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  quoteVolume: string;
}

export interface FuturesTicker24h {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
}

export interface PremiumIndex {
  symbol: string;
  markPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  fundingTime?: number;
}

export interface OpenInterest {
  symbol: string;
  openInterest: string;
  openInterestValue: string;
  timestamp: number;
}

export interface LongShortRatio {
  symbol: string;
  longAccount: string;
  shortAccount: string;
  /** The ratio field is named `longShortRatio`, not `ratio`. */
  longShortRatio: string;
  timestamp: number;
}

/** [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, ...] */
export type Kline = [number, string, string, string, string, string, number, string, number, ...string[]];

export interface FuturesExchangeInfo {
  symbols: { symbol: string; status: string; onboardDate?: number; contractType?: string }[];
}

function num(s: string | undefined): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export const binance = {
  async spotTickers(): Promise<SpotTicker24h[]> {
    const rows = await fetchJson<SpotTicker24h[]>(`${SPOT}/api/v3/ticker/24hr`);
    return rows.filter(r => r.symbol.endsWith('USDT'));
  },

  async futuresTickers(): Promise<FuturesTicker24h[]> {
    const rows = await fetchJson<FuturesTicker24h[]>(`${FUT}/fapi/v1/ticker/24hr`);
    return rows.filter(r => r.symbol.endsWith('USDT'));
  },

  async klines(symbol: string, interval: '1m' | '3m' | '5m' | '15m' | '1h' | '4h' | '1d', limit = 100): Promise<Kline[]> {
    return fetchJson<Kline[]>(`${SPOT}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  },

  /** Candlesticks for the perpetual, which is what the charts should show. */
  async futuresKlines(symbol: string, interval: '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d', limit = 100): Promise<Kline[]> {
    return fetchJson<Kline[]>(`${FUT}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  },

  async premiumIndex(): Promise<PremiumIndex[]> {
    return fetchJson<PremiumIndex[]>(`${FUT}/fapi/v1/premiumIndex`);
  },

  async fundingHistory(symbol: string, limit = 3): Promise<{ symbol: string; fundingRate: string; fundingTime: number }[]> {
    return fetchJson(`${FUT}/fapi/v1/fundingRate?symbol=${symbol}&limit=${limit}`);
  },

  async openInterest(symbol: string): Promise<OpenInterest> {
    return fetchJson<OpenInterest>(`${FUT}/fapi/v1/openInterest?symbol=${symbol}`);
  },

  /** Only ~5 days of history is retained by Binance for these statistics endpoints. */
  async openInterestHist(symbol: string, period: '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '12h' | '1d', limit = 30) {
    return fetchJson<{ symbol: string; sumOpenInterest: string; sumOpenInterestValue: string; timestamp: number }[]>(
      `${FUT_DATA}/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`,
    );
  },

  async globalLongShort(symbol: string, period: '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '12h' | '1d', limit = 2) {
    const rows = await fetchJson<LongShortRatio[]>(`${FUT_DATA}/globalLongShortAccountRatio?symbol=${symbol}&period=${period}&limit=${limit}`);
    return rows;
  },

  async futuresExchangeInfo(): Promise<FuturesExchangeInfo> {
    return fetchJson<FuturesExchangeInfo>(`${FUT}/fapi/v1/exchangeInfo`);
  },
};

export { num };

/** Trim the long tail: junk pairs dominate a raw gainers list. */
export function liquid<T extends { quoteVolume: string }>(tickers: T[], minQuoteVolume = 5_000_000): T[] {
  return tickers.filter(t => num(t.quoteVolume) >= minQuoteVolume);
}
