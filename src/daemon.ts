import 'dotenv/config';
import { Store, type AccountRow } from './db/index.ts';
import { collect, generate, generateForMatrix, generateFromPool, publishDue, pauseState } from './pipeline.ts';
import { settingsFrom } from './schedule.ts';
import { backfillStats, tuneTemplateWeights } from './stats/backfill.ts';
import { sampleSquareBoards } from './stats/benchmarks.ts';
import { retire } from './lifecycle.ts';
import { matrixEligibleAccounts } from './studio/lock.ts';
import { runStudio } from './studio/runner.ts';
import { getSecret } from './secrets.ts';

/**
 * The unattended loop. One tick = collect → expire stale material → split the hot coins
 * between the enabled accounts → draft → (optionally) publish → harvest stats. Publishing
 * live still requires both a key and autoPublish, so a stray `daemon` start cannot put
 * content on an account.
 */

export interface TickResult {
  at: number;
  skipped?: string;
  collected: number;
  poolCreated: number;
  eventCreated: number;
  published: number;
  uncertain: number;
  failed: number;
  statsUpdated: number;
  benchmarked: number;
  studioDrafted: number;
  studioPublished: number;
  tuned: number;
  expired: number;
  accountsRun: number;
  notes: string[];
}

export async function tick(store: Store, opts: { live?: boolean; statsEveryTicks?: number; benchEveryTicks?: number; tickNo?: number } = {}): Promise<TickResult> {
  const settings = settingsFrom(store);
  const res: TickResult = {
    at: Date.now(), collected: 0, poolCreated: 0, eventCreated: 0, published: 0, uncertain: 0,
    failed: 0, statsUpdated: 0, benchmarked: 0, studioDrafted: 0, studioPublished: 0, tuned: 0, expired: 0, accountsRun: 0, notes: [],
  };

  const pause = pauseState(store);
  if (pause.paused) {
    res.skipped = `已暂停：${pause.reason ?? ''}（在设置里把 paused 清掉才会继续）`;
    return res;
  }

  try {
    const c = await collect(store, settings);
    res.collected = c.inserted;
    if (c.errors.length) res.notes.push(`采集 ${c.errors.length} 个源失败`);
  } catch (err) {
    res.notes.push(`collect 失败：${String(err).slice(0, 100)}`);
  }

  // Expire before drafting, or a stale ratio gets dressed up as news.
  try {
    res.expired = retire(store, settings).discarded;
  } catch (err) {
    res.notes.push(`retire 失败：${String(err).slice(0, 100)}`);
  }

  // The comparison pool refreshes on a slower clock than our own counters: board membership
  // moves over hours, and re-reading the same 120 posts every 15 minutes buys no information
  // while costing 6 requests each time.
  const benchEvery = opts.benchEveryTicks ?? 4;
  if ((opts.tickNo ?? 1) % benchEvery === 0) {
    try {
      const bm = await sampleSquareBoards(store);
      res.benchmarked = bm.stored;
      if (bm.errors.length) res.notes.push(`基准采样 ${bm.errors.length} 个页面失败`);
      if (bm.oursOnBoard) res.notes.push(`本轮有 ${bm.oursOnBoard} 条自己的帖子上了公开榜`);
    } catch (err) {
      res.notes.push(`基准采样失败：${String(err).slice(0, 100)}`);
    }
  }

  try {
    const accounts = matrixEligibleAccounts(store);
    // Without a publisher there is no point generating. Drafts with no account can only be
    // posted by the env-key fallback, so when neither exists every tick would pile more
    // auto-approved rows into a bucket nothing can drain — which is exactly what the
    // "every draft must belong to an account" rule below is there to prevent.
    const canPublish = accounts.length > 0 || Boolean(process.env.SQUARE_API_KEY);
    if (!canPublish) {
      res.notes.push('短帖已停摆：唯一可用账号被工作室占用，且 .env 未配 SQUARE_API_KEY，再生成也发不出去');
    } else {
    if (accounts.length) {
      const m = await generateForMatrix(store, settings);
      res.accountsRun = m.accounts.length;
      res.poolCreated = m.accounts.reduce((s, a) => s + a.created, 0);
      for (const a of m.accounts.filter(x => !x.created)) res.notes.push(`${a.label}：${a.skipped[0] ?? '未产出'}`);
      if (m.errors.length) res.notes.push(`矩阵 ${m.errors.length} 个错误`);
    } else {
      const g = await generateFromPool(store, settings, { count: 2 });
      res.poolCreated = g.created.length;
      if (g.errors.length) res.notes.push(`热度池 ${g.errors.length} 个错误`);
      if (g.matureCount === 0) res.notes.push(`热度池无成熟标的（${g.skipped.length} 个被挡）`);
    }
    // Fill remaining slots from event materials so a quiet market still posts. Every
    // draft must belong to an account, or no account can ever publish it.
    const want = Math.max(0, Math.ceil(settings.postsPerDay / 4) - res.poolCreated);
    if (want > 0) {
      const owners = matrixEligibleAccounts(store);
      const shares = new Map<number, number>();
      for (let i = 0; i < want; i++) {
        const key = owners.length ? (owners[i % owners.length]?.id ?? 0) : 0;
        shares.set(key, (shares.get(key) ?? 0) + 1);
      }
      for (const [accountId, n] of shares) {
        const a = owners.find(x => x.id === accountId);
        const g = await generate(store, settings, n, { account: a });
        res.eventCreated += g.created.length;
        for (const s of g.skipped) res.notes.push(`${a?.label ?? '单号'}: ${s}`);
      }
    }
    }
  } catch (err) {
    res.notes.push(`generate 失败：${String(err).slice(0, 100)}`);
  }

  if (opts.live && settings.autoPublish) {
    // Each account publishes only its own approved posts, with its own key and egress.
    const accounts = matrixEligibleAccounts(store);
    const targets: { account?: AccountRow }[] = accounts.length ? accounts.map(a => ({ account: a })) : [{}];
    for (const t of targets) {
      try {
        const p = await publishDue(store, settings, { live: true, ...t });
        res.published += p.published.length;
        res.uncertain += p.uncertain.length;
        res.failed += p.failed.length;
        if (p.uncertain.length) res.notes.push(`${p.uncertain.length} 条状态未知，需人工到广场确认`);
        if (p.paused) res.notes.push(`${t.account?.label ?? '账号'}已自动暂停`);
      } catch (err) {
        res.notes.push(`publish 失败：${String(err).slice(0, 100)}`);
      }
    }
  }

  // The studio runs on the same tick but a different clock: articles are two a day, not
  // twenty, and each one costs a chart render plus an image upload. It is wrapped the same
  // way as every other stage because a broken article pipeline must never stop the feed.
  try {
    const st = await runStudio(store, settings, { live: opts.live ?? true });
    for (const a of st.accounts) {
      res.studioDrafted += a.drafted.length;
      res.studioPublished += a.published;
      for (const sk of a.skipped) res.notes.push(`${a.label}(工作室)：${sk}`);
    }
    if (st.lessonsRecorded) res.notes.push(`工作室记录 ${st.lessonsRecorded} 条被数据推翻的断言`);
    if (st.errors.length) res.notes.push(`工作室 ${st.errors.length} 个错误`);
  } catch (err) {
    res.notes.push(`工作室失败：${String(err).slice(0, 100)}`);
  }

  // Every tick, not every 6th. nextCheckDue already makes a non-due post cost zero
  // requests, and a 90-minute stats cadence is coarser than the first three checkpoints
  // (20m / 1h / 3h) — which are the only ones that show whether a post is taking off.
  const every = opts.statsEveryTicks ?? 1;
  if ((opts.tickNo ?? 1) % every === 0) {
    try {
      const b = await backfillStats(store);
      res.statsUpdated = b.updated;
      const t = tuneTemplateWeights(store, {});
      res.tuned = t.adjusted.length;
      if (t.skipped) res.notes.push(`调权跳过：${t.skipped}`);
    } catch (err) {
      res.notes.push(`stats 失败：${String(err).slice(0, 100)}`);
    }
  }

  store.log('tick', res);
  return res;
}

export function line(r: TickResult): string {
  const t = new Date(r.at + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
  if (r.skipped) return `[${stamp}] 跳过 — ${r.skipped}`;
  return (
    `[${stamp}] 素材+${r.collected}${r.expired ? ` 过期${r.expired}` : ''} ` +
    `${r.accountsRun ? `${r.accountsRun}号` : '单号'}发帖${r.poolCreated}${r.eventCreated ? ` 事件${r.eventCreated}` : ''} ` +
    `发布${r.published}${r.uncertain ? ` 待确认${r.uncertain}` : ''}${r.failed ? ` 失败${r.failed}` : ''}` +
    `${r.statsUpdated ? ` 回抓${r.statsUpdated}` : ''}${r.tuned ? ` 调权${r.tuned}` : ''}` +
    `${r.studioDrafted || r.studioPublished ? ` 文章${r.studioPublished}稿${r.studioDrafted}` : ''}` +
    `${r.notes.length ? `  (${r.notes.join('; ')})` : ''}`
  );
}

export async function runLoop(intervalMinutes: number, live: boolean): Promise<never> {
  const store = Store.open(process.env.DB_PATH ?? './data/squareforge.db');
  const settings = settingsFrom(store);
  console.log(`\n  调度启动：每 ${intervalMinutes} 分钟一轮 · ${live && settings.autoPublish ? '真实发布' : '演练/人工审核'}\n`);
  let n = 0;
  for (;;) {
    n++;
    try {
      console.log(line(await tick(store, { live, tickNo: n })));
    } catch (err) {
      console.log(`[${new Date().toISOString()}] tick 异常：${String(err).slice(0, 200)}`);
    }
    await new Promise(r => setTimeout(r, intervalMinutes * 60_000));
  }
}
