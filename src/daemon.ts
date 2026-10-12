import 'dotenv/config';
import { Store, type AccountRow } from './db/index.ts';
import { collect, generate, generateForMatrix, generateFromPool, publishDue, pauseState } from './pipeline.ts';
import { generateColumn } from './column.ts';
import { settingsFrom } from './schedule.ts';
import { backfillStats, tuneTemplateWeights } from './stats/backfill.ts';
import { observeDistribution } from './rank/observations.ts';
import { revokeStaleRules, scoreAll } from './rank/score.ts';
import { retireStalled } from './rank/registry.ts';
import { applyPendingChanges, evaluateChanges } from './rank/params.ts';
import { expireMemories } from './brain/memory.ts';
import { reflect } from './brain/author.ts';
import { brainFor } from './brain/brain.ts';
import { attributeConversions } from './money/conversion.ts';
import { sampleSquareBoards } from './stats/benchmarks.ts';
import { retire } from './lifecycle.ts';
import { matrixEligibleAccounts } from './studio/lock.ts';
import { runStudio } from './studio/runner.ts';
import { getSecret } from './secrets.ts';
import { backupDatabase } from './backup.ts';
import { currentTarget, evaluateBreaker } from './rank/gates.ts';
import { judgeCalls } from './calls.ts';
import { runSentinel } from './brain/sentinel.ts';
import { runWeekly } from './brain/weekly.ts';

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
  /// Posts waiting for their minute — waiting, not broken.
  deferred: number;
  statsUpdated: number;
  benchmarked: number;
  studioDrafted: number;
  studioPublished: number;
  tuned: number;
  /** Posts whose distribution shape was recomputed from the checkpoint curve. */
  observed: number;
  /** Hypotheses that have earned a rule, and how many are still gathering samples. */
  rules: number;
  /// Posts carrying apportioned rebate credit this tick.
  conversionAttributed: number;
  testing: number;
  expired: number;
  /** Verdicts the daily reflection acted on — rules and flat results carried into the ledger. */
  reflected: number;
  /** Parameter changes the system was allowed to make to itself and start verifying this tick. */
  paramsApplied: number;
  accountsRun: number;
  notes: string[];
}

export async function tick(store: Store, opts: { live?: boolean; statsEveryTicks?: number; benchEveryTicks?: number; tickNo?: number } = {}): Promise<TickResult> {
  const settings = settingsFrom(store);
  const res: TickResult = {
    at: Date.now(), collected: 0, poolCreated: 0, eventCreated: 0, published: 0, uncertain: 0, deferred: 0,
    failed: 0, statsUpdated: 0, benchmarked: 0, studioDrafted: 0, studioPublished: 0, tuned: 0, observed: 0, rules: 0, testing: 0, conversionAttributed: 0, expired: 0, reflected: 0, paramsApplied: 0, accountsRun: 0, notes: [],
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
    if (settings.columnMode && accounts.length) {
      // The column replaces the mixed lane outright: a fixed heading sharing a feed with the
      // thirty-odd generic data posts is not a column. Quiet markets simply produce nothing.
      for (const a of accounts) {
        const c = await generateColumn(store, settings, a);
        res.poolCreated += c.created.length;
        for (const n of c.skipped) res.notes.push(`${a.label}：${n}`);
      }
    } else if (!canPublish) {
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

  // The breaker only stops *automatic* publishing: an operator pressing 发布 by hand is a person
  // deciding, which is exactly what a tripped breaker asks for.
  const breakerNow = evaluateBreaker(store, settings);
  if (breakerNow.tripped && opts.live && settings.autoPublish) {
    res.notes.push(`熔断：最近 ${breakerNow.window} 条浏览中位数 ${Math.round(breakerNow.median ?? 0)} < ${breakerNow.floor}，已停止自动发布，需要在 AI 大脑页手动恢复`);
  }
  if (opts.live && settings.autoPublish && !breakerNow.tripped) {
    // Each account publishes only its own approved posts, with its own key and egress.
    const accounts = matrixEligibleAccounts(store);
    const targets: { account?: AccountRow }[] = accounts.length ? accounts.map(a => ({ account: a })) : [{}];
    for (const t of targets) {
      try {
        const p = await publishDue(store, settings, { live: true, ...t });
        res.published += p.published.length;
        res.uncertain += p.uncertain.length;
        // A post waiting for its minute is not a failed post. Folding the two together made a
        // healthy queue look like an outage — the line read 「失败1」 on a day nothing failed.
        const deferred = p.failed.filter(f => /未到发布时刻/.test(f.label)).length;
        res.deferred += deferred;
        res.failed += p.failed.length - deferred;
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
      // Template weights read all-time averages that move by a post or two a day; re-deciding them
      // every 15 minutes only re-applies the same verdict. Daily is the cadence the evidence has.
      const lastTune = store.getSetting<number>('lastTuneAt', 0);
      if (Date.now() - lastTune >= 20 * 3600_000) {
        const t = tuneTemplateWeights(store, {});
        store.setSetting('lastTuneAt', Date.now());
        res.tuned = t.adjusted.length;
        if (t.skipped) res.notes.push(`调权跳过：${t.skipped}`);
      }
      // The curve only becomes knowledge if someone reads it: distribution facts, then the
      // hypotheses scored against them, then whatever earned the right to be called a rule.
      res.observed = observeDistribution(store);
      // Re-apportion any newly entered conversion figures before scoring, so a number typed in
      // this morning is reflected in this afternoon's verdicts.
      const conv = attributeConversions(store, {});
      if (conv.posts) res.conversionAttributed = conv.posts;
      const verdicts = scoreAll(store, { writeMemory: true, target: currentTarget(store, settings) });
      res.rules = verdicts.filter(v => v.status === 'rule').length;
      res.testing = verdicts.filter(v => v.status === 'observing').length;
      // Learning has two directions. Writing what earned belief is the easy half; retiring what
      // the latest measurement no longer supports is the half that stops the ledger filling with
      // folklore about a comparison that has since stopped holding.
      const revoked = revokeStaleRules(store, verdicts);
      if (revoked.length) res.notes.push(`撤销了 ${revoked.length} 条不再被测量支持的规则：${revoked.join('、')}`);
      // The registry and the parameter loop are the two places the system is allowed to change
      // itself. Both are run here so the daily cadence is the same as the measurement cadence:
      // cull what cannot be sampled, settle what is past its evaluation window, then apply what
      // has been waiting — in that order, so a rolled-back change never competes with its own
      // successor inside one tick.
      const culled = retireStalled(store, verdicts);
      if (culled.length) res.notes.push(`退休了 ${culled.length} 条攒不到样本的假设：${culled.join('、')}`);
      // While the breaker is tripped the account is not publishing, so a parameter window would be
      // measuring nothing. Both steps wait; the reset shifts the open windows by the time frozen.
      const frozen = evaluateBreaker(store, settings).tripped;
      const decided = frozen ? { improved: [], rolledBack: [], deferred: [] } : evaluateChanges(store);
      if (frozen) res.notes.push('熔断中：参数回路已冻结');
      if (decided.improved.length) res.notes.push(`参数改动见效，保留：${decided.improved.join('、')}`);
      if (decided.rolledBack.length) res.notes.push(`参数改动没有改善，已自动回滚：${decided.rolledBack.join('、')}`);
      if (decided.deferred.length) res.notes.push(`参数改动样本还不够，继续观察：${decided.deferred.join('、')}`);
      const applied = frozen ? [] : applyPendingChanges(store);
      res.paramsApplied = applied.length;
      if (applied.length) res.notes.push(`开始验证参数：${applied.map(a => `${a.label} ${a.from}→${a.to}`).join('，')}`);
      const exp = expireMemories(store);
      if (exp) res.notes.push(`长期记忆里 ${exp} 条已过期的判断被撤下`);
    } catch (err) {
      res.notes.push(`stats 失败：${String(err).slice(0, 100)}`);
    }
  }

  // Reflection is the step that turns measurement into "what to try next", and it is the only
  // part of the loop that can spend money on a model call — so it runs on a daily gate rather
  // than every tick. The evidence it reads (24h and 72h checkpoints) does not move minute to
  // minute. With no brain configured it still runs: that path is deterministic and free, and it
  // is what keeps the ledger honest when the operator has not wired a model up.
  try {
    const REFLECT_EVERY_MS = 20 * 3600_000;
    const lastReflect = store.getSetting<number>('lastReflectAt', 0);
    // brainDaily switches the *model* off; the deterministic half of reflect() still runs.
    if (Date.now() - lastReflect >= REFLECT_EVERY_MS) {
      const r = await reflect(store, settings.brainDaily ? brainFor(store, settings) : null, { target: currentTarget(store, settings) });
      store.setSetting('lastReflectAt', Date.now());
      res.reflected = r.stored.length;
      for (const n of r.notes) res.notes.push(n);
      store.log('rank_reflect', { stored: r.stored, notes: r.notes, by: 'daemon' });
    }
  } catch (err) {
    res.notes.push(`反思失败：${String(err).slice(0, 100)}`);
  }

  // The call ledger: code rules on the statements the column made a day ago. Cheap (one request)
  // and a no-op when nothing is due.
  try {
    const j = await judgeCalls(store);
    if (j.judged || j.voided) res.notes.push(`栏目判断裁决 ${j.judged} 条（成立 ${j.held}），作废 ${j.voided} 条`);
  } catch (err) {
    res.notes.push(`裁决失败：${String(err).slice(0, 100)}`);
  }

  // The sentinel is arithmetic every tick; the model only hears about it when an alarm is new and
  // the daily wake cap allows.
  try {
    const sn = await runSentinel(store, settings);
    for (const a of sn.raised) res.notes.push(`警报 ${a.code}：${a.detail.slice(0, 60)}`);
    if (sn.raised.length && sn.skippedWhy) res.notes.push(`未唤醒大脑：${sn.skippedWhy}`);
  } catch (err) {
    res.notes.push(`哨兵失败：${String(err).slice(0, 100)}`);
  }

  // Sunday 22:00 Beijing or later, once. runWeekly refuses a second report inside the week.
  try {
    // A two-hour window meant one network blip skipped the whole week (it did, on the first run).
    // Now: from Sunday 22:00 through Tuesday, retried at most every 2 hours until one lands.
    const bj = new Date(Date.now() + 8 * 3600_000);
    const day = bj.getUTCDay();
    const inWindow = (day === 0 && bj.getUTCHours() >= 22) || day === 1 || day === 2;
    const lastTry = store.getSetting<number>('lastWeeklyTryAt', 0);
    if (inWindow && Date.now() - lastTry >= 2 * 3600_000) {
      store.setSetting('lastWeeklyTryAt', Date.now());
      const w = await runWeekly(store, settings);
      if (w.ok) res.notes.push(`周复盘已生成（#${w.reportId}），等你在 AI 大脑页审阅`);
    }
  } catch (err) {
    res.notes.push(`周复盘失败：${String(err).slice(0, 100)}`);
  }

  // Once a day, on the first tick that finds it due. Everything the robot has learned lives in
  // one SQLite file, and the last time this mattered the audit had already shipped four posts.
  try {
    const b = backupDatabase(store);
    if (b.made) res.notes.push(`已备份数据库${b.removed ? `，清掉 ${b.removed} 份旧的` : ''}`);
  } catch (err) {
    res.notes.push(`备份失败：${String(err).slice(0, 100)}`);
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
    `发布${r.published}${r.uncertain ? ` 待确认${r.uncertain}` : ''}${r.deferred ? ` 顺延${r.deferred}` : ''}${r.failed ? ` 失败${r.failed}` : ''}` +
    `${r.statsUpdated ? ` 回抓${r.statsUpdated}` : ''}${r.tuned ? ` 调权${r.tuned}` : ''}` +
    `${r.studioDrafted || r.studioPublished ? ` 文章${r.studioPublished}稿${r.studioDrafted}` : ''}` +
    `${r.observed ? ` 分发${r.observed}条${r.rules ? ` 规则${r.rules}` : ''}` : ''}` +
    `${r.reflected ? ` 反思${r.reflected}` : ''}` +
    `${r.paramsApplied ? ` 调参${r.paramsApplied}` : ''}` +
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
