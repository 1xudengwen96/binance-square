import { Store, type AccountRow } from './db/index.ts';
import { templates as builtinTemplates } from './content/templates.ts';
import { wordBank } from './content/wordbank.ts';
import { compose, eligibleTemplates } from './engine/compose.ts';
import { isStructuralDuplicate } from './engine/guard.ts';
import { hashString } from './engine/prng.ts';
import { detectFundingExtremes, detectLeaderboards, detectLongShortSkew, detectMaCrosses, detectOpenInterestMoves, detectPriceMoves } from './collectors/detectors.ts';
import { fearAndGreed, stablecoinShifts } from './collectors/sentiment.ts';
import { trendingMaterials } from './collectors/hot.ts';
import { dexTrending } from './collectors/dex.ts';
import { announcements } from './collectors/announce.ts';
import { newsflashes } from './collectors/flash.ts';
import { hyperliquid } from './collectors/hyperliquid.ts';
import { nextSlot, nextSlotFor, settingsForAccount, settingsFrom } from './schedule.ts';
import { refreshPool, pool, dossier, type PoolEntry } from './hot/pool.ts';
import {
  CROSS_ACCOUNT_THRESHOLD, accountBlockedTemplates, accountStyles, allocate, collidesWithMatrix, materialAllowedForAccount, personaSeed,
} from './matrix.ts';
import { makeMaterial } from './material/types.ts';
import { enrichWithMarketContext } from './material/enrich.ts';
import { mergeSameStory } from './material/merge.ts';
import { buildChartFor } from './chart/forSymbol.ts';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { SquareClient, MAX_BODY_CHARS, type PublishOutcome } from './publisher/square.ts';
import { preFlight } from './engine/preflight.ts';
import { polish } from './llm/polish.ts';
import { getAccountSecret, getSecret } from './secrets.ts';
import type { LlmConfig } from './llm/providers.ts';
import type { Fact } from './engine/types.ts';
import type { Material } from './material/types.ts';
import type { Settings } from './config.ts';
import { matrixEligibleAccounts } from './studio/lock.ts';
import { planArms, recordArms } from './rank/experiments.ts';
import { playbook } from './rank/playbook.ts';
import { scoreAll } from './rank/score.ts';
import { writingNotes } from './brain/author.ts';
import type { Verdict } from './rank/score.ts';

/** A line from the word bank, chosen by the same seed that chose the draft, so a preview repeats. */
function pickBank(key: string, seed: string | number): string {
  const raw = wordBank[key] ?? '';
  const opts = raw.startsWith('{') ? raw.slice(1, -1).split('|') : [raw];
  const h = typeof seed === 'number' ? seed : hashString(seed);
  return opts[Math.abs(h) % opts.length]!;
}

const DISCLAIMER_BANK = /^(phrase\.notAdvice|disclaimer\.)/;

/**
 * What a disclaimer actually says, checked against the rendered text.
 *
 * The gate used to ask "did this draft draw from a bank named like a disclaimer", and one of
 * that bank's three variants was 「数据摆在这儿，决定你自己做」— a shrug, not a disclaimer. Four
 * published posts went out with no compliance line and nothing complained. A sentence either
 * disclaims advice or it does not; that is a property of the text.
 */
const DISCLAIMER_RE = /不构成[^。\n]{0,10}建议|仅为信息整理|仅供参考|不构成任何建议|DYOR|请自行判断/i;
export const carriesDisclaimer = (text: string): boolean => DISCLAIMER_RE.test(text);

/** Square's own hashtag grammar — anything outside it renders as dead text. */
const HASHTAG_OK = /^[\p{L}\p{N}_]{2,60}$/u;

/**
 * The thinnest post worth publishing, in distinct numeric claims. One number plus an opinion is
 * what a single-event tool can also print; measured on the first day, the 60–88 character
 * funding notes carried exactly one number each and were also the ones repeated four times on
 * the same coin. Below this floor the draft is dropped rather than sent.
 */
export const MIN_DISTINCT_FACTS = 3;

export function tooThin(facts: Fact[], text: string): string | null {
  const distinct = new Set(facts.filter(f => f.kind === 'number' && f.value !== null).map(f => f.field));
  if (distinct.size >= MIN_DISTINCT_FACTS) return null;
  // A long post that leans on two numbers is still an argument; a short one is a shrug.
  if (distinct.size >= 2 && text.length >= 160) return null;
  return `信息量不足：${distinct.size} 个独立数字（门槛 ${MIN_DISTINCT_FACTS} 个），${text.length} 字`;
}

const DISCLAIMER_LINES = new Set(
  Object.entries(wordBank)
    .filter(([k]) => DISCLAIMER_BANK.test(k))
    .flatMap(([, v]) => (v.startsWith('{') ? v.slice(1, -1).split('|') : [v]))
    .map(s => s.trim())
    .filter(s => DISCLAIMER_RE.test(s)),
);

/** Templates this account may use. Blocking one is per-account so two accounts can be
 *  forced onto disjoint template sets — the strongest anti-collision lever we have. */
function defsForAccount(all: ReturnType<Store['allTemplates']>, account?: AccountRow) {
  if (!account) return all;
  const blocked = accountBlockedTemplates(account);
  return blocked.size ? all.filter(t => !blocked.has(t.id)) : all;
}

/**
 * A `#COIN` in the body is parsed by Square and files the post on that coin's hashtag
 * page, which is a distribution surface the write API hands over for free. It goes
 * above the disclaimer so the legal line stays last.
 */
/**
 * One topical tag next to the coin tag, up to `total` hashtags on the post.
 *
 * A bare `#BTC` competes with every bitcoin post ever published; the topic feeds are where a
 * small account actually gets placed. This is also an experiment arm (`h_hashtag_count`), so the
 * count is a parameter rather than a constant — and it counts what a reader sees, coin tag
 * included, because that is the thing the engine can react to.
 */
const TOPIC_TAGS: Record<string, string> = {
  attention: '热度榜', funding: '资金费率', long_short: '多空比', market_move: '行情异动',
  leaderboard: '涨跌榜', sentiment: '市场情绪', stablecoin: '稳定币', trending: '热搜',
  onchain: '链上数据', dex: 'DEX', liquidation: '爆仓', open_interest: '持仓变化',
  announcement: '币安公告', newsflash: '快讯', etf_flow: 'ETF',
};

export function withHashtags(text: string, m: Material, total = 2): string {
  const tag = [m.symbol, ...m.symbols].map(s => (s ?? '').trim()).find(s => HASHTAG_OK.test(s));
  if (!tag) return text;
  const topical = Math.max(0, total - 1);
  const wanted = [`#${tag}`, ...[m.category, 'crypto'].slice(0, topical).map(c => `#${TOPIC_TAGS[c] ?? 'crypto'}`)];
  // A tag already anywhere in the text counts as present — inline in a sentence still puts the
  // post on that page, and repeating it reads as padding.
  const already = (t: string) =>
    new RegExp(`${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
  const lines = text.split('\n');
  const add = wanted.filter(t => !already(t));
  if (!add.length) return text;
  // Insert above the disclaimer so the compliance line stays the last thing a reader sees.
  const at = DISCLAIMER_LINES.has((lines[lines.length - 1] ?? '').trim()) ? lines.length - 1 : lines.length;
  const existing = (lines[at - 1] ?? '').trim();
  if (existing && /^#/.test(existing)) {
    // A previous run already left a tag line here; extend it rather than stacking paragraphs.
    const merged = existing.split(/\s+/).filter(Boolean);
    for (const t of [...add].reverse()) if (!merged.includes(t)) merged.splice(1, 0, t);
    lines[at - 1] = merged.join(' ');
    return lines.join('\n');
  }
  lines.splice(at, 0, add.join(' '));
  // Templates already breathe between paragraphs; only add the separator it lacks.
  if ((lines[at - 1] ?? '').trim()) lines.splice(at, 0, '');
  return lines.join('\n');
}

export interface CollectReport {
  fetched: number;
  inserted: number;
  /** How many materials gained live market dimensions for their coin. */
  enriched: number;
  /** How many items folded into an existing one as the same story. */
  merged: number;
  byCategory: Record<string, number>;
  errors: string[];
}

/** Pull every enabled source, drop repeats of an event we already posted about, store the rest. */
export async function collect(store: Store, settings: Settings): Promise<CollectReport> {
  store.syncTemplates(builtinTemplates);

  const jobs: { name: string; run: () => Promise<Material[]> }[] = [
    { name: 'announcement', run: () => announcements({}) },
    { name: 'newsflash', run: () => newsflashes(25) },
    { name: 'market_move', run: () => detectPriceMoves({}) },
    { name: 'leaderboard', run: () => detectLeaderboards() },
    { name: 'funding', run: () => detectFundingExtremes() },
    { name: 'long_short', run: () => detectLongShortSkew(['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE']) },
    { name: 'open_interest', run: () => detectOpenInterestMoves({}) },
    { name: 'market_move', run: () => detectMaCrosses({}) },
    { name: 'sentiment', run: () => fearAndGreed() },
    { name: 'stablecoin', run: () => stablecoinShifts() },
    { name: 'trending', run: () => trendingMaterials({}) },
    { name: 'dex', run: () => dexTrending({}) },
    { name: 'onchain', run: () => hyperliquid({}) },
  ];

  const report: CollectReport = { fetched: 0, inserted: 0, enriched: 0, merged: 0, byCategory: {}, errors: [] };
  const enabled = new Set(settings.enabledCategories);

  const gathered: Material[] = [];
  for (const job of jobs) {
    if (!enabled.has(job.name)) continue;
    try {
      const mats = await job.run();
      report.fetched += mats.length;
      gathered.push(...mats);
    } catch (err) {
      report.errors.push(`${job.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // One batched market-context pass over everything, before anything is stored: this is
  // what gives the writing styles something other than synonyms to differ over.
  try {
    report.enriched = await enrichWithMarketContext(gathered);
  } catch (err) {
    report.errors.push(`enrich: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Same story from two wires (or the same wire twice) collapses to one material.
  const { kept, merged } = mergeSameStory(gathered);
  report.merged = merged;

  const cooldownMs = settings.fingerprintCooldownMinutes * 60_000;
  for (const m of kept) {
    if (store.hasRecentFingerprint(m.fingerprint, Date.now() - cooldownMs)) continue;
    if (store.insertMaterial(m)) {
      report.inserted++;
      report.byCategory[m.category] = (report.byCategory[m.category] ?? 0) + 1;
    }
  }

  store.log('collect', report);
  return report;
}

/**
 * Raw scores are not comparable across categories — a long/short reading of 80 and
 * a newswire item of 66 come from different scales — so ordering by score alone lets
 * one category own the whole queue. Round-robin over categories, ranked by their
 * strongest item, keeps the feed mixed.
 */
export function selectBalanced(pool: Material[], want: number, weights: Record<string, number> = {}): Material[] {
  const byCategory = new Map<string, Material[]>();
  for (const m of pool) {
    const list = byCategory.get(m.category) ?? [];
    list.push(m);
    byCategory.set(m.category, list);
  }
  const strength = (list: Material[]) => (list[0]?.score ?? 0) * (weights[list[0]?.category ?? ''] ?? 1);
  const groups = [...byCategory.values()]
    .map(list => list.sort((a, b) => b.score - a.score))
    .sort((a, b) => strength(b) - strength(a));

  const out: Material[] = [];
  while (out.length < want && groups.some(g => g.length)) {
    for (const g of groups) {
      const next = g.shift();
      if (next) out.push(next);
      if (out.length >= want) break;
    }
  }
  return out;
}

export interface GenerateReport {
  created: { id: number; material: string; template: string; text: string; scheduledAt: number }[];
  skipped: string[];
}

/**
 * Turn unused materials into draft posts, spaced out over the active window.
 * Nothing here touches the network beyond the database.
 */
/**
 * Build the LLM config from settings plus the stored provider key.
 * Returns null when the layer is off, so callers can treat AI as an optional pass.
 */
export function llmConfigFor(store: Store, settings: Settings): LlmConfig | null {
  if (!settings.llmEnabled) return null;
  const keyName = settings.llmProvider === 'anthropic' ? 'anthropicApiKey' : 'openaiApiKey';
  return {
    provider: settings.llmProvider,
    baseUrl: settings.llmBaseUrl,
    model: settings.llmModel,
    apiKey: getSecret(store, keyName),
    maxTokens: settings.llmMaxTokens,
    temperature: settings.llmTemperature,
  };
}

/** Run the rewrite pass and keep a record of why it was rejected, if it was. */
async function applyPolish(
  store: Store, settings: Settings, text: string, facts: Fact[], persona = '',
  ctx: { category?: string; subType?: string | null; symbol?: string | null } = {},
): Promise<{ text: string; note?: string }> {
  const cfg = llmConfigFor(store, settings);
  if (!cfg || !cfg.apiKey || !cfg.model) return { text };
  // The writer reads its own memory before drafting. Cheap when the ledger is empty, which is
  // what it should be — an unfounded belief must not outrank a measured one.
  const notes = writingNotes(store, { category: ctx.category, subType: ctx.subType ?? null, symbol: ctx.symbol ?? null });
  const r = await polish(cfg, text, facts, persona, notes);
  return r.changed ? { text: r.text, note: 'ai_polished' } : { text, note: `ai_rejected: ${r.reason}` };
}

export async function generate(
  store: Store,
  settings: Settings,
  want = 3,
  opts: { account?: AccountRow; dryRun?: boolean } = {},
): Promise<GenerateReport> {
  store.syncTemplates(builtinTemplates);
  const account = opts.account;
  const defs = defsForAccount(store.allTemplates(), account);
  const report: GenerateReport = { created: [], skipped: [] };
  // Scored once per pass: every draft in a tick should see the same beliefs, and scoring is a
  // table scan, not something to repeat per post.
  const rankVerdicts: Verdict[] = scoreAll(store, { writeMemory: false });
  const eff = account ? settingsForAccount(settings, account) : settings;
  const styles = account ? accountStyles(account) : [eff.style];
  // A draft now reserves its minute a day ahead, so generation is bounded by what the queue can
  // actually deliver: unbounded drafting buries the day's target in material that expires before
  // its own slot arrives. Preview is exempt — looking at what an account would post should never
  // be blocked by how busy it already is.
  if (!opts.dryRun) {
    const pending = store.pendingQueueCount(account?.id ?? null);
    const room = eff.postsPerDay - pending;
    if (room <= 0) {
      report.skipped.push(`待发布已有 ${pending} 条，达到该号每天 ${eff.postsPerDay} 条的目标，本轮不再生成`);
      return report;
    }
    want = Math.min(want, room);
  }
  const pool = selectBalanced(store.unusedMaterials(want * 4), want * 2, settings.categoryWeights).filter(
    m => !account || materialAllowedForAccount(m, account),
  );
  const recent = store.recentPostTexts(40, ['published', 'approved', 'uncertain', 'draft'], account?.id ?? null);
  const avoidTexts = account
    ? store.recentPostsFromOthers(account.id, Date.now() - settings.crossAccountCoinExclusionMinutes * 60_000).map(r => r.text)
    : [];
  // Repeating one template back-to-back reads as a bot; cool each one down for a few posts.
  const recentlyUsed = store
    .postsByStatus('draft', 3)
    .concat(store.postsByStatus('approved', 3))
    .map(p => p.template_id)
    .filter((x): x is string => Boolean(x));

  for (const m of pool) {
    if (report.created.length >= want) break;
    const when = Date.now() + report.created.length * nominalGap(eff);
    const slot = account ? nextSlotFor(store, settings, account, when, null, true) : nextSlot(store, eff, when, null, true);
    if (!slot.allowed) {
      report.skipped.push(slot.reason);
      break;
    }
    if (!opts.dryRun && rolledPastToday(slot)) {
      report.skipped.push('今天的发帖时段已经排满，再写就只能排到明天 —— 停在这里，不写过期的草稿');
      break;
    }
    const seed = personaSeed(m.id, account?.id ?? 0, slot.at);
    if (!opts.dryRun && m.symbol && store.recentCoinSignal(account?.id ?? null, m.symbol, m.category, Date.now() - eff.coinSignalCooldownMinutes * 60_000)) {
      report.skipped.push(`${m.title}: 这个币的「${m.category}」类内容 ${Math.round(eff.coinSignalCooldownMinutes / 60)} 小时内已经发过`);
      continue;
    }
    const candidates = eligible(m, defs, settings, recentlyUsed);
    if (!candidates.length) {
      report.skipped.push(`${m.title}: 所有匹配模版都在冷却中`);
      continue;
    }
    const c = compose(m, candidates, {
      seed: hashString(seed),
      bank: wordBank,
      style: styles,
      recent: [...recent],
      avoid: avoidTexts.length ? { texts: avoidTexts, threshold: CROSS_ACCOUNT_THRESHOLD } : undefined,
      sensitiveWords: settings.sensitiveWords,
    });
    if ('error' in c) {
      report.skipped.push(`${m.title}: ${c.error}`);
      continue;
    }
    let text = c.text;
    // The arm is drawn before the post exists, so an outcome can never be explained by whoever
    // chose the winner afterwards.
    const arms = planArms({ seed: hashString(`${seed}:arms`), verdicts: rankVerdicts });
    const pb = playbook(store, { verdicts: rankVerdicts, arms });
    if (pb.opening === 'question' && !/[？?]/.test(text) && !opts.dryRun) {
      text = `${text}\n${pickBank('closing.question', seed)}`;
    }
    // Only append a disclaimer the copy did not already carry.
    if (eff.appendDisclaimer && !carriesDisclaimer(text)) {
      text = `${text}\n${wordBank['disclaimer.default']}`;
    }
    const polished = await applyPolish(store, eff, text, c.result.facts, account?.persona_note ?? '', m);
    text = polished.text;
    // Tagged after polish: a model must never get the chance to reword a hashtag.
    if (eff.appendHashtags) text = withHashtags(text, m, pb.hashtagTotal);
    if (!opts.dryRun) {
      const thin = tooThin(c.result.facts, text);
      if (thin) {
        report.skipped.push(`${m.title}: ${thin}`);
        continue;
      }
    }

    // Any material that names a single coin can carry its chart.
    let images: string[] = [];
    if (eff.attachChart && pb.attachChart && m.symbol && !opts.dryRun) {
      const f = m.facts as Record<string, unknown>;
      const pick = (k: string): number | null => (typeof f[k] === 'number' ? (f[k] as number) : null);
      try {
        const built = await buildChartFor({
          symbol: m.symbol,
          chg24h: pick('chg24h'),
          volMultiple: pick('volMultiple'),
          funding: pick('funding'),
          oiChangePct: pick('oiChangePct'),
          longRatio: pick('longRatio'),
        });
        if (built) images = [built.path];
      } catch (err) {
        report.skipped.push(`${m.title}: chart 失败 ${String(err).slice(0, 60)}`);
      }
    }
    if (opts.dryRun) {
      // Preview must not consume the material or claim the coin, or looking at what an
      // account *would* post would change what it actually posts.
      report.created.push({ id: 0, material: m.title, template: c.templateName, text, scheduledAt: slot.at });
      recent.unshift(text);
      continue;
    }
    const id = store.addPost({
      materialId: m.id,
      templateId: c.templateId,
      text,
      status: eff.autoPublish ? 'approved' : 'draft',
      scheduledAt: slot.at,
      facts: c.result.facts,
      trace: { ...c.result.trace, polish: polished.note, account: account?.label ?? null },
      images,
    });
    if (account) store.updatePost(id, { accountId: account.id });
    recordArms(store, id, arms);
    // Consume the material. Without this every account's pass sees the same unused list
    // and drafts the same events, which is the duplication the matrix exists to avoid.
    store.markMaterialUsed(m.id);
    recent.unshift(text);
    recentlyUsed.push(c.templateId);
    report.created.push({ id, material: m.title, template: c.templateName, text, scheduledAt: slot.at });
  }

  store.log('generate', { created: report.created.map(c => c.id), skipped: report.skipped });
  return report;
}

function nominalGap(settings: Settings): number {
  return Math.max(settings.minIntervalMinutes, 20) * 60_000;
}

/**
 * A slot rolled into tomorrow means today's window is already full. Writing another draft then
 * produces a post whose material expires before its minute arrives — the queue cap counts posts,
 * this reads the clock, and only the second one knows when to stop.
 */
function rolledPastToday(slot: { reason: string }): boolean {
  return slot.reason.includes('已顺延');
}

/**
 * Templates eligible for this material, with recently-used ones held back so the
 * feed does not become one template with the symbol swapped out. A category with a
 * single template is allowed to reuse it — the structural duplicate guard is what
 * actually stops the copy from repeating.
 */
function eligible(m: Material, defs: ReturnType<Store['allTemplates']>, settings: Settings, cooldownIds: string[]) {
  const all = eligibleTemplates(m, defs, { style: settings.style });
  const fresh = all.filter(t => !cooldownIds.includes(t.id));
  return fresh.length ? fresh : all;
}

export interface PublishReport {
  attempted: number;
  published: { id: number; url?: string }[];
  uncertain: { id: number; label: string }[];
  failed: { id: number; label: string }[];
  /** Things the last-mile gate fixed rather than blocked — worth surfacing, not alarming. */
  notes: string[];
  paused: boolean;
}

/**
 * Send everything that is approved and due.
 * A gateway timeout is recorded as `uncertain` and the post is never re-sent —
 * the only safe reading of that response is "it probably went through".
 */
export async function publishDue(
  store: Store,
  settings: Settings,
  opts: { live?: boolean; apiKey?: string; account?: AccountRow } = {},
): Promise<PublishReport> {
  const report: PublishReport = { attempted: 0, published: [], uncertain: [], failed: [], notes: [], paused: false };
  const acct = opts.account ?? null;
  const apiKey = opts.apiKey ?? (acct ? getAccountSecret(store, acct.id) : process.env.SQUARE_API_KEY ?? '');
  if (!opts.live) {
    report.failed.push({ id: 0, label: '未加 --live，仅演练' });
  }
  if (opts.live && !apiKey) {
    report.failed.push({ id: 0, label: acct ? `${acct.label} 还没有广场 Key` : '还没有配置广场 Key（设置页 → 密钥）' });
    return report;
  }

  const client = new SquareClient({ apiKey, dryRun: !opts.live, proxyUrl: acct?.proxy_url ?? '' });
  const due = (acct ? store.approvedForAccount(acct.id, 20) : store.postsByStatus('approved', 20))
    .filter(p => (p.scheduled_at ?? 0) <= Date.now())
    // Oldest first. The account path already returns rows in schedule order, but the
    // no-account path comes back newest-first, and a defer-then-break loop over that looks
    // at the newest post, finds four siblings already claiming its minute, defers it — and
    // never reaches the one that was genuinely due.
    .sort((a, b) => (a.scheduled_at ?? a.created_at) - (b.scheduled_at ?? b.created_at) || a.id - b.id);
  // Posts queued in the same run must not duplicate each other either.
  const justSent: string[] = [];

  for (const post of due) {
    const candidate = { id: post.id, at: post.scheduled_at ?? post.created_at };
    const slot = acct ? nextSlotFor(store, settings, acct, Date.now(), candidate) : nextSlot(store, settings, Date.now(), candidate);
    if (!slot.allowed) {
      report.failed.push({ id: post.id, label: slot.reason });
      break;
    }
    // `allowed` only means the day's cap has not been reached. The slot it hands back is
    // the next *legal* moment, which is routinely in the future — and posting anyway is what
    // made five drafts go out inside one minute. The interval and the active window are only
    // real if someone refuses to post before their time.
    if (slot.at > Date.now()) {
      report.failed.push({ id: post.id, label: `未到发布时刻，顺延到 ${new Date(slot.at + 8 * 3600_000).toISOString().slice(5, 16).replace('T', ' ')} 北京（${slot.reason}）` });
      break;
    }
    report.attempted++;

    // Last gate before the network: approval can come from the CLI in bulk, so the
    // duplicate check lives here where it cannot be stepped around.
    const alreadySent = store.recentPostTexts(30, ['published', 'uncertain'], acct?.id ?? null);
    const dupOf = isStructuralDuplicate(post.text, [...alreadySent, ...justSent]);
    if (dupOf) {
      store.updatePost(post.id, { status: 'draft', error: '发布前发现与已发帖子结构重复，已退回草稿' });
      report.failed.push({ id: post.id, label: '与已发布内容同句换币，已退回草稿' });
      continue;
    }
    // And the matrix gate: another account must not have said this already.
    if (acct) {
      const clash = collidesWithMatrix(store, settings, acct.id, post.text);
      if (clash) {
        store.updatePost(post.id, { status: 'draft', error: `与「${clash.ownerLabel}」近期文案句式相同（相似度 ${(clash.signature * 100).toFixed(0)}%），已退回草稿` });
        report.failed.push({ id: post.id, label: `跨账号撞句（${clash.ownerLabel}）` });
        continue;
      }
    }
    justSent.push(post.text);

    // The last gate is on the bytes about to be sent, not on the draft as it was written:
    // polish, panel edits and rerolls all happen after the generation-time checks.
    const pf = preFlight({
      text: post.text,
      facts: (JSON.parse(post.facts_json ?? 'null') as Fact[] | null) ?? null,
      disclaimerRequired: (acct ? settingsForAccount(settings, acct) : settings).appendDisclaimer,
      sensitiveWords: settings.sensitiveWords,
      maxChars: MAX_BODY_CHARS,
    });
    if (!pf.ok) {
      store.updatePost(post.id, { status: 'rejected', error: `发布前合规检查拦下：${pf.reason}` });
      report.failed.push({ id: post.id, label: `发布前拦下：${pf.reason}` });
      continue;
    }
    if (pf.text !== post.text) {
      store.updatePostText(post.id, pf.text);
      report.notes.push(`#${post.id} 发布前${pf.note}`);
    }
    const finalText = pf.text;

    // Charts are uploaded just-in-time: the presigned URL is only valid for a
    // short window, so it must not be done at draft-creation time.
    const imageUrls: string[] = [];
    const localImages: string[] = JSON.parse(post.images_json ?? '[]') as string[];
    for (const file of localImages.slice(0, 4)) {
      try {
        const bytes = readFileSync(file);
        const mime = extname(file).toLowerCase() === '.jpg' ? 'image/jpeg' : `image/${extname(file).slice(1)}`;
        const up = await client.uploadImage(bytes, `${post.id}-${file.split(/[\\/]/).pop()}`, mime);
        if (up.ok && up.imageUrl) imageUrls.push(up.imageUrl);
        else report.failed.push({ id: post.id, label: `图片上传失败：${up.label ?? ''}` });
      } catch (err) {
        report.failed.push({ id: post.id, label: `图片读取失败：${String(err).slice(0, 60)}` });
      }
    }
    // A missing chart degrades the post; it must not discard it.
    if (!opts.live) imageUrls.length = 0;

    let outcome: PublishOutcome;
    try {
      outcome = await client.publish(finalText, imageUrls);
    } catch (err) {
      outcome = { ok: false, kind: 'network', label: err instanceof Error ? err.message : String(err) };
    }

    if (outcome.ok) {
      if (!opts.live) {
        // A drill must leave no trace in the ledger. These texts never went out, and
        // recording them as published eats the daily cap and poisons the dedup source
        // that the real publish gate reads.
        store.log('dry-run', { postId: post.id, chars: post.text.length });
        report.published.push({ id: post.id, url: undefined });
        continue;
      }
      store.updatePost(post.id, {
        status: 'published',
        squarePostId: outcome.postId ?? null,
        url: outcome.url ?? null,
        publishedAt: Date.now(),
      });
      store.log('published', { postId: post.id, url: outcome.url });
      report.published.push({ id: post.id, url: outcome.url });
      continue;
    }

    if (outcome.uncertain) {
      store.updatePost(post.id, { status: 'uncertain', error: outcome.label ?? 'unknown' });
      store.log('uncertain', { postId: post.id, label: outcome.label });
      report.uncertain.push({ id: post.id, label: outcome.label ?? '' });
      continue;
    }

    store.updatePost(post.id, { status: 'failed', error: `${outcome.code ?? ''} ${outcome.label ?? outcome.message ?? ''}`.trim() });
    report.failed.push({ id: post.id, label: outcome.label ?? 'failed' });

    if (outcome.kind === 'account_restricted' || outcome.kind === 'auth') {
      report.paused = true;
      store.setSetting('paused', { at: Date.now(), reason: outcome.label });
      store.log('pause', { reason: outcome.label, kind: outcome.kind });
      break;
    }
  }
  return report;
}

/**
 * Re-render an existing draft from its original material with a different seed, or
 * force a specific template. This is the iteration loop: same facts, new wording,
 * and the previous attempt stays in the log so a bad angle is visible, not lost.
 */
export async function reroll(
  store: Store,
  settings: Settings,
  postId: number,
  opts: { templateId?: string; seed?: string } = {},
): Promise<{ ok: true; post: ReturnType<Store['postById']>; note: string } | { ok: false; error: string }> {
  const post = store.postById(postId);
  if (!post) return { ok: false, error: '找不到这条帖子' };
  if (post.status === 'published' || post.status === 'uncertain') return { ok: false, error: `${post.status} 的帖子不能重写` };
  if (!post.material_id) return { ok: false, error: '这条帖子没有关联素材，无法重生成' };

  const material = store.materialById(post.material_id);
  if (!material) return { ok: false, error: '原始素材已不在库里' };

  store.syncTemplates(builtinTemplates);
  let defs = store.allTemplates();
  if (opts.templateId) defs = defs.filter(t => t.id === opts.templateId);
  if (!defs.length) return { ok: false, error: opts.templateId ? `模版 ${opts.templateId} 未启用` : '该素材没有可用模版' };

  const seed = opts.seed ?? `${material.id}:${Date.now()}`;
  const c = compose(material, defs, {
    seed: hashString(seed),
    bank: wordBank,
    style: settings.style,
    recent: store.recentPostTexts(40).filter(t => t !== post.text),
    sensitiveWords: settings.sensitiveWords,
    // When a specific template is requested, do not silently fall back to another.
    maxAttempts: opts.templateId ? 1 : undefined,
  });
  if ('error' in c) return { ok: false, error: c.error };

  let text = c.text;
  if (settings.appendDisclaimer && !carriesDisclaimer(text)) {
    text = `${text}\n${wordBank['disclaimer.default']}`;
  }
  const polished = await applyPolish(store, settings, text, c.result.facts);
  let finalText = polished.text;
  if (settings.appendHashtags) finalText = withHashtags(finalText, material);

  store.updatePostText(postId, finalText);
  store.db
    .prepare('UPDATE posts SET template_id = ?, facts_json = ?, trace_json = ? WHERE id = ?')
    .run(c.templateId, JSON.stringify(c.result.facts), JSON.stringify({ ...c.result.trace, polish: polished.note }), postId);
  store.log('reroll', { postId, from: post.template_id, to: c.templateId, seed });

  return { ok: true, post: store.postById(postId), note: polished.note ?? 'template_only' };
}

export function pauseState(store: Store): { paused: boolean; reason?: string; at?: number } {
  const p = store.getSetting<{ at: number; reason: string } | null>('paused', null);
  return p ? { paused: true, ...p } : { paused: false };
}

/* ------------------------------------------------- attention-driven posts --- */

export interface PoolGenerateReport {
  matureCount: number;
  created: { id: number; symbol: string; template: string; text: string; chart: string | null; scheduledAt: number }[];
  skipped: { symbol: string; why: string }[];
  errors: string[];
}

/**
 * The main loop: Square picks the coin, the market feed supplies the numbers, the
 * template fixes the wording, and a candlestick chart is attached when available.
 *
 * Pass `account` to generate for one member of the matrix. Its persona then drives the
 * style filter, the synonym seed and the polish voice, and the draft is additionally
 * checked against every *other* account's recent copy.
 */
export async function generateFromPool(
  store: Store,
  settings: Settings,
  opts: { count?: number; refresh?: boolean; account?: AccountRow; poolEntries?: PoolEntry[] } = {},
): Promise<PoolGenerateReport> {
  store.syncTemplates(builtinTemplates);
  const defs = defsForAccount(store.allTemplates(), opts.account);
  const report: PoolGenerateReport = { matureCount: 0, created: [], skipped: [], errors: [] };
  const rankVerdicts: Verdict[] = scoreAll(store, { writeMemory: false });
  const acct = opts.account ?? null;
  const eff = acct ? settingsForAccount(settings, acct) : settings;
  const styles = acct ? accountStyles(acct) : [eff.style];

  if (opts.refresh !== false && !opts.poolEntries) {
    try {
      await refreshPool(store, settings);
    } catch (err) {
      report.errors.push(`refresh: ${String(err).slice(0, 140)}`);
    }
  }

  let entries = opts.poolEntries;
  if (!entries) {
    try {
      ({ entries } = await pool(store, settings));
    } catch (err) {
      report.errors.push(`pool: ${String(err).slice(0, 140)}`);
      return report;
    }
  }

  const mature = entries.filter(e => e.mature);
  report.matureCount = mature.length;
  const recent = store.recentPostTexts(40, ['published', 'approved', 'uncertain', 'draft'], acct?.id ?? null);
  const avoidTexts = acct
    ? store.recentPostsFromOthers(acct.id, Date.now() - settings.crossAccountCoinExclusionMinutes * 60_000).map(r => r.text)
    : [];

  // Same ceiling as `generate`, and the same reason: a draft whose minute lands after tonight's
  // window is a draft that expires before anyone reads it.
  const room = eff.postsPerDay - store.pendingQueueCount(acct?.id ?? null);
  if (room <= 0) {
    report.skipped.push({ symbol: '*', why: `待发布已排到 ${eff.postsPerDay} 条上限，本轮不再生成` });
    return report;
  }
  const budget = Math.min(opts.count ?? 2, room);

  for (const [i, e] of mature.slice(0, budget).entries()) {
    const when = Date.now() + i * nominalGap(eff);
    const slot = acct ? nextSlotFor(store, settings, acct, when, null, true) : nextSlot(store, eff, when, null, true);
    if (!slot.allowed) {
      report.skipped.push({ symbol: e.symbol, why: slot.reason });
      break;
    }
    if (rolledPastToday(slot)) {
      report.skipped.push({ symbol: e.symbol, why: '今天的发帖时段已排满，再写就只能排到明天' });
      break;
    }
    const facts = dossier(e);
    if (store.recentCoinSignal(acct?.id ?? null, e.symbol, 'attention', Date.now() - eff.coinSignalCooldownMinutes * 60_000)) {
      report.skipped.push({ symbol: e.symbol, why: `这个币的热度内容 ${Math.round(eff.coinSignalCooldownMinutes / 60)} 小时内已经发过` });
      continue;
    }
    const material = makeMaterial({
      category: 'attention',
      subType: e.tag ? 'topic' : 'follow',
      title: `${e.symbol} 热度跟进`,
      symbol: e.symbol,
      source: '广场热度 + 币安行情',
      at: Date.now(),
      sentiment: Number(facts.chg24h ?? 0) >= 0 ? 'bull' : 'bear',
      score: e.score,
      facts,
    });

    const c = compose(material, defs, {
      seed: hashString(personaSeed(material.id, acct?.id ?? 0, slot.at)),
      bank: wordBank,
      style: styles,
      recent: [...recent],
      avoid: avoidTexts.length ? { texts: avoidTexts, threshold: CROSS_ACCOUNT_THRESHOLD } : undefined,
      sensitiveWords: settings.sensitiveWords,
    });
    if ('error' in c) {
      report.skipped.push({ symbol: e.symbol, why: c.error.split('\n').slice(0, 2).join(' ') });
      continue;
    }

    let text = c.text;
    const arms = planArms({ seed: hashString(`${material.id}:arms`), verdicts: rankVerdicts });
    const pb = playbook(store, { verdicts: rankVerdicts, arms });
    if (pb.opening === 'question' && !/[？?]/.test(text)) {
      text = `${text}\n${pickBank('closing.question', material.id)}`;
    }
    if (eff.appendDisclaimer && !carriesDisclaimer(text)) {
      text = `${text}\n${wordBank['disclaimer.default']}`;
    }
    const polished = await applyPolish(store, eff, text, c.result.facts, acct?.persona_note ?? '', material);
    text = polished.text;
    if (eff.appendHashtags) text = withHashtags(text, material, pb.hashtagTotal);
    const thin = tooThin(c.result.facts, text);
    if (thin) {
      report.skipped.push({ symbol: e.symbol, why: thin });
      continue;
    }

    let chart: string | null = null;
    if (eff.attachChart && pb.attachChart) {
      try {
        const built = await buildChartFor(
          {
            symbol: e.symbol,
            chg24h: e.market?.chg24h ?? null,
            volMultiple: e.market?.volMultiple ?? null,
            funding: e.market?.funding ?? null,
            oiChangePct: e.market?.oiChangePct ?? null,
            longRatio: e.market?.longRatio ?? null,
          },
          undefined,
          settings.chartInterval,
        );
        chart = built?.path ?? null;
      } catch (err) {
        report.errors.push(`chart ${e.symbol}: ${String(err).slice(0, 100)}`);
      }
    }

    // Persist the synthesised material so the post keeps a resolvable provenance row.
    store.insertMaterial(material);

    const id = store.addPost({
      materialId: material.id,
      templateId: c.templateId,
      text,
      status: eff.autoPublish ? 'approved' : 'draft',
      scheduledAt: slot.at,
      facts: c.result.facts,
      trace: { ...c.result.trace, polish: polished.note, account: acct?.label ?? null },
      images: chart ? [chart] : [],
    });
    if (acct) store.updatePost(id, { accountId: acct.id });
    recordArms(store, id, arms);
    store.markMaterialUsed(material.id);
    // One post per attention rise; the coin stays blocked until the cooldown passes.
    store.claim(e.symbol, id, e.score, acct?.id ?? null);
    recent.unshift(text);
    report.created.push({ id, symbol: e.symbol, template: c.templateName, text, chart, scheduledAt: slot.at });
  }

  store.log('pool_generate', { created: report.created.map(c => `${c.symbol}#${c.id}`), skipped: report.skipped });
  return report;
}

export { settingsFrom };

/* -------------------------------------------------------------- matrix --- */

export interface MatrixAccountReport {
  accountId: number;
  label: string;
  created: number;
  assigned: string[];
  skipped: string[];
}

export interface MatrixGenerateReport {
  accounts: MatrixAccountReport[];
  matureCount: number;
  errors: string[];
}

/**
 * One pass over the account matrix.
 *
 * The pool is refreshed once and then *split* — handing every account the same coin list
 * and hoping the copy differs is how ten accounts end up saying the same thing. Allocation
 * is exclusive, so a coin belongs to one account for the whole exclusion window.
 */
export async function generateForMatrix(store: Store, settings: Settings): Promise<MatrixGenerateReport> {
  const report: MatrixGenerateReport = { accounts: [], matureCount: 0, errors: [] };
  // Accounts the studio owns are skipped: a teaching account must not also be drawing
  // mixed-voice short posts from this queue, or the persona the track exists to build is
  // undone by the module that was never meant to touch it.
  const accounts = matrixEligibleAccounts(store);
  if (!accounts.length) return report;

  try {
    await refreshPool(store, settings);
  } catch (err) {
    report.errors.push(`refresh: ${String(err).slice(0, 140)}`);
  }

  let entries;
  try {
    ({ entries } = await pool(store, settings));
  } catch (err) {
    report.errors.push(`pool: ${String(err).slice(0, 140)}`);
    return report;
  }
  const mature = entries.filter(e => e.mature);
  report.matureCount = mature.length;

  const alloc = allocate(mature, accounts, store, settings);
  for (const a of accounts) {
    const mine = alloc.get(a.id) ?? [];
    if (!mine.length) {
      report.accounts.push({ accountId: a.id, label: a.label, created: 0, assigned: [], skipped: ['本轮没有分到可发的币'] });
      continue;
    }
    const g = await generateFromPool(store, settings, { account: a, poolEntries: mine, refresh: false, count: mine.length });
    report.errors.push(...g.errors);
    report.accounts.push({
      accountId: a.id,
      label: a.label,
      created: g.created.length,
      assigned: mine.map(e => e.symbol),
      skipped: g.skipped.map(s => `${s.symbol}: ${s.why}`),
    });
  }

  store.log('matrix_generate', { accounts: report.accounts.map(a => `${a.label}=${a.created}`), mature: report.matureCount });
  return report;
}
