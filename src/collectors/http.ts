/** HTTP helper for public data endpoints: bounded timeout, and retries only where they are safe. */

import { ProxyAgent } from 'undici';

export interface FetchJsonOptions {
  timeoutMs?: number;
  /** Retries are only for idempotent GETs against public data. Never used for publishing. */
  retries?: number;
  headers?: Record<string, string>;
}

/**
 * Binance market data is geo-sensitive. When the operator sets HTTPS_PROXY in
 * the environment (dotenv loads .env), public GETs ride that proxy; unset means
 * direct, exactly as before.
 */
const proxyUrl = (process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '').trim();
const agent = proxyUrl ? new ProxyAgent(proxyUrl) : null;
// `globalThis.fetch` is looked up on every call, not captured at load: the tests swap it for a
// stub, and a reference taken at import time sent their requests to the real network instead.
const httpFetch = (input: Parameters<typeof fetch>[0], init: RequestInit = {}): Promise<Response> => {
  const f = globalThis.fetch as unknown as (i: Parameters<typeof fetch>[0], o: RequestInit & { dispatcher?: unknown }) => Promise<Response>;
  return agent ? f(input, { ...init, dispatcher: agent }) : f(input, init);
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message?: string,
  ) {
    super(`HTTP ${status} for ${url}${message ? `: ${message}` : ''}`);
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = 15_000, retries = 2, headers } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await httpFetch(url, { signal: ac.signal, headers: { accept: 'application/json', ...headers } });
      if (!res.ok) {
        // 429/418 are rate-limit backoffs; 4xx other than 429 will not fix themselves.
        if (res.status < 500 && res.status !== 429 && res.status !== 418) throw new HttpError(res.status, url);
        throw new HttpError(res.status, url, 'retryable');
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError && err.status < 500 && err.status !== 429 && err.status !== 418) throw err;
      if (attempt < retries) await sleep(400 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Failed to fetch ${url}`);
}
