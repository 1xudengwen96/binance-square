import type { Store } from '../db/index.ts';
import { HYPOTHESES } from './hypotheses.ts';
import type { Verdict } from './score.ts';
import { hashString, mulberry32 } from '../engine/prng.ts';

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

/**
 * How much traffic is deliberately allowed to re-post a coin inside the cooldown window.
 *
 * `h_repeat_interval` asks whether a quick repeat suppresses itself, and `coinSignalCooldownMinutes`
 * is the parameter that answer is supposed to set. But the cooldown also guarantees the `within6h`
 * arm never receives a single row — so the number was being defended by a measurement that could
 * not exist. Five percent accumulates rows slowly and costs almost nothing if repeats really do
 * self-suppress, which is the thing being measured.
 */
export const REPEAT_EXPLORE_SHARE = 0.05;

/**
 * Deterministic on (material, account, slot), so re-running a tick makes the same call and a
 * bypass can be audited afterwards instead of looking like a race.
 */
export function exploreRepeat(seed: string, share = REPEAT_EXPLORE_SHARE): boolean {
  return mulberry32(hashString(`${seed}:repeat`))() < share;
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
      // Half tilted to the nominal winner, half still random. "No difference" is itself a
      // measurement and measurements can be broken: the engagement metric read zero on every row
      // for as long as its columns were missing from the query, which looks exactly like a flat
      // verdict. The tilt costs nothing (the gap is inside the noise) and the retained variation
      // is what would notice if the flat result were ever contradicted.
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
