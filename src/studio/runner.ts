import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Settings } from '../config.ts';
import type { Material } from '../material/types.ts';
import { makeMaterial, toContext } from '../material/types.ts';
import type { Context } from '../engine/types.ts';
import type { Store } from '../db/index.ts';
import { beijingDayStart } from '../schedule.ts';
import { llmConfigFor } from '../pipeline.ts';
import { polish } from '../llm/polish.ts';
import { buildChartFor } from '../chart/forSymbol.ts';
import { SquareClient } from '../publisher/square.ts';
import { getAccountSecret } from '../secrets.ts';
import { wordBank } from '../content/wordbank.ts';
import { nextCheckDue, readPost } from '../stats/backfill.ts';
/**
 * When may this account's next long post go out?
 *
 * The track's gap is a schedule, not a description. On the first live day both articles went out
 * at 11:54 because nothing read `minGapHours` — and a long post published two minutes after
 * another one spends reach it cannot get back. The draft reserves its minute here; the publisher
 * releases it when that minute arrives.
 */
export function nextArticleSlot(store: Store, accountId: number, track: Track, now = Date.now()): number {
  return Math.max(now, store.lastArticleClaimAt(accountId) + track.cadence.minGapHours * 3_600_000);
}

/** Raw materials row as stored. */
interface MaterialRow {
  id: string; category: Material["category"]; sub_type: string; title: string; symbol: string | null;
  sentiment: NonNullable<Material["sentiment"]> | null; score: number; source: string; occurred_at: number; facts_json: string;
}

import { CONCEPTS } from './concepts.ts';
import { composeArticle } from './compose.ts';
import { checkClaims, nextTopics } from './evidence.ts';
import { specFor } from './library.ts';
import { assertTextOnTrack, trackForAccount } from './lock.ts';
import type { Track } from './tracks.ts';

/**
 * The studio's own tick.
 *
 * Deliberately separate from the main loop rather than another stage inside it: articles
 * are produced at two a day, not twenty, and they need a different resource (a chart render,
 * an image upload, a long LLM pass) that has no business sitting in the short-post path.
 */

export interface StudioRunReport {
  accounts: { accountId: number; label: string; track: string; drafted: { conceptId: string; title: string; chars: number }[]; published: number; skipped: string[] }[];
  lessonsRecorded: number;
  statsUpdated: number;
  errors: string[];
}

/** Fields the current material pool can actually supply, so we never offer a dead concept. */
function availableFields(materials: Material[]): Set<string> {
  const out = new Set<string>(['cashtag', 'symbol', 'title', 'date', 'time', 'source', 'sentiment', 'category', 'subType']);
  for (const m of materials) {
    for (const k of Object.keys(m.facts)) out.add(k);
    if (m.symbol) out.add('cashtag');
  }
  return out;
}

/**
 * A material is a candidate for a concept only if it carries every field the concept is
 * written from. Matching on category alone would let a funding spike supply an
 * open-interest article and produce a piece that composes and then fails its own ledger.
 */
function materialFor(store: Store, conceptId: string, track: Track): Material | null {
  const concept = CONCEPTS.find(c => c.id === conceptId);
  if (!concept) return null;
  const rows = store.db
    .prepare(
      `SELECT * FROM materials WHERE discarded = 0 AND category = ? AND symbol IS NOT NULL
       ORDER BY score DESC, occurred_at DESC LIMIT 40`,
    )
    .all(concept.sourceCategory) as MaterialRow[];
  for (const r of rows) {
    const facts = JSON.parse(r.facts_json ?? '{}') as Context;
    const m = makeMaterial({
      category: r.category, subType: r.sub_type, title: r.title, symbol: r.symbol,
      sentiment: r.sentiment ?? undefined, score: r.score, source: r.source, at: r.occurred_at, facts,
    });
    m.id = r.id;
    if (!track.allowedCategories.includes(m.category)) continue;
    if (!concept.needsFields.every(f => f in facts && facts[f] !== null && facts[f] !== undefined)) continue;
    // A concept that quotes the coin's price must not be built from a coin nobody trades.
    if (typeof facts.quoteVolume24h === 'number' && facts.quoteVolume24h < 5_000_000) continue;
    return m;
  }
  return null;
}

/** The chart's headline number, read from the freshest material on that coin. */
function latestChg24h(store: Store, symbol: string): number {
  const row = store.db
    .prepare("SELECT facts_json FROM materials WHERE discarded = 0 AND symbol = ? ORDER BY occurred_at DESC LIMIT 1")
    .get(symbol) as { facts_json: string } | undefined;
  const f = row ? (JSON.parse(row.facts_json) as Record<string, unknown>) : {};
  return Number(f.chg24h ?? f.chg ?? 0);
}

async function makeCover(symbol: string, chg24h: number, outDir: string): Promise<string | null> {
  const built = await buildChartFor({ symbol, chg24h }, outDir, '1h');
  return built?.path ?? null;
}

export async function runStudio(
  store: Store,
  settings: Settings,
  opts: { live?: boolean; outDir?: string; now?: number } = {},
): Promise<StudioRunReport> {
  const report: StudioRunReport = { accounts: [], lessonsRecorded: 0, statsUpdated: 0, errors: [] };
  const now = opts.now ?? Date.now();
  const bindings = store.studioAccounts().filter(b => b.enabled);
  if (!bindings.length) return report;

  for (const b of bindings) {
    const account = store.accountById(b.account_id);
    const track = trackForAccount(store, b.account_id);
    const entry = { accountId: b.account_id, label: account?.label ?? String(b.account_id), track: b.track_id, drafted: [] as { conceptId: string; title: string; chars: number }[], published: 0, skipped: [] as string[] };
    report.accounts.push(entry);
    if (!account || !track) {
      entry.skipped.push('账号不存在或赛道未定义');
      continue;
    }
    if (!account.enabled) {
      entry.skipped.push('账号已停用');
      continue;
    }

    const recent = store.db
      .prepare("SELECT * FROM materials WHERE discarded = 0 AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT 400")
      .all(now - 6 * 3_600_000) as MaterialRow[];
    const mats: Material[] = recent.map(r => {
      const m = makeMaterial({
        category: r.category, subType: r.sub_type, title: r.title, symbol: r.symbol,
        sentiment: r.sentiment ?? undefined, score: r.score, source: r.source, at: r.occurred_at,
        facts: JSON.parse(r.facts_json ?? '{}'),
      });
      m.id = r.id;
      return m;
    });

    const want = b.articles_per_day ?? track.cadence.articlesPerDay;
    const alreadyToday = (store.db.prepare(
      'SELECT COUNT(*) AS n FROM studio_articles WHERE account_id = ? AND created_at >= ?',
    ).get(b.account_id, beijingDayStart(now)) as { n: number }).n;
    const budget = Math.max(0, want - alreadyToday);
    if (!budget) {
      entry.skipped.push(`今日 ${want} 篇额度已用完`);
      continue;
    }

    const choices = nextTopics(store, b.track_id, { limit: budget, availableFields: availableFields(mats) });
    if (!choices.length) entry.skipped.push('没有可写的概念（前置未满足或当前数据源无对应素材）');

    for (const choice of choices) {
      try {
        const spec = specFor(choice.conceptId);
        if (!spec) {
          entry.skipped.push(`${choice.conceptId}：还没有写好这篇内容`);
          continue;
        }
        const material = materialFor(store, choice.conceptId, track);
        if (!material) {
          entry.skipped.push(`${choice.conceptId}：当前素材里没有它需要的数据`);
          continue;
        }
        const composed = composeArticle(spec, toContext(material), { seed: `${choice.conceptId}:${now}`, bank: wordBank, track });
        if (!composed.ok) {
          entry.skipped.push(`${choice.conceptId}：${composed.reason}`);
          continue;
        }

        const claimAt = nextArticleSlot(store, b.account_id, track, now);
        const id = store.addArticle({
          trackId: track.id,
          conceptId: choice.conceptId,
          accountId: b.account_id,
          symbol: material.symbol,
          title: composed.title,
          body: composed.body,
          sections: composed.sections,
          facts: composed.facts,
          coverPath: null,
          scheduledAt: claimAt,
          expiresAt: spec.validForHours ? claimAt + spec.validForHours * 3_600_000 : null,
          windowClaims: composed.claims,
        });
        entry.drafted.push({ conceptId: choice.conceptId, title: composed.title, chars: composed.chars });
        store.log('studio_generate', { accountId: b.account_id, conceptId: choice.conceptId, articleId: id, chars: composed.chars });
      } catch (err) {
        report.errors.push(`${b.account_id}/${choice.conceptId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /* ------------------------------------------------------------- publishing --- */
  const apiKeyOf = new Map<number, string>();
  for (const a of store.studioAccounts()) {
    const k = getAccountSecret(store, a.account_id);
    if (k) apiKeyOf.set(a.account_id, k);
  }

  const due = store.studioArticles(['approved']).filter(a => (a.scheduled_at ?? 0) <= now);
  for (const a of due) {
    const account = a.account_id ? store.accountById(a.account_id) : null;
    const track = a.account_id ? trackForAccount(store, a.account_id) : undefined;
    if (!account || !track) {
      store.updateStudioArticle(a.id, { status: 'rejected', error: '账号或赛道绑定已不存在' });
      continue;
    }
    const apiKey = apiKeyOf.get(account.id);
    if (!apiKey) {
      store.updateStudioArticle(a.id, { error: '该账号还没有广场 Key' });
      continue;
    }

    // The last gate before the network, and it runs on the text that is about to go out —
    // which, if polish ran, is not the text that was composed.
    const gate = assertTextOnTrack(track, `${a.title}\n${a.body}`, 'polish');
    if (!gate.ok) {
      store.updateStudioArticle(a.id, { status: 'rejected', error: gate.reasons.join('；'), refusalHits: JSON.stringify(gate.reasons) });
      continue;
    }

    if (!opts.live) {
      store.log('studio_dry_run', { articleId: a.id, title: a.title });
      continue;
    }

    try {
      const client = new SquareClient({ apiKey, dryRun: false, proxyUrl: account.proxy_url ?? '' });
      let coverUrl = a.cover_url ?? '';
      if (!coverUrl) {
        // An article cannot be posted without exactly one cover, so a failed chart is a
        // blocked post rather than a text-only one.
        const path = a.symbol ? await makeCover(a.symbol, latestChg24h(store, a.symbol), opts.outDir ?? 'data/charts') : null;
        if (!path) {
          store.updateStudioArticle(a.id, { error: '封面图生成失败，文章未发布' });
          continue;
        }
        const up = await client.uploadImage(readFileSync(path), basename(path), 'image/png');
        if (!up.ok || !up.imageUrl) {
          store.updateStudioArticle(a.id, { error: `封面上传失败：${up.label ?? '未知'}` });
          continue;
        }
        coverUrl = up.imageUrl;
        store.updateStudioArticle(a.id, { coverUrl, coverPath: path });
      }

      const r = await client.publishArticle({ title: a.title, bodyTextOnly: a.body, coverUrl });
      if (r.ok && r.postId) {
        store.updateStudioArticle(a.id, { status: 'published', squarePostId: r.postId, url: r.url ?? null, publishedAt: Date.now() });
        store.recordConceptWritten(a.concept_id, a.track_id, 0, 0);
        const owner = report.accounts.find(x => x.accountId === a.account_id);
        if (owner) owner.published++;
        store.log('studio_published', { articleId: a.id, conceptId: a.concept_id, postId: r.postId });
      } else if (r.uncertain) {
        // A 504 here probably means it posted. Never retried — that duplicates.
        store.updateStudioArticle(a.id, { status: 'uncertain', error: r.label ?? '状态未知，需人工到广场确认' });
      } else {
        store.updateStudioArticle(a.id, { status: 'failed', error: r.label ?? '发布失败' });
      }
    } catch (err) {
      report.errors.push(`studio publish ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* ------------------------------------------------------------------ stats --- */
  for (const a of store.studioArticles(['published']).filter(x => /^\d{6,}$/.test(x.square_post_id ?? ''))) {
    const dueIdx = nextCheckDue(a.published_at ?? a.created_at, store.studioObservations(a.id).map(o => o.checkpoint));
    if (dueIdx < 0) continue;
    try {
      const vo = await readPost(a.square_post_id!);
      if (!vo) continue;
      store.recordStudioObservation(a.id, dueIdx, {
        views: Number(vo.viewCount ?? 0), likes: Number(vo.likeCount ?? 0), comments: Number(vo.commentCount ?? 0),
        shares: Number(vo.shareCount ?? 0), reactions: Number(vo.totalReactionCount ?? 0), subscribers: Number(vo.subscribeCount ?? 0),
        onBoard: false,
      });
      report.statsUpdated++;
    } catch (err) {
      report.errors.push(`studio stats ${a.id}: ${String(err).slice(0, 80)}`);
    }
  }

  /* ---------------------------------------------------------- self-correction --- */
  try {
    const res = await checkClaims(store, async (symbol, field) => {
      const row = store.db
        .prepare("SELECT facts_json FROM materials WHERE discarded = 0 AND symbol = ? ORDER BY occurred_at DESC LIMIT 1")
        .get(symbol) as { facts_json: string } | undefined;
      const f = row ? (JSON.parse(row.facts_json) as Record<string, unknown>) : {};
      const v = f[field];
      return typeof v === 'number' ? v : null;
    });
    report.lessonsRecorded = res.contradicted;
  } catch (err) {
    report.errors.push(`claims: ${err instanceof Error ? err.message : String(err)}`);
  }

  return report;
}


/**
 * Optional LLM pass over a composed article.
 *
 * Allowed to change wording only. The refusal gate re-runs afterwards because polish is the
 * step most likely to turn a description into advice — it is the operation whose entire
 * purpose is making prose sound more decisive.
 */
export async function polishArticleDraft(store: Store, settings: Settings, articleId: number): Promise<{ ok: boolean; changed: boolean; reason?: string }> {
  const a = store.studioArticle(articleId);
  if (!a) return { ok: false, changed: false, reason: '文章不存在' };
  const track = a.account_id ? trackForAccount(store, a.account_id) : undefined;
  if (!track) return { ok: false, changed: false, reason: '缺少赛道绑定，无法校验润色结果' };
  const cfg = llmConfigFor(store, settings);
  if (!cfg) return { ok: false, changed: false, reason: 'AI 未启用' };

  const facts = (() => {
    try {
      return JSON.parse(a.facts_json ?? '[]');
    } catch {
      return [];
    }
  })();
  const res = await polish(cfg, a.body, facts as never);
  if (!res.changed) return { ok: false, changed: false, reason: res.reason };
  const gate = assertTextOnTrack(track, `${a.title}\n${res.text}`, 'polish');
  if (!gate.ok) return { ok: false, changed: false, reason: `润色后越出赛道边界：${gate.reasons.join('；')}` };
  store.updateStudioArticle(articleId, { body: res.text });
  return { ok: true, changed: true };
}
