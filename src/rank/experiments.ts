import type { Store } from '../db/index.ts';
import { HYPOTHESES } from './hypotheses.ts';
import type { Verdict } from './score.ts';

/**
 * Assigning experimental arms.
 *
 * Two rules make this worth having. The first: the arm is chosen before the post exists and
 * written down next to it, so the outcome cannot be explained after the fact by whoever picked
 * the winner. The second: once a hypothesis has earned a rule, the exploration share drops to a
 * re-check rate instead of zero — an algorithm that changed last month would otherwise be
 * discovered by our numbers quietly getting worse with no experiment left to explain why.
 */

export const EXPLORE_SHARE = 0.35;
/** How much traffic we keep spending re-testing rules we already believe. */
export const RECHECK_SHARE = 0.1;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ArmPlan {
  [hypothesisId: string]: string;
}

export function planArms(opts: { seed: number; verdicts: Verdict[]; exploreShare?: number; recheckShare?: number }): ArmPlan {
  const rnd = mulberry32(opts.seed);
  const byId = new Map(opts.verdicts.map(v => [v.id, v]));
  const plan: ArmPlan = {};
  for (const h of HYPOTHESES) {
    if (h.mode !== 'experiment') continue;
    const v = byId.get(h.id);
    const roll = rnd();
    if (v?.status === 'rule' && v.winner) {
      plan[h.id] = roll < (opts.recheckShare ?? RECHECK_SHARE) ? h.arms[Math.floor(rnd() * h.arms.length)]! : v.winner;
    } else if (v?.status === 'flat' && v.winner) {
      // Nothing learned from varying it, so stop spending: take the better of the two anyway.
      plan[h.id] = roll < 0.5 ? v.winner : h.arms[Math.floor(rnd() * h.arms.length)]!;
    } else {
      plan[h.id] = h.arms[Math.floor(rnd() * h.arms.length)]!;
    }
  }
  return plan;
}

export function recordArms(store: Store, postId: number, plan: ArmPlan, at = Date.now()): void {
  const ins = store.db.prepare('INSERT OR REPLACE INTO post_arms (post_id, experiment, arm, assigned_at) VALUES (?,?,?,?)');
  for (const [experiment, arm] of Object.entries(plan)) ins.run(postId, experiment, arm, at);
}

export function armsOf(store: Store, postId: number): ArmPlan {
  const rows = store.db.prepare('SELECT experiment, arm FROM post_arms WHERE post_id = ?').all(postId) as { experiment: string; arm: string }[];
  return Object.fromEntries(rows.map(r => [r.experiment, r.arm]));
}
