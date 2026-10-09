/**
 * Client for the official Binance Square OpenAPI.
 *
 * Contract taken from Binance's own reference implementation
 * (github.com/binance/binance-skills-hub, skills/binance/square-post).
 * Auth is a single static header — there is no HMAC signing step here, which is
 * consistent with the key being post-only.
 */

import { hasProxy, proxiedFetch } from '../net.ts';

const BASE = 'https://www.binance.com/bapi/composite';
const V1 = `${BASE}/v1/public/pgc/openApi`;
const V2 = `${BASE}/v2/public/pgc/openApi`;

export const DAILY_POST_LIMIT = 100;
export const DAILY_UPLOAD_LIMIT = 400;
export const MAX_IMAGES = 4;
export const MAX_BODY_CHARS = 2000;
/**
 * Measured, not guessed: a 2700-character article published cleanly (content
 * 375169413966150), so the 2000 ceiling above is our own short-post constant and not the
 * API's limit for `contentType: 2`. The real ceiling is still unmeasured — cover validation
 * runs before length validation, so an over-long body with a bad cover fails on the cover
 * and reveals nothing. 6000 is set as a working bound, and exceeding it is a hard error
 * rather than a truncation: a teaching article cut off mid-explanation is worse than one
 * that refuses to publish.
 */
export const MAX_ARTICLE_CHARS = 6000;

export type FailureKind =
  | 'auth'
  | 'quota'
  | 'content'
  | 'account_restricted'
  | 'network'
  /** The request may have succeeded server-side but the answer is unknown. Never retry these. */
  | 'uncertain'
  | 'unknown';

const CODES: Record<string, { kind: FailureKind; label: string }> = {
  '220003': { kind: 'auth', label: 'API Key 不存在' },
  '220004': { kind: 'auth', label: 'API Key 已过期' },
  '220009': { kind: 'quota', label: '已达每日发帖上限 (100)' },
  '220014': { kind: 'quota', label: '已达每日上传上限 (400)' },
  '20002': { kind: 'content', label: '内容含敏感词' },
  '20022': { kind: 'content', label: '内容含敏感词' },
  '20013': { kind: 'content', label: '内容超长' },
  '20020': { kind: 'content', label: '正文为空' },
  '220011': { kind: 'content', label: '正文为空' },
  '20041': { kind: 'content', label: '正文中的链接被拒绝' },
  '30008': { kind: 'account_restricted', label: '账号被限制发帖' },
  '2000001': { kind: 'account_restricted', label: '账号被限制发帖' },
  '2000002': { kind: 'account_restricted', label: '设备被限制发帖' },
};

export interface PublishOutcome {
  ok: boolean;
  postId?: string;
  url?: string;
  code?: string;
  message?: string;
  kind?: FailureKind;
  label?: string;
  /** True when the post may exist on Square but we could not confirm it. */
  uncertain?: boolean;
}

export interface SquareClientOptions {
  apiKey: string;
  /** Route this account's traffic out through its own address. Empty = the machine's IP. */
  proxyUrl?: string;
  /** When true, nothing is sent; the request that would have been made is returned instead. */
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

interface Envelope<T> {
  code?: string;
  message?: string;
  messageDetail?: string | null;
  data?: T;
  success?: boolean;
}

export class SquareClient {
  private readonly timeoutMs: number;

  constructor(private readonly opts: SquareClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private get fetchImpl(): typeof fetch {
    // An injected impl always wins so tests stay offline; otherwise honour the proxy.
    if (this.opts.fetchImpl) return this.opts.fetchImpl;
    return hasProxy(this.opts.proxyUrl) ? proxiedFetch(this.opts.proxyUrl!) : fetch;
  }

  private headers(json = true): Record<string, string> {
    return {
      'X-Square-OpenAPI-Key': this.opts.apiKey,
      clienttype: 'binanceSkill',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  private async call<T>(url: string, body: unknown): Promise<{ httpStatus: number; envelope?: Envelope<T>; error?: string }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await res.text();
      let envelope: Envelope<T> | undefined;
      try {
        envelope = JSON.parse(text) as Envelope<T>;
      } catch {
        return { httpStatus: res.status, error: `non-JSON response: ${text.slice(0, 200)}` };
      }
      return { httpStatus: res.status, envelope };
    } catch (err) {
      return { httpStatus: 0, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  private static interpret<T>(r: { httpStatus: number; envelope?: Envelope<T>; error?: string }, dataOf: (d: T) => PublishOutcome): PublishOutcome {
    if (r.httpStatus === 504 || r.httpStatus === 502 || r.httpStatus === 503) {
      // A gateway timeout on publish is NOT a failure: the post usually landed.
      // Retrying would create duplicates, so surface it for human confirmation.
      return {
        ok: false,
        uncertain: true,
        kind: 'uncertain',
        label: `HTTP ${r.httpStatus} — 帖子可能已发出但未拿到 ID，请去广场人工确认，切勿自动重试`,
      };
    }
    if (r.httpStatus === 0) {
      return { ok: false, kind: 'network', label: '网络请求失败', message: r.error };
    }
    const env = r.envelope;
    if (!env) return { ok: false, kind: 'unknown', message: r.error ?? 'empty response' };
    if (env.code === '000000' && env.data) return dataOf(env.data);
    const known = env.code ? CODES[env.code] : undefined;
    return {
      ok: false,
      code: env.code,
      message: env.message ?? r.error,
      kind: known?.kind ?? 'unknown',
      label: known?.label ?? `未知错误 ${env.code ?? ''}`.trim(),
    };
  }

  /**
   * Publish a text post, optionally with already-uploaded image URLs (max 4).
   *
   * What the body text buys us, measured on a real post (content 375013785425696):
   *   `$BTC`  → `coinPairList` + `tradingPairs`, carrying a live price and change, and
   *            `futuresSymbol` — so the inline market chip is free.
   *   `#BTC`  → `hashtagList`, i.e. the post really is filed on the coin's hashtag page.
   *
   * What it does not buy us: the editor's 行情/K线 card. That is `tradeWidgets`, present
   * on 22 of 80 sampled posts and holding only `{coin, bridge, type}` — the client draws
   * the chart from it live. We sent `tradeWidgets` on a live publish; the post was
   * accepted and came back with `tradeWidgets: null`. The field is silently dropped, so
   * a candlestick can only reach Square as an image.
   */
  async publish(bodyTextOnly: string, imageUrls: string[] = []): Promise<PublishOutcome> {
    const body = { contentType: 1, bodyTextOnly, ...(imageUrls.length ? { imageList: imageUrls } : {}) };
    if (this.opts.dryRun) {
      this.opts.log?.(`[dry-run] POST ${V1}/content/add ${JSON.stringify(body).slice(0, 300)}`);
      return { ok: true, postId: 'dry-run', url: undefined, label: 'dry-run，未发送' };
    }
    if (bodyTextOnly.length > MAX_BODY_CHARS) {
      return { ok: false, kind: 'content', label: `正文超过 ${MAX_BODY_CHARS} 字 (${bodyTextOnly.length})` };
    }
    if (imageUrls.length > MAX_IMAGES) {
      return { ok: false, kind: 'content', label: `图片最多 ${MAX_IMAGES} 张` };
    }
    const r = await this.call<{ id?: string; shareLink?: string }>(`${V1}/content/add`, body);
    return SquareClient.interpret(r, d => ({
      ok: true,
      postId: d.id ? String(d.id) : undefined,
      url: d.shareLink ?? (d.id ? `https://www.binance.com/square/post/${d.id}` : undefined),
    }));
  }

  /**
   * Publish a 长文 (contentType 2). Measured behaviour, all of it different from posts:
   *
   * - `cover` takes the hosted **imageUrl**, not the upload fileTicket. The ticket form has
   *   no reason to be tried; the URL path returns `000000` and renders.
   * - A title is required, and exactly one cover — `imageList` cannot be combined with it.
   * - The body comes back on `content/{id}` in **`bodyTextOnly`**, while `content` is empty.
   *   Reading the wrong field looks exactly like a silently-empty article, so verify with
   *   `readArticleBody()` rather than the post path.
   * - Articles carry a `subscribeCount`. A post is a feed item; an article is a followable
   *     asset, which is the mechanism behind "教学复利".
   * - `$BTC` / `#BTC` still have to be inside the body text. The probe article mentioned
   *   CTSI in prose only and came back with `coinPairList` but an empty `hashtagList`.
   */
  async publishArticle(a: { title: string; bodyTextOnly: string; coverUrl: string }): Promise<PublishOutcome> {
    const title = a.title.trim();
    const body = a.bodyTextOnly.trim();
    const payload = { contentType: 2, title, bodyTextOnly: body, cover: a.coverUrl };

    if (this.opts.dryRun) {
      this.opts.log?.(`[dry-run] POST article "${title}" ${body.length}字 cover=${a.coverUrl.slice(0, 60)}`);
      return { ok: true, postId: 'dry-run', label: 'dry-run，未发送' };
    }
    if (!title) return { ok: false, kind: 'content', label: '文章必须有标题' };
    if (!a.coverUrl) return { ok: false, kind: 'content', label: '文章必须有一张封面图' };
    if (body.length > MAX_ARTICLE_CHARS) {
      return { ok: false, kind: 'content', label: `正文超过文章上限 ${MAX_ARTICLE_CHARS} 字 (${body.length})，不做截断` };
    }

    const r = await this.call<{ id?: string; shareLink?: string }>(`${V1}/content/add`, payload);
    return SquareClient.interpret(r, d => ({
      ok: true,
      postId: d.id ? String(d.id) : undefined,
      url: d.shareLink ?? (d.id ? `https://www.binance.com/square/post/${d.id}` : undefined),
    }));
  }

  /**
   * Check a key without publishing anything.
   *
   * There is no read endpoint on this API, so we send an intentionally empty body:
   * authentication is evaluated before content validation, therefore a
   * "body empty" error proves the key was accepted while nothing can be posted.
   */
  async validateKey(): Promise<{ ok: boolean; label: string; code?: string }> {
    const r = await this.call<{ id?: string }>(`${V1}/content/add`, { contentType: 1, bodyTextOnly: '' });
    const code = r.envelope?.code;
    if (r.httpStatus === 0) return { ok: false, label: `网络失败：${r.error ?? '未知'}` };
    if (code === '220003') return { ok: false, label: 'Key 不存在 —— 检查是否复制完整、是否用的是广场 Key', code };
    if (code === '220004') return { ok: false, label: 'Key 已过期 —— 到创作者中心重新生成', code };
    if (code === '20020' || code === '220011') return { ok: true, label: 'Key 有效：鉴权通过，空正文被正确拒绝', code };
    if (code === '000000') return { ok: true, label: 'Key 有效（空正文被接受，与文档不符，未发布任何内容）', code };
    const known = code ? CODES[code] : undefined;
    if (known?.kind === 'account_restricted') return { ok: true, label: `Key 可用，但账号被限制发帖：${known.label}`, code };
    if (known?.kind === 'quota') return { ok: true, label: `Key 可用，但今日额度已满：${known.label}`, code };
    return { ok: false, label: `未预期的响应：${code ?? '无 code'} ${known?.label ?? r.error ?? ''}`.trim(), code };
  }

  /**
   * Upload one image and wait for Square to transcode it.
   * Returns the hosted URL to pass into `publish`.
   */
  async uploadImage(bytes: Uint8Array, imageName: string, contentType: string): Promise<PublishOutcome & { imageUrl?: string }> {
    if (this.opts.dryRun) {
      this.opts.log?.(`[dry-run] would upload ${imageName} (${bytes.byteLength} bytes)`);
      return { ok: true, imageUrl: `dry-run://${imageName}`, label: 'dry-run，未发送' };
    }

    const presign = await this.call<{ presignedUrl?: string; fileTicket?: string }>(`${V2}/image/presignedUrl`, { imageName });
    const pre = SquareClient.interpret(presign, d => ({ ok: true, postId: JSON.stringify(d) }));
    if (!pre.ok) return pre;
    const data = presign.envelope?.data;
    if (!data?.presignedUrl || !data.fileTicket) {
      return { ok: false, kind: 'unknown', label: 'presignedUrl 响应缺少字段' };
    }

    const put = await this.fetchImpl(data.presignedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: bytes,
    }).catch(err => ({ ok: false, status: 0, statusText: String(err) }));
    if (!('ok' in put) || !put.ok) {
      return { ok: false, kind: 'network', label: `上传到对象存储失败 (${(put as Response).status ?? 'unknown'})` };
    }

    // Square processes the image asynchronously; the official client polls 10 x 3s.
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(r => setTimeout(r, 3000));
      const st = await this.call<{ status?: number; imageUrl?: string; failedReason?: string }>(`${V2}/image/imageStatus`, {
        fileTicket: data.fileTicket,
      });
      const d = st.envelope?.data;
      if (d?.status === 1 && d.imageUrl) return { ok: true, imageUrl: d.imageUrl };
      if (d?.status === 2) return { ok: false, kind: 'content', label: `图片处理失败：${d.failedReason ?? '未知原因'}` };
    }
    return { ok: false, kind: 'uncertain', uncertain: true, label: '图片处理超时，未确认成功' };
  }
}
