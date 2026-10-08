/** HTTP helper for public data endpoints: bounded timeout, and retries only where they are safe. */

export interface FetchJsonOptions {
  timeoutMs?: number;
  /** Retries are only for idempotent GETs against public data. Never used for publishing. */
  retries?: number;
  headers?: Record<string, string>;
}

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
      const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json', ...headers } });
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
