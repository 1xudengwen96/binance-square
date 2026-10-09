import type { Store, StudioArticle } from '../db/index.ts';
import { CONCEPTS, conceptById, citingConcepts, unlockedBy } from './concepts.ts';
import type { Concept, } from './concepts.ts';
import type { WindowClaim } from './compose.ts';

/**
 * The loop that makes the account get better at being itself.
 *
 * Three mechanisms, and the honest limits of each:
 *
 * **Selection.** Topics are chosen from the curriculum, gated by prerequisites, scored by
 * what has actually been measured — plus a deliberate exploration floor. Without that floor
 * one early lucky article would capture the whole schedule and the account would stop
 * learning anything it did not already believe.
 *
 * **Falsification.** An article that says "持仓还在增加" has made a claim with an expiry
 * date. Later data either still supports it or it does not. When it does not, that is
 * recorded as a lesson and the phrasing tightens going forward. The published article
 * cannot be edited — the API is create-only — so this is the only form of self-correction
 * actually available, and it is worth being precise about that rather than implying the
 * system revises its own past.
 *
 * **What it cannot do.** With a handful of articles, no ranking is trustworthy. Square's
 * view distribution is power-law, so the same template measured 48 and 313 on two different
 * coins. Anything below MIN_SAMPLES is reported as insufficient rather than turned into a
 * recommendation.
 */

/** Below this, a concept's numbers are displayed but never used to choose anything. */
export const MIN_SAMPLES = 5;
/** Fraction of picks reserved for topics that are not currently top-ranked. */
export const EXPLORATION_SHARE = 0.25;

export interface ConceptPerformance {
  conceptId: string;
  title: string;
  tier: number;
  written: boolean;
  articles: number;
  measured: number;
  medianViews: number;
  bestViews: number;
  engagementPer1k: number;
  subscribers: number;
  onBoard: number;
  rankable: boolean;
  needsUpdate: boolean;
}

export interface TopicChoice {
  conceptId: string;
  title: string;
  tier: number;
  score: number;
  /** Plain-language reasons, shown in the UI so the choice can be argued with. */
  why: string[];
  /** How many currently-blocked concepts this piece would unlock. */
  unlocks: number;
  forcedByExploration: boolean;
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

function parseClaims(a: StudioArticle): WindowClaim[] {
  // addArticle stores `null` as the string "null", which JSON.parse happily returns as a
  // non-array. Guard the shape, not just the parse error.
  try {
    const v = JSON.parse(a.window_claims_json ?? '[]');
    return Array.isArray(v) ? (v as WindowClaim[]) : [];
  } catch {
    return [];
  }
}

export function conceptPerformance(store: Store, trackId: string): ConceptPerformance[] {
  const states = new Map(store.conceptStates(trackId).map(s => [s.concept_id, s]));
  const articles = store.studioArticles(['published', 'approved']);

  return CONCEPTS.filter(c => c.trackId === trackId).map(c => {
    const mine = articles.filter(a => a.concept_id === c.id);
    const stats = store.studioLatestStats(mine.map(a => a.id));
    const views = [...stats.values()].map(s => s.views).filter((v): v is number => v != null);
    const viewTotal = views.reduce((a, b) => a + b, 0);
    const eng = [...stats.values()].reduce((s, x) => s + (x.likes ?? 0) + (x.comments ?? 0) + (x.shares ?? 0), 0);
    const state = states.get(c.id);
    return {
      conceptId: c.id,
      title: c.title,
      tier: c.tier,
      written: Boolean(state?.written),
      articles: mine.length,
      measured: views.length,
      medianViews: Math.round(median(views)),
      bestViews: views.length ? Math.max(...views) : 0,
      engagementPer1k: viewTotal > 0 ? Number(((eng * 1000) / viewTotal).toFixed(1)) : 0,
      subscribers: [...stats.values()].reduce((s, x) => s + (x.subscribers ?? 0), 0),
      onBoard: [...stats.values()].filter(s => s.on_board).length,
      rankable: views.length >= MIN_SAMPLES,
      needsUpdate: Boolean(state?.needs_update),
    };
  });
}

interface SelectOptions {
  limit?: number;
  /** Injectable so tests can make the exploration draw deterministic. */
  rand?: () => number;
  /** Live fields available right now. A concept whose data source is quiet is not offered. */
  availableFields?: Set<string>;
}

/**
 * Pick what to write next.
 *
 * The score is not a popularity maximiser. A keystone concept that unlocks seven others is
 * worth more than a mid-tier one that happened to catch a good coin, and the formula says
 * so explicitly rather than hiding it behind a single number.
 */
export function nextTopics(store: Store, trackId: string, opts: SelectOptions = {}): TopicChoice[] {
  const rand = opts.rand ?? Math.random;
  const perf = new Map(conceptPerformance(store, trackId).map(p => [p.conceptId, p]));
  const written = new Set([...perf].filter(([, p]) => p.written).map(([id]) => id));
  const available = opts.availableFields;

  const candidates = unlockedBy(written).filter(c => {
    if (!available) return true;
    // A concept cannot be written without its fields; offering it would only produce a
    // compose failure later and hide the real reason.
    return c.needsFields.every(f => available.has(f));
  });

  const bestMeasured = Math.max(1, ...[...perf.values()].map(p => p.medianViews));
  const out: TopicChoice[] = candidates.map(c => {
    const p = perf.get(c.id);
    const why: string[] = [];
    let score = 1;

    const unlocks = citingConcepts(c.id).filter(x => !written.has(x.id)).length;
    if (unlocks) {
      score += unlocks * 1.6;
      why.push(`写完解锁 ${unlocks} 个后续概念`);
    }
    if (c.tier === 0) {
      score += 0.8;
      why.push('基础概念，越早发越早有复利');
    }
    if (p?.rankable) {
      const rel = p.medianViews / bestMeasured;
      score += 0.5 + rel;
      why.push(`该概念已有 ${p.measured} 篇读数，中位浏览 ${p.medianViews}${rel > 0.6 ? '，表现居前' : ''}`);
    } else if (p && p.measured > 0) {
      why.push(`已有 ${p.measured} 篇但不足 ${MIN_SAMPLES} 篇，暂不参与排名`);
    }
    if (p?.needsUpdate) {
      score += 2;
      why.push('先前版本的例子已过期，需要重写');
    }
    if (p && p.articles > 0 && p.engagementPer1k === 0) {
      why.push('注意：该概念已有文章零互动，换角度而不是换数量');
    }
    return { conceptId: c.id, title: c.title, tier: c.tier, score, why, unlocks, forcedByExploration: false };
  });

  out.sort((a, b) => b.score - a.score);

  // Reserve a slice of the schedule for everything that is not currently winning. A pure
  // exploiter converges on one format after two or three posts and then reports only
  // confirms its own early noise.
  //
  // `max(1, …)` rather than a bare floor: at the default limit of three, 25% rounds to zero
  // and the exploration floor silently disappears — in exactly the small-sample regime it
  // exists to protect.
  const limit = Math.max(1, opts.limit ?? 3);
  const explore = out.length > limit ? Math.max(1, Math.floor(limit * EXPLORATION_SHARE)) : 0;
  if (explore > 0) {
    const tail = out.slice(limit - explore);
    const picked = tail[Math.floor(rand() * tail.length) % tail.length];
    if (picked) {
      picked.forcedByExploration = true;
      picked.why.push('探索位：样本太少时，不能只发当前排名靠前的');
      out.splice(limit - 1, 1, picked);
    }
  }
  return out.slice(0, limit);
}

/**
 * Re-check the falsifiable statements in published articles against current data.
 *
 * Returns the lessons written, so the caller can surface them. A claim that still holds is
 * recorded too — an account that only logs its surprises learns the wrong base rate.
 */
export async function checkClaims(
  store: Store,
  currentOf: (symbol: string, field: string) => Promise<number | null> | number | null,
): Promise<{ checked: number; contradicted: number; held: number; expired: number }> {
  const published = store.studioArticles(['published']).filter(a => a.symbol && parseClaims(a).length);
  let contradicted = 0;
  let held = 0;
  let expired = 0;

  for (const a of published) {
    if (a.expires_at && Date.now() > a.expires_at) expired++;
    for (const claim of parseClaims(a)) {
      const now = await currentOf(a.symbol!, claim.field);
      if (now == null || !Number.isFinite(now)) continue;
      const before = claim.value;
      let broken = false;
      if (claim.assertion === 'increasing') broken = now < 0;
      else if (claim.assertion === 'decreasing') broken = now > 0;
      else if (claim.assertion === 'above') broken = before != null && now < 0;
      else if (claim.assertion === 'below') broken = before != null && now > 0;
      else if (claim.assertion === 'paying') broken = Math.sign(now) !== Math.sign(before ?? now);

      if (broken) {
        contradicted++;
        store.addLesson({
          articleId: a.id,
          conceptId: a.concept_id,
          kind: 'contradicted',
          detail: `《${a.title}》断言「${claim.phrase}」，现在 ${claim.field} = ${now.toFixed(3)}，已不成立。该措辞在后续同概念文章中需加时限。`,
        });
        store.markConceptStale(a.concept_id, a.track_id);
      } else {
        held++;
      }
    }
  }
  return { checked: published.length, contradicted, held, expired };
}

/** Anything the module knows about itself that the operator should see. */
export function summarize(store: Store, trackId: string): string[] {
  const perf = conceptPerformance(store, trackId);
  const written = perf.filter(p => p.written);
  const rankable = perf.filter(p => p.rankable);
  const lessons = store.lessons(20).filter(l => l.kind === 'contradicted');
  const out: string[] = [];
  out.push(`课程进度 ${written.length}/${perf.length} 个概念已发，${rankable.length} 个攒够 ${MIN_SAMPLES} 篇读数可排名。`);
  if (!rankable.length) {
    const need = Math.max(0, ...perf.map(p => MIN_SAMPLES - p.measured));
    out.push(`还没有任何概念可排名：最接近的还差 ${need} 篇读数。这期间选题按课程结构而非历史表现决定。`);
  }
  if (lessons.length) out.push(`已记录 ${lessons.length} 条被后续数据推翻的断言，相关措辞已收紧。`);
  const stale = perf.filter(p => p.needsUpdate);
  if (stale.length) out.push(`${stale.length} 个概念的例子已过期，需要新数据重写：${stale.map(p => conceptById(p.conceptId)?.title ?? p.conceptId).join('、')}。`);
  return out;
}

export type { Concept };
