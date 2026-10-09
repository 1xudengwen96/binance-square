import type { Store } from '../db/index.ts';
import { recall } from '../brain/memory.ts';
import { scoreAll, type Verdict } from './score.ts';
import type { ArmPlan } from './experiments.ts';

/**
 * What the robot currently does with what it believes.
 *
 * The generator must not read hypotheses directly — it needs one small object of knobs, each
 * either decided by a rule that earned the right, decided by this post's experimental arm, or
 * still at its default. Defaults matter: before there is evidence the system has to behave like
 * a sensible editor, not like a coin flip.
 */
export interface Playbook {
  hashtagTotal: number;
  attachChart: boolean;
  opening: 'statement' | 'question';
  /** Rules that are currently acting on this post, for the audit trail and the panel. */
  acting: { source: 'rule' | 'experiment'; text: string }[];
  verdicts: Verdict[];
}

/** Coin tag plus one topic tag — the shape the panel shipped before any of this was measured. */
const DEFAULTS = { hashtagTotal: 2, attachChart: true, opening: 'statement' as const };

export function playbook(store: Store, opts: { verdicts?: Verdict[]; arms?: ArmPlan } = {}): Playbook {
  const verdicts = opts.verdicts ?? scoreAll(store, { writeMemory: false });
  const acting: Playbook['acting'] = [];
  let pb: Playbook = { ...DEFAULTS, opening: DEFAULTS.opening, acting, verdicts };

  const decided = (id: string): Verdict | undefined => {
    const v = verdicts.find(x => x.id === id);
    return v && v.status === 'rule' ? v : undefined;
  };

  const chart = decided('h_chart');
  if (chart?.winner) {
    pb.attachChart = chart.winner === 'chart';
    acting.push({ source: 'rule', text: `配图：${chart.winner === 'chart' ? '带上' : '不带'}（${chart.claim}）` });
  }

  const tags = decided('h_hashtag_count');
  const tagArm = opts.arms?.h_hashtag_count ?? tags?.winner;
  if (tagArm) {
    pb.hashtagTotal = tagArm === 'one' ? 1 : tagArm === 'two' ? 2 : 3;
    acting.push({ source: opts.arms?.h_hashtag_count ? 'experiment' : 'rule', text: `全篇 ${pb.hashtagTotal} 个标签` });
  }

  const open = decided('h_opening');
  const openArm = opts.arms?.h_opening ?? open?.winner;
  if (openArm) {
    pb.opening = openArm === 'question' ? 'question' : 'statement';
    acting.push({ source: opts.arms?.h_opening ? 'experiment' : 'rule', text: `收尾${pb.opening === 'question' ? '提问' : '陈述'}` });
  }

  // A chart arm assigned for this post always beats the standing rule — that is how the
  // experiment gets its sample in the first place.
  const chartArm = opts.arms?.h_chart;
  if (chartArm) {
    pb.attachChart = chartArm === 'chart';
    acting.push({ source: 'experiment', text: `本篇配图按实验臂：${chartArm}` });
  }

  return pb;
}

/** The standing rules, as sentences — used when briefing the writer or the AI brain. */
export function rankRulesFor(store: Store, about: string, limit = 4) {
  return recall(store, { kinds: ['rank-rule', 'content-lesson'], about, limit });
}
