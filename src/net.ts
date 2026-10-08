import { ProxyAgent } from 'undici';

/**
 * Per-account egress. Binance ties abuse signals to the calling IP, so an account matrix
 * wants one proxy per account rather than ten accounts sharing the machine's address.
 *
 * Node's global fetch is undici underneath and honours a `dispatcher`, which is how this
 * hooks in without replacing fetch wholesale.
 */

const agents = new Map<string, ProxyAgent>();
const fetches = new Map<string, typeof fetch>();

export function normalizeProxy(raw: string): string {
  const url = raw.trim();
  if (!url) return '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`代理地址无法解析：${url.slice(0, 60)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`代理只支持 http/https，收到 ${parsed.protocol}`);
  }
  return url;
}

/** Cached so a matrix of 10 accounts does not build 10 connection pools to the same proxy. */
function agentFor(proxyUrl: string): ProxyAgent {
  const key = normalizeProxy(proxyUrl);
  let agent = agents.get(key);
  if (!agent) {
    agent = new ProxyAgent(key);
    agents.set(key, agent);
  }
  return agent;
}

export function proxiedFetch(proxyUrl: string): typeof fetch {
  const key = normalizeProxy(proxyUrl);
  let f = fetches.get(key);
  if (!f) {
    const agent = agentFor(key);
    const inner = globalThis.fetch as unknown as (i: Parameters<typeof fetch>[0], o: RequestInit) => Promise<Response>;
    f = ((input, init = {}) => inner(input, { ...init, dispatcher: agent })) as typeof fetch;
    fetches.set(key, f);
  }
  return f;
}

export function hasProxy(proxyUrl: string | null | undefined): boolean {
  return Boolean(proxyUrl && proxyUrl.trim());
}
