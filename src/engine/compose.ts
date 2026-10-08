import { renderTemplate } from './render.ts';
import { auditAgainstFacts } from './verify.ts';
import { guardPost, isStructuralDuplicate } from './guard.ts';
import { Rng } from './prng.ts';
import type { RenderResult, TemplateDef } from './types.ts';
import type { Material } from '../material/types.ts';
import { toContext } from '../material/types.ts';

/** Style used when the account rotates across all styles. */
export const MIXED = 'mixed';

export interface TemplateFilter {
  /** One style, a list of them (the account picks per post from its own set), or any. */
  style?: string | string[];
}

/**
 * A template is eligible only when it was written for this exact material
 * sub-type. Matching on category alone lets "跳水" copy land on a pump.
 */
export function eligibleTemplates(m: Material, all: readonly TemplateDef[], filter: TemplateFilter = {}): TemplateDef[] {
  const raw = Array.isArray(filter.style) ? filter.style : [filter.style];
  const styles = new Set(raw.filter((s): s is string => Boolean(s)));
  const any = styles.size === 0 || styles.has(MIXED);
  return all.filter(t => {
    if (t.enabled === false) return false;
    if (t.category !== m.category) return false;
    if (t.subType && t.subType !== m.subType) return false;
    // Several voices on one account is the cheapest variety lever there is: the weighted
    // shuffle then picks across all of them instead of being locked into one.
    if (!any && t.style !== 'any' && !styles.has(t.style)) return false;
    return true;
  });
}

export interface ComposeOptions {
  seed: number | string;
  bank: Record<string, string>;
  style?: string | string[];
  /** Recent post texts, used to reject near-duplicates before they queue up. */
  recent?: string[];
  /**
   * Copy from *other* accounts. The same sentence with the coin swapped is what two
   * accounts sharing a template produces, so this is checked at a lower similarity
   * threshold than the account's own cooldown.
   */
  avoid?: { texts: readonly string[]; threshold: number };
  sensitiveWords?: string[];
  /** How many candidate templates to try before giving up. */
  maxAttempts?: number;
}

export interface Candidate {
  templateId: string;
  templateName: string;
  text: string;
  result: RenderResult;
}

function weightedShuffle<T>(items: T[], weightOf: (t: T) => number, rng: Rng): T[] {
  const pool = items.map(t => ({ t, w: Math.max(0.01, weightOf(t)) }));
  const out: T[] = [];
  while (pool.length) {
    const total = pool.reduce((s, p) => s + p.w, 0);
    let pick = rng.float() * total;
    let idx = 0;
    for (; idx < pool.length; idx++) {
      pick -= (pool[idx] as { t: T; w: number }).w;
      if (pick <= 0) break;
    }
    out.push(pool[Math.min(idx, pool.length - 1)]!.t);
    pool.splice(Math.min(idx, pool.length - 1), 1);
  }
  return out;
}

/**
 * Turn one material into one publishable post.
 * Tries eligible templates in weighted-random order and returns the first that
 * satisfies its data contract, clears the content guards, and passes the fact audit.
 */
export function compose(m: Material, all: readonly TemplateDef[], opts: ComposeOptions): Candidate | { error: string } {
  const rng = new Rng(opts.seed);
  const ctx = toContext(m);
  const candidates = eligibleTemplates(m, all, { style: opts.style });
  if (!candidates.length) return { error: `no template matches ${m.category}/${m.subType}` };

  const tried: string[] = [];
  const wanted = Array.isArray(opts.style) ? opts.style : [opts.style];
  const specific = new Set(wanted.filter(s => s && s !== MIXED));
  // A `style: 'any'` template is visible to every voice, so a good generic one would
  // otherwise swallow the whole style — five styles picking the same generic body and
  // differing only in the opening emoji. Boost a style's own templates so they win when
  // they exist, while `any` stays as the fallback that keeps a quiet cell writable.
  const boost = (t: TemplateDef): number => (specific.has(t.style) ? (t.weight ?? 1) * 6 : t.weight ?? 1);
  for (const t of weightedShuffle(candidates, boost, rng).slice(0, opts.maxAttempts ?? candidates.length)) {
    const res = renderTemplate(t, ctx, { seed: `${opts.seed}:${t.id}`, bank: opts.bank });
    if (!res.ok) {
      tried.push(`${t.id}: ${res.reason}`);
      continue;
    }
    const audit = auditAgainstFacts(res.text, res.facts);
    if (!audit.ok) {
      tried.push(`${t.id}: invented facts ${JSON.stringify(audit)}`);
      continue;
    }
    const guard = guardPost(res.text, {
      sensitiveWords: opts.sensitiveWords ?? [],
      recent: opts.recent ?? [],
    });
    if (!guard.ok) {
      tried.push(`${t.id}: ${guard.reasons.join('; ')}`);
      continue;
    }
    if (opts.avoid?.texts.length) {
      const clash = isStructuralDuplicate(res.text, opts.avoid.texts, opts.avoid.threshold);
      if (clash) {
        tried.push(`${t.id}: 与其他账号近期文案同句式`);
        continue;
      }
    }
    return { templateId: t.id, templateName: t.name, text: res.text, result: res };
  }
  return { error: `all ${tried.length} candidate(s) rejected:\n  ${tried.join('\n  ')}` };
}
