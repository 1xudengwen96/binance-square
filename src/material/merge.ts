import type { Material } from './types.ts';
import { similarity } from '../engine/guard.ts';

/**
 * Collapse the same story arriving more than once.
 *
 * Wires re-run each other constantly, and the same outlet will post the same headline
 * twice inside ten minutes as it edits it. Without this, one event can occupy several
 * slots in a day's queue — which reads to an audience (and to Square's own duplicate
 * handling) as an account saying the same thing over and over.
 *
 * Matching is on the coin plus the shape of the headline, not on the source name: the
 * point is to notice the same *fact*, whether it arrives twice from one wire or from two.
 */

function normalize(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、！？：；「」『』“”‘’（）()《》<>\-—_.,!?:;"']/g, '');
}

/** How alike two headlines must be to count as the same story. */
export const SAME_STORY_THRESHOLD = 0.72;

export interface MergeReport {
  kept: Material[];
  merged: number;
}

export function mergeSameStory(inputs: Material[]): MergeReport {
  const kept: Material[] = [];
  const buckets: { key: string; norm: string; m: Material }[] = [];
  let merged = 0;

  // Newest first inside the batch so the survivor carries the freshest body.
  const inputs2 = [...inputs].sort((a, b) => b.at - a.at);
  for (const m of inputs2) {
    const coin = (m.symbol ?? '-').toUpperCase();
    const norm = normalize(m.title);
    const twin = buckets.find(b => b.key === coin && similarity(b.norm, norm) >= SAME_STORY_THRESHOLD);
    if (twin) {
      // Fold the duplicate into the survivor rather than dropping it silently: the
      // number of outlets carrying a story is itself a signal the copy can use.
      const f = twin.m.facts as Record<string, unknown>;
      const tf = m.facts as Record<string, unknown>;
      const names = new Set([...String(f.source_names ?? f.source_name ?? twin.m.source).split('、'), String(tf.source_name ?? m.source)]);
      f.source_names = [...names].join('、');
      f.source_count = names.size;
      for (const s of m.symbols) if (!twin.m.symbols.includes(s)) twin.m.symbols.push(s);
      merged++;
      continue;
    }
    buckets.push({ key: coin, norm, m });
    kept.push(m);
  }
  return { kept, merged };
}
