import type { Store } from '../db/index.ts';
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
 *
 * While nothing is believed the draw goes to the arm with the fewest recorded samples rather than
 * being rationed by an explore share: there is no winner to hold traffic back for, and a uniform
 * draw is only balanced in expectation — at ten posts a side the expectation is not what happened.
 */

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

export interface ArmPlanOptions {
  seed: number;
  verdicts: Verdict[];
  recheckShare?: number;
  only?: readonly string[] | null;
  exclude?: readonly string[];
  /** Arms this lane can actually carry this round, per experiment (the column knows which shapes
   *  its material supports). A shape that cannot be written is not a draw — it is a sample the
   *  comparison never receives, which is how recap stayed at three while anomaly reached fifteen. */
  allow?: Record<string, readonly string[]>;
}

/**
 * Draw this post's arms.
 *
 * Read off the verdict list rather than the hypothesis array, which is what lets a hypothesis
 * registered in the database get its arms assigned with no change here. Every hypothesis the
 * registry knows appears in the verdict list even at zero samples, so nothing is skipped.
 */
export function planArms(opts: ArmPlanOptions): ArmPlan {
  const plan: ArmPlan = {};
  for (const v of opts.verdicts) {
    if (v.mode !== 'experiment') continue;
    // A hypothesis outside the active set draws nothing and gets no arm.
    if (opts.only && !opts.only.includes(v.id)) continue;
    // Lane-specific hypotheses (the column shape) must not be drawn for posts from another lane.
    if (opts.exclude?.includes(v.id)) continue;
    // Each hypothesis has its own stream, keyed by the post seed and its id. One shared stream
    // advances by a different amount depending on which branch a hypothesis takes, so adding or
    // removing one would quietly reassign every arm after it.
    const rnd = mulberry32(hashString(`${opts.seed}:${v.id}`));
    const allowed = opts.allow?.[v.id];
    const arms = v.arms.map(a => a.arm).filter(a => !allowed || allowed.includes(a));
    if (!arms.length) continue;
    // Fewest-samples-first. A uniform draw is balanced in expectation, but ten posts a side is
    // not enough for the expectation to be what happened: the column ran 15 anomaly against 3
    // recap, the polish arm 22 raw against 6 polished, and both comparisons stayed one-sided for
    // weeks. Ties stay random, so the arm is still decided before the post exists and recorded
    // with it — this changes how often an arm is drawn, never how its outcome is measured.
    const samples = new Map(v.arms.map(a => [a.arm, a.n]));
    const pick = () => {
      const fewest = Math.min(...arms.map(a => samples.get(a) ?? 0));
      const pool = arms.filter(a => (samples.get(a) ?? 0) === fewest);
      return pool[Math.floor(rnd() * pool.length)]!;
    };
    const roll = rnd();
    if (v.status === 'rule' && v.winner) {
      plan[v.id] = roll < (opts.recheckShare ?? RECHECK_SHARE) ? pick() : v.winner;
    } else if (v.status === 'flat' && v.winner) {
      // Half tilted to the nominal winner, half still random. "No difference" is itself a
      // measurement and measurements can be broken: the engagement metric read zero on every row
      // for as long as its columns were missing from the query, which looks exactly like a flat
      // verdict. The tilt costs nothing (the gap is inside the noise) and the retained variation
      // is what would notice if the flat result were ever contradicted.
      plan[v.id] = roll < 0.5 ? v.winner : pick();
    } else {
      plan[v.id] = pick();
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
