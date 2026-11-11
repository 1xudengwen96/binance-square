import type { Store } from '../db/index.ts';
import type { Settings } from '../config.ts';
import { breaker, currentTarget, evaluateBreaker, gateReport, GATE_LINES, type BreakerStatus, type GateReport } from '../rank/gates.ts';
import { scoreAll, heatProfile, MATURITY_FLOOR_MS, type Verdict } from '../rank/score.ts';
import { changeLedger, liveKnobs, currentKnob } from '../rank/params.ts';
import { settingsFrom } from '../schedule.ts';
import { boardComposition, type BoardComposition } from '../stats/benchmarks.ts';
import { callStats, type CallStats } from '../calls.ts';
import { upgradesForSnapshot } from './upgrades.ts';
import { METRIC_DEFINITIONS, MEASUREMENT_SAMPLE } from '../rank/metrics.ts';

/**
 * Everything the brain is allowed to know, in one fixed shape.
 *
 * The same fields are present on every call, so «this week against last week» is a comparison the
 * model can actually make, and so a field that cannot be read is `null` rather than missing:
 * «unknown» and «zero» are different statements and the model is told so.
 *
 * Nothing here is computed by the model and nothing in it is a number the model may repeat as its
 * own: the snapshot is the evidence, not the output.
 */

const DAY = 86_400_000;

export interface WindowStats {
  days: number;
  posts: number;
  /** Posts that already have a reading. */
  measured: number;
  medianViews: number | null;
  /** comments / views * 1000, pooled. Null when there are no views to divide by. */
  commentsPer1k: number | null;
  likesPer1k: number | null;
}

export interface ColumnStats {
  kind: string;
  posts: number;
  /** Published, a day old and read at 24 hours — the same rows an experiment arm counts. */
  matured: number;
  /** Mutually exclusive exclusions, with post IDs for auditing. */
  maturityExcluded: { tooYoung: number[]; missing24h: number[] };
  /** Mature rows only; matched + missing + mismatched = matured. */
  registration: { matched: number[]; missing: number[]; mismatched: { postId: number; arm: string }[] };
  medianViews: number | null;
  commentsPer1k: number | null;
}

export interface BrainSnapshot {
  asOf: number;
  /** The goal as the brain should state it, so the prompt and the data cannot drift apart. */
  mission: { gates: { A: string; B: string; C: string }; target: string; targetMode: string };
  gates: GateReport;
  breaker: BreakerStatus;
  account: { w7: WindowStats; w14: WindowStats; w30: WindowStats; publishedTotal: number };
  columns: ColumnStats[];
  /** Chart arm vs no chart, on the posts that carry that arm. */
  chart: { chart: { n: number; medianViews: number | null }; text: { n: number; medianViews: number | null }; missingImage: number } | null;
  hypotheses: {
    id: string; mode: string; metric: string; metricDefinition: (typeof METRIC_DEFINITIONS)[keyof typeof METRIC_DEFINITIONS]; status: string; claim: string;
    arms: { arm: string; n: number; median: number | null }[]; missing: number; sampleShortfall: number; active: boolean;
    /** The same comparison inside (category × heat band) strata; `agree` of `strata` went the same way. */
    stratified: Verdict['stratified'];
  }[];
  paramChanges: { key: string; from: number; to: number; status: string; reason: string; rejectReason: string | null }[];
  knobs: { key: string; label: string; current: number | null; judgedBy: string }[];
  failures: { key: string; text: string; at: number }[];
  benchmark: { zh: BoardComposition; poolZh: number; poolOther: number };
  calls: CallStats;
  alerts: { code: string; detail: string; at: number }[];
  /** What the brain already filed as needing a code change, and what the operator did with it. */
  upgrades: ReturnType<typeof upgradesForSnapshot>;
  /** How much the coin's heat and the account move views on their own — the size of the confound. */
  heat: ReturnType<typeof heatProfile>;
  /** What each count above counts, so two numbers that differ by design are not read as a contradiction. */
  definitions: string[];
  /** Plain statements about what the brain is NOT being shown, so it does not infer from absence. */
  unknowns: string[];
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

interface Row {
  id: number;
  published_at: number;
  template_id: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  v24h: number | null;
  kind: string | null;
}

function postRows(store: Store, since: number): Row[] {
  return store.db
    .prepare(
      `SELECT p.id, p.published_at, p.template_id, s.views, s.likes, s.comments, d.v24h,
              (SELECT arm FROM post_arms a WHERE a.post_id = p.id AND a.experiment = 'h_column') AS kind
       FROM posts p
       LEFT JOIN post_stats s ON s.post_id = p.id
       LEFT JOIN post_distribution d ON d.post_id = p.id
       WHERE p.status = 'published' AND p.published_at >= ?
       ORDER BY p.published_at ASC`,
    )
    .all(since) as Row[];
}

const reading = (r: Row): number | null => r.v24h ?? r.views;
/** The verdicts' rule: a day old and read at 24 hours. Anything looser and two tables disagree. */
const matured = (r: Row, now: number): boolean => r.v24h != null && now - r.published_at >= MATURITY_FLOOR_MS;

function windowStats(rows: Row[], days: number, now: number): WindowStats {
  const inWin = rows.filter(r => r.published_at >= now - days * DAY);
  const measured = inWin.filter(r => reading(r) != null);
  const views = measured.reduce((s, r) => s + (reading(r) ?? 0), 0);
  const sum = (f: (r: Row) => number | null): number => measured.reduce((s, r) => s + (f(r) ?? 0), 0);
  // A null comment counter is «not read», not «zero comments»: pooling it as zero is how two weeks
  // of missing data read as a comment rate of 0 and got filed as a finding of its own. The rate is
  // over the rows that actually carried a reading; no reading at all means null, not 0.
  const withComments = measured.filter(r => r.comments != null);
  const commentViews = withComments.reduce((s, r) => s + (reading(r) ?? 0), 0);
  return {
    days,
    posts: inWin.length,
    measured: measured.length,
    medianViews: median(measured.map(r => reading(r)!)),
    commentsPer1k: commentViews > 0
      ? Number(((withComments.reduce((s, r) => s + (r.comments ?? 0), 0) / commentViews) * 1000).toFixed(2))
      : null,
    likesPer1k: views > 0 ? Number(((sum(r => r.likes) / views) * 1000).toFixed(2)) : null,
  };
}

function columnStats(rows: Row[], now: number): ColumnStats[] {
  const by = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r.template_id?.startsWith('column.') ? r.template_id.slice('column.'.length) : null;
    if (!k) continue;
    (by.get(k) ?? by.set(k, []).get(k)!).push(r);
  }
  return [...by].map(([kind, list]) => {
    const m = list.filter(r => matured(r, now));
    const withComments = m.filter(r => r.comments != null);
    const commentViews = withComments.reduce((s, r) => s + (r.v24h ?? 0), 0);
    return {
      kind,
      posts: list.length,
      matured: m.length,
      maturityExcluded: {
        tooYoung: list.filter(r => now - r.published_at < MATURITY_FLOOR_MS).map(r => r.id),
        missing24h: list.filter(r => now - r.published_at >= MATURITY_FLOOR_MS && r.v24h == null).map(r => r.id),
      },
      registration: {
        matched: m.filter(r => r.kind === kind).map(r => r.id),
        missing: m.filter(r => r.kind == null).map(r => r.id),
        mismatched: m.filter(r => r.kind != null && r.kind !== kind).map(r => ({ postId: r.id, arm: r.kind! })),
      },
      medianViews: median(m.map(r => r.v24h!)),
      commentsPer1k: commentViews > 0
        ? Number(((withComments.reduce((s, r) => s + (r.comments ?? 0), 0) / commentViews) * 1000).toFixed(2))
        : null,
    };
  });
}

/**
 * What each count counts. The first weekly review found three pairs of numbers that disagreed —
 * column posts 7 vs arm rows 5, chart 20 vs 19, «53 with readings» vs 57 published — and every
 * pair was two definitions, not a bug. The tables that could share one rule now do (a day old, read
 * at 24 hours); the rest are said here so the model reads the difference as designed.
 */
const DEFINITIONS = [
  `hypotheses：近 30 天；${MEASUREMENT_SAMPLE} 每项的 metricDefinition 标明实际判定指标的名称、单位、公式与有效样本；互动分子为最新读数，未必与 24h 分母同龄。`,
  'account.wN.posts：窗口内发布的帖子数；measured：其中已读到浏览数的（含未满 24 小时的，用最新读数）；medianViews 也是这批。它是账号概况，不是关卡口径。',
  'gates.A / gates.B / gates.C 同一批帖子：发布满 24 小时且有 24h 读数的。B 的 windowPosts = maturePosts + immature；maturePosts = withComments + missingComments。posts = withComments（实际参与合并的条数）；views = commentViews（仅有评论读数帖子的 24h 浏览之和），commentsPer1k = comments / commentViews × 1000（保留两位小数，分母为 0 时 null）；missingCommentPostIds 可追查缺评论的成熟帖。immature 是窗口内没有 24h 读数而被排除的条数（未满 24 小时，或 24h 那次回抓错过了）。B 和 account.w14 对不上是口径不同，不是数据错。',
  'account.publishedTotal：有史以来全部已发布条数，不限窗口。',
  'columns[].posts：近 30 天该栏目发布条数；matured：其中满 24 小时且有 24h 读数的；medianViews、commentsPer1k 只算 matured。maturityExcluded 按帖子 ID 区分 tooYoung（未满一天）与 missing24h（已满一天但缺读数）；posts = matured + 两类排除数。registration 只在 matured 中核对 h_column：matched / missing / mismatched 分别是登记一致、未登记、登记与模板不一致的帖子 ID，三类数之和等于 matured。',
  'hypotheses[].arms[].n：近 30 天、满 24 小时、分到此臂且满足 metricDefinition.sample 的帖子数；median 是这些帖子的 metric 指标中位数。growth1h 使用早期检查点，不要求 24h 读数；其他指标需要 24h 浏览读数。',
  'hypotheses[].missing 与 sampleShortfall 相同：最小臂距离 minSamples 的样本缺口，不是未成熟数或未登记数；栏目登记缺失查 columns[].registration.missing。',
  'chart：与 h_chart 同口径（满 24 小时、有 24h 读数）。',
  'hypotheses[].stratified：在同一素材类别、同一成交额档（见 heat.bands）内比较；对栏目另控制字数带和北京时间时段；对观察维度控制栏目、字数带、时段中除自身外的维度（controls）。cells 保留所有层（包括只有一臂、不可比较的层），列出每臂 n、median、postIds；栏目未知的层不参与比较。strata 是两边都有数据的层数，agree 是领先那一臂在几层里排第一，detail 是每层各臂的样本数和中位数。没有成交额的素材退回用采集评分分档（档名以「评分」开头）。',
  'heat：各成交额档、各账号的 24h 浏览中位数，同上口径。档与档差得越多，不分层的比较越不可信；差得少，热度就不是主要干扰。',
  'calls 顶层 total / held / faded / flipped / open 是历史合计，混合新旧口径，不能据此评价当前成立率；按 byKind 分开看，currentKind 指向当前口径。funding_persists（旧）：隔天同一边付费且费率幅度至少保留一半才成立，否则为减弱或反转；payer_persists（新）：隔天仍是同一边付费即成立。分组依据每条记录的 kind，历史裁决不重算。',
  'calls.byKind 各组 total 只含已裁决的 held + faded + flipped；heldRate = held / total（0–1），无已裁决样本时为 null；open 待裁决、void 作废均不进分母。firstRegisteredAt / lastRegisteredAt 是该组登记时间范围（check_at 减 24 小时），不代表裁决日期或精确升级日期。calls_failing 告警只看 currentKind，至少 5 条裁决才判断。',
  'alerts 里的条数是哨兵触发当时的计数，可能比现在的少。',
];

export function buildSnapshot(store: Store, settings: Settings, now = Date.now()): BrainSnapshot {
  const target = currentTarget(store, settings, now);
  const verdicts: Verdict[] = scoreAll(store, { days: 30, writeMemory: false, target, now });
  const rows = postRows(store, now - 30 * DAY);
  const active = settings.activeExperiments;

  const armRows = store.db
    .prepare(
      `SELECT a.arm, d.v24h FROM post_arms a
       JOIN posts p ON p.id = a.post_id AND p.status = 'published'
       LEFT JOIN post_distribution d ON d.post_id = a.post_id
       WHERE a.experiment = 'h_chart' AND p.published_at >= ? AND p.published_at <= ?`,
    )
    .all(now - 30 * DAY, now - MATURITY_FLOOR_MS) as { arm: string; v24h: number | null }[];
  const chartOf = (arm: string) => {
    const xs = armRows.filter(r => r.arm === arm).map(r => r.v24h).filter((x): x is number => x != null);
    return { n: xs.length, medianViews: median(xs) };
  };
  const missingImage = (store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'image_missing' AND at >= ?").get(now - 30 * DAY) as { n: number }).n;

  const comp = boardComposition(store);
  const by = store.boardCountByLang();
  const gates = gateReport(store, now);
  const brk = evaluateBreaker(store, settings, now);
  const unknowns: string[] = [
    '粉丝数读不到（币安没有公开接口），关卡 C 用「二次分发」条数代替，它不是粉丝数。',
    '榜上的帖子是被分发之后才采到的，形态占比不能当成「这样写就会被分发」。',
  ];
  if (!gates.A.median7d) unknowns.push('最近 7 天没有满 24 小时的帖子，关卡 A 的中位数读不到。');
  if (!gates.B.posts) unknowns.push(`最近 ${GATE_LINES.commentWindowDays} 天没有满 24 小时且读到评论数的帖子，关卡 B 的评论率读不到（不是 0）。`);
  if (comp.n < 50) unknowns.push(`中文榜样本只有 ${comp.n} 条，形态占比不稳。`);
  if (!by.zh) unknowns.push('库里还没有中文榜样本。');

  return {
    asOf: now,
    mission: {
      gates: {
        A: `连续 ${GATE_LINES.daysInARow} 天，每天 ≥ ${GATE_LINES.minPostsPerDay} 条满 24 小时的帖子且浏览中位数 ≥ ${GATE_LINES.viewsMedian}`,
        B: `近 ${GATE_LINES.commentWindowDays} 天满 24 小时的帖子（与 A 同一批）合并评论率 ≥ ${GATE_LINES.commentsPer1k} 条 / 千次 24h 浏览`,
        C: `累计 ≥ ${GATE_LINES.secondRoundNeeded} 条帖子 24 小时浏览 ≥ ${GATE_LINES.secondRoundRatio} 倍的 3 小时浏览且 ≥ ${GATE_LINES.secondRoundMinViews}`,
      },
      target,
      targetMode: settings.targetMode,
    },
    gates,
    breaker: brk,
    account: {
      w7: windowStats(rows, 7, now),
      w14: windowStats(rows, 14, now),
      w30: windowStats(rows, 30, now),
      publishedTotal: (store.db.prepare("SELECT COUNT(*) AS n FROM posts WHERE status = 'published'").get() as { n: number }).n,
    },
    columns: columnStats(rows, now),
    chart: armRows.length ? { chart: chartOf('chart'), text: chartOf('text'), missingImage } : null,
    hypotheses: verdicts.map(v => ({
      id: v.id, mode: v.mode, metric: v.metric, status: v.status, claim: v.claim,
      metricDefinition: METRIC_DEFINITIONS[v.metric],
      arms: v.arms.map(a => ({ arm: a.arm, n: a.n, median: a.median == null ? null : Number(a.median.toFixed(2)) })),
      missing: v.missing, sampleShortfall: v.missing,
      active: v.mode !== 'experiment' ? false : active == null || active.includes(v.id),
      stratified: v.stratified,
    })),
    paramChanges: changeLedger(store, 5).map(c => ({
      key: c.key, from: c.from_value, to: c.to_value, status: c.status, reason: c.reason, rejectReason: c.reject_reason,
    })),
    knobs: liveKnobs(settingsFrom(store)).map(k => ({ key: k.key, label: k.label, current: currentKnob(store, k.key), judgedBy: k.judge })),
    failures: (store.db
      .prepare("SELECT key, text, created_at FROM brain_memory WHERE status = 'active' AND (key LIKE 'param:%' OR key LIKE 'rank:stalled:%' OR key LIKE 'brain:rejected:%') ORDER BY created_at DESC LIMIT 12")
      .all() as { key: string; text: string; created_at: number }[]).map(f => ({ key: f.key, text: f.text, at: f.created_at })),
    benchmark: { zh: comp, poolZh: by.zh, poolOther: by.other },
    calls: callStats(store),
    alerts: (store.db.prepare('SELECT at, code, detail FROM brain_alarms WHERE at >= ? ORDER BY at DESC LIMIT 12').all(now - 7 * DAY) as { at: number; code: string; detail: string }[]),
    upgrades: upgradesForSnapshot(store, now),
    heat: heatProfile(store, { now }),
    definitions: DEFINITIONS,
    unknowns,
  };
}

/** Model input is a bounded summary; the full audit snapshot stays in reports and the panel. */
export function snapshotForModel(s: BrainSnapshot, purpose: 'sentinel' | 'weekly' | 'review' = 'weekly') {
  const detailLimit = purpose === 'sentinel' ? 0 : 6;
  const idsLimit = 5;
  return {
    ...s,
    gates: { ...s.gates, B: { ...s.gates.B, missingCommentPostIds: s.gates.B.missingCommentPostIds?.slice(0, idsLimit) } },
    columns: s.columns.map(c => ({
      ...c,
      maturityExcluded: { tooYoung: c.maturityExcluded?.tooYoung.slice(0, idsLimit), missing24h: c.maturityExcluded?.missing24h.slice(0, idsLimit) },
      registration: { matched: c.registration?.matched.slice(0, idsLimit), missing: c.registration?.missing.slice(0, idsLimit), mismatched: c.registration?.mismatched.slice(0, idsLimit) },
      auditCounts: { tooYoung: (c.maturityExcluded?.tooYoung.length ?? null), missing24h: (c.maturityExcluded?.missing24h.length ?? null),
        matched: (c.registration?.matched.length ?? null), missing: (c.registration?.missing.length ?? null), mismatched: (c.registration?.mismatched.length ?? null) },
    })),
    hypotheses: s.hypotheses.map(h => {
      const { cells, detail, ...summary } = h.stratified;
      return { ...h, stratified: { ...summary, detail: detail?.slice(0, detailLimit),
        auditCounts: { cells: cells?.length ?? null, comparable: cells?.filter(c => c.comparable).length ?? null, detail: detail?.length ?? null } } };
    }),
    contextCoverage: {
      purpose, fullAuditRetained: true,
      note: '这是模型摘要：未发送交叉层 cells 及其逐帖 postIds；分层总体统计完整保留。detail 仅保留原顺序前几层，不能据此替代完整分层统计或推断被省略层。栏目及缺评论的 ID 数组仅为示例，长度不代表总数；用 auditCounts 或原有计数字段。完整明细留在面板和报告。',
      detailLimit, idExamplesLimit: idsLimit, missingCommentPosts: s.gates.B.missingCommentPostIds?.length ?? null,
    },
  };
}

export function snapshotText(s: BrainSnapshot, purpose: 'sentinel' | 'weekly' | 'review' = 'weekly'): string {
  return JSON.stringify(snapshotForModel(s, purpose), (_k, v) => (v === undefined ? null : v));
}

export { breaker };
