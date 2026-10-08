import 'dotenv/config';
import { Store } from './db/index.ts';
import { DEFAULT_SETTINGS, type Settings } from './config.ts';
import { collect, generate, publishDue, pauseState } from './pipeline.ts';
import { nextSlot, settingsFrom, beijingDayStart } from './schedule.ts';
import { getSecret } from './secrets.ts';
import { pool } from './hot/pool.ts';
import { tick, runLoop, line } from './daemon.ts';
import { backfillStats, tuneTemplateWeights } from './stats/backfill.ts';
import { templates as builtinTemplates } from './content/templates.ts';

const DB_PATH = process.env.DB_PATH ?? './data/squareforge.db';

function fmtTime(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms + 8 * 3600_000);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function usage(): never {
  console.log(`squareforge — 本地币安广场内容工厂

用法: npm run <命令> [参数]

  db:init       建库并同步内置模版
  collect       抓取素材（联网，只读公开行情接口）
  gen [N]       从素材生成 N 条草稿（默认 3，不联网）
  queue         列出草稿与待发布
  show <ID>     查看某条帖子的正文与生成溯源
  approve <ID>|--all   放入发布队列
  reject <ID>   丢弃
  publish       演练发布（不联网）
  publish --live  真正发到币安广场（需要 SQUARE_API_KEY）
  status        配额、时段、下一帖、暂停状态
  tick          跑一轮完整流程（采集→选币→生成→[发布]→回抓）
  daemon [分]   常驻调度，默认每 15 分钟一轮；加 --live 才会真发
  stats         回抓广场数据并按效果调模版权重
  resume        解除自动暂停
  chart <币>    只生成一张合约 K 线图到 data/charts/
  templates     列出模版及其权重
  settings      查看当前设置
  set <键> <值>  修改设置，例如: set postsPerDay 12
`);
  process.exit(0);
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) usage();

const store = Store.open(DB_PATH);
const settings = settingsFrom(store);

switch (cmd) {
  case 'db:init': {
    store.syncTemplates(builtinTemplates);
    console.log(`✓ 数据库就绪 ${DB_PATH}`);
    console.log(`✓ 内置模版 ${builtinTemplates.length} 条已同步`);
    break;
  }

  case 'collect': {
    process.stdout.write('抓取中… ');
    const r = await collect(store, settings);
    console.log(`\n抓到 ${r.fetched} 条，入库 ${r.inserted} 条`);
    for (const [k, v] of Object.entries(r.byCategory)) console.log(`  ${k.padEnd(14)} ${v}`);
    if (r.errors.length) {
      console.log('失败:');
      for (const e of r.errors) console.log(`  ! ${e}`);
    }
    for (const m of store.recentMaterials(12)) {
      console.log(`  [${m.score.toFixed(0).padStart(3)}] ${m.category}/${m.subType}  ${m.title}`);
    }
    break;
  }

  case 'gen': {
    const n = Number(args[0] ?? 3);
    const r = await generate(store, settings, n);
    console.log(`生成 ${r.created.length} 条：`);
    for (const c of r.created) {
      console.log(`\n#${c.id}  ${c.template}  计划 ${fmtTime(c.scheduledAt)}`);
      console.log(c.text);
    }
    if (r.skipped.length) {
      console.log(`\n跳过 ${r.skipped.length} 条:`);
      for (const s of r.skipped.slice(0, 8)) console.log(`  - ${s}`);
    }
    break;
  }

  case 'queue': {
    for (const status of ['draft', 'approved', 'uncertain', 'failed']) {
      const rows = store.postsByStatus(status, 20);
      if (!rows.length) continue;
      console.log(`\n${status.toUpperCase()} (${rows.length})`);
      for (const p of rows) {
        const first = p.text.split('\n')[0] ?? '';
        console.log(`  #${String(p.id).padStart(3)} ${fmtTime(p.scheduled_at)}  ${first.slice(0, 60)}`);
        if (p.error) console.log(`       ! ${p.error}`);
      }
    }
    break;
  }

  case 'show': {
    const id = Number(args[0]);
    if (!id) usage();
    const rows = [...store.postsByStatus('draft', 200), ...store.postsByStatus('approved', 200), ...store.postsByStatus('published', 200)];
    const p = rows.find(r => r.id === id);
    if (!p) {
      console.log(`找不到帖子 #${id}`);
      break;
    }
    console.log(`#${p.id} [${p.status}] ${p.url ?? ''}\n\n${p.text}\n`);
    break;
  }

  case 'approve': {
    const rows = store.postsByStatus('draft', 100);
    const targets = args[0] === '--all' ? rows : rows.filter(r => r.id === Number(args[0]));
    if (!targets.length) {
      console.log('没有匹配的草稿');
      break;
    }
    for (const p of targets) store.updatePost(p.id, { status: 'approved' });
    console.log(`✓ 已放行 ${targets.length} 条：${targets.map(t => `#${t.id}`).join(' ')}`);
    break;
  }

  case 'reject': {
    const id = Number(args[0]);
    const rows = [...store.postsByStatus('draft', 200), ...store.postsByStatus('approved', 200)];
    const p = rows.find(r => r.id === id);
    if (!p) {
      console.log('找不到');
      break;
    }
    store.updatePost(id, { status: 'rejected' });
    console.log(`✓ #${id} 已丢弃`);
    break;
  }

  case 'publish': {
    const live = args.includes('--live');
    if (live) console.log('⚠ 真实发布模式 —— 帖子会出现在你的币安广场账号上');
    const r = await publishDue(store, settings, { live, apiKey: getSecret(store, 'squareApiKey') });
    console.log(`尝试 ${r.attempted} · 成功 ${r.published.length} · 待确认 ${r.uncertain.length} · 失败 ${r.failed.length}`);
    for (const p of r.published) console.log(`  ✓ #${p.id} ${p.url ?? ''}`);
    for (const u of r.uncertain) console.log(`  ? #${u.id} ${u.label}`);
    for (const f of r.failed) console.log(`  ✗ ${f.id === 0 ? '' : `#${f.id} `}${f.label}`);
    if (r.paused) console.log('\n⛔ 已自动暂停：账号受限或 Key 失效，修好前不再发。');
    break;
  }

  case 'status': {
    const published = store.publishedToday(beijingDayStart());
    const slot = nextSlot(store, settings);
    const pause = pauseState(store);
    console.log(`等级设置      每日上限 ${settings.dailyCap} 帖 · 目标 ${settings.postsPerDay} 帖/天 · 最小间隔 ${settings.minIntervalMinutes} 分`);
    console.log(`时段          ${settings.activeStartHour}:00 – ${settings.activeEndHour}:00 (北京时间)`);
    console.log(`风格          ${settings.style}   发布方式 ${settings.autoPublish ? '自动' : '人工审核'}`);
    console.log(`今日已发      ${published} / ${settings.dailyCap}`);
    console.log(`下一帖        ${slot.allowed ? fmtTime(slot.at) : `不可发：${slot.reason}`}`);
    console.log(`暂停状态      ${pause.paused ? `是 — ${pause.reason} (${fmtTime(pause.at!)})` : '否'}`);
    console.log(`广场 Key        ${getSecret(store, 'squareApiKey') ? '已配置' : '未配置（发布需要它）'}`);
    break;
  }

  case 'templates': {
    store.syncTemplates(builtinTemplates);
    for (const t of store.allTemplates()) {
      console.log(`  ${t.id.padEnd(22)} ${t.category}/${t.subType ?? '-'}  ${t.style.padEnd(8)} w=${t.weight.toFixed(2)}  ${t.name}`);
    }
    break;
  }

  case 'settings': {
    console.log(JSON.stringify({ ...DEFAULT_SETTINGS, ...settings }, null, 2));
    break;
  }

  case 'set': {
    const key = args[0] as keyof Settings;
    const raw = args[1];
    if (!key || raw === undefined) usage();
    let value: unknown = raw;
    if (raw === 'true') value = true;
    else if (raw === 'false') value = false;
    else if (!Number.isNaN(Number(raw))) value = Number(raw);
    else if (raw.startsWith('[')) value = JSON.parse(raw);
    (settings as unknown as Record<string, unknown>)[key] = value;
    store.setSetting('settings', settings);
    console.log(`✓ ${String(key)} = ${JSON.stringify(value)}`);
    break;
  }

  case 'pool': {
    const { entries, square, errors } = await pool(store, settings);
    console.log(`\n榜  币     热度   广场浏览   24h     1h量  持续/采样  状态`);
    console.log('-'.repeat(72));
    for (const e of entries) {
      const m = e.market;
      console.log(
        `#${String(e.rank).padStart(2)} ${e.symbol.padEnd(7)}${String(e.score).padStart(6)} ${String(e.squareViews).padStart(11)} ` +
        `${(m ? `${m.chg24h >= 0 ? '+' : ''}${m.chg24h.toFixed(2)}%` : '—').padStart(9)} ${(m ? `${m.volMultiple.toFixed(1)}x` : '—').padStart(7)} ` +
        `${`${e.sustainedMinutes}分/${e.samples}次`.padStart(10)}  ${e.mature ? '✓ 可发' : (e.blocked ?? '')}`,
      );
    }
    console.log('\n广场热门话题：');
    for (const t of square.topics.slice(0, 6)) console.log(`  ${t.tag.padEnd(42)} ${t.views.toLocaleString('en-US')} 浏览 · ${t.posts} 帖`);
    if (errors.length) console.log('\n失败：', errors.join(' | '));
    break;
  }

  case 'tick': {
    const r = await tick(store, { live: args.includes('--live'), tickNo: 1, statsEveryTicks: 1 });
    console.log(line(r));
    break;
  }

  case 'daemon': {
    const mins = Number(args.find(a => /^\d+$/.test(a)) ?? 15);
    console.log(`调度启动：每 ${mins} 分钟一轮，Ctrl+C 退出`);
    await runLoop(mins, args.includes('--live'));
    break;
  }

  case 'stats': {
    const b = await backfillStats(store);
    console.log(`到期采样 ${b.due} 条，读到 ${b.read} 条，写入 ${b.updated} 条`);
    if (b.errors.length) console.log('错误:', b.errors.join(' | '));
    const t = tuneTemplateWeights(store, {});
    if (t.skipped) console.log(`调权跳过：${t.skipped}`);
    for (const a of t.adjusted) console.log(`  ${a.templateId.padEnd(22)} ${a.from.toFixed(2)} → ${a.to.toFixed(2)}  (${a.posts} 帖, 均浏览 ${a.avgViews})`);
    break;
  }

  case 'resume': {
    store.setSetting('paused', null);
    console.log('✓ 已解除暂停');
    break;
  }

  case 'chart': {
    const base = (args[0] ?? 'BTC').toUpperCase();
    const symbol = base.endsWith('USDT') ? base : `${base}USDT`;
    const { binance } = await import('./collectors/binance.ts');
    const { renderKlinePng } = await import('./chart/kline.ts');
    const { mkdirSync } = await import('node:fs');

    let k = await binance.futuresKlines(symbol, '1h', 72).catch(async () => binance.klines(symbol, '1h', 72));
    const closed = k.slice(0, -1);
    if (closed.length < 3) {
      console.log(`没有 ${symbol} 的 K 线数据`);
      break;
    }
    const last = closed[closed.length - 1]!;
    const first = closed[0]!;
    const chg = ((Number(last[4]) - Number(first[4])) / Number(first[4])) * 100;

    const premium = await binance.premiumIndex().catch(() => []);
    const fund = premium.find(p => p.symbol === symbol)?.lastFundingRate;
    const oi = await binance.openInterestHist(symbol, '1h', 25).catch(() => []);
    const oiChg = oi.length > 1 ? ((Number(oi[oi.length - 1]!.sumOpenInterestValue) - Number(oi[0]!.sumOpenInterestValue)) / Number(oi[0]!.sumOpenInterestValue)) * 100 : null;
    const ls = await binance.globalLongShort(symbol, '1h', 1).catch(() => []);

    const chips = [
      `24h ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`,
      fund ? `Funding ${(Number(fund) * 100).toFixed(3)}%` : null,
      oiChg !== null ? `OI 24h ${oiChg >= 0 ? '+' : ''}${oiChg.toFixed(1)}%` : null,
      ls[0] ? `L/S ${Number(ls[0].longShortRatio).toFixed(2)}` : null,
      `1h candles x${closed.length}`,
    ].filter(Boolean) as string[];

    const png = await renderKlinePng(closed, {
      title: `${base}USDT Perp · 1H`,
      subtitle: 'Binance Futures',
      lastPrice: Number(last[4]),
      changePct: chg,
      stats: { chips },
    });
    mkdirSync('data/charts', { recursive: true });
    const file = `data/charts/${base}-1h.png`;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, png);
    console.log(`✓ ${file}  ${(png.length / 1024).toFixed(0)}KB  ${chips.join(' | ')}`);
    break;
  }

  default:
    usage();
}

store.close();
