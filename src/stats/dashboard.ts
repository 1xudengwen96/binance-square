import { Store, type PerformanceRow } from '../db/index.ts';
import { STYLE_LABELS } from '../config.ts';
import { beijingDayStart, nextSlotFor, nominalIntervalMinutes, settingsFrom } from '../schedule.ts';
import { signalLabel } from './insight.ts';
import { nextArticleSlot } from '../studio/runner.ts';
import { trackById } from '../studio/tracks.ts';

const BJ = 8 * 3600_000;

type Row = PerformanceRow & { kind: 'post' | 'article' };

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const engagementOf = (r: PerformanceRow): number => (r.likes ?? 0) + (r.comments ?? 0) + (r.shares ?? 0);
const dayKey = (ms: number): string => new Date(ms + BJ).toISOString().slice(0, 10);
const hourOf = (ms: number): number => new Date(ms + BJ).getUTCHours();
const stamp = (ms: number): string => new Date(ms + BJ).toISOString().slice(0, 16).replace('T', ' ');

export interface DayPoint {
  day: string;
  posts: number;
  articles: number;
  views: number;
  engagement: number;
}

export interface HourPoint {
  hour: number;
  count: number;
  medianViews: number | null;
}

export interface AccountPoint {
  id: number;
  label: string;
  enabled: number;
  /** What this account is for, in one line — the fact the operator otherwise has to remember. */
  role: string;
  trackId: string | null;
  posts: number;
  articles: number;
  measured: number;
  views: number;
  medianViews: number | null;
  engagement: number;
  engagementPer1k: number;
  subscribers: number;
  pending: number;
  today: number;
  cap: number;
  capUnit: '篇长文' | '帖';
  nextAt: number | null;
  nextReason: string;
}

export interface Cadence {
  intendedMinutes: number;
  actualMedianMinutes: number | null;
  bursts: number;
  longestIdleHours: number | null;
  idleWindow: { from: string; to: string } | null;
  histogram: { label: string; count: number }[];
  /** Every publish, in order, for the timeline strip. */
  events: {
    at: number;
    accountLabel: string;
    kind: 'post' | 'article';
    views: number | null;
    cell: string;
    symbol: string | null;
    engagement: number;
  }[];
}

export interface CellPoint {
  key: string;
  /** Chinese display label — the raw `category/sub_type` slug means nothing to the operator. */
  label: string;
  count: number;
  measured: number;
  medianViews: number | null;
  meanViews: number | null;
  bestViews: number | null;
  views: number;
  engagement: number;
}

export interface Dashboard {
  days: number;
  since: number;
  totals: { posts: number; articles: number; measured: number; views: number; engagement: number; medianViews: number | null };
  series: DayPoint[];
  hours: HourPoint[];
  accounts: AccountPoint[];
  cadence: Cadence;
  cells: CellPoint[];
  styles: CellPoint[];
  /** Approved work with no account: queued in name only, since no publisher reads it. */
  orphanPending: number;
}

const BANDS: { label: string; min: number; max: number }[] = [
  { label: '同一分钟', min: 0, max: 1 },
  { label: '1–15 分', min: 1, max: 15 },
  { label: '15–45 分', min: 15, max: 45 },
  { label: '45–120 分', min: 45, max: 120 },
  { label: '2–6 小时', min: 120, max: 360 },
  { label: '6 小时以上', min: 360, max: Number.POSITIVE_INFINITY },
];

function rollup(rows: Row[], key: (r: Row) => string | null, label: (r: Row, k: string) => string): CellPoint[] {
  const groups = new Map<string, { label: string; rows: Row[] }>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const bucket = groups.get(k);
    if (bucket) bucket.rows.push(r);
    else groups.set(k, { label: label(r, k), rows: [r] });
  }
  return [...groups.entries()]
    .map(([k, g]) => {
      const vs = g.rows.map(r => r.views).filter((v): v is number => v != null);
      return {
        key: k,
        label: g.label,
        count: g.rows.length,
        measured: vs.length,
        medianViews: median(vs),
        meanViews: vs.length ? Math.round(sum(vs) / vs.length) : null,
        bestViews: vs.length ? Math.max(...vs) : null,
        views: sum(vs),
        engagement: sum(g.rows.map(engagementOf)),
      };
    })
    .sort((a, b) => (b.medianViews ?? -1) - (a.medianViews ?? -1));
}

/**
 * The operational board: what went out, when, on which account, and what it earned.
 *
 * `analyze` answers "which kind of copy performs", a content question that needs a sample.
 * This answers "is the machine posting the way it is configured to", which needs none, and is
 * the question that caught the same-minute burst and the seven-hour silence. Both read the
 * committed rows rather than the settings, because the gap between the two is where the
 * failures live.
 */
export function dashboard(store: Store, opts: { days?: number } = {}): Dashboard {
  const days = Math.max(1, Math.min(90, opts.days ?? 14));
  const since = beijingDayStart(Date.now() - (days - 1) * 86_400_000);
  const settings = settingsFrom(store);

  const postRows: Row[] = store.performanceRows(days).filter(r => (r.published_at ?? 0) >= since).map(r => ({ ...r, kind: 'post' }));
  const articleRows: Row[] = store.articleRows(days).filter(r => (r.published_at ?? 0) >= since).map(r => ({ ...r, kind: 'article' }));
  const all = [...postRows, ...articleRows].sort((a, b) => (a.published_at ?? 0) - (b.published_at ?? 0));

  const measuredViews = all.map(r => r.views).filter((v): v is number => v != null);
  const totals = {
    posts: postRows.length,
    articles: articleRows.length,
    measured: measuredViews.length,
    views: sum(measuredViews),
    engagement: sum(all.map(engagementOf)),
    medianViews: median(measuredViews),
  };

  const byDay = new Map<string, DayPoint>();
  for (let d = 0; d < days; d++) {
    const key = dayKey(since + d * 86_400_000);
    byDay.set(key, { day: key, posts: 0, articles: 0, views: 0, engagement: 0 });
  }
  for (const r of all) {
    const p = byDay.get(dayKey(r.published_at ?? 0));
    if (!p) continue;
    if (r.kind === 'article') p.articles++;
    else p.posts++;
    p.views += r.views ?? 0;
    p.engagement += engagementOf(r);
  }

  const hours: HourPoint[] = [];
  for (let h = 0; h < 24; h++) {
    const rs = all.filter(r => hourOf(r.published_at ?? 0) === h);
    hours.push({ hour: h, count: rs.length, medianViews: median(rs.map(r => r.views).filter((v): v is number => v != null)) });
  }

  const gaps: number[] = [];
  let longestIdle = 0;
  let idleFrom = 0;
  for (let i = 1; i < all.length; i++) {
    const delta = (all[i]!.published_at ?? 0) - (all[i - 1]!.published_at ?? 0);
    if (delta >= 0) gaps.push(delta / 60_000);
    if (delta > longestIdle) {
      longestIdle = delta;
      idleFrom = all[i - 1]!.published_at ?? 0;
    }
  }

  const cadence: Cadence = {
    intendedMinutes: nominalIntervalMinutes(settings),
    actualMedianMinutes: median(gaps),
    bursts: gaps.filter(g => g < 1).length,
    longestIdleHours: all.length > 1 ? Number((longestIdle / 3600_000).toFixed(1)) : null,
    idleWindow: all.length > 1 && longestIdle > 3 * 3600_000 ? { from: stamp(idleFrom), to: stamp(idleFrom + longestIdle) } : null,
    histogram: BANDS.map(b => ({ label: b.label, count: gaps.filter(g => g >= b.min && g < b.max).length })),
    events: all.map(r => ({
      at: r.published_at ?? 0,
      accountLabel: r.account_label ?? '未归属账号',
      kind: r.kind,
      views: r.views,
      /** What it was about, already in Chinese — the timeline tooltip has to say something readable. */
      cell: r.kind === 'post' ? signalLabel(r.category, r.sub_type) : `长文 · ${r.template_name ?? ''}`,
      symbol: r.symbol,
      engagement: engagementOf(r),
    })),
  };

  const bindings = store.studioAccounts();
  const accounts: AccountPoint[] = store.allAccounts().map(a => {
    const mine = all.filter(r => r.account_id === a.id);
    const mv = mine.map(r => r.views).filter((v): v is number => v != null);
    const binding = bindings.find(b => b.account_id === a.id);
    const track = binding ? trackById(binding.track_id) : undefined;
    const views = sum(mv);
    const eng = sum(mine.map(engagementOf));
    // A studio account's next *short-post* slot is not its next post. Reporting the matrix
    // clock for an account that left the matrix is how a board starts being ignored.
    const slot = track
      ? { allowed: true, at: nextArticleSlot(store, a.id, track), reason: `长文 · 每 ${track.cadence.minGapHours} 小时最多一篇` }
      : nextSlotFor(store, settings, a);
    return {
      id: a.id,
      label: a.label,
      enabled: a.enabled,
      role: binding ? `长文 · ${track?.label ?? binding.track_id}` : a.enabled ? '短帖矩阵' : '已停用',
      trackId: binding?.track_id ?? null,
      posts: mine.filter(r => r.kind === 'post').length,
      articles: mine.filter(r => r.kind === 'article').length,
      measured: mv.length,
      views,
      medianViews: median(mv),
      engagement: eng,
      engagementPer1k: views > 0 ? Number(((eng / views) * 1000).toFixed(1)) : 0,
      subscribers: sum(mine.map(r => r.subscribers ?? 0)),
      pending: store.pendingQueueCount(a.id),
      today: store.accountPostsToday(a.id, beijingDayStart()),
      // A studio account is measured in articles; a matrix account in posts. One number with
      // two units is how a quota looks satisfied while it is not.
      cap: track && binding ? (binding.articles_per_day ?? track.cadence.articlesPerDay) : (a.posts_per_day ?? settings.postsPerDay),
      capUnit: track ? '篇长文' : '帖',
      nextAt: slot.allowed ? slot.at : null,
      nextReason: slot.reason,
    };
  });

  const orphanPending = (
    store.db
      .prepare("SELECT COUNT(*) AS n FROM posts WHERE status IN ('draft','approved') AND account_id IS NULL")
      .get() as { n: number }
  ).n;

  return {
    days,
    since,
    totals,
    series: [...byDay.values()],
    hours,
    accounts,
    cadence,
    cells: rollup(postRows, r => (r.sub_type ? `${r.category}/${r.sub_type}` : r.category), r => signalLabel(r.category, r.sub_type)),
    styles: rollup(postRows, r => r.style, r => STYLE_LABELS[r.style ?? ''] ?? r.style ?? '未标注'),
    orphanPending,
  };
}
