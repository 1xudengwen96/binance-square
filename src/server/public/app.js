const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let STATE = {}, TAB = 'overview';

async function api(path, opts = {}) {
  const o = { ...opts };
  // The server refuses any mutation without this header, which stops a random
  // web page from POSTing to the local panel while it is open.
  if (o.method && o.method !== 'GET') o.headers = { 'x-squareforge': 'ui', ...(o.headers || {}) };
  const r = await fetch(path, o);
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && j.loginRequired) {
    location.replace('/login' + location.hash);
    throw new Error('登录已过期，请重新登录');
  }
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}
async function logout() {
  const button = $('#logoutBtn');
  button.disabled = true;
  try {
    await api('/api/auth/logout', { method: 'POST' });
    location.replace('/login');
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
  }
}
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast on${bad ? ' bad' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('on'), 3400);
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('sf-theme', next);
}

const ICON = {
  overview: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM13 3v4h8V3zM3 17v4h8v-4z"/>',
  board: '<path d="M3 20h18M6 16V9M11 16V4M16 16v-5M21 16v-8"/>',
  insights: '<path d="M21 12a9 9 0 11-9-9v9z"/>',
  rank: '<path d="M3 17l6-6 4 3 7-8"/><path d="M14 6h6v6"/><path d="M3 21h18"/>',
  pool: '<path d="M3 17l5-6 4 3 4-6 5 4M3 21h18"/>',
  materials: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  templates: '<path d="M4 4h7v7H4zM13 4h7v4h-7zM13 11h7v9h-7zM4 14h7v6H4z"/>',
  queue: '<path d="M4 6h16M4 12h16M4 18h16M20 6H8M20 12H9M20 18H8"/>',
  ops: '<path d="M12 3a9 9 0 109 9"/><path d="M12 8v4l3 2"/><path d="M19 3v5h5"/>',
  accounts: '<path d="M16 20v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM21 20v-1a4 4 0 00-3-3.9M16 4.1a4 4 0 010 7.8"/>',
  studio: '<path d="M4 19.5V6a2 2 0 012-2h12v16H6a2 2 0 00-2 2 2 2 0 002-2h12"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16M9 4v4M15 10v4M7 16v4"/>',
  connect: '<path d="M9 3v5M15 3v5M6 8h12v4a6 6 0 01-12 0zM12 18v3"/>',
  brain: '<path d="M9 4a3 3 0 00-3 3v.5A3 3 0 004 10.5 3 3 0 005 13a3.5 3.5 0 004 5.5V20h2V4zM15 4a3 3 0 013 3v.5a3 3 0 012 3 3 3 0 01-1 2.5 3.5 3.5 0 01-4 5.5V20h-2V4z"/>',
  backup: '<path d="M4 7h16v14H4zM3 3h18v4H3zM9 11h6M12 15v4M9 17l3 3 3-3"/>',
};

/**
 * Navigation is grouped by what the operator is doing, not by data table. Eleven flat tabs
 * force a search for the right one every time; four groups let the eye go straight to the
 * section, and each page states in one line what question it answers.
 */
const NAV = [
  ['总览', [
    ['overview', '概览', '现在的状态、今天发了什么、下一步会发生什么', ICON.overview],
    ['ops', '运行台', '能不能发、有没有在发、什么挡住了 —— 每条状态自带最后正常时间', ICON.ops],
    ['board', '数据板', '发帖时间、节奏、账号分工与效果的图形视图', ICON.board],
    ['rank', '流量引擎', '用实验去问币安的推荐系统要什么样的内容', ICON.rank],
    ['insights', '效果分析', '哪类内容更吸引人，需要样本量才成立', ICON.insights],
  ]],
  ['内容', [
    ['pool', '热度榜', '广场正在盯哪些币，够不够成熟到能发', ICON.pool],
    ['materials', '素材库', '抓到的原始素材与它们的保质期', ICON.materials],
    ['templates', '模版', '文案骨架库，按分类与风格筛选', ICON.templates],
    ['studio', '内容工作室', '一个账号深耕一个领域的长文产线', ICON.studio],
  ]],
  ['发布', [
    ['queue', '发帖记录', '发出去的每一条，以及它们后来的数据', ICON.queue],
    ['accounts', '账号', '每个号的岗位、节奏、密钥与出口', ICON.accounts],
  ]],
  ['系统', [
    ['backup', '备份与迁移', 'S3 自动备份、30 天保留与新服务器一键导入', ICON.backup],
    ['settings', '设置', '全局规则：额度、节奏、敏感词、保留期', ICON.settings],
    ['brain', 'AI 大脑', '算法大脑的连接、任务、关卡、熔断和周报', ICON.brain],
    ['connect', '接入与 AI', '广场 Key、代理', ICON.connect],
  ]],
];

const NAV_FLAT = NAV.flatMap(([, items]) => items);
const pageMeta = id => NAV_FLAT.find(([k]) => k === id) || NAV_FLAT[0];

function navCount(id) {
  const s = STATE.settings || {};
  if (id === 'materials') return STATE.unused || 0;
  if (id === 'queue') return STATE.pending || 0;
  if (id === 'accounts') return (STATE.accounts || []).filter(a => a.enabled).length || 0;
  if (id === 'templates') return STATE.templateCount || 0;
  // 三分出处（§9c 判据 4 加）：总线残量 + 面板自算 + 仅存在于 tick note 的限制条件。
  // 读不到的那一面不铺 0（宁可少计），题注里点名缺面 —— 见 opsBadge()。
  if (id === 'ops') return opsBadge().n;
  if (id === 'overview') return s.autoRun ? 0 : 0;
  return 0;
}

function renderNav() {
  $('#nav').innerHTML = NAV.map(([group, items]) => `
    <div class="nav-group">
      <i>${esc(group)}</i>
      ${items.map(([id, label, , icon]) => {
        const n = navCount(id);
        // 运行台那枚角标的题注必须带三分拆法，否则"3"会被读成"三面都证实了 3 枚"。
        const title = id === 'ops' ? `${label} —— ${opsBadge().title}` : label;
        return `<button class="${id === TAB ? 'on' : ''}" onclick="go('${id}')" title="${esc(title)}">
          <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
          <span>${esc(label)}</span>${n ? `<span class="cnt">${n}</span>` : ''}
        </button>`;
      }).join('')}
    </div>`).join('');
}
async function go(tab) {
  TAB = tab;
  // The tab survives a reload, and a page can be linked to as /#brain.
  if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
  renderNav();
  await render();
}

function fmtTs(ms, withSeconds = false) {
  if (!ms) return '—';
  const d = new Date(ms + 8 * 3600000);
  const p = n => String(n).padStart(2, '0');
  // 秒位是给网格相位用的（22:05:36.9 与 :36.89 不是同一个钟面读数）；默认仍只到分钟，
  // 免得把所有历史读数的宽度改掉。
  const sec = withSeconds ? ':' + p(d.getUTCSeconds()) + (ms % 1000 ? '.' + String(ms % 1000).padStart(3, '0') : '') : '';
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}${sec}`;
}
function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return '刚刚';
  if (s < 5400) return Math.round(s / 60) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  return Math.round(s / 86400) + ' 天前';
}
const scoreCls = n => n >= 70 ? 's-high' : n >= 55 ? 's-mid' : 's-low';

/* ------------------------------------------------- 账号维度 · 四元组 · 首屏三问 ---
 * 群主的原话是"不区分账号"。这一格为真：帖子、概览、素材、效果分析都只按状态过滤，
 * 账号只在「账号」这一页出现。所以这里把账号提成一等维度 —— 但只在自己能证明的范围内说大话：
 *
 * 1) 合并数字必须带着它的母体出场。"今日 4 条"如果不说是两个号加起来的，就会被当成
 *    一个号的成绩读；停用号混在合并里，合并值还继续增长，看起来像"当前在发"。
 * 2) 每个数都带四元组：母体 n ／ 口径 ／ 尺 ／ 取数时刻。缺任一枚就写"无出处"，
 *    并把这条降级为"只展示、不判读" —— 不许裸数字出现在页面上。
 * 3) 取数时刻是本机读到 /api/status 的那一刻，不是服务器的钟：面板拿不到服务端时间戳
 *    （补字段属后端的只读接口件），所以这里明写"面板读取时刻"，不冒充库内时刻。
 * 4) 分母只用库内四字段（status/published_at/square_post_id/url），不用事件行计数 ——
 *    现网实测事件行 52 ⊂ 库内 53，缺的那一枚确实对外发过。
 * ----------------------------------------------------------------------------- */

const OUTWARD_FIELDS = ['status', 'published_at', 'square_post_id', 'url'];
const OUTWARD_CALIBER = `库内四字段：status=published ∧ ${OUTWARD_FIELDS.slice(1).join(' ∧ ')}`;
const STATUS_SIX = ['draft', 'approved', 'published', 'rejected', 'failed', 'uncertain'];

/** 每次 /api/status 回来就打一个点；页面上所有"取于"都指向它，绝不沿用上一轮的读数。 */
let FETCHED_AT = 0;
/** 0 = 全部账号（合并口径）；其余 = 单个账号 id。选中的号停用后仍不算"当前"。 */
let ACCT = (() => {
  const v = Number(localStorage.getItem('sf-acct'));
  return Number.isInteger(v) && v > 0 ? v : 0;
})();

function acctScopeOf(accounts, acctId) {
  const all = accounts || [];
  const one = acctId ? all.find(a => a.id === acctId) || null : null;
  const off = all.filter(a => !a.enabled).length;
  return {
    one,
    id: one ? one.id : null,
    label: one ? (one.label ?? String(one.id)) : '全部账号',
    isOne: Boolean(one),
    n: one ? 1 : all.length,
    off,
    // 停用号绝不进"当前"这句话；它只是历史母体的一部分。
    caliber: one
      ? `单号 · ${one.label ?? one.id}${one.enabled ? '' : '（已停用 · 不是当前）'}`
      : `合并 ${all.length} 号${off ? ` · 含 ${off} 个停用` : ''}`,
  };
}
const acctScope = () => acctScopeOf(STATE.accounts, ACCT);

/**
 * 归属过滤：没有账号的行（早期存量 60 条）只在合并视图里出现，且必须被点名，
 * 否则"合并"就悄悄把无主稿算进了某个号的功劳里。
 */
function rowsInScope(rows, acctId) {
  const list = rows || [];
  if (acctId) return list.filter(r => (r.account_id ?? null) === acctId);
  return list;
}
const unownedCount = rows => (rows || []).filter(r => r.account_id == null).length;

/** 对外分母：四个库内字段齐了才算"发出去了"。事件行不算。 */
function outwardRows(rows) {
  return (rows || []).filter(p => p.status === 'published' && OUTWARD_FIELDS.slice(1).every(k => p[k]));
}

function srcLine(t) {
  const parts = [
    `母体 ${t && t.n != null ? (typeof t.n === 'number' ? t.n + ' 条' : t.n) : '未取'}`,
    `口径 ${t && t.caliber ? t.caliber : '未标注'}`,
    `尺 ${t && t.ruler ? t.ruler : '未标注'}`,
    `取于 ${t && t.at ? (typeof t.at === 'string' ? t.at : fmtTs(t.at, true) + '（北京 · 面板读取时刻）') : '未取'}`,
  ];
  const incomplete = !t || t.n == null || !t.caliber || !t.ruler || !t.at;
  // 四元组默认折进一枚小徽标：审计链一条不少，但不再平铺在页面上压过数字本身。
  return `<details class="src${incomplete ? ' unk' : ''}"><summary>溯源${incomplete ? ' · 无出处不判读' : ''}</summary><span>${esc(parts.join(' ｜ '))}</span></details>`;
}
/** 一次性给全四元组的快捷入口：n／口径／尺由调用方点名，时刻统一取本轮 FETCHED_AT。 */
const tupleOf = (n, caliber, ruler) => ({ n, caliber, ruler, at: FETCHED_AT });
/** 从 tip 行里提四元组：凡名字以 母体／口径／尺／取于 开头的行就是这一格的出处，缺哪枚就报哪枚。 */
function tupleFromRows(rows) {
  const get = pre => (rows || []).find(r => String(r[0]).startsWith(pre));
  const val = pre => { const r = get(pre); return r ? String(r[1]) : null; };
  return { n: val('母体'), caliber: val('口径'), ruler: val('尺') || val('发帖时段'), at: val('取于') };
}

/** 分母为零时不显示比率，也不显示 0%。0% 会把"没样本"读成"没人看"。 */
function ratioOrDash(num, den, fmt) {
  if (!den) return { v: '—', note: '无分母 · 不显示比率' };
  return { v: fmt(num / den), note: `${num} / ${den}` };
}

/**
 * 状态六格分列：一格都不并母。缺格补 0，但 0 与"读不到"必须在同一行里区分开 ——
 * 整表拿不到时传 null，渲染成"未取"，绝不渲染成一排 0。
 */
function sixGrid(rows) {
  if (!rows) return { ok: false, cells: STATUS_SIX.map(s => [s, null]), other: 0 };
  const by = {};
  for (const s of STATUS_SIX) by[s] = 0;
  let other = 0;
  for (const r of rows) { if (by[r.status] != null) by[r.status] += 1; else other += 1; }
  return { ok: true, cells: STATUS_SIX.map(s => [s, by[s]]), other };
}

/**
 * 熔断两栏：`acked:false` 有两态 —— 从未签（ackedAt:null）与签后过 24h 静音窗重火
 * （ackedAt 留旧值），只有 ackedAt 能区分，所以禁止写成"未签"一栏。
 * 台账拿不到时返回 ok:false —— 面板不许把"读不到"报成"没有"。
 */
function breakerGrid(items) {
  if (!items) return { ok: false, never: null, refire: null, acked: null, total: null };
  const list = items.filter(i => i && i.kind === 'breaker_tripped');
  return {
    ok: true,
    total: list.length,
    never: list.filter(i => i.acked === false && (i.ackedAt == null || i.ackedAt === 0)).length,
    refire: list.filter(i => i.acked === false && i.ackedAt != null && i.ackedAt !== 0).length,
    acked: list.filter(i => i.acked === true).length,
  };
}

/**
 * 告警面按 kind 摊开"全量条目 / 未签残量"。HTTP 200 与自己那一条变绿都不算数 ——
 * 挡止按 kind 全量、解除按 (kind,key) 逐枚，所以残量必须整列出来。
 * 无总线数据（现网 /api/status 还没带 alerts）时，residual 一律 null = 不可判。
 */
function alertKinds(items) {
  if (!items) return { ok: false, rows: [] };
  const by = {};
  for (const it of items) {
    const k = it.kind || '(无 kind)';
    const r = by[k] || (by[k] = { kind: k, total: 0, unacked: 0, keys: [], severity: 'info', bus: false, panel: false });
    r.total += 1;
    if (it.source === 'bus') r.bus = true; else r.panel = true;
    if (it.acked !== true) r.unacked += 1;
    if (it.key) r.keys.push(it.key);
    if (sevRank(it.severity) > sevRank(r.severity)) r.severity = it.severity;
  }
  return { ok: true, rows: Object.values(by).sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || b.unacked - a.unacked) };
}

/**
 * 挡止面三分出处（§9c 判据 4 加 · 裁定八十五）。三个证据面各有独立的读数状态：
 * ① 总线 kind —— `/api/status.alerts`（`activeAlerts()`）逐枚 (kind,key)，残量＝未签；
 * ② 面板自算 —— `opsState` 从 state 推出来的条目（`source:'panel'`），只展示、不驱动灯；
 * ③ 仅存在于 `tick` note —— 事件面根本没有同名 kind 的限制条件。现网已核两枚：
 *    `stats_stalled`（谓词 `sentinel.ts:84`／产出 `:85`，只写旧告警码面＋note）与「未唤醒大脑」（`daemon.ts:384`，只有 note）。
 * 禁手：不许拿"ledger 无条目／kind 无此名"推"无挡止"。而且 notes 是**边沿触发**的
 * （`daemon.ts:383` 那条 push 只对 `sn.raised` 里的每一枚留行 ⇒ 同一条件持续成立也只留一轮）⇒ 第三面读到、且这轮没有新行，也只能写
 * "最近一轮没有新行"，仍不能写成"没有挡止"。缺哪一面就点名哪一面。
 */
const NOTE_ONLY = [
  { mark: 'stats_stalled', cn: '效果数据断流 · 学习回路在读空气', where: 'sentinel.ts:84 谓词／:85 产出 ⇒ 旧告警码面＋tick note · 事件面无同名 kind' },
  { mark: '未唤醒大脑', cn: '大脑未唤醒 · 今日唤醒次数已达上限', where: 'src/daemon.ts:384 ⇒ 只有 tick note · 事件面无同名 kind' },
];
const FACE_CN = { bus: '总线 kind', panel: '面板自算', note: '仅 tick note' };

/** 第三面：note 与旧告警码面各自独立可读，两个都拿不到就是不可判（不写"没有"）。 */
function noteFaces(notes, alarms) {
  const hasNotes = Array.isArray(notes);
  const hasAlarms = Array.isArray(alarms);
  const rows = NOTE_ONLY.map(c => {
    const hit = hasNotes ? notes.filter(n => typeof n === 'string' && n.includes(c.mark)) : [];
    const led = hasAlarms ? alarms.filter(a => a && a.code === c.mark) : [];
    return {
      mark: c.mark,
      cn: c.cn,
      where: c.where,
      noteN: hit.length,
      note: hit.length ? String(hit[0]).slice(0, 90) : null,
      alarmAt: led.length ? Math.max(...led.map(a => Number(a.at) || 0)) : null,
      seen: hit.length > 0 || led.length > 0,
    };
  });
  return { ok: hasNotes || hasAlarms, hasNotes, hasAlarms, rows, any: rows.some(r => r.seen) };
}

/**
 * 把三面摊成一个结构：每面要么给数组（读到），要么给 null（不可判）。
 * 面板自算面里 `displayOnly` 那几枚单列 —— 它们按契约不驱动灯，混进残量就假报警。
 */
function blockerFaces(q) {
  const alerts = Array.isArray(q.alerts) ? q.alerts : null;
  const bus = alerts ? alerts.filter(a => a && a.acked !== true) : null;
  const ops = q.ops || null;
  const panel = ops ? ops.all.filter(a => a.source !== 'bus' && a.acked !== true && !a.displayOnly) : null;
  const shown = ops ? ops.all.filter(a => a.source !== 'bus' && a.acked !== true && a.displayOnly) : null;
  const note = noteFaces(q.notes, q.alarms);
  const missing = [];
  if (!bus) missing.push(`${FACE_CN.bus}未接入`);
  if (!panel) missing.push(`${FACE_CN.panel}未算（运行台状态层没跑过）`);
  if (!note.ok) missing.push(`${FACE_CN.note}未取到最近一轮`);
  const counts = [bus, panel].map(x => (x == null ? null : x.length)).concat([note.any ? note.rows.filter(r => r.seen).length : null]);
  return { bus, panel, shown, note, missing, counts, conclusive: missing.length === 0 };
}

/** 角标三分：读不到的那一面不铺 0，只在题注里点名 —— 角标宁可少计也不假报警。 */
function opsBadge() {
  const f = blockerFaces({ alerts: STATE.alerts, ops: OPS_LAST, notes: STATE.loop?.lastTick?.notes, alarms: null });
  const n = (f.bus?.length ?? 0) + (f.panel?.length ?? 0) + (f.note.ok ? f.note.rows.filter(r => r.seen).length : 0);
  const seg = x => (x == null ? '不可判' : String(x));
  return {
    n,
    title: `挡止角标三分：${FACE_CN.bus} ${seg(f.bus?.length)} · ${FACE_CN.panel} ${seg(f.panel?.length)} · ${FACE_CN.note} ${seg(f.note.ok ? f.note.rows.filter(r => r.seen).length : null)}${f.missing.length ? `（缺面：${f.missing.join('／')} ⇒ 不推"无挡止"）` : ''}`,
  };
}

/** 三分出处的呈现：整段折进可展开面板 —— 摘要行给三面计数，缺面在摘要里直接点名。 */
function blockerFacesHtml(f) {
  const pill = a => `<span class="pill ${sevRank(a.severity) >= 2 ? 'bad' : a.severity === 'warning' ? 'warn' : 'plain'}">${esc(a.kind)}｜${esc(a.key)}${a.ackedAt ? ' · 签后过窗重火' : ''}</span>`;
  const face = (label, xs, extra) => `<div class="facerow"><span class="lbl">${label}</span>${
    xs == null ? '<span class="pill warn plain">不可判 —— 这一面没读到</span>' : xs.length ? xs.map(pill).join(' ') : '<span class="muted">读到：这一面 0 枚</span>'}${extra || ''}</div>`;
  const noteRow = r => `<div class="facerow"><span class="lbl">${FACE_CN.note}</span>${
    !f.note.ok ? '<span class="pill warn plain">不可判 —— 最近一轮 tick 的 notes 没取到</span>'
      : r.seen ? `<span class="pill warn plain">${esc(r.cn)} · note ${r.noteN} 行${r.alarmAt ? ` · 旧码面最近 ${fmtTs(r.alarmAt)}` : ''}</span>`
        : `<span class="pill plain">${esc(r.cn)} · 最近一轮没有新行（notes 边沿触发 ⇒ 这不等于"没有"）</span>`}
    <span class="muted">${esc(r.where)}</span></div>`;
  const seg = x => (x == null ? '不可判' : String(x));
  const noteSeen = f.note.ok ? f.note.rows.filter(r => r.seen).length : null;
  return `<details class="faces">
    <summary><span class="ttl">阻断面三分出处</span><b>${FACE_CN.bus} ${seg(f.bus?.length ?? null)} ／ ${FACE_CN.panel} ${seg(f.panel?.length ?? null)} ／ ${FACE_CN.note} ${seg(noteSeen)}</b>${f.missing.length ? `<b class="miss">缺面：${esc(f.missing.join('／'))}</b>` : ''}<i>展开</i></summary>
    <div class="faces-in">
      <div class="sub">缺任何一面都不许写"无挡止"；三面的母体不同，不并成一格</div>
      ${face(`${FACE_CN.bus} · 未签残量`, f.bus)}
      ${face(`${FACE_CN.panel} · 只展示／不驱动灯`, f.panel, f.shown?.length ? ` <span class="muted">另 ${f.shown.length} 枚只展示</span>` : '')}
      ${f.note.rows.map(noteRow).join('')}
      ${f.missing.length ? `<div class="src unk"><span>覆盖声明：${esc(f.missing.join('／'))} ⇒ 禁推"无挡止"；三面的母体不同，不并成一格</span></div>`
        : '<div class="src"><span>覆盖声明：三面都读到（母体分别＝总线台账／面板可见 state／最近一轮 notes＋旧告警码面）· 不并母</span></div>'}
    </div>
  </details>`;
}

/**
 * 旧码面（brain_alarms）的中文标签与"同名不同物"声明（裁定八十六 §二）。
 * `breaker` 这枚的谓词是"最近窗浏览中位数低于 floor"（sentinel.ts:29-34），
 * 和发布门里那枚 busBreaker（总线台账 breaker_tripped 未签，bus.ts:159-162）**只是同名**。
 * 面板必须把这句话说出来 —— 否则旧码面出现 breaker 会被读成"发布门挡着"，反之亦然。
 */
const LEGACY_CODE_CN = {
  breaker: '熔断（浏览量低于线）', stats_stalled: '回抓停了', no_posts: '停发',
  brain_failing: '大脑调用失败', no_comments: '无评论', outlier_good: '异常好',
  gate_a_cleared: '关卡 A 过线', calls_failing: '判断不成立',
};
const NOT_THE_PUBLISH_GATE = { breaker: '≠ 发布门那枚（这枚谓词＝浏览中位数低于 floor）' };
/** 发布门那枚的反向标签：看到 bus 的 breaker_tripped 时也要说清它不是浏览量熔断。 */
const GATE_KIND_NOTE = { breaker_tripped: '这是发布门那枚（总线台账，未签＝整个自动面被挡），不是旧码面的浏览量熔断' };
function legacyCodeCell(code) {
  const cn = LEGACY_CODE_CN[code] || code;
  return `<span class="pill ${code === 'breaker' ? 'bad' : 'info'}">${esc(cn)}</span>${NOT_THE_PUBLISH_GATE[code] ? `<span class="tag">${esc(NOT_THE_PUBLISH_GATE[code])}</span>` : ''}`;
}

/** 账号切换条：全部 + 每个号；停用号用"停用"旗标压住，不会被看成当前在跑的号。 */
function accountBar(scope) {
  const all = STATE.accounts || [];
  const chip = (id, label, off) => `<button class="chip ${ACCT === id ? 'on' : ''}${off ? ' off' : ''}" onclick="setAcct(${id})">${esc(label)}${off ? ' · 停用' : ''}</button>`;
  return `<div class="acctbar">
    <span class="lbl">账号维度</span>
    <div class="chips">${chip(0, `全部（${scope.caliber.replace(/^合并 /, '')}）`, false)}${all.map(a => chip(a.id, a.label ?? String(a.id), !a.enabled)).join('')}</div>
    <span class="scope">${esc(scope.isOne ? `当前视图＝${scope.label}` : `当前视图＝合并 ${scope.n} 号${scope.off ? `（含 ${scope.off} 停用）` : ''}`)}</span>
  </div>`;
}

async function setAcct(id) {
  const next = Number(id) || 0;
  if (next && !(STATE.accounts || []).some(a => a.id === next)) { toast('这个号不在当前账号列表里', true); return; }
  ACCT = next;
  localStorage.setItem('sf-acct', String(ACCT));
  await render();
}

/**
 * 发布门四枚（`daemon.ts:206`：`opts.live && settings.autoPublish && !breakerNow.tripped && !busBreaker`）。
 *
 * 排程给出的"下一帖 HH:mm 可发"不含这四枚里任何一枚（`schedule.ts:59-88` 只管额度／间隔／时段窗），
 * 所以现网出现过"标签页亮红＋首屏说可发"并存 —— 两个不同谓词被画成同一句话。这里逐枚给
 * 通过／不通过／不可判，并给出挡止那一枚的 kind 残量；面板证明不了的（`live`）就明写证明不了。
 */
function publishGateRows(q) {
  const unacked = (q.alerts || []).filter(a => a && a.kind === 'breaker_tripped' && a.acked !== true);
  const keys = unacked.map(a => a.key);
  const acctAp = q.accountAutoPublish;
  const gates = [
    {
      name: '① opts.live',
      verdict: 'unknown',
      why: '演练轮与实跑轮分不开：`TickResult` 里没有 live 字段（`daemon.ts:56-72`），而 `dryRun` 也推前 `lastTickAt`（`:127`）⇒ 面板无法从载荷证明这一枚，禁当成通过。',
    },
    {
      name: '② settings.autoPublish',
      verdict: q.autoPublish === undefined ? 'unknown' : q.autoPublish ? 'pass' : 'blocked',
      why: q.autoPublish === undefined
        ? '读不到全局 stored 值。'
        : `全局 stored＝${q.autoPublish ? '开' : '关（等人工审核）'}${acctAp === null || acctAp === undefined ? '' : ` · 号级 auto_publish 覆盖＝${acctAp ? '开' : '关'}（生效值看号级那一枚）`}`,
    },
    {
      name: '③ !breakerNow.tripped（浏览量熔断）',
      verdict: q.breaker === undefined || q.breaker === null ? 'unknown' : q.breaker.tripped ? 'blocked' : 'pass',
      why: !q.breaker || q.breaker.tripped === undefined
        ? '这一枚只在 /api/brain 的 breaker 面里，面板没拉到 ⇒ 不可判。'
        : `中位 ${q.breaker.median == null ? '无读数' : Math.round(q.breaker.median)} ／ 线 ${q.breaker.floor} · 窗 ${q.breaker.window} 条${q.breaker.tripped ? ' ⇒ 已停止自动发布，需在 AI 大脑页手动恢复' : ''}`,
    },
    {
      name: '④ !busBreaker（告警总线熔断）',
      verdict: q.alerts === undefined || q.alerts === null ? 'unknown' : unacked.length ? 'blocked' : 'pass',
      why: q.alerts == null
        ? '总线台账读不到 ⇒ 不可判（把不可判当通过＝假绿）。'
        : `breaker_tripped 未确认残量 ${unacked.length} 枚${keys.length ? `（key：${keys.join(' / ')}）` : ''}。挡止按 kind 全量、解除按 (kind,key) 逐枚 —— 签一枚不够，除非该 kind 只剩这一枚。`,
      residual: unacked.length,
    },
  ];
  return gates;
}

/** 四枚里第一个真正挡住的：不可判排在通过之前，绝不算"没挡住"。 */
function blockingGate(gates) {
  return gates.find(g => g.verdict === 'blocked') || gates.find(g => g.verdict === 'unknown') || null;
}

/**
 * 下一班拆两行：排程时刻一行、发布门残量一行。
 * 单值"下一帖 HH:mm"以"可发"语气显示是禁止的 —— 那把两个谓词合成了一句。
 */
function shiftClock(state, gates, scope) {
  const next = state.next || {};
  const blocker = blockingGate(gates);
  const bad = gates.filter(g => g.verdict === 'blocked').length;
  const unk = gates.filter(g => g.verdict === 'unknown').length;
  // 门状态灯：四枚固定用短标签，完整名字与理由悬浮可见、细节可展开。
  const SHORT_GATE = ['live', 'autoPublish', 'breakerNow', 'busBreaker'];
  const chip = (g, i) => `<span class="gatechip ${g.verdict}" title="${esc(g.name)} · ${esc(g.why)}"><i></i>${esc(SHORT_GATE[i] ?? g.name.replace(/（.*?）/g, ''))}</span>`;
  const chips = `<div class="gatechips">${gates.map(chip).join('')}</div>`;
  const proof = `<details class="proof"><summary>判定细节</summary><div class="proof-in">
      <div class="gatewhy"><b>排程时刻</b>＝网格相位（相位随进程换，禁沿用上一轮）· 排程谓词只含额度／间隔／时段窗 —— 这一格不含发布门，门单独看下面四枚</div>
      ${gates.map(g => `<div class="gatewhy">${esc(g.name)} · ${esc(g.why)}</div>`).join('')}
      ${srcLine(tupleOf(scope.n, `${scope.caliber} · 号级 auto_publish 可再覆盖一层`, '排程＝nextSlot（额度／间隔／时段窗）· 门＝daemon.ts:206 四枚'))}
    </div></details>`;
  if (!next.allowed) {
    return `<div class="clockcard"><div class="clock"><span class="clock-nope">不可发</span></div>
      <span class="clock-ago">${esc(next.reason || '原因未记录')}</span>
      <span class="clock-gate ${bad ? 'bad' : 'warn'}">${bad ? `门里 ${bad} 枚不通过、${unk} 枚不可判` : `门里有 ${unk} 枚不可判`}</span>
      ${chips}${proof}</div>`;
  }
  const d = new Date(next.at + 8 * 3600000);
  const p = n => String(n).padStart(2, '0');
  const hm = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  const gate = bad
    ? `<span class="clock-gate bad">门挡 · ${bad} 枚不通过${blocker ? ` · ${esc(blocker.name.replace(/（.*?）/g, ''))}` : ''}</span>`
    : unk ? '<span class="clock-gate warn">门里有不可判</span>' : '<span class="clock-gate ok">四门全过</span>';
  return `<div class="clockcard">
      <div class="clock"><b>${hm}</b><span class="clock-date">${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}</span><span class="clock-ago">距今 ${Math.max(0, Math.round((next.at - Date.now()) / 60_000))} 分</span></div>
      ${gate}${chips}${proof}</div>`;
}

/**
 * 队列／待发布必须点名"一表还是两表"：`pendingQueueCount`（`db/index.ts:1044-1054`）是
 * `posts` ∪ `studio_articles` 两段 UNION ALL，而只看 `posts` 的读数会给出 0 ——
 * 同屏 7 与 0 两个真数就是这么来的，不是时点差。
 */
function queueSplit(postsRows, studioRows, acctId) {
  const pick = rows => (rows || []).filter(r => !acctId || (r.account_id ?? null) === acctId);
  const p = pick(postsRows), a = pick(studioRows);
  const cnt = (rows, st) => rows.filter(r => r.status === st).length;
  return {
    ok: postsRows != null && studioRows != null,
    posts: { draft: cnt(p, 'draft'), approved: cnt(p, 'approved'), n: p.length },
    studio: { draft: cnt(a, 'draft'), approved: cnt(a, 'approved'), n: a.length },
    total: cnt(p, 'draft') + cnt(p, 'approved') + cnt(a, 'draft') + cnt(a, 'approved'),
    acctId: acctId || null,
  };
}

function queueSplitHtml(q, scope) {
  if (!q.ok) return `<div class="src unk">待发布＝两表口径 · 其中一表读不到 ⇒ 不显示合并数（读不到≠零）</div>`;
  return `<div class="kv" style="flex-wrap:wrap;gap:8px;margin-top:6px">
      <span class="pill plain">两表分列：posts 草稿 ${q.posts.draft}／已通过 ${q.posts.approved} · studio_articles 草稿 ${q.studio.draft}／已通过 ${q.studio.approved}</span>
      <span class="pill ${q.total ? 'warn' : 'plain'}">合计 ${q.total} 条 = 号级封顶用的那个数</span>
      ${q.studio.draft + q.studio.approved > 0 ? '<span class="muted">长文草稿计入号级"待发布"是设计意图（共用同一个额度）—— 它会把短帖生成门顶到"已达每日目标"，即使熔断面签了仍按住生成侧。</span>' : ''}
    </div>
    ${srcLine(tupleOf(q.posts.n + q.studio.n, `母体＝posts ∪ studio_articles（两表 UNION ALL）· ${scope.caliber}${q.acctId ? ' · 按号过滤' : ' · 不分号'}`, '只数 draft／approved 两态 · 队列数不过日界'))}`;
}

/**
 * 首屏三问 —— 概览页顶部先把这三个答案给出来：今天发了几帖 ／ 现在被什么挡着 ／ 下一班几点。
 * 三个答案各自带自己的四元组，且"被什么挡着"允许回答"面板读不到"，不允许留空当没挡住。
 * 第二问按**三分出处**建（§9c 判据 4 加 · 裁定八十五）：每条都带着它来自哪一面，
 * 缺哪一面就单独点名哪一面 —— 缺面时禁止任何"无挡止"措辞。
 */
function firstScreen(q) {
  const out = outwardRows(q.rows);
  const today = (q.rows || []).filter(p => p.published_at && bjDay(p.published_at) === bjDay(Date.now()));
  const sent = out.filter(p => p.published_at && bjDay(p.published_at) === bjDay(Date.now()));
  const faces = blockerFaces({ alerts: q.alerts, ops: q.ops, notes: q.notes, alarms: q.alarms });
  const bus = [];
  if (q.breaker && q.breaker.ok && q.breaker.never + q.breaker.refire > 0) {
    bus.push(`[${FACE_CN.bus}] 熔断面未签 ${q.breaker.never + q.breaker.refire} 枚（从未签 ${q.breaker.never} ／ 过窗重火 ${q.breaker.refire}）`);
  }
  const panel = [];
  if (q.hasKey === false) panel.push(`[${FACE_CN.panel}] 没有广场 Key：只能演练`);
  if (q.paused) panel.push(`[${FACE_CN.panel}] 已暂停：${q.pauseReason || '原因未记录'}`);
  if (q.autoPublish === false) panel.push(`[${FACE_CN.panel}] 自动发布关着：等人工审核`);
  if (q.next && q.next.allowed === false) panel.push(`[${FACE_CN.panel}] 下一班不可发：${q.next.reason || '原因未记录'}`);
  if ((q.orphanPending ?? 0) > 0) panel.push(`[${FACE_CN.panel}] ${q.orphanPending} 条无归属账号（只展示，不驱动灯）`);
  const note = faces.note.rows.filter(r => r.seen).map(r => `[${FACE_CN.note}] ${r.cn} —— ${r.where}`);
  const blockers = bus.concat(panel, note);
  // "没读到"与"读到且为空"是两件事：前者只许写不可判，两者都不许写成"无挡止"。
  const unknown = [];
  if (!faces.bus) unknown.push(`${FACE_CN.bus}残量不可判（台账未接入面板）`);
  if (!faces.panel) unknown.push(`${FACE_CN.panel}未算（状态层这轮没跑）`);
  if (!faces.note.ok) unknown.push(`${FACE_CN.note}未取到最近一轮（loop.lastTick 缺位）`);
  return {
    scope: q.scope,
    sentToday: { v: sent.length, tuple: tupleOf(out.length, `${OUTWARD_CALIBER} · 北京日 ${bjDay(Date.now())}`, '库内 published_at 落在北京今日') },
    inLibrary: { v: q.publishedToday ?? out.length, tuple: tupleOf(out.length, OUTWARD_CALIBER, '接口 publishedToday（不区分日界口径见尺）') },
    draftedToday: { v: today.length, tuple: tupleOf(q.rows ? q.rows.length : null, '库内 status=published 行 · 北京日', '面板自算 · 只展示不判读') },
    blockers: blockers.length ? blockers
      : unknown.length ? [`不能判"无挡止"：${unknown.join('／')}`]
        : ['三面都读到、都没有未确认条目（notes 边沿触发 ⇒ 这只算"最近一轮没有新行"，不算"没有"）'],
    faces,
    blockerTuple: tupleOf(q.alertCount ?? null, `三分出处：${FACE_CN.bus}／${FACE_CN.panel}／${FACE_CN.note}（缺面单列，不推无挡止）`, 'kind 全量／残量分列；note 面按 (标记, 最近一轮) 计'),
    next: q.next || null,
    nextTuple: tupleOf(q.scope.n, q.scope.caliber, q.next?.allowed ? '派生式 max(min_interval, ⌊窗长/帖数⌋) · 见"下一班"尺注' : '不可发'),
  };
}

/**
 * 按号表：效果分析那页的后端只读接口没有号参数（补字段归后端），所以这一格是面板自算。
 * 面板自算的行只展示、不参与判定；无归属账号的行单列一行，不并进任何一个号。
 * 整表读不到（rows=null）时返回 ok:false，页面写"未取"，不铺一排 0。
 */
function acctScopeTable(rows) {
  if (!rows) return { ok: false, rows: [] };
  const out = outwardRows(rows);
  const by = {};
  for (const p of out) {
    const id = p.account_id ?? null;
    const r = by[id] || (by[id] = { id, label: id == null ? '无归属账号' : (p.account_label ?? `账号 ${id}`), off: false, n: 0, measured: 0, views: 0, likes: 0, comments: 0, shares: 0 });
    r.n += 1;
    if (p.stats) { r.measured += 1; r.views += p.stats.views || 0; r.likes += p.stats.likes || 0; r.comments += p.stats.comments || 0; r.shares += p.stats.shares || 0; }
  }
  const a = acctScopeOf(STATE.accounts, null);
  for (const acc of (STATE.accounts || [])) if (by[acc.id]) by[acc.id].off = !acc.enabled;
  const list = Object.values(by).sort((x, y) => y.n - x.n);
  const median = vs => { const v = vs.filter(x => x != null).sort((x, y) => x - y); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
  for (const r of list) {
    r.medianViews = median(out.filter(p => (p.account_id ?? null) === r.id && p.stats).map(p => p.stats.views || 0));
    r.per1k = r.views ? Math.round(((r.likes + r.comments + r.shares) / r.views) * 1000) : null;
  }
  return { ok: true, rows: list, n: out.length, mergedCaliber: a.caliber, listed: (STATE.accounts || []).length };
}

function acctTableHtml(t) {
  if (!t.ok) return `<div class="card" style="margin-top:14px"><div class="empty"><b>按号读数未取</b><span>发帖列表拉不到 —— 这里不会铺一排 0，也不会把合并数按号分。</span></div></div>`;
  return `<div class="card" style="margin-top:14px">
    <div class="card-hd"><h3>按号看</h3><span class="sub">面板自算 · 只展示、不参与判定与验收</span></div>
    <div class="tw"><table><thead><tr><th>账号</th><th class="num">已发布（四字段）</th><th class="num">有读数</th><th class="num">中位浏览</th><th class="num">互动/千</th><th class="num">赞·评·转</th></tr></thead>
      <tbody>${t.rows.map(r => `<tr class="${r.id == null ? 'off' : ''}">
        <td><span class="b">${esc(r.label)}</span>${r.off ? '<span class="pill warn plain">已停用 · 不是当前</span>' : ''}</td>
        <td class="num">${r.n}</td>
        <td class="num">${r.measured}<span class="muted"> / ${r.n}</span></td>
        <td class="num">${r.medianViews == null ? '—' : fmtN(r.medianViews)}</td>
        <td class="num">${r.per1k == null ? '无分母 · 不显示' : r.per1k}</td>
        <td class="num muted">${r.likes}·${r.comments}·${r.shares}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">列表里没有四字段齐的已发布行</td></tr>'}</tbody></table></div>
    ${srcLine(tupleOf(t.n, `库内四字段 · 面板自算按号（列表接口前 200 条，不是全库）`, '中位数＝nearest-rank · 互动/千 分母是该号累计浏览量；无读数不并进母体'))}
  </div>`;
}

/** The always-visible strip: what the machine is doing right now, without opening a page. */
/**
 * 侧栏「下一帖」那一行（判据 3 对侧栏同样成立）：单值时刻禁止带"可发"语气。
 * 后缀必须是发布门里第一枚未过的门（不可判也算未过），口径行自己声明"这一行不含发布门"。
 */
function sideNextRow(state, scope, s) {
  const next = state.next;
  if (!next || !next.allowed) {
    return `<div class="mt"><span>下一帖</span><b>暂不可发</b></div>
      <div class="src">${esc(`不可发：${next?.reason || '原因未记录'}`)}</div>`;
  }
  const g = blockingGate(publishGateRows({ alerts: state.alerts, autoPublish: s?.autoPublish, breaker: state.breaker ?? null }));
  const short = g ? g.name.replace(/（.*?）/g, '') : '';
  return `<div class="mt"><span>下一帖</span><b>${hhmm(next.at)} <small>排程</small></b>${
    g ? `<span class="pill ${g.verdict === 'blocked' ? 'bad' : 'warn'} plain" title="${esc(g.name)} · ${esc(g.why)}">门未过：${esc(short)}</span>`
      : '<span class="pill on plain">四枚门都过</span>'}</div>
    <div class="src">${esc(`口径 全局排程（合并 ${scope.n} 号）· 这一行不含发布门 · 尺 ${nominalHint()} 分钟派生 · 依据 ${next.reason || '未记录'}`)}</div>`;
}

function renderChrome() {
  const s = STATE.settings || {};
  const scope = acctScope();
  const [, , sub] = pageMeta(TAB);
  $('#pageTitle').textContent = NAV_FLAT.find(([k]) => k === TAB)?.[1] ?? '概览';
  $('#pageSub').textContent = sub;
  const paused = STATE.pause?.paused;
  const chips = [
    paused ? ['bad', `已暂停：${STATE.pause.reason}`] : [s.autoPublish ? 'on' : 'info', s.autoPublish ? '自动发布中' : '人工审核中'],
    // 合并数必须在场面上就带口径，否则"今日 4 条"会被读成单个号的成绩。
    ['plain', `今日 ${STATE.publishedToday ?? 0} / ${s.dailyCap ?? 0} · ${scope.caliber}`],
    STATE.pending ? ['plain', `队列 ${STATE.pending} 条`] : ['plain', '队列空'],
    [STATE.hasKey ? 'on' : 'warn', STATE.hasKey ? '广场 Key 已配置' : '未配 Key（只能演练）'],
  ];
  $('#topStatus').innerHTML = chips.map(([cls, t]) => `<span class="pill ${cls}">${esc(t)}</span>`).join('');
  const cap = s.dailyCap ?? 0;
  const used = cap ? Math.min(100, ((STATE.publishedToday ?? 0) / cap) * 100) : 0;
  $('#sideFoot').innerHTML = `
    <div class="meter">
      <div class="mt"><span>今日合计 / 全局硬上限</span><b>${STATE.publishedToday ?? 0} / ${cap}</b></div>
      <div class="track"><i style="width:${used}%"></i></div>
      <div class="src">${esc(`口径 ${scope.caliber} · 取于 ${fmtTs(FETCHED_AT)}（北京 · 面板读取时刻）`)}</div>
    </div>
    <div class="mt"><span>自动循环</span><b>${s.autoRun ? (STATE.loop?.lastTick ? ago(STATE.loop.lastTick.at) : '未跑过') : '已关闭'}</b></div>
    ${sideNextRow(STATE, scope, s)}`;
}

async function render() {
  captureLlmForm();
  STATE = await api('/api/status');
  FETCHED_AT = Date.now();
  renderChrome();
  opsRefresh(STATE);
  renderNav();
  $('#pubBtn').textContent = STATE.hasKey ? '发布（需确认）' : '演练发布';
  const el = $('#main');
  if (TAB === 'overview') el.innerHTML = await overview();
  else if (TAB === 'ops') el.innerHTML = await opsView();
  else if (TAB === 'board') el.innerHTML = await boardView();
  else if (TAB === 'rank') el.innerHTML = await rankView();
  else if (TAB === 'accounts') el.innerHTML = await accountsView();
  else if (TAB === 'pool') el.innerHTML = await poolView();
  else if (TAB === 'materials') el.innerHTML = await materialsView();
  else if (TAB === 'queue') el.innerHTML = await queueView();
  else if (TAB === 'insights') el.innerHTML = await insightsView();
  else if (TAB === 'studio') el.innerHTML = await studioView();
  else if (TAB === 'templates') el.innerHTML = await templatesView();
  else if (TAB === 'settings') el.innerHTML = settingsView();
  else if (TAB === 'brain') el.innerHTML = await brainView();
  else if (TAB === 'backup') { el.innerHTML = await backupView(); backupPoll(); }
  else el.innerHTML = await connectView();
}

let OPEN_ACCOUNT = 0;

const STYLE_CHOICES = [
  ['tech', '技术分析派', '冷静专业，讲结构、指标、关键位'],
  ['news', '快讯速递派', '简洁快速，第一时间播报消息'],
  ['data', '数据派', '用数据和榜单说话，信息密度高'],
  ['capital', '资金追踪派', '盯资金流向、费率、持仓变化'],
  ['emotion', '情绪派', '口语化、强情绪，调动共鸣'],
  ['chat', '唠嗑派', '第一人称聊天口吻，像朋友分享'],
  ['joke', '段子手', '幽默玩梗，把行情写成段子'],
];
// 档位贴着定稿的承诺（每号 4 帖/天，区间 3–5）。原来的 12/24/40 是「点一下就把额度抬到
// 承诺的六倍」，而且 24 帖在 45 分钟最小间隔、8:00–24:00 时段下根本铺不满（最多 21 条）。
const CADENCE_PRESETS = [['轻', 3], ['标准', 4], ['积极', 5]];
const CATEGORY_CHOICES = [
  ['newsflash', '快讯消息', '金十、PANews、吴说等快讯'],
  ['announcement', '币安公告', '上新、下架、活动公告'],
  ['market_move', '行情异动', '涨跌、放量、新高新低'],
  ['funding', '资金费率', '各所费率极值与分歧'],
  ['long_short', '多空比', '账户与持仓多空比'],
  ['leaderboard', '涨跌榜', '24 小时涨幅榜 / 跌幅榜'],
  ['attention', '广场热点', '广场热议币、热门话题'],
  ['onchain', 'Hyperliquid', '第二合约所的数据与分歧'],
  ['dex', 'DEX 热门', '链上热门池与放量'],
  ['sentiment', '市场情绪', '恐惧贪婪指数'],
  ['stablecoin', '稳定币', '发行量异常变化'],
];
let TPLIST = [];

/** Live readout of what a cadence actually means, instead of a bare number. */
function intervalHint(ppd, start, end, minInt) {
  const span = (end === 24 ? 1440 : end * 60) - start * 60;
  if (span <= 0 || !ppd) return '';
  const floor = Math.max(1, minInt || 1);
  const reach = Math.max(1, Math.floor(span / floor));
  // 不报一个比最小间隔还密的节奏：24 帖铺在 8:00–24:00 算出「每 40 分钟一帖」，而最小
  // 间隔是 45 分钟——那个数做不到，只会让人以为额度被谁吞了。
  if (ppd > reach) return `这个节奏最多装 ${reach} 条（${span} 分 ÷ ${floor} 分）`;
  return `平均每 ${Math.max(floor, Math.round(span / ppd))} 分钟一帖`;
}

function chipGroup(name, choices, selected) {
  return choices.map(([v, label, desc]) => {
    const on = selected.includes(v);
    return `<label class="chip ${on ? 'on' : ''}"><input type="checkbox" name="${name}" value="${v}" ${on ? 'checked' : ''}>`
      + `<span>${esc(label)}${desc ? `<em>${esc(desc)}</em>` : ''}</span></label>`;
  }).join('');
}

function accountCard(a) {
  const open = OPEN_ACCOUNT === a.id;
  const styles = JSON.parse(a.styles_json || 'null') || [a.style || 'mixed'];
  const cats = JSON.parse(a.categories_json || 'null') || CATEGORY_CHOICES.map(c => c[0]);
  const blockedSyms = JSON.parse(a.blocked_symbols_json || '[]');
  const blockedTpls = JSON.parse(a.blocked_templates_json || '[]');
  const pinned = JSON.parse(a.symbols_json || '[]');
  const ppd = a.posts_per_day ?? STATE.settings.postsPerDay;
  const start = a.active_start_hour ?? STATE.settings.activeStartHour;
  const end = a.active_end_hour ?? STATE.settings.activeEndHour;
  const ap = a.auto_publish === null ? 'inherit' : (a.auto_publish ? 'auto' : 'review');
  // 目标与上限是两个数：目标是这个号自己铺排节奏用的，硬上限是全局共用的天花板。
  const minInt = a.min_interval_minutes ?? STATE.settings.minIntervalMinutes;
  const spanMin = (end === 24 ? 1440 : end * 60) - start * 60;
  const reach = spanMin > 0 ? Math.max(1, Math.floor(spanMin / Math.max(1, minInt))) : ppd;
  const perPost = spanMin > 0 ? Math.max(minInt, Math.round(spanMin / Math.max(1, ppd))) : minInt;
  const mini = (label, value, sub, rows) => `<div class="tile"${rows ? tip(label, rows) : ''}>
      <div class="lbl">${label}</div><div class="v" style="font-size:19px">${value}</div><div class="s">${sub}</div></div>`;
  return `
  <div class="card">
    <div class="card-hd">
      <h3>${esc(a.label)}</h3>
      <span class="sub">${a.owner ? esc(a.owner) + ' · ' : ''}${a.trackId ? `深耕「${esc(a.trackLabel ?? a.trackId)}」长文` : '短帖矩阵：按热度出帖'}</span>
      <span class="right">
        <button class="btn ${a.enabled ? '' : 'primary'}" onclick="toggleAccount(${a.id}, ${a.enabled ? 'false' : 'true'})">${a.enabled ? '停用' : '启用'}</button>
        <button class="btn" onclick="setAccountRole(${a.id}, ${a.trackId ? "'matrix'" : "'trading_literacy'"})">${a.trackId ? '转回短帖矩阵' : '改跑长文'}</button>
        <button class="btn ${open ? 'primary' : ''}" onclick="openAccount(${open ? 0 : a.id})">${open ? '收起设置' : '设置'}</button>
      </span>
    </div>
    <div class="kv" style="gap:7px">
      <span class="pill ${a.enabled ? 'on' : ''}">${a.enabled ? '运行中' : '已停用'}</span>
      <span class="pill ${a.key.set ? 'on' : 'warn'}">${a.key.set ? 'Key ' + esc(a.key.masked) : '缺 Key'}</span>
      ${a.proxy_url ? '<span class="pill on">独立出口 IP</span>' : '<span class="pill warn">共用出口 IP</span>'}
      <span class="pill plain">${a.trackId ? '短帖风格与时段暂不适用' : esc(styles.map(s => STATE.styleLabels[s] || s).join('/'))}</span>
    </div>
    ${a.last_error ? `<div class="alert bad" style="margin-top:10px">
      <svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>
      <div>${esc(a.last_error)}</div></div>` : ''}
    <div class="grid gkpi" style="margin-top:12px">
      ${mini('今日', `${a.today}<small>/${a.trackId ? `${a.articlesPerDay} 篇` : ppd}</small>`, a.trackId ? '长文额度' : '今日目标',
        [['已发', `${a.today}`], ['今日目标', `${a.trackId ? `${a.articlesPerDay} 篇长文` : `${ppd} 帖`}`],
         ['全局硬上限', `${STATE.settings.dailyCap} 帖 · 所有号合计`], ['这个节奏装得下', `${reach} 帖`],
         ['口径', '目标是这个号铺排间隔用的数，硬上限是全局共用的天花板，两者不是一回事']])}
      ${mini('队列', a.pending ?? 0, a.pending ? '已排好分钟' : '空的，下一轮现写',
        [['待发布', `${a.pending ?? 0} 条`], ['说明', a.pending ? '到点由自动循环发出' : '队列空时下一轮会现写现发']])}
      ${mini('下一帖', a.next?.allowed && a.next.at ? hhmm(a.next.at) : '不可发', a.next?.allowed ? fmtTs(a.next.at).slice(0, 5) : esc(a.next?.reason ?? ''),
        [['时间', a.next?.allowed && a.next.at ? fmtTs(a.next.at) : '不可发'], ['依据', a.next?.reason ?? '']])}
      ${mini('节奏', a.trackId ? `${a.articlesPerDay}<small> 篇/天</small>` : `${perPost}<small> 分钟/帖</small>`,
        a.trackId ? '长文赛道自带的间隔' : ppd > reach ? `每天 ${ppd} 帖超出这个节奏 · 最多装 ${reach} 条` : `时段 ${start}:00–${end}:00 · 每天 ${ppd} 帖`,
        [['最小间隔', `${minInt} 分钟`], ['每天目标', `${a.trackId ? `${a.articlesPerDay} 篇长文` : `${ppd} 帖`}`], ['这个节奏装得下', `${reach} 帖（时段 ${spanMin} 分 ÷ 最小间隔 ${minInt} 分）`], ['发帖时段', `${start}:00 – ${end}:00`], ['错峰偏移', `${a.phase_minutes} 分钟`]])}
    </div>
    ${open ? `
    <div class="grp"><div class="gh">发帖节奏</div>
      <div class="kv" style="margin-bottom:8px">
        ${CADENCE_PRESETS.map(([l, n]) => `<button class="btn ${ppd === n ? 'primary' : ''}" onclick="setCadence(${a.id}, ${n})">${l} · ${n} 帖/天</button>`).join('')}
        <span class="muted">自定义</span>
        <input type="number" id="ac-ppd-${a.id}" min="1" max="100" value="${ppd}" style="width:74px" oninput="cadenceHint(${a.id})">
        <input type="hidden" id="ac-start-${a.id}" value="${start}"><input type="hidden" id="ac-end-${a.id}" value="${end}">
        <span class="pill" id="ac-hint-${a.id}">${esc(intervalHint(ppd, start, end, minInt))}</span>
      </div>
      <div class="kv">
        <span class="muted">发帖时段</span>
        <button class="btn ${start === 0 && end === 24 ? 'primary' : ''}" onclick="setWindow(${a.id},0,24)">全天</button>
        <button class="btn ${start === 8 && end === 24 ? 'primary' : ''}" onclick="setWindow(${a.id},8,24)">白天 8–24</button>
        <input type="number" id="ac-start2-${a.id}" min="0" max="23" value="${start}" style="width:60px"> –
        <input type="number" id="ac-end2-${a.id}" min="1" max="24" value="${end}" style="width:60px">
        <span class="muted">北京时间 · 点上面两个按钮会立刻保存</span>
      </div>
    </div>

    <div class="grp"><div class="gh">内容风格 <span class="muted">可多选，每帖从选中的里随机挑一种</span></div>
      <div class="chips">${chipGroup(`styles-${a.id}`, STYLE_CHOICES, styles)}</div>
    </div>

    <div class="grp"><div class="card-hd"><h3>发布方式</h3></div>
      <div class="seg">
        <button class="${ap === 'review' ? 'on' : ''}" onclick="setAutoPublish(${a.id},'review')">先审核再发</button>
        <button class="${ap === 'auto' ? 'on' : ''}" onclick="setAutoPublish(${a.id},'auto')">自动发布</button>
        <button class="${ap === 'inherit' ? 'on' : ''}" onclick="setAutoPublish(${a.id},'inherit')">跟随全局</button>
      </div>
    </div>

    <div class="grp"><div class="card-hd"><h3>广场 API Key</h3></div>
      <div class="inputline">
        <input type="password" id="ac-key-${a.id}" placeholder="${a.key.set ? '已保存 ' + esc(a.key.masked) + ' · 留空则不改动' : '粘贴该号的广场 Key'}" autocomplete="off" onkeydown="if(event.key==='Enter')saveAccountKey(${a.id})">
        <button class="btn" onclick="saveAccountKey(${a.id})">保存 Key</button>
        <button class="btn" onclick="testAccountKey(${a.id})">验证</button>
        <span class="muted" id="ac-result-${a.id}"></span>
      </div>
      <div class="hint">「验证」发一次<b>空正文</b>请求：鉴权先于内容校验，返回「正文为空」即证明 Key 有效，且不会发出任何帖子。只填广场 Key —— 交易所 API Key 能提现能交易，绝对不要填进来。</div>
    </div>

    <details class="grp"><summary class="gh">高级设置 <span class="muted">素材来源、币种黑白名单、模版屏蔽、代理、人设、错峰</span></summary>
      <div class="field"><span class="cap">素材来源 <span class="muted">至少选一个</span></span><div class="chips">${chipGroup(`cats-${a.id}`, CATEGORY_CHOICES, cats)}</div></div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px">
        <div class="field"><span class="cap">只发这些币（留空=自动分配）</span><input type="text" id="ac-syms-${a.id}" value="${esc(pinned.join(', '))}" placeholder="BTC, ETH"></div>
        <div class="field"><span class="cap">不发这些币</span><input type="text" id="ac-deny-${a.id}" value="${esc(blockedSyms.join(', '))}" placeholder="垃圾币、出事币"></div>
        <div class="field"><span class="cap">两帖最小间隔（分）</span><input type="number" id="ac-minint-${a.id}" min="5" max="720" value="${a.min_interval_minutes ?? STATE.settings.minIntervalMinutes}"></div>
        <div class="field"><span class="cap">错峰偏移（分钟）</span><input type="number" id="ac-phase-${a.id}" min="0" max="1439" value="${a.phase_minutes}"></div>
        <div class="field"><span class="cap">发帖语言（尚未生效）</span><select id="ac-lang-${a.id}" disabled><option value="zh-CN" ${a.lang !== 'zh-TW' ? 'selected' : ''}>简体</option><option value="zh-TW" ${a.lang === 'zh-TW' ? 'selected' : ''}>繁體</option></select><div class="hint">这个选项目前只是存下来了，<b>还没有接上转换逻辑</b>，选繁體不会真的输出繁体字。</div></div>
        <div class="field"><span class="cap">代理地址（留空=共用本机 IP）</span><input type="text" id="ac-proxy-${a.id}" value="${esc(a.proxy_url)}" placeholder="http://user:pass@host:port"></div>
      </div>
      <div class="field"><span class="cap">语气补充（只影响措辞，不得放宽事实校验）</span><input type="text" id="ac-persona-${a.id}" value="${esc(a.persona_note)}" placeholder="例如：克制、少用感叹号、结尾爱用一个反问"></div>
      <div class="field"><span class="cap">屏蔽的模版（该号永不使用）</span>
        <select id="ac-tpl-${a.id}" multiple size="6" style="height:auto">${TPLIST.filter(t => !blockedTpls.includes(t.id)).map(t => `<option value="${esc(t.id)}">${esc(t.name)}（${esc(STATE.styleLabels[t.style] || t.style)} · ${esc(t.category)}）</option>`).join('')}</select>
        <div class="hint">已屏蔽 ${blockedTpls.length} 个：<code>${esc(blockedTpls.join(', ') || '无')}</code>。按住 Ctrl/⌘ 多选。<b>把同一个模版在两个号上错开屏蔽，是保证不撞句最直接的办法。</b></div>
      </div>
      <div class="field"><span class="cap">账号名称 / 谁的号</span>
        <div class="inputline"><input type="text" id="ac-label-${a.id}" value="${esc(a.label)}"><input type="text" id="ac-owner-${a.id}" value="${esc(a.owner)}" placeholder="谁的号"></div>
      </div>
    </details>

    <div class="kv" style="margin-top:12px">
      <button class="btn primary" onclick="saveAccount(${a.id})">保存设置</button>
      <button class="btn" onclick="previewAccount(${a.id})">预览几条</button>
      <button class="btn danger" onclick="removeAccount(${a.id})">解绑并删除</button>
    </div>
    <div id="ac-preview-${a.id}"></div>` : ''}
  </div>`;
}

async function accountsView() {
  // The template list is only needed to block templates, so fetch it when a card is open
  // rather than on every render of every tab.
  if (OPEN_ACCOUNT && !TPLIST.length) {
    TPLIST = await api('/api/templates').catch(() => []);
  }
  const accs = STATE.accounts || [];
  const on = accs.filter(a => a.enabled).length;
  const sharedIp = accs.filter(a => a.enabled && !a.proxy_url).length;
  return `
  <div class="card">
    <div class="card-hd"><h3>账号矩阵</h3><span class="sub">每个号一套自己的 Key、人设、节奏和出口 IP；同一个币同一时间只会有一个号发</span>
      <span class="right"><span class="pill ${on ? 'on' : 'warn'}">${on} / ${accs.length} 启用</span></span></div>
    <div class="inputline">
      <input type="text" id="new-acct-label" placeholder="备注名，例如「小李的主号」" onkeydown="if(event.key==='Enter')addAccount()">
      <input type="text" id="new-acct-owner" placeholder="谁的号（可留空）" style="max-width:200px;flex:0 1 200px">
      <button class="btn primary" onclick="addAccount()">添加账号</button>
    </div>
    <div class="hint">新加的号默认停用，填好广场 Key 并自己打开开关才会开始发。广场 Key 只有发帖权限 —— 交易所的 API Key / Secret 绝对不要填进来，那个能提现能交易。</div>
    ${sharedIp > 1 ? `<div class="alert warn" style="margin-top:10px">
      <svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>
      <div>有 ${sharedIp} 个启用的号没有配代理，它们会从同一个出口 IP 发帖 —— 这是平台判定关联账号最直接的信号。</div></div>` : ''}
  </div>
  ${accs.length ? `<div class="stack" style="margin-top:14px">${accs.map(accountCard).join('')}</div>`
    : '<div class="card" style="margin-top:14px"><div class="empty"><b>还没有账号</b><span>加一个号、填上它的广场 Key，再打开开关。</span></div></div>'}
  `;
}

function openAccount(id) { OPEN_ACCOUNT = id; render(); }

async function addAccount() {
  const label = $('#new-acct-label').value.trim();
  if (!label) return toast('先给这个号起个备注名', true);
  const owner = $('#new-acct-owner').value.trim();
  const r = await api('/api/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label, owner }) });
  $('#new-acct-label').value = ''; $('#new-acct-owner').value = '';
  OPEN_ACCOUNT = r.id;
  toast('已添加，默认停用'); await render();
}

async function toggleAccount(id, on) {
  if (on && !(STATE.accounts.find(a => a.id === id)?.key.set)) {
    if (!confirm('这个号还没有广场 Key，启用后它发不出帖子（只会一直失败）。仍要启用吗？')) return;
  }
  await api('/api/accounts/' + id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: on }) });
  toast(on ? '已启用' : '已停用'); await render();
}

function csv(sel) { return (document.querySelector(sel)?.value || '').split(/[,，\s]+/).map(s => s.trim()).filter(Boolean); }
function checkedValues(name) { return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(i => i.value); }

async function patchAccount(id, body) {
  const r = await api('/api/accounts/' + id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await render();
  return r;
}

async function saveAccount(id) {
  const cats = checkedValues(`cats-${id}`);
  if (!cats.length) return toast('素材来源至少选一个，否则这个号无米下锅', true);
  const styles = checkedValues(`styles-${id}`);
  const body = {
    label: $(`#ac-label-${id}`).value.trim(),
    owner: $(`#ac-owner-${id}`).value.trim(),
    styles,
    // The primary style stays as the fallback for anything that still reads one value.
    style: styles[0] || 'mixed',
    categories: cats,
    lang: $(`#ac-lang-${id}`).value,
    postsPerDay: +$(`#ac-ppd-${id}`).value,
    minIntervalMinutes: +$(`#ac-minint-${id}`).value,
    activeStartHour: +$(`#ac-start2-${id}`).value,
    activeEndHour: +$(`#ac-end2-${id}`).value,
    phaseMinutes: +$(`#ac-phase-${id}`).value,
    personaNote: $(`#ac-persona-${id}`).value.trim(),
    proxyUrl: $(`#ac-proxy-${id}`).value.trim(),
    symbols: csv(`#ac-syms-${id}`),
    blockedSymbols: csv(`#ac-deny-${id}`),
  };
  if (!body.label) return toast('备注名不能为空', true);
  const r = await patchAccount(id, body);
  toast(r?.note ?? '已保存');
}

function cadenceHint(id) {
  const ppd = +$(`#ac-ppd-${id}`).value, start = +$(`#ac-start2-${id}`).value, end = +$(`#ac-end2-${id}`).value;
  const el = $(`#ac-minint-${id}`);
  $(`#ac-hint-${id}`).textContent = intervalHint(ppd, start, end, el ? +el.value : STATE.settings.minIntervalMinutes);
}

async function setCadence(id, n) {
  const start = +$(`#ac-start2-${id}`).value, end = +$(`#ac-end2-${id}`).value;
  // 后端会把装不下的额度收到物理上限并说一声，这里原话转达，不让人以为填多少就是多少。
  const r = await patchAccount(id, { postsPerDay: n, activeStartHour: start, activeEndHour: end });
  toast(r?.note ?? `已设为 ${n} 帖/天`);
}

async function setWindow(id, s, e) { await patchAccount(id, { activeStartHour: s, activeEndHour: e }); toast('时段已保存'); }
async function setAutoPublish(id, mode) {
  await patchAccount(id, { autoPublish: mode === 'inherit' ? null : mode === 'auto' });
  toast(mode === 'auto' ? '该号将自动发布' : mode === 'review' ? '该号改为先审核' : '该号跟随全局设置');
}

async function previewAccount(id) {
  const host = $(`#ac-preview-${id}`);
  host.innerHTML = '<div class="muted" style="padding:10px 0">生成中…（预览不入库，不影响实际发帖）</div>';
  try {
    const r = await api(`/api/accounts/${id}/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: 3 }) });
    if (!r.created.length) {
      host.innerHTML = `<div class="result show bad">这个号现在一条都生不出来：${esc((r.skipped[0] || '没有可用素材').slice(0, 200))}</div>`;
      return;
    }
    host.innerHTML = `<div class="result show good">${r.created.map(c => `<div style="margin-top:8px"><b>${esc(c.template)}</b><pre style="white-space:pre-wrap;margin:4px 0 0">${esc(c.text)}</pre></div>`).join('')}</div>`;
  } catch (e) { host.innerHTML = `<div class="result show bad">预览失败：${esc(e.message)}</div>`; }
}

async function saveAccountKey(id) {
  const v = $(`#ac-key-${id}`).value.trim();
  if (!v) return toast('输入框是空的', true);
  await api(`/api/accounts/${id}/key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: v }) });
  $(`#ac-key-${id}`).value = '';
  toast('该号 Key 已保存'); await render();
}

async function testAccountKey(id) {
  const el = $(`#ac-result-${id}`);
  el.textContent = '验证中…';
  try {
    const r = await api(`/api/accounts/${id}/test`, { method: 'POST' });
    el.textContent = `${r.ok ? '✓' : '✗'} ${r.label}`;
    toast(r.ok ? 'Key 有效' : 'Key 有问题', !r.ok);
    await render();
  } catch (e) { el.textContent = '失败：' + e.message; }
}

async function removeAccount(id) {
  const a = STATE.accounts.find(x => x.id === id);
  if (!confirm(`删除「${a?.label ?? id}」？它的 Key 会一并从本机清除，已发出去的帖子不受影响。`)) return;
  await api('/api/accounts/' + id, { method: 'DELETE' });
  OPEN_ACCOUNT = 0;
  toast('已删除'); await render();
}

async function overview() {
  const s = STATE.settings;
  const scope = acctScope();
  // 一次多取一些再按号过滤：直接带 limit=8 的话，选单个号时会在过滤前先丢一批。
  const feedAll = await api('/api/posts?status=published&limit=120').catch(() => []);
  const mine = rowsInScope(feedAll, ACCT).slice(0, 8);
  const fs = firstScreen({
    rows: rowsInScope(feedAll, ACCT), scope, hasKey: STATE.hasKey, paused: STATE.pause?.paused,
    pauseReason: STATE.pause?.reason, autoPublish: s.autoPublish, next: STATE.next,
    publishedToday: STATE.publishedToday, orphanPending: STATE.orphanPending,
    alertCount: STATE.alerts ? STATE.alerts.length : (OPS_LAST ? OPS_LAST.all.length : null),
    breaker: breakerGrid(STATE.alerts ?? null),
    // 挡止面三分（§9c 判据 4 加）：总线台账／面板状态层／最近一轮 tick notes。
    // 这一页**不读 /api/brain**（evaluateBreaker 会写 settings.breaker），所以旧告警码面留给运行台。
    alerts: STATE.alerts, ops: OPS_LAST, notes: STATE.loop?.lastTick?.notes ?? null, alarms: null,
  });
  const cap = s.dailyCap || 1;
  // 发布门四枚：面板证不了 ①（TickResult 无 live 字段），③ 只在 /api/brain 里、这一页不拉它
  // （evaluateBreaker 会写 settings.breaker ⇒ 不在概览的轮询里顺手 latch）。两枚都记"不可判"。
  const gates = publishGateRows({
    alerts: STATE.alerts, autoPublish: s.autoPublish,
    accountAutoPublish: scope.one ? (scope.one.auto_publish ?? null) : null,
    breaker: STATE.breaker ?? null,
  });
  // 瓦片只留三问没有覆盖的三格：运行状态／待发布／待用素材 —— 避免同一个数在首屏出现两遍。
  const tiles = [
    ['运行状态', STATE.pause.paused ? '已暂停' : (s.autoRun ? '运行中' : '已停摆'),
      STATE.pause.paused ? esc(STATE.pause.reason) : (s.autoRun ? `每 ${s.tickMinutes} 分钟一轮 · ${STATE.loop?.lastTick ? '上次 ' + ago(STATE.loop.lastTick.at) : '还没跑过'}` : '自动循环已在设置里关闭'),
      STATE.pause.paused ? 'bad' : s.autoRun ? 'good' : 'warn',
      [['自动发布', s.autoPublish ? '开（到点直接发）' : '关（等人工审核）'], ['自动循环', s.autoRun ? `每 ${s.tickMinutes} 分钟` : '已关闭'], ['上次循环', STATE.loop?.lastTick ? fmtTs(STATE.loop.lastTick.at) : '还没跑过'], ['广场 Key', STATE.hasKey ? '已配置' : '未配置，只能演练'],
       ['母体', `全局设置 · 不分数（${scope.n} 号共用一个开关）`], ['口径', '自动发布＝全局 stored；号级 auto_publish 可再覆盖一层，见账号页'],
       ['尺', `上次循环＝tick 行的轮起时刻（北京）`], ['取于', `${fmtTs(FETCHED_AT)}（北京 · 面板读取时刻）`]]],
    ['待发布', `${STATE.pending ?? 0}<small>条</small>`, STATE.orphanPending ? `<span style="color:var(--red)">${STATE.orphanPending} 条没有归属账号</span>` : '已排好分钟，到点自动发', '',
      (STATE.accounts || []).map(a => [`${a.label}（${a.trackId ? '长文' : '短帖'}${a.enabled ? '' : ' · 停用'}）`, `队列 ${a.pending} · 今日 ${a.today}/${a.articlesPerDay ?? a.posts_per_day ?? s.postsPerDay}`]
      ).concat([['母体', `${scope.n} 号 · ${scope.caliber}`], ['口径', `接口 pending＝posts(draft,approved)＋studio_articles(draft,approved)，${scope.isOne ? '按号' : '不分号'}`],
       ['尺', '队列数不过日界（同 pendingQueueCount）—— 长文积压不随 08:00 释放'], ['取于', `${fmtTs(FETCHED_AT)}（北京 · 面板读取时刻）`]])],
    ['待用素材', `${STATE.unused}<small>条</small>`, '近 6 小时抓到、还没生成过', '',
      [['母体', '素材表 · 不按号分（素材没有账号归属）'], ['口径', 'unused＝近 6 小时抓到且未生成过'],
       ['尺', '抓取时刻（素材 at）'], ['取于', `${fmtTs(FETCHED_AT)}（北京 · 面板读取时刻）`],
       ['账号维度', '本数不适用 —— 素材在生成草稿时才挂号；强行按号切会造出一个假维度']]],
  ];

  const acctRows = (STATE.accounts || []).map(a => `<tr class="${ACCT === a.id ? 'sel' : ''}${a.enabled ? '' : ' off'}">
      <td><span class="b">${esc(a.label)}</span>${a.owner ? `<span class="sub">${esc(a.owner)}</span>` : ''}${a.enabled ? '' : '<span class="pill warn plain">已停用 · 不是当前</span>'}</td>
      <td>${a.trackId ? `<span class="pill on">${esc(a.trackLabel)} 长文</span>` : a.enabled ? '<span class="pill on">短帖矩阵</span>' : '<span class="pill">已停用</span>'}</td>
      <td class="num">${a.today} <span class="muted">/ ${a.articlesPerDay ?? a.posts_per_day ?? s.postsPerDay}</span></td>
      <td class="num">${a.pending}</td>
      <td class="num">${a.next?.allowed ? hhmm(a.next.at) : '<span class="muted">不可发</span>'}<span class="sub">${a.next?.allowed ? '' : esc(a.next?.reason ?? '')}</span></td>
      <td>${a.key?.set ? '<span class="pill on plain">Key 已配</span>' : '<span class="pill warn plain">缺 Key</span>'}${a.proxy_url ? '' : ' <span class="pill warn plain">共用 IP</span>'}</td>
    </tr>`).join('');

  const feed = mine.length ? mine.map(p => `<div class="feed-row">
      <span class="feed-t">${ago(p.published_at ?? p.created_at)}</span>
      <span class="feed-x">${esc((p.text || '').split('\n')[0].slice(0, 46))}</span>
      <span class="feed-a">${esc(p.account_label ?? '无归属')}</span>
      <span class="feed-v">${p.stats ? fmtN(p.stats.views) + ' 看' : '读数中'}</span>
    </div>`).join('') : '<div class="empty"><b>这个视图里没有已发布内容</b><span>第一条发出去之后，这里会按时间倒序列出最近的帖子；换号或点"全部"看别的号。</span></div>';

  const cats = (STATE.materials || []).map(m => ({ ...m, label: CATEGORY_LABELS[m.category] ?? m.category }))
    .sort((a, b) => b.n - a.n);
  const catMax = Math.max(1, ...cats.map(m => m.n));

  const perf = (STATE.performance || []).slice(0, 8);
  const perfRows = perf.map(r => `<tr>
      <td><span class="b">${esc(r.name || r.template_id)}</span><span class="sub">${esc(r.template_id)}</span></td>
      <td class="num">${r.posts}</td>
      <td class="num b">${Math.round(r.avg_views)}</td>
      <td class="num">${Number(r.weight).toFixed(2)}</td>
    </tr>`).join('');

  // 首屏三问的"无挡止"形态：三面都读到且都没有未确认条目 —— 这句话很长，但它是好消息。
  const clearDay = fs.blockers.length === 1 && fs.blockers[0].startsWith('三面都读到');
  const capN = s.dailyCap || 0;
  const pct = capN ? Math.min(100, Math.round((fs.sentToday.v / capN) * 100)) : 0;

  return `
  ${accountBar(scope)}

  <div class="card first3">
    <div class="card-hd"><h3>首屏三问</h3><span class="sub">今天发了几帖 · 现在被什么挡着 · 下一班几点</span>
      <span class="right"><span class="muted">${esc(scope.caliber)}</span></span></div>
    <div class="grid g3">
      <div class="q qbig"><i>今天发了几帖</i>
        <div class="qrow">
          <div class="ring${pct >= 100 ? ' full' : ''}" style="--p:${pct}%"><div class="rv"><b>${fs.sentToday.v}</b><small>/ ${capN || '—'}</small></div></div>
          <div class="qside"><span>对外口径＝四字段齐</span><span>接口今值 ${STATE.publishedToday ?? '未取'} / ${capN || '—'}</span></div>
        </div>
        ${srcLine(fs.sentToday.tuple)}</div>
      <div class="q qbig"><i>现在被什么挡着</i>
        <b class="qstat ${clearDay ? 'ok' : 'bad'}">${clearDay ? '通行' : '被挡'}</b>
        <span class="qwhy">${esc(fs.blockers[0])}</span>
        ${fs.blockers.length > 1 ? `<details class="src"><summary>另 ${fs.blockers.length - 1} 项 · 展开</summary><span>${fs.blockers.slice(1).map(esc).join('<br>')}</span></details>` : ''}
        ${srcLine(fs.blockerTuple)}</div>
      <div class="q qbig"><i>下一班几点 —— 排程与门是两件事</i>
        ${shiftClock(STATE, gates, scope)}</div>
    </div>
    ${blockerFacesHtml(fs.faces)}
  </div>

  ${STATE.warnings?.length ? STATE.warnings.map(w => `<div class="alert bad" style="margin-bottom:14px">
      <svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>
      <div>${esc(w)}</div></div>`).join('') : ''}

  <div class="grid gkpi">
    ${tiles.map(([label, value, sub, tone, rows]) => `<div class="tile ${tone}"${rows ? tip(label, rows) : ''}>
      <div class="lbl">${label}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`).join('')}
  </div>

  <div class="grid g2" style="margin-top:14px">
    <div class="card">
      <div class="card-hd"><h3>账号一览</h3><span class="sub">谁在干什么、今天发了多少</span>
        <span class="right"><button class="btn sm" onclick="go('accounts')">管理账号</button></span></div>
      <div class="tw"><table><thead><tr><th>账号</th><th>岗位</th><th class="num">今日/目标</th><th class="num">队列</th><th class="num">下一帖</th><th>密钥与出口</th></tr></thead>
        <tbody>${acctRows || '<tr><td colspan="6"><div class="empty"><b>还没有账号</b><span>加一个号、填上它的广场 Key，再打开开关。</span></div></td></tr>'}</tbody></table></div>
      ${srcLine(tupleOf((STATE.accounts || []).length, '账号表全量 · 停用号带旗标、不算"当前"', '今日＝接口 accountPostsToday（北京日界）· 目标＝该号 posts_per_day（铺排间隔用）· 硬上限是全局 dailyCap，在设置页 · 队列＝pendingQueueCount 按号'))}
    </div>
    <div class="card">
      <div class="card-hd"><h3>刚刚发出去</h3><span class="sub">${esc(scope.label)} · 最近 ${mine.length} 条 · 按时间</span>
        <span class="right"><button class="btn sm" onclick="go('queue')">全部记录</button></span></div>
      <div class="feed">${feed}</div>
      ${srcLine(tupleOf(outwardRows(rowsInScope(feedAll, ACCT)).length, `${OUTWARD_CALIBER} · ${scope.caliber}`, '抓取列表前 120 条（LIMIT，不是全库）· 账号维度在面板侧过滤'))}
    </div>
  </div>

  <div class="grid g2" style="margin-top:14px">
    <div class="card">
      <div class="card-hd"><h3>素材库存</h3><span class="sub">按分类，条数与最高分</span>
        <span class="right"><button class="btn sm" onclick="go('materials')">看素材</button></span></div>
      ${cats.length ? `<div class="hbars">${cats.slice(0, 9).map(m => `<div class="hbar">
          <span>${esc(m.label)}</span>
          <span class="track"><i style="width:${Math.max(3, (m.n / catMax) * 100)}%"></i></span>
          <span class="v"${tip(m.label, [['条数', m.n + ' 条'], ['最高分', m.best.toFixed(0)]])}>${m.n}<span class="muted">最高 ${m.best.toFixed(0)} 分</span></span>
        </div>`).join('')}</div>` : '<div class="empty"><b>还没有素材</b><span>点右上角「抓取素材」，或等自动循环下一轮自己抓。</span></div>'}
      ${srcLine(tupleOf((STATE.materials || []).reduce((a, m) => a + m.n, 0), '素材表按分类 · 不按号分（素材在生成草稿时才挂号）', '接口 materials：每类的条数与最高分 · 账号维度不适用'))}
    </div>
    <div class="card">
      <div class="card-hd"><h3>当前节奏与护栏</h3><span class="sub">全局设置，账号可各自覆盖</span>
        <span class="right"><button class="btn sm" onclick="go('settings')">改设置</button></span></div>
      <table><tbody>
        <tr><td>目标帖数</td><td class="num b">${s.postsPerDay} 帖/天</td></tr>
        <tr><td>最小间隔</td><td class="num b">${s.minIntervalMinutes} 分钟（实际按 ${nominalHint()} 分钟排）</td></tr>
        <tr><td>发帖时段</td><td class="num b">${s.activeStartHour}:00 – ${s.activeEndHour}:00 北京时间</td></tr>
        <tr><td>同一说法冷却</td><td class="num b">${Math.round(s.fingerprintCooldownMinutes / 60)} 小时</td></tr>
        <tr><td>敏感词</td><td class="num b">${s.sensitiveWords.length} 个</td></tr>
        <tr><td>AI 润色</td><td class="num b">${s.llmEnabled ? '开 · ' + esc(s.llmModel || '未填模型') : '关'}</td></tr>
      </tbody></table>
      <div class="hint">所有数字都来自交易所公开接口；模版只能引用素材里已声明的字段，生成后还要过一次事实台账校验，凭空出现的数字或币种会被打回。</div>
    </div>
  </div>

  <div class="card" style="margin-top:14px">
    <div class="card-hd"><h3>模版表现</h3><span class="sub">权重按实测浏览自动调整</span>
      <span class="right"><button class="btn sm" onclick="go('templates')">模版库</button></span></div>
    ${perf.length ? `<div class="tw"><table><thead><tr><th>模版</th><th class="num">用过</th><th class="num">平均浏览</th><th class="num">当前权重</th></tr></thead><tbody>${perfRows}</tbody></table></div>
      <div class="hint">同一模版攒够 3 条有读数的帖子才动权重，单次调幅有上限并夹在 0.3–3 之间 —— 一条运气好的帖子不能让它吃掉整个排期。</div>`
      : '<div class="empty"><b>还没有读数</b><span>帖子发出约 20 分钟后第一次扫榜才会有数字，且只有当时还挂在热榜或资讯榜上的帖子能测到。</span></div>'}
  </div>`;
}

/** The spacing the scheduler will actually use, which is not always 最小间隔. */
function nominalHint() {
  const s = STATE.settings;
  const span = (s.activeEndHour === 24 ? 1440 : s.activeEndHour * 60) - s.activeStartHour * 60;
  return Math.max(s.minIntervalMinutes, Math.floor(span / Math.max(1, s.postsPerDay)));
}

async function poolView() {
  const p = await api('/api/pool');
  const rows = p.entries.map(e => `
    <tr>
      <td class="num muted">#${e.rank}</td>
      <td class="b">$${esc(e.symbol)}</td>
      <td class="num score ${scoreCls(e.score)}">${e.score.toFixed(1)}</td>
      <td class="num">${e.squareViews.toLocaleString('en-US')}</td>
      <td class="num muted">${e.squarePosts}</td>
      <td class="num" style="color:${e.market && e.market.chg24h < 0 ? 'var(--red)' : 'var(--green)'}">${e.market ? (e.market.chg24h >= 0 ? '+' : '') + e.market.chg24h.toFixed(2) + '%' : '—'}</td>
      <td class="num">${e.market ? e.market.volMultiple.toFixed(1) + 'x' : '—'}</td>
      <td class="num">${e.sustainedMinutes} 分 / ${e.samples} 次</td>
      <td class="muted">${esc(e.agreeing)}</td>
      <td>${e.mature ? '<span class="pill on">可发</span>' : `<span class="pill">${esc(e.blocked ?? '未成熟')}</span>`}</td>
    </tr>`).join('');

  return `
  <div class="card">
    <div class="card-hd"><h3>广场热度榜</h3><span class="sub">门槛 ${p.threshold} 分 · 需持续 ${p.matureMinutes} 分钟 · 共 ${p.entries.length} 个币在观察</span>
      <span class="right">
        <button class="btn sm" onclick="reloadPool()">重新采样</button>
        <button class="btn sm primary" ${p.entries.some(e => e.mature) ? '' : 'disabled'} onclick="genFromPool()">生成跟进帖</button>
      </span></div>
    <div class="hint" style="margin-top:0">选题来自币安广场的实时讨论热度，数字来自币安合约行情。刚进榜的币要连续采样到成熟才会发 —— 这是「发专帖、不抢第一波」的代价。</div>
  </div>
  <div class="card" style="margin-top:14px"><div class="tw"><table>
    <thead><tr><th class="num">榜位</th><th>币</th><th class="num">热度</th><th class="num">广场浏览</th><th class="num">帖数</th><th class="num">24h</th><th class="num">1h 量能</th><th class="num">持续 / 采样</th><th>信号</th><th>状态</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="10"><div class="empty"><b>还没有采样数据</b><span>点「重新采样」拉一轮，或等自动循环采样。</span></div></td></tr>'}</tbody></table></div></div>
  <div class="card" style="margin-top:14px"><div class="card-hd"><h3>广场热门话题</h3><span class="sub">当前流里实时出现的标签</span></div>
    <div class="tw"><table><thead><tr><th>话题</th><th class="num">浏览</th><th class="num">帖数</th><th class="num">本流出现</th></tr></thead><tbody>${p.topics.map(t => `<tr><td class="b">#${esc(t.tag)}</td><td class="num">${t.views.toLocaleString('en-US')}</td><td class="num">${t.posts}</td><td class="num muted">${t.recentUses}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">暂无</td></tr>'}</tbody></table></div>
    ${p.errors.length ? `<div class="alert warn" style="margin-top:10px"><svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg><div>部分源失败：${p.errors.map(esc).join('； ')}</div></div>` : ''}
  </div>`;
}

async function reloadPool() {
  toast('采样中…');
  await api('/api/pool?refresh=1');
  await render();
}
async function genFromPool() {
  const r = await api('/api/generate-pool', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: 2 }) });
  toast(`成熟 ${r.matureCount} 个，生成 ${r.created.length} 条${r.errors.length ? `，${r.errors.length} 个错误` : ''}`, !!r.errors.length);
  await go('queue');
}

async function materialsView() {
  const rows = await api('/api/materials?limit=120');
  const byCat = {};
  for (const m of rows) byCat[m.categoryCn] = (byCat[m.categoryCn] || 0) + 1;
  return `<div class="card">
    ${accountBar(acctScope())}
    <div class="card-hd"><h3>素材库</h3><span class="sub">最近抓到的 ${rows.length} 条原始素材 · 分数越高越值得发</span>
      <span class="right"><button class="btn sm" onclick="act('collect')">抓取素材</button></span></div>
    <div class="hint" style="margin-top:0">每条素材都有保质期：多空比、费率这类数字一小时后就是错的陈述。过期素材会在自动循环里被作废，不会变成帖子。</div>
    ${srcLine(tupleOf(rows.length, `素材表 · 账号维度不适用（素材在生成草稿时才挂号）· 当前视图 ${acctScope().caliber}`, '列表接口前 120 条（LIMIT，不是全库）· 尺＝素材抓取时刻 at'))}
  </div>
  <div class="card" style="margin-top:14px">
    <div class="tw"><table>
      <thead><tr><th class="num">分</th><th>信号</th><th>内容</th><th>来源</th><th class="num">抓到</th></tr></thead>
      <tbody>${rows.map(m => `<tr>
        <td class="num score ${scoreCls(m.score)}">${m.score.toFixed(0)}</td>
        <td><span class="tag">${esc(m.categoryCn)}</span>${m.subType ? `<span class="sub">${esc(m.signalCn.replace(m.categoryCn + ' · ', '') || '')}</span>` : ''}</td>
        <td>${esc(m.title)}${m.symbol ? ` <span class="tag">$${esc(m.symbol)}</span>` : ''}</td>
        <td class="muted">${esc(m.source)}</td>
        <td class="num muted">${ago(m.at)}</td></tr>`).join('') || '<tr><td colspan="5"><div class="empty"><b>还没有素材</b><span>点「抓取素材」拉一轮，或等自动循环。</span></div></td></tr>'}
      </tbody></table></div>
    ${Object.keys(byCat).length ? `<div class="legend">${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span>${esc(k)} ${v}</span>`).join('')}</div>` : ''}
  </div>`;
}

async function queueView() {
  const scope = acctScope();
  const posts = rowsInScope(await api(`/api/posts?${POST_FILTER === '全部' ? '' : 'status=' + encodeURIComponent(POST_FILTER) + '&'}sort=${POST_SORT}`), ACCT);
  const all = await api('/api/posts').catch(() => null);
  const counts = all === null ? [] : rowsInScope(all, ACCT);
  // 六格用整表算，不用被状态筛过的列表算 —— 否则选"已发布"时其余五格全成 0，那是假象。
  // 整表拉不到时传 null：sixGrid 渲染"未取"，绝不把读不到铺成一排 0。
  const grid = sixGrid(all === null ? null : counts);
  // 两表口径：pendingQueueCount 是 posts ∪ studio_articles，只看一表必然同屏出现两个真数。
  // /api/studio 是只读列表（articles 里带 status 与 account_id）；拿不到就单列"读不到"。
  const studio = await api('/api/studio').catch(() => null);
  const studioArticles = studio && Array.isArray(studio.articles) ? studio.articles : null;
  const byStatus = {};
  for (const p of counts) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;

  const label = { 全部: '全部', published: '已发布', draft: '待审核', approved: '已通过', rejected: '已驳回', failed: '失败', uncertain: '状态未知' };
  const chips = ['全部', ...STATUS_SIX]
    .map(t => `<button class="chip ${t === POST_FILTER ? 'on' : ''}" onclick="setPostFilter('${t}')">${label[t] ?? t}${t === '全部' ? ` ${counts.length}` : ` ${byStatus[t] ?? 0}`}</button>`)
    .join('');

  const n = posts.filter(p => p.stats).length;
  const sum = k => posts.reduce((s, p) => s + ((p.stats && p.stats[k]) || 0), 0);
  const banner = POST_FILTER === 'published' && posts.length
    ? `<div class="kv" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
        <span class="pill plain">已读数 ${n} / ${posts.length}</span>
        <span class="muted">浏览 ${fmtN(sum('views'))} · 赞 ${sum('likes') || 0} · 评 ${sum('comments') || 0} · 转 ${sum('shares') || 0}</span>
        <span class="spacer" style="flex:1"></span>
        <button class="btn sm" onclick="go('insights')">看效果分析 →</button>
      </div>` : '';

  const warn = (STATE.warnings ?? []).length
    ? STATE.warnings.map(w => `<div class="alert bad" style="margin-top:14px">
        <svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>
        <div>${esc(w)}</div></div>`).join('')
    : '';

  return `<div class="card">
    ${accountBar(scope)}
    <div class="card-hd"><h3>发帖记录</h3><span class="sub">${counts.length} 条 · ${esc(scope.caliber)}${all && unownedCount(counts) ? ` · 其中 ${unownedCount(counts)} 条无归属账号（只展示）` : ''}</span>
      <span class="right"><div class="seg">
        <button class="${POST_SORT === 'recent' ? 'on' : ''}" onclick="setPostSort('recent')">最新</button>
        <button class="${POST_SORT === 'views' ? 'on' : ''}" onclick="setPostSort('views')">浏览最多</button>
      </div></span></div>
    <div class="chips">${chips}</div>
    ${banner}
    <div class="hint">按浏览量排序时，还没拿到读数的帖子排在最后，不会被当成 0 浏览。状态六格分列、不并母。</div>
    ${statusGridHtml(grid, scope)}
    ${queueSplitHtml(queueSplit(all, studioArticles, ACCT), scope)}
    ${breakerHtml(STATE.alerts ?? null)}
  </div>
  ${warn}
  ${posts.length ? `<div style="margin-top:14px">${posts.map(postCard).join('')}</div>`
    : '<div class="card" style="margin-top:14px"><div class="empty"><b>这个视图里没有记录</b><span>换个号或点"全部账号"；先「抓取素材」再「生成草稿」，草稿会出现在这里等审核或直接发布。</span></div></div>'}`;
}

/** 状态六格分列：一格都不并母；0 就是 0，整表读不到才是"未取"。 */
function statusGridHtml(grid, scope) {
  const cells = grid.cells.map(([st, n]) => `<div class="sg${n == null ? ' unk' : ''}">
      <i>${esc(STATUS_LABELS[st] || st)}</i><b>${n == null ? '未取' : n}</b></div>`).join('')
    + (grid.other ? `<div class="sg other"><i>非六格状态</i><b>${grid.other}</b></div>` : '');
  return `<div class="sixgrid">${cells}</div>
    ${srcLine(tupleOf(grid.ok ? (grid.cells.reduce((a, [, n]) => a + (n || 0), 0)) : null,
      `${scope.caliber} · 状态六格分列（不并母、不合并）`,
      grid.ok ? `列表接口全量（LIMIT 150/页 · 账号维度在面板侧过滤）${grid.other ? ` · 另有 ${grid.other} 条不在六格内` : ''}` : '整表读不到 · 六格一律显示"未取"'))}`;
}

/**
 * 熔断两栏：`acked:false` 有"从未签"与"签后过 24h 窗重火"两态，只有 ackedAt 能区分，
 * 所以禁止压成一栏"未签"。
 * 参数只能是总线台账（/api/status.alerts）—— 面板自算的那几项不是台账，把它们喂进来
 * 会让"残量 0"显示成绿灯，而那正是投影面替代事实面的形状。
 */
function breakerHtml(ledger) {
  const g = breakerGrid(ledger);
  const kinds = alertKinds(ledger);
  return `<div class="kv" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);flex-wrap:wrap;gap:8px">
      <span class="pill ${g.ok && g.never + g.refire > 0 ? 'bad' : g.ok ? 'on' : 'warn'}">${g.ok ? `熔断台账：从未签 ${g.never} · 签后过窗重火 ${g.refire} · 已签 ${g.acked}（发布门那枚，非旧码面浏览量熔断）` : '熔断残量：总线台账未接入面板 · 不可判'}</span>
      ${kinds.ok ? (kinds.rows.length ? kinds.rows.map(r => `<span class="pill plain">${esc(KIND_CN[r.kind] || r.kind)} 全量 ${r.total} · 未确认 ${r.unacked}${r.keys.length ? ` · key ${esc(r.keys.join('/'))}` : ''}</span>`).join('') : '<span class="muted">总线这一轮读到 0 枚条目 —— 这是读到空集，不是"无挡止"。</span>')
        : '<span class="muted">按 kind 的全量／残量要等总线落地；面板自算的那几项在运行台单列，不冒充台账残量。</span>'}
    </div>
    <div class="hint">${g.ok ? 'acked:false 是两态 —— 只有 ackedAt 能区分"从未签"与"签后过 24h 窗重火"，所以不并成一栏。' : '读不到就写不可判：把不可判铺成 0 会让面板显示"没有熔断"，那是假绿。'}</div>
    ${srcLine(tupleOf(g.ok ? g.total : null,
      g.ok ? 'kind 全量与 (kind,key) 残量分列 · HTTP 200 与"我签那枚变绿"都不算解除' : '熔断与告警残量：读不到（来源＝/api/status.alerts）',
      g.ok ? 'ledger 的 acked／ackedAt 双字段（两态靠 ackedAt 区分，唯一写点 bus.ts:137）' : '现网 /api/status 无 alerts 字段 · 禁把读不到写成 0'))}`;
}

function postCard(p) {
  const bits = [
    p.account_label ? esc(p.account_label) : null,
    p.signalCn ? esc(p.signalCn) : null,
    p.styleCn ? esc(p.styleCn) : null,
    p.symbol ? `$${esc(p.symbol)}` : null,
  ].filter(Boolean);
  // A published post with no reading is a timing fact, not a zero. Saying "浏览 0" would
  // misreport a post that simply has not reached its first checkpoint yet.
  const stat = p.status === 'published'
    ? (p.stats
      ? `<span class="kv" style="gap:10px">${[['浏览', fmtN(p.stats.views || 0)], ['赞', p.stats.likes || 0], ['评', p.stats.comments || 0], ['转', p.stats.shares || 0]]
        .map(([k, v]) => `<span class="kv" style="gap:4px"><i class="sk">${k}</i><b>${v}</b></span>`).join('')}<span class="muted">${ago(p.stats.checked_at)}</span></span>`
      : '<span class="pill warn">尚无数据 · 发出约 20 分钟后出首个读数</span>')
    : p.status === 'approved' ? `<span class="pill info">计划 ${fmtTs(p.scheduled_at)} 发</span>` : '';
  const acts = [
    p.status === 'draft' ? `<button class="btn sm primary" onclick="postAct(${p.id},'approve')">通过</button>
      <button class="btn sm danger" onclick="postAct(${p.id},'reject')">驳回</button>` : '',
    p.status === 'approved' ? `<button class="btn sm" onclick="postAct(${p.id},'unapprove')">撤回审核</button>
      <button class="btn sm danger" onclick="postAct(${p.id},'reject')">驳回</button>` : '',
    ['draft', 'approved', 'rejected'].includes(p.status) ? `<button class="btn sm" onclick="edit(${p.id})">编辑正文</button>` : '',
    `<button class="btn sm" onclick="reroll(${p.id}, false)">换一条</button>`,
    `<button class="btn sm" onclick="toggleTrace(${p.id})">溯源</button>`,
    p.url ? `<a class="btn sm ghost" href="${esc(p.url)}" target="_blank" rel="noopener">在广场查看 ↗</a>` : '',
  ].filter(Boolean).join('');
  return `
    <div class="post" id="post-${p.id}">
      <div class="meta">
        <span class="st ${esc(p.status)}">${esc(STATUS_LABELS[p.status] || p.status)}</span>
        <span class="b">#${p.id}</span>
        ${bits.map(b => `<span>${b}</span>`).join('<span class="muted">·</span>')}
        ${p.onBoard ? '<span class="pill on">上过公开榜</span>' : ''}
        <span class="spacer" style="flex:1"></span>
        ${stat}
      </div>
      <div class="body" id="body-${p.id}">${esc(p.text)}</div>
      <div id="trace-${p.id}" class="hide"></div>
      ${(p.images ?? []).length ? `<div class="row" style="margin-top:10px;flex-wrap:wrap">${p.images.map(u => `<img src="${esc(u)}" alt="K线图" style="max-width:100%;width:420px;border:1px solid var(--border);border-radius:var(--r-sm)" onerror="chartGone(this)">`).join('')}</div>` : ''}
      ${p.error ? `<div class="alert bad" style="margin-top:10px">
        <svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>
        <div>${esc(p.error)}</div></div>` : ''}
      <div class="post-ft">${acts}<span class="muted" style="margin-left:auto">${p.status === 'published' ? '发布 ' + fmtTs(p.published_at) : '生成 ' + fmtTs(p.created_at)}</span></div>
    </div>`;
}

const STATUS_LABELS = { draft: '待审核', approved: '已通过', published: '已发布', rejected: '已驳回', failed: '失败', uncertain: '状态未知' };

/**
 * Chart PNGs are reclaimable and get pruned on a retention clock, so a published post's
 * local image file is expected to disappear while the post itself stays live on Square
 * (the copy that was uploaded at publish time is on their CDN). A broken image icon reads
 * as a failure; this says what actually happened.
 */
function chartGone(el) {
  const note = document.createElement('span');
  note.className = 'muted';
  note.textContent = '本地 K 线图已按保留期清理 · 发布时上传的那份仍在广场上';
  el.replaceWith(note);
}
const CATEGORY_LABELS = { market_move: '行情异动', funding: '资金费率', long_short: '多空持仓', leaderboard: '涨跌幅榜', sentiment: '市场情绪', stablecoin: '稳定币', trending: '热搜话题', onchain: '链上数据', dex: 'DEX 热门', attention: '广场热度', announcement: '币安公告', newsflash: '快讯消息', liquidation: '爆仓', open_interest: '持仓异动', etf_flow: 'ETF 资金流' };
const STYLE_LABELS = { tech: '技术结构派', capital: '资金追踪派', data: '数据派', news: '消息转述派', emotion: '情绪派', chat: '第一人称派', joke: '段子手', any: '通用', mixed: '混合风格' };

let POST_FILTER = '全部';
let POST_SORT = 'recent';
let ANALYSIS_DAYS = 14;

async function setPostFilter(t) { POST_FILTER = t; await render(); }
async function setPostSort(s) { POST_SORT = s; await render(); }
async function setAnalysisDays(d) { ANALYSIS_DAYS = d; await render(); }

const fmtN = x => (x >= 10000 ? (x / 10000).toFixed(1) + ' 万' : String(x ?? 0));

const KIND_STYLE = {
  lead: { cls: 'on', tag: '值得深挖' },
  cut: { cls: 'warn', tag: '建议压缩' },
  watch: { cls: '', tag: '需要区分' },
  info: { cls: '', tag: '现状' },
};

async function insightsView() {
  const r = await api('/api/stats/summary?days=' + ANALYSIS_DAYS);
  const t = r.totals;
  const days = [7, 14, 30].map(d => `<button class="chip ${d === ANALYSIS_DAYS ? 'on' : ''}" onclick="setAnalysisDays(${d})">最近 ${d} 天</button>`).join('');

  if (!t.posts) {
    return `<div class="card">
      ${accountBar(acctScope())}
      <div class="chips">${days}</div>
      <div class="muted" style="margin-top:12px">还没有已发布的帖子，所以没有任何效果数据。等第一条发出去约 20 分钟，第一个读数会自己进来。</div>
      ${srcLine(tupleOf(0, `${OUTWARD_CALIBER} · ${acctScope().caliber}`, `近 ${ANALYSIS_DAYS} 北京日 · 母体为零 ⇒ 本页不显示任何比率`))}
    </div>`;
  }

  const kpi = (label, value, sub, rows, tn, tcaliber, truler) => `<div class="tile"${tip(label, (rows || []).concat([['母体 n', tn == null ? '未取' : `${tn} 条`], ['口径', tcaliber], ['尺', truler], ['取于', `${fmtTs(FETCHED_AT)}（北京 · 面板读取时刻）`]]))}>
      <div class="lbl">${label}</div><div class="v" style="font-size:22px">${value}</div>
      ${sub ? `<div class="s">${sub}</div>` : ''}
      ${srcLine(tupleOf(tn, tcaliber, truler))}
    </div>`;

  // The reach/attraction pair is the whole point of this page, so it is shown side by side
  // rather than merged into one "performance" number that would hide the difference.
  const MER = `后端只读接口全库 · 不分号（分号读数看下面「按号」表）`;
  const kpis = `<div class="grid gkpi">
    ${kpi('已发布', t.posts, `${t.measured} 条拿到读数`, [['已发布', `${t.posts} 条`], ['拿到读数', `${t.measured} 条`], ['还没读数', `${t.posts - t.measured} 条`], ['口径', '发布后按 20 分钟 / 1 / 3 / 8 / 24 / 72 小时回看']], t.posts, `${MER} · ${OUTWARD_CALIBER}`, `近 ${ANALYSIS_DAYS} 北京日 · 尺＝回看检查点`)}
    ${kpi('总浏览', fmtN(t.views), `中位 ${fmtN(t.medianViews)}`, [['累计浏览', fmtN(t.views)], ['单条中位', fmtN(t.medianViews)], ['为什么用中位数', '浏览量是长尾分布，一条爆款会把平均值抬到没有意义']], t.measured, `${MER} · 只算拿到读数的行`, '中位数（nearest-rank）· 无读数的行不并进母体')}
    ${kpi('互动（赞+评+转）', t.likes + t.comments + t.shares, `每千次浏览 ${t.engagementPer1k} 次回应`, [['赞', String(t.likes)], ['评论', String(t.comments)], ['转发', String(t.shares)], ['每千次浏览', `${t.engagementPer1k} 次回应`], ['口径', '用「每千次浏览」而不是百分比：浏览量本身是基数，百分比会被它骗']], t.measured, `${MER} · 赞+评+转`, '每千次浏览（分母是浏览量，不是帖子数）')}
    ${kpi('上过公开榜', t.surfaced, `${ratioOrDash(t.surfaced, t.posts, x => (x * 100).toFixed(0) + '%').v === '—' ? '无分母 · 不显示比率' : `上榜率 ${ratioOrDash(t.surfaced, t.posts, x => (x * 100).toFixed(0) + '%').v}`}`, [['上过榜', `${t.surfaced} 条`], ['上榜率', ratioOrDash(t.surfaced, t.posts, x => (x * 100).toFixed(0) + '%').v], ['含义', '被广场算法推出去过，和「被人看到」是两件事']], t.posts, `${MER} · 分母＝已发布（库内四字段）`, '上榜率＝上过榜 ÷ 已发布 · 分母为零不显示比率不显示 0%')}
    ${kpi('广场热榜中位', fmtN(r.benchmark.trendMedian), `快讯流中位 ${fmtN(r.benchmark.newsMedian)}`, [['热榜中位', fmtN(r.benchmark.trendMedian)], ['快讯流中位', fmtN(r.benchmark.newsMedian)], ['基准样本', `${r.benchmark.pool} 条`], ['提醒', '榜上的帖子已经赢过一次算法筛选，直接对比会高估我们']], r.benchmark.pool, '平台基准池 · 与我们的号无关（不是我们的分母）', '中位数 · 样本＝基准池条数')}
  </div>`;

  // 分号表：后端的只读接口没有按号参数（补字段属后端那一格），所以这页的"分号"是面板自算。
  // 面板自算的行只展示、不参与任何判定或验收，并且明写它用的哪把尺。
  const acctPosts = await api('/api/posts?status=published&limit=200').catch(() => null);
  const perAcct = acctScopeTable(acctPosts);

  const insights = r.insights.length
    ? r.insights.map(i => {
      const k = KIND_STYLE[i.kind] ?? KIND_STYLE.info;
      return `<div class="kv" style="align-items:flex-start;gap:10px;padding:11px 0;border-top:1px solid var(--line)">
        <span class="pill ${k.cls}" style="flex:none">${k.tag}</span>
        <span style="font-size:14px;line-height:1.7">${esc(i.text)}</span>
      </div>`;
    }).join('')
    : '<div class="muted" style="padding:10px 0">数据量还不够得出结论。</div>';

  const caveats = r.caveats.length
    ? `<div class="card" style="margin-top:14px"><div class="card-hd"><h3>这些数字不能怎么读</h3></div>
        ${r.caveats.map(c => `<div class="hint">· ${esc(c)}</div>`).join('')}</div>`
    : '';

  const dims = r.dimensions.map(d => {
    const rankable = d.groups.filter(g => g.rankable).length;
    const rows = d.groups.slice(0, 12).map(g => `
      <tr${g.rankable ? '' : ' class="off"'}>
        <td>${esc(g.label)}</td>
        <td class="num">${g.measured}${g.rankable ? '' : ' <span class="muted">不足</span>'}</td>
        <td class="num">${fmtN(g.medianViews)}<div class="muted" style="font-size:11px">均值 ${fmtN(g.meanViews)} · 最高 ${fmtN(g.bestViews)}</div></td>
        <td class="num">${g.engagementPer1k}</td>
        <td class="num">${g.surfaced}</td>
        <td class="num">${g.vsBenchmark == null ? '<span class="muted">—</span>' : (g.vsBenchmark * 100).toFixed(0) + '%'}<div class="muted" style="font-size:11px">${g.benchmarkMedian == null ? '无同类基准' : '基准 ' + fmtN(g.benchmarkMedian)}</div></td>
      </tr>`).join('');
    return `<div class="card" style="margin-top:14px">
      <div class="card-hd"><h3>${esc(d.label)}</h3><span class="sub">${d.groups.length} 组，可比 ${rankable} 组${d.note ? ' · ' + esc(d.note) : ''}</span></div>
      <div class="tw"><table><thead><tr>
        <th>分组</th><th class="num">读数</th><th class="num">中位浏览</th>
        <th class="num">互动/千</th><th class="num">上榜</th><th class="num">相对水位</th>
      </tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted">暂无</td></tr>'}</tbody></table></div>
    </div>`;
  }).join('');

  return `<div class="card">
    ${accountBar(acctScope())}
    <div class="chips">${days}</div>
    <div class="kv" style="margin-top:10px">
      ${r.conclusive
        ? `<span class="pill on">样本足够（${t.measured} 条读数）</span>`
        : `<span class="pill warn">样本不足：还差 ${r.neededForFirstRank} 条读数才能让任何一个分组可比</span>`}
      <span class="muted">排名一律用中位数：广场的浏览量是长尾分布，一条爆款就能把均值抬到毫无意义。</span>
      <span class="pill plain">上方数字＝${esc(MER)}</span>
    </div>
  </div>
  <div style="margin-top:14px">${kpis}</div>
  ${acctTableHtml(perAcct)}
  <div class="card" style="margin-top:14px">
    <div class="card-hd"><h3>自动归纳</h3></div>
    ${insights}
  </div>
  ${caveats}
  ${dims}`;
}

/* ------------------------------------------------------------------ 数据板 --- */

let BOARD_DAYS = 14;

const PALETTE = ['#f0b90b', '#4f8ef7', '#22c55e', '#c084fc', '#f472b6', '#22d3ee', '#fb923c', '#a3e635'];
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const bjHour = ms => { const d = new Date(ms + 8 * 3600000); return d.getUTCHours() + d.getUTCMinutes() / 60; };
const bjDay = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const dayLabel = key => {
  const [y, m, d] = key.split('-').map(Number);
  return `${m}/${d} ${WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}`;
};
const colorOf = (key, keys) => PALETTE[Math.max(0, keys.indexOf(key)) % PALETTE.length];
const pctOf = (n, t) => (t ? Math.round((n / t) * 100) : 0) + '%';
const hhmm = ms => { const d = new Date(ms + 8 * 3600000); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };

/* ----------------------------------------------------------- 悬浮读数条 --- */

let TIP_EL = null;

/**
 * One floating readout for every chart. Native SVG `<title>` needs a second of hovering before
 * it appears and cannot be styled, so on a board meant to be scanned quickly it is the same as
 * having no numbers at all.
 */
function ensureTip() {
  if (TIP_EL) return TIP_EL;
  TIP_EL = document.createElement('div');
  TIP_EL.className = 'tip';
  document.body.appendChild(TIP_EL);
  document.addEventListener('mousemove', ev => {
    const el = ev.target && ev.target.closest ? ev.target.closest('[data-tip]') : null;
    if (!el) { TIP_EL.classList.remove('on'); return; }
    let d = null;
    try { d = JSON.parse(el.getAttribute('data-tip')); } catch { return; }
    TIP_EL.innerHTML = `<div class="tip-h">${esc(d.t)}</div>`
      + (d.r || []).map(([k, v]) => `<div class="tip-r"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')
      + (d.n ? `<div class="tip-n">${esc(d.n)}</div>` : '');
    TIP_EL.classList.add('on');
    const box = TIP_EL.getBoundingClientRect();
    let x = ev.clientX + 16, y = ev.clientY + 16;
    if (x + box.width > window.innerWidth - 10) x = ev.clientX - box.width - 16;
    if (y + box.height > window.innerHeight - 10) y = ev.clientY - box.height - 16;
    TIP_EL.style.left = Math.max(8, x) + 'px';
    TIP_EL.style.top = Math.max(8, y) + 'px';
  }, true);
  return TIP_EL;
}

const tip = (title, rows, note) => ` data-tip="${esc(JSON.stringify({ t: title, r: rows, n: note || null }))}"`;

/* ------------------------------------------------------------- 发帖时间轴 --- */

function stripChart(d) {
  const ev = d.cadence.events;
  if (!ev.length) return '<div class="muted" style="padding:6px 0">这个区间里还没有已发布的内容。</div>';
  const days = d.series.map(p => p.day);
  const who = [...new Set(ev.map(e => e.accountLabel))];
  const W = 1120, padL = 74, padR = 54, padT = 26, rowH = days.length > 14 ? 20 : 30, H = padT + days.length * rowH + 26;
  const x = h => padL + (h / 24) * (W - padL - padR);
  const y = i => padT + i * rowH + rowH / 2;
  const s = STATE.settings;
  let g = `<rect class="win" x="${x(s.activeStartHour)}" y="${padT - 4}" width="${x(Math.min(s.activeEndHour, 24)) - x(s.activeStartHour)}" height="${days.length * rowH + 8}"/>`;
  g += `<text x="${x(s.activeStartHour) + 6}" y="${padT - 10}">发帖时段 ${s.activeStartHour}:00 – ${Math.min(s.activeEndHour, 24)}:00</text>`;
  for (let h = 0; h <= 24; h += 3) {
    g += `<line class="grid" x1="${x(h)}" y1="${padT - 4}" x2="${x(h)}" y2="${padT + days.length * rowH}"/>`;
    g += `<text x="${x(h)}" y="${H - 10}" text-anchor="middle">${h} 时</text>`;
  }
  days.forEach((day, i) => {
    const mine = ev.filter(e => bjDay(e.at) === day);
    g += `<text x="${padL - 10}" y="${y(i) + 4}" text-anchor="end" class="${mine.length ? 'lbl-b' : ''}">${dayLabel(day)}</text>`;
    g += `<text x="${W - padR + 10}" y="${y(i) + 4}">${mine.length ? mine.length + ' 篇' : '—'}</text>`;
    if (!mine.length) return;
    const views = mine.map(e => e.views).filter(v => v != null).sort((a, b) => a - b);
    const med = views.length ? (views.length % 2 ? views[(views.length - 1) / 2] : Math.round((views[views.length / 2 - 1] + views[views.length / 2]) / 2)) : null;
    g += `<rect x="${padL}" y="${y(i) - rowH / 2}" width="${W - padL - padR}" height="${rowH}" fill="transparent"${tip(`${dayLabel(day)} 共 ${mine.length} 篇`, [
      ['中位浏览', med == null ? '无读数' : fmtN(med)],
      ['当天浏览合计', fmtN(views.reduce((a, b) => a + b, 0))],
      ['互动', String(mine.reduce((a, e) => a + e.engagement, 0))],
    ], med == null ? '读数还没回来，通常发布后 20 分钟到几小时。' : null)}`;
    const byMin = new Map();
    for (const e of mine) {
      const k = Math.round(e.at / 60000);
      if (!byMin.has(k)) byMin.set(k, []);
      byMin.get(k).push(e);
    }
    for (const list of byMin.values()) {
      const e0 = list[0];
      const cx = x(bjHour(e0.at)), cy = y(i), c = colorOf(e0.accountLabel, who);
      const rows = [
        ['时间', `${hhmm(e0.at)}（北京时间）`],
        ['账号', e0.accountLabel],
        ['类型', e0.kind === 'article' ? '长文' : '短帖'],
        ['内容', e0.cell],
      ];
      if (e0.symbol) rows.push(['币种', e0.symbol]);
      rows.push(['浏览', e0.views == null ? '还没拿到读数' : fmtN(e0.views) + ' 次']);
      rows.push(['互动', e0.engagement ? `${e0.engagement}（赞/评/转）` : '0 次']);
      if (list.length > 1) rows.push(['同一分钟', `${list.length} 条挤在一起`]);
      const t = tip(`${hhmm(e0.at)} · ${e0.kind === 'article' ? '长文' : '短帖'}${list.length > 1 ? ` · 同分钟 ${list.length} 条` : ''}`, rows);
      g += e0.kind === 'article'
        ? `<rect class="dot" x="${cx - 5.5}" y="${cy - 5.5}" width="11" height="11" rx="3" fill="${c}"/>`
        : `<circle class="dot" cx="${cx}" cy="${cy}" r="5.5" fill="${c}"/>`;
      if (list.length > 1) g += `<circle class="burst" cx="${cx}" cy="${cy}" r="10"/>`;
      g += `<circle class="hit" cx="${cx}" cy="${cy}" r="11"${t}/>`;
    }
  });
  const legend = who.map((w, i) => `<span><i style="background:${colorOf(w, who)}"></i>${esc(w)}（${ev.filter(e => e.accountLabel === w).length} 篇）</span>`).join('')
    + '<span><i class="rd"></i>圆点＝短帖</span><span><i class="sq"></i>方块＝长文</span>'
    + `<span><i class="ring"></i>红圈＝同一分钟挤了多条（应为 0）</span>`;
  return `<div class="chartwrap"><svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${g}</svg></div><div class="legend">${legend}</div>`;
}

/* ------------------------------------------------------- 每日发布量与浏览 --- */

function dayChart(d) {
  const se = d.series.slice(-Math.min(d.series.length, 21));
  if (!se.length) return '<div class="muted" style="padding:6px 0">区间内没有数据。</div>';
  const W = 560, padL = 34, padR = 40, padT = 16, plotH = 150, H = padT + plotH + 26;
  const maxC = Math.max(1, ...se.map(p => p.posts + p.articles));
  const maxV = Math.max(1, ...se.map(p => p.views));
  const bw = (W - padL - padR) / se.length;
  let g = '';
  for (let t = 1; t <= 3; t++) {
    const yy = padT + plotH - (t / 3) * plotH;
    g += `<line class="grid" x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}"/>`;
    g += `<text x="${padL - 6}" y="${yy + 3}" text-anchor="end">${Math.round((t / 3) * maxC)}</text>`;
  }
  se.forEach((p, i) => {
    const bx = padL + i * bw + bw * 0.2, w = bw * 0.6;
    const hp = (p.posts / maxC) * plotH, ha = (p.articles / maxC) * plotH;
    const top = padT + plotH - hp - ha;
    if (p.posts + p.articles) {
      g += `<rect x="${bx}" y="${padT + plotH - hp}" width="${w}" height="${hp}" fill="#4f8ef7" opacity=".9"/>`;
      if (p.articles) g += `<rect x="${bx}" y="${top}" width="${w}" height="${ha}" fill="#22c55e" opacity=".9"/>`;
      g += `<text x="${bx + w / 2}" y="${top - 4}" text-anchor="middle" class="lbl-b">${p.posts + p.articles}</text>`;
    }
    const vy = padT + plotH - (p.views / maxV) * plotH;
    g += `<circle cx="${bx + w / 2}" cy="${vy}" r="3" fill="var(--accent)"/>`;
    g += `<rect x="${padL + i * bw}" y="${padT}" width="${bw}" height="${plotH}" fill="transparent"${tip(dayLabel(p.day), [
      ['短帖', p.posts + ' 篇'], ['长文', p.articles + ' 篇'], ['浏览', fmtN(p.views)], ['互动', String(p.engagement)],
    ])}>`;
    if (se.length <= 10) g += `<text x="${bx + w / 2}" y="${H - 8}" text-anchor="middle">${p.day.slice(8)}</text>`;
  });
  g += `<line class="ax" x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}"/>`;
  g += `<text x="${W - padR + 6}" y="${padT + 4}">${fmtN(maxV)}</text>`;
  return `<div class="chartwrap"><svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${g}</svg></div>
    <div class="legend"><span><i style="background:#4f8ef7"></i>当天发布条数（左轴）</span><span><i class="rd" style="background:var(--accent)"></i>当天内容的浏览量（右轴）</span><span class="muted">柱子矮、线高＝发得少但发对了；柱高线矮＝发得多没人看。</span></div>`;
}

/* ---------------------------------------------------------- 分时段：发与看 --- */

function hourChart(d) {
  const W = 560, padL = 34, padR = 40, padT = 16, plotH = 150, H = padT + plotH + 26;
  const maxC = Math.max(1, ...d.hours.map(h => h.count));
  const maxV = Math.max(1, ...d.hours.map(h => h.medianViews ?? 0));
  const bw = (W - padL - padR) / 24;
  const s = STATE.settings;
  let g = `<rect class="win" x="${padL + s.activeStartHour * bw}" y="${padT - 4}" width="${(Math.min(s.activeEndHour, 24) - s.activeStartHour) * bw}" height="${plotH + 8}"/>`;
  for (let t = 1; t <= 3; t++) {
    const yy = padT + plotH - (t / 3) * plotH;
    g += `<line class="grid" x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}"/>`;
    g += `<text x="${padL - 6}" y="${yy + 3}" text-anchor="end">${Math.round((t / 3) * maxC)}</text>`;
  }
  const pts = [];
  d.hours.forEach((h, i) => {
    const bx = padL + i * bw + bw * 0.22, w = bw * 0.56;
    if (h.count) {
      const hc = (h.count / maxC) * plotH;
      g += `<rect x="${bx}" y="${padT + plotH - hc}" width="${w}" height="${Math.max(2, hc)}" rx="2" fill="#4f8ef7" opacity=".9"/>`;
      g += `<text x="${bx + w / 2}" y="${padT + plotH - hc - 4}" text-anchor="middle" class="lbl-b">${h.count}</text>`;
    }
    if (h.medianViews != null) pts.push(`${bx + w / 2},${padT + plotH - (h.medianViews / maxV) * plotH}`);
    g += `<rect x="${padL + i * bw}" y="${padT - 4}" width="${bw}" height="${plotH + 8}" fill="transparent"${tip(`${h.hour}:00 – ${h.hour + 1}:00`, [
      ['发布', h.count + ' 篇'],
      ['中位浏览', h.medianViews == null ? '该时段没有读数' : fmtN(h.medianViews)],
    ], h.hour < s.activeStartHour || h.hour >= Math.min(s.activeEndHour, 24) ? '这个时段在设定的发帖窗口之外。' : null)}>`;
    if (i % 3 === 0) g += `<text x="${bx + w / 2}" y="${H - 8}" text-anchor="middle">${h.hour}</text>`;
  });
  if (pts.length > 1) g += `<polyline points="${pts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
  d.hours.forEach((h, i) => {
    if (h.medianViews == null) return;
    g += `<circle cx="${padL + i * bw + bw / 2}" cy="${padT + plotH - (h.medianViews / maxV) * plotH}" r="3" fill="var(--accent)"/>`;
  });
  g += `<line class="ax" x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}"/>`;
  g += `<text x="${W - padR + 6}" y="${padT + 4}">${fmtN(maxV)}</text>`;
  return `<div class="chartwrap"><svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${g}</svg></div>
    <div class="legend"><span><i style="background:#4f8ef7"></i>该时段发了几篇（左轴）</span><span><i class="rd" style="background:var(--accent)"></i>该时段的中位浏览（右轴）</span><span class="muted">横轴＝北京时间几时</span></div>`;
}

/* ---------------------------------------------------------------- 间隔分布 --- */

function gapChart(c) {
  const total = c.histogram.reduce((a, b) => a + b.count, 0);
  if (!total) return '<div class="muted" style="padding:6px 0">发布条数还不够算间隔（至少 2 条）。</div>';
  const max = Math.max(1, ...c.histogram.map(b => b.count));
  const mean = {
    '同一分钟': '同一分钟发多条：平台最容易判定为机器，也是互相抢曝光。',
    '1–15 分': '远小于目标间隔，等于连着发。',
    '15–45 分': '略密于目标间隔。',
    '45–120 分': '符合设定节奏。',
    '2–6 小时': '偏松：时段里还有空位没排上内容。',
    '6 小时以上': '长空档：通常是素材断供、时段外、或队列被卡住。',
  };
  return `<div class="hbars">${c.histogram.map(b => {
    const bad = b.min < 1, tight = b.max <= c.intendedMinutes;
    const col = bad ? 'var(--bad)' : tight ? 'var(--warn)' : b.count ? '#4f8ef7' : 'var(--line)';
    return `<div class="hbar">
      <span>${b.label}</span>
      <span class="track"><i style="width:${Math.max(b.count ? 3 : 0, (b.count / max) * 100)}%;background:${col}"></i></span>
      <span class="v"${tip(`${b.count} 次 / 共 ${total} 个间隔`, [['占比', pctOf(b.count, total)], ['说明', mean[b.label] || '']], b.label === '45–120 分' ? `目标间隔 ${c.intendedMinutes} 分钟。` : null)}>${b.count} 次<span class="muted">${pctOf(b.count, total)}</span></span>
    </div>`;
  }).join('')}</div>`;
}

/* -------------------------------------------------------------- 排名条形 --- */

function rankBars(list, unit) {
  if (!list.length) return '<div class="muted" style="padding:6px 0">还没有已发布的内容。</div>';
  const max = Math.max(1, ...list.map(g => g.medianViews ?? 0));
  return `<div class="hbars">${list.map(g => `<div class="hbar${g.medianViews == null ? ' off' : ''}">
      <span title="${esc(g.key)}">${esc(g.label)}</span>
      <span class="track"><i style="width:${g.medianViews == null ? 0 : Math.max(3, (g.medianViews / max) * 100)}%"></i></span>
      <span class="v"${tip(g.label, [
        ['中位浏览', g.medianViews == null ? '无读数' : fmtN(g.medianViews)],
        ['平均浏览', g.meanViews == null ? '无读数' : fmtN(g.meanViews)],
        ['最好一条', g.bestViews == null ? '无读数' : fmtN(g.bestViews)],
        ['发布条数', `${g.count} 篇（${g.measured} 篇有读数）`],
        ['浏览合计', fmtN(g.views)],
        ['互动', `${g.engagement} 次`],
      ], g.measured < g.count ? `还有 ${g.count - g.measured} 篇没拿到读数，中位数只按已有读数算。` : '中位数不受单条爆款影响，比平均值可靠。')}>${g.medianViews == null ? '无读数' : fmtN(g.medianViews)}<span class="muted">${g.count} 篇 · ${unit} ${g.engagement}</span></span>
    </div>`).join('')}</div>`;
}

/* ------------------------------------------------------------------ 整页 --- */

async function boardView() {
  ensureTip();
  const d = await api('/api/dashboard?days=' + BOARD_DAYS);
  const c = d.cadence;
  const names = d.accounts.map(a => a.label);

  // 账号 × 天：从每条发布流水现聚成矩阵，账号日历卡与每日明细表共用这一份，后端不必加接口。
  const byAcct = new Map();
  for (const e of c.events) {
    if (!byAcct.has(e.accountLabel)) byAcct.set(e.accountLabel, new Map());
    const m = byAcct.get(e.accountLabel), k = bjDay(e.at);
    if (!m.has(k)) m.set(k, { p: 0, a: 0, v: 0, e: 0 });
    const b = m.get(k);
    if (e.kind === 'article') b.a++; else b.p++;
    b.v += e.views ?? 0;
    b.e += e.engagement || 0;
  }
  const dayOf = (label, k) => (byAcct.get(label) || new Map()).get(k) || null;

  const days = [3, 7, 14, 30].map(n => `<button class="chip ${n === BOARD_DAYS ? 'on' : ''}" onclick="setBoardDays(${n})">最近 ${n} 天</button>`).join('');

  const kpi = (label, value, sub, rows) => `<div class="tile"${rows ? tip(label, rows) : ''}>
    <div class="lbl">${label}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`;

  const today = d.accounts.reduce((a, x) => a + x.today, 0);
  const pendingAll = d.accounts.reduce((a, x) => a + x.pending, 0);
  const kpis = `<div class="grid gkpi">
    ${kpi('区间内发布', `${d.totals.posts + d.totals.articles}`, `短帖 ${d.totals.posts} · 长文 ${d.totals.articles}`,
      [['短帖', d.totals.posts + ' 篇'], ['长文', d.totals.articles + ' 篇'], ['拿到读数', `${d.totals.measured} 篇`], ['还没读到数', `${d.totals.posts + d.totals.articles - d.totals.measured} 篇`]])}
    ${kpi('累计浏览', fmtN(d.totals.views), `单条中位 ${fmtN(d.totals.medianViews ?? 0)}`,
      [['累计浏览', fmtN(d.totals.views)], ['单条中位', fmtN(d.totals.medianViews ?? 0)], ['互动合计', `${d.totals.engagement} 次`]])}
    ${kpi('今日已发', `${today}`, d.accounts.map(a => `${a.label} ${a.today}/${a.cap}${a.capUnit === '篇长文' ? '篇' : '帖'}`).join(' · '),
      d.accounts.map(a => [a.label, `今日 ${a.today}/${a.cap} ${a.capUnit}`]))}
    ${kpi('待发布', `${pendingAll}`, d.orphanPending ? `<span style="color:var(--bad)">${d.orphanPending} 条没有归属账号</span>` : '全部都有账号可发',
      d.accounts.map(a => [a.label, `待发布 ${a.pending} 条`]).concat(d.orphanPending ? [['无归属', d.orphanPending + ' 条']] : []))}
  </div>`;

  const verdict = [];
  if (c.bursts) verdict.push(['warn', `${c.bursts} 次同一分钟挤发`]);
  else verdict.push(['on', '节奏正常 · 无挤发']);
  if (c.actualMedianMinutes != null) verdict.push([c.actualMedianMinutes < c.intendedMinutes ? 'warn' : 'on', `中位间隔 ${Math.round(c.actualMedianMinutes)} 分（目标 ${c.intendedMinutes}）`]);
  if (c.idleWindow) verdict.push(['warn', `最长空档 ${c.longestIdleHours} 小时（${c.idleWindow.from} → ${c.idleWindow.to}）`]);
  if (d.orphanPending) verdict.push(['bad', `${d.orphanPending} 条待发布无归属`]);

  // 每账号一张卡：岗位与额度做头，四个区间数字做骨架，日历条把每一天印在页面上——一格一天。
  const TODAY_KEY = bjDay(Date.now());
  const acctCard = a => {
    const m = byAcct.get(a.label) || new Map();
    const cal = d.series.map(pt => {
      const b = m.get(pt.day);
      const n = b ? b.p + b.a : 0;
      const rows = [['短帖', (b ? b.p : 0) + ' 篇'], ['长文', (b ? b.a : 0) + ' 篇'], ['浏览', fmtN(b ? b.v : 0)], ['互动', String(b ? b.e : 0)]];
      return `<div class="cd${n ? ' has' : ''}${pt.day === TODAY_KEY ? ' today' : ''}"${tip(dayLabel(pt.day) + ' · ' + a.label, rows)}>
        <span class="d">${Number(pt.day.slice(8))}</span>${n ? `<b class="n">${n}</b><span class="v">${b.v ? fmtN(b.v) : '·'}</span>` : '<span class="v">&nbsp;</span>'}
      </div>`;
    }).join('');
    const nums = [
      ['发布', `${a.posts + a.articles}`, `帖 ${a.posts} · 文 ${a.articles}`],
      ['浏览', fmtN(a.views), a.medianViews == null ? '暂无读数' : `中位 ${fmtN(a.medianViews)}`],
      ['互动/千', `${a.engagementPer1k}`, `${a.engagement} 次`],
      ['队列', `${a.pending}`, `今日 ${a.today}/${a.cap}${a.capUnit === '篇长文' ? ' 篇' : ' 帖'}`],
    ].map(([l, v, s]) => `<div class="an"><span class="l">${l}</span><b>${v}</b><span class="s">${s}</span></div>`).join('');
    return `<div class="card acct${a.enabled ? '' : ' off'}">
      <div class="acct-hd">
        <span class="cdot" style="background:${colorOf(a.label, names)}"></span>
        <h3>${esc(a.label)}</h3>
        <span class="pill plain">${esc(a.role)}</span>
        <span class="acct-next"${tip('下一帖', [['时间', a.nextAt ? fmtTs(a.nextAt) : '不可发'], ['依据', a.nextReason]])}>${a.nextAt ? '下一帖 ' + hhmm(a.nextAt) : '暂不可发'}</span>
      </div>
      <div class="acct-nums">${nums}</div>
      <div class="acal">${cal}</div>
    </div>`;
  };

  // 每日明细表：行＝天（最近的在上），列＝账号。格内大数字＝当天发布条数，小字＝当天浏览。
  const dailyRows = [...d.series].reverse().map(pt => {
    const k = pt.day;
    const cells = names.map(nm => {
      const b = dayOf(nm, k);
      if (!b || !(b.p + b.a)) return '<td class="num mut">·</td>';
      return `<td class="num"${tip(nm + ' · ' + dayLabel(k), [['短帖', b.p + ' 篇'], ['长文', b.a + ' 篇'], ['浏览', fmtN(b.v)], ['互动', String(b.e)]])}><b>${b.p + b.a}</b><small>${b.v ? ' ' + fmtN(b.v) : ''}</small></td>`;
    }).join('');
    return `<tr${k === TODAY_KEY ? ' class="now"' : ''}>
      <td>${dayLabel(k)}${k === TODAY_KEY ? ' <span class="tag">今天</span>' : ''}</td>${cells}
      <td class="num"><b>${pt.posts + pt.articles}</b></td>
      <td class="num">${fmtN(pt.views)}</td>
      <td class="num">${pt.engagement}</td>
    </tr>`;
  }).join('');

  const fold = (title, how, body) => `<details class="card fold"><summary>${title}<i></i></summary><div class="fold-in"><div class="how">${how}</div>${body}</div></details>`;

  const acctRows = d.accounts.map(a => `<tr>
      <td><span class="b">${esc(a.label)}</span>${a.enabled ? '' : ' <span class="pill">已停用</span>'}</td>
      <td><span class="pill ${a.trackId ? 'on' : a.enabled ? 'on' : ''}">${esc(a.role)}</span></td>
      <td class="num"${tip('今日额度', [['已发', `${a.today} ${a.capUnit}`], ['上限', `${a.cap} ${a.capUnit}`], ['口径', '长文与短帖共用同一个 Key 的日额度']])}>${a.today} <span class="muted">/ ${a.cap} ${a.capUnit}</span></td>
      <td class="num">${a.pending}</td>
      <td class="num">${a.nextAt ? hhmm(a.nextAt) : '<span class="muted">不可发</span>'}</td>
      <td class="num">${a.posts} <span class="muted">+${a.articles}</span></td>
      <td class="num">${a.medianViews == null ? '—' : fmtN(a.medianViews)}</td>
      <td class="num">${a.engagementPer1k}</td>
      <td class="num">${a.subscribers || '—'}</td>
      <td>${rolePicker(a)}</td>
    </tr>`).join('');

  return `
  <div class="card">
    <div class="chips">${days}</div>
    <div class="kv" style="margin-top:10px">${verdict.map(([cls, t]) => `<span class="pill ${cls} plain">${esc(t)}</span>`).join('')}</div>
    <div style="margin-top:12px">${kpis}</div>
  </div>
  <div class="grid g2" style="margin-top:14px">${d.accounts.map(acctCard).join('')}</div>
  <div class="card" style="margin-top:14px">
    <div class="card-hd"><h3>每日明细 · 每个号每天发了多少</h3></div>
    <div class="how">行＝天（最近的在上），列＝账号。格内大数字＝当天发布条数，小字＝当天浏览合计；悬停看短帖/长文拆分与互动。</div>
    <div class="tw"><table class="daily">
      <thead><tr><th>日期</th>${names.map(nm => `<th class="num"><i class="cdot" style="background:${colorOf(nm, names)}"></i>${esc(nm)}</th>`).join('')}<th class="num">合计</th><th class="num">浏览</th><th class="num">互动</th></tr></thead>
      <tbody>${dailyRows || `<tr><td colspan="${names.length + 4}" class="muted">这个区间里还没有发布记录</td></tr>`}</tbody>
    </table></div>
  </div>
  ${fold('发帖时间轴 · 几点发的、哪个号发的',
    '横轴是北京时间 0–24 点，底色区间是设定的发帖时段。悬停任何一个点，会看到几点、哪个账号、写的什么、多少人看。空行就是空档。',
    stripChart(d))}
  ${fold('每日趋势与分时段效率',
    '左图：柱＝当天发布条数，黄线＝当天浏览量。右图：蓝柱＝该时段发布条数，黄点＝该时段中位浏览。两个都高的时段才值得加码。',
    `<div class="grid g2">${dayChart(d)}${hourChart(d)}</div>`)}
  ${fold('相邻两帖的间隔分布',
    `两帖之间隔了多久。目标是 ${c.intendedMinutes} 分钟一帖：红＝同一分钟挤发，黄＝比目标密，蓝＝正常或偏松。`,
    gapChart(c))}
  ${fold('哪类内容、哪种写法有人看',
    '每条的中位浏览从高到低排。条数少的先别下结论，悬停能看到几篇拿到了读数。',
    `<div class="grid g2">${rankBars(d.cells.slice(0, 10), '互动')}${rankBars(d.styles.slice(0, 10), '互动')}</div>`)}
  ${fold('账号岗位管理 · 当场换岗',
    '岗位决定账号发什么：短帖矩阵按热度出短帖，长文赛道深耕一个领域。这里改动立即生效。',
    `<div class="tw"><table><thead><tr>
      <th>账号</th><th>岗位</th><th class="num">今日/目标</th><th class="num">队列</th><th class="num">下一帖</th>
      <th class="num">短帖+长文</th><th class="num">中位浏览</th><th class="num">互动/千</th><th class="num">订阅</th><th>改岗位</th>
    </tr></thead><tbody>${acctRows || '<tr><td colspan="10" class="muted">还没有账号</td></tr>'}</tbody></table></div>`)}
  <div class="hint" style="margin-top:12px">这页的每个数字都来自已经写入库的发布记录，不来自设置项。每张账号卡下面一条日历：哪天发了、发了多少、被看了多少，一格一天，不用悬停就能读。</div>`;
}

function setBoardDays(n) { BOARD_DAYS = n; render(); }

function rolePicker(a) {
  const tracks = STATE.availableTracks || [];
  if (a.trackId) return `<button class="btn" onclick="setAccountRole(${a.id},'matrix')">转回短帖矩阵</button>`;
  return `<span class="rolepick">${tracks.map(t => `<button class="btn" onclick="setAccountRole(${a.id},'${t.id}')">跑「${esc(t.label)}」长文</button>`).join('')}</span>`;
}

async function setAccountRole(id, role) {
  if (role === 'matrix') {
    await api('/api/studio/unbind', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: id }) });
    toast('该号已转回短帖矩阵');
  } else {
    const a = (STATE.accounts || []).find(x => x.id === id);
    const warn = a?.pending ? `绑定后它会退出短帖矩阵，队列里已有 ${a.pending} 条会停发（可在账号页驳回后重新生成）。` : '';
    if (!confirm(`让这个号深耕长文赛道？它会从短帖矩阵退出 —— 一个账号同时服务两种人设，等于没有赛道。${warn}`)) return;
    await api('/api/studio/bind', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: id, trackId: role }) });
    toast('已绑定赛道，该号开始深耕长文');
  }
  await render();
}


/* --------------------------------------------------------------- 流量引擎 --- */

let RANK_DAYS = 30;
/** Mirrors ATTRIBUTION_WINDOW_HOURS in src/money/conversion.ts — shown so the number is interpretable. */
const ATTRIBUTION_WINDOW = 36;
const setRankDays = n => { RANK_DAYS = n; render(); };

/**
 * 定稿 v1 §7.3-2：判定口径不再是面板上的可点控件。
 * 这个页面曾经用三个按钮即时改全局 targetMetric —— 关卡 A 未过时切到互动口径，就会把
 * 全零样本判成「测过了，差别不大」并写进长期记忆（43 帖、1 赞、0 评的那次）。控件留着，
 * 任何一次手滑都会重演。所以这里只剩一句只读播报：改口径＝开新假设，走口径库。
 */
const TARGET_CN = { views: 'v24h 浏览', engagement: '每千次浏览互动质量', money: '每千次浏览返佣' };
const targetReadout = t => {
  const label = TARGET_CN[t] ?? '未知口径';
  const pill = t === 'views'
    ? '<span class="pill on">浏览量口径</span>'
    : '<span class="pill bad">非浏览量口径</span>';
  return `<div class="targetbar"${tip('判定口径（只读）', [['当前口径', label], ['为什么锁着', '关卡 A 未过时按互动/返佣判定，会把全零样本判成「差别不大」并写进记忆'], ['谁能改', '口径库审批；改口径＝开新假设，只收紧不放宽，面板无切换入口'], ['手输返佣列', '已降为自愿记录观察列，不参与判定']])}>${pill}<b>口径 ${esc(label)}</b><span class="muted">只读 · 改口径走口径库</span></div>`;
};

async function saveConversion() {
  const body = {
    day: document.querySelector('#cv-day').value,
    clicks: document.querySelector('#cv-clicks').value,
    followers: document.querySelector('#cv-followers').value,
    rebateUsd: document.querySelector('#cv-rebate').value,
  };
  if (!body.day) return toast('先选日期', true);
  try {
    const r = await api('/api/conversion', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    toast(`已记入观察列（手输近似，不参与验收）：按浏览量摊到 ${r.attributed.posts} 条帖子${r.attributed.unattributed ? `（${r.attributed.unattributed} 条没能分下去）` : ''}`);
    await render();
  } catch (e) { toast(e.message, true); }
}

const RANK_STATUS = {
  rule: ['on', '已成立 · 会照它写'],
  leaning: ['info', '倾向 · 还不敢当规则'],
  flat: ['plain', '测过了 · 差别不大'],
  observing: ['warn', '样本不足 · 不下结论'],
};

/** A tiny multi-point curve: this is what "the engine kept pushing it" looks like. */
function sparkline(points) {
  const pts = points.map((v, i) => ({ i, v })).filter(p => p.v != null);
  if (pts.length < 2) return '<span class="muted">读数不足</span>';
  const W = 96, H = 26, max = Math.max(...pts.map(p => p.v)), min = Math.min(...pts.map(p => p.v));
  const x = i => 2 + (i / 5) * (W - 4);
  const y = v => H - 2 - (max === min ? (H - 4) / 2 : ((v - min) / (max - min)) * (H - 4));
  const line = pts.map(p => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><polyline points="${line}" fill="none" stroke="var(--blue)" stroke-width="1.6"/>`
    + `<circle cx="${x(last.i).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="2.4" fill="var(--accent)"/></svg>`;
}

async function rankView() {
  ensureTip();
  const [d, cv] = await Promise.all([api('/api/rank?days=' + RANK_DAYS), api('/api/conversion')]);
  const chips = [7, 14, 30, 60].map(n => `<button class="chip ${n === RANK_DAYS ? 'on' : ''}" onclick="setRankDays(${n})">最近 ${n} 天</button>`).join('');
  const counts = {
    rule: d.verdicts.filter(v => v.status === 'rule').length,
    leaning: d.verdicts.filter(v => v.status === 'leaning').length,
    observing: d.verdicts.filter(v => v.status === 'observing').length,
    flat: d.verdicts.filter(v => v.status === 'flat').length,
  };
  const tile = (label, value, sub, rows) => `<div class="tile"${rows ? tip(label, rows) : ''}>
    <div class="lbl">${label}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`;

  const entered = cv.days.length;
  const money = cv.totals.rebate || 0;
  const per1k = cv.attributed.posts && d.curve.reduce((s, c) => s + (c.v8h ?? c.v3h ?? c.firstRead ?? 0), 0) > 0
    ? (money / d.curve.reduce((s, c) => s + (c.v8h ?? c.v3h ?? c.firstRead ?? 0), 0) * 1000) : null;
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  /**
   * 定稿 v1 §7.3-1：手填彻底出局，conversion_daily 降为可选观察列。
   * 原来这张卡直排在页面主路径上，标题写着「今天从币安后台抄三个数」，还当场回显
   * 「归因到 N 条帖子」——把手输近似渲染得像账单。现在折叠、改名、每个归因数都带「手输近似」，
   * 并且验收卡与标签台一律不引用它。
   */
  const convObs = `<details class="obs">
    <summary>自愿记录 · 手输近似（观察列，不参与验收与判定）</summary>
    <div class="obd">
      <div class="form-grid">
        <div class="field"><span class="cap">日期</span><input type="date" id="cv-day" value="${today}"></div>
        <div class="field"><span class="cap">链接点击</span><input type="number" id="cv-clicks" min="0" placeholder="0"></div>
        <div class="field"><span class="cap">新增粉丝</span><input type="number" id="cv-followers" min="0" placeholder="0"></div>
        <div class="field"><span class="cap">返佣（USDT）</span><input type="number" id="cv-rebate" min="0" step="0.01" placeholder="0"></div>
      </div>
      <div class="row"><button class="btn" onclick="saveConversion()">记一笔</button>
        <span class="muted">${entered ? `已录 ${entered} 天，累计返佣 ${money.toFixed(2)} USDT，每千次浏览 ${per1k == null ? '算不出（还没有可归因的帖）' : per1k.toFixed(2)} USDT —— 全部为手输近似` : '一天都还没录 —— 这一列空着不影响任何验收'}</span></div>
      <div class="hint">这里的数全部来自人工抄录：把当天总额按各帖<b>当时已积累的浏览量</b>加权摊下去，回看窗口 ${ATTRIBUTION_WINDOW} 小时。这是近似，不是账单 —— 它假设「看得多就点得多」，而这恰恰是没验证过的东西。<b>R5 的验收不看这一列</b>：定稿写死「关注存量与帖级归因不可测；可自动读到的只有分发与回应。」判定口径由上面那一行只读播报，这里改不了。</div>
      ${cv.days.length ? `<div class="tw" style="margin-top:10px"><table><thead><tr><th>日期</th><th class="num">点击</th><th class="num">新粉</th><th class="num">返佣</th><th>录入于</th></tr></thead><tbody>
        ${cv.days.slice(0, 8).map(x => `<tr><td>${esc(x.day)}</td><td class="num">${x.clicks ?? '—'}</td><td class="num">${x.followers ?? '—'}</td><td class="num">${x.rebate_usd != null ? x.rebate_usd.toFixed(2) : '—'}</td><td class="muted">${ago(x.entered_at)}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    </div>
  </details>`;

  // 首屏只回答三个问题：在测什么、学会了什么、样本有多少。口径/记忆/大脑的细节进悬浮与折叠。
  const obsN = counts.observing + counts.leaning;
  const kpis = `<div class="grid gkpi">
    ${tile('正在测', `${obsN}`, obsN ? `${counts.observing} 条样本不足 · ${counts.leaning} 条已现倾向` : '没有在测的假设',
      d.verdicts.filter(v => v.status === 'observing' || v.status === 'leaning').map(v => [v.id, (RANK_STATUS[v.status] ?? ['', v.status])[1] + (v.status === 'observing' ? ` · 还差 ${v.missing} 条` : '')]))}
    ${tile('已成立', `${counts.rule}`, counts.rule ? `正在影响每一次写作 · 记忆 ${d.memory.length} 条` : '还没有 · 样本与差距同时够格才升规则',
      d.verdicts.filter(v => v.status === 'rule').map(v => [v.id, v.arms.map(a => `${a.arm}:${a.median ?? '—'}`).join(' ')]))}
    ${tile('已测帖子', `${d.curve.length}`, '20 分钟 / 1 / 3 / 8 / 24 小时回看',
      [['怎么读曲线', '首小时增速 > 1 表示引擎在持续推'], ['判定口径', TARGET_CN[d.target] ?? String(d.target ?? '未知')], ['AI 大脑', d.brain ? `${d.brain.provider} · ${d.brain.model}` : '未启用 · 规则由测量直接得出']])}
  </div>`;

  const cards = d.verdicts.map(v => {
    const [cls, label] = RANK_STATUS[v.status] ?? ['', v.status];
    const max = Math.max(0, ...v.arms.map(a => a.median ?? 0));
    const bars = v.arms.map(a => `<div class="hbar big${a.median == null ? ' off' : ''}">
        <span>${esc(a.arm)}</span>
        <span class="track"><i style="width:${a.median == null || !max ? 0 : Math.max(3, (a.median / max) * 100)}%;background:${v.winner === a.arm ? 'var(--green)' : 'var(--blue)'}"></i></span>
        <span class="v"${tip(`${v.id} · ${a.arm}`, [['中位', a.median == null ? '无读数' : Math.round(a.median).toLocaleString('en-US')], ['样本', `${a.n} 条`], ['最好一条', a.best == null ? '—' : Math.round(a.best).toLocaleString('en-US')]])}>${a.median == null ? '—' : Math.round(a.median).toLocaleString('en-US')}<span class="muted">${a.n} 条</span></span>
      </div>`).join('');
    // 药丸墙换成四格「标签+值」：一眼读完，解释全部进悬浮——页面只留数字。
    const facts = [
      ['样本', `${v.arms.reduce((s, a) => s + a.n, 0)} 条`, v.arms.map(a => `${a.arm} ${a.n} 条`).join(' · ')],
      ['置信', `${(v.confidence * 100).toFixed(0)}%`, '样本量和差距同时够格，才升为规则'],
      ['分层比', v.stratified.strata >= 1 ? `${v.stratified.agree}/${v.stratified.strata} 层同向` : '0 层·比不了', v.stratified.strata >= 1 ? `同一类别、同一成交额档里对比：领先的那一臂在 ${v.stratified.strata} 层里赢了 ${v.stratified.agree} 层${v.stratified.rel != null ? `；层内相对差距 ${(v.stratified.rel * 100).toFixed(0)}%` : ''}；只有一边有数据、被丢掉 ${v.stratified.dropped} 层` : '没有一层同时有两边的数据 —— 浏览受币的热度影响，得在同热度内比才算数'],
      ['两半验证', v.replicated === true ? '一致' : v.replicated === false ? '打架' : '未验证', v.replicated === false ? '前半段的赢家后半段不在——多半是噪声' : '前半段测出的赢家，后半段还在不在'],
    ];
    const mrow = facts.map(([l, val, tt]) => `<div class="mf"${tip(l, [['值', String(val)], ['说明', tt]])}><span class="l">${l}</span><b>${esc(val)}</b></div>`).join('');
    return `<div class="card vf">
      <div class="vf-hd">
        <span class="dotst ${cls}"></span>
        <div class="vf-t"><h3>${esc(v.claim)}</h3>
          <span class="vf-sub">${v.mode === 'experiment' ? '主动实验 · 机器人随机分配' : '观察 · 从已发生的事里读'} · 指标 ${esc(v.metric)}${v.status === 'observing' ? ` · 还差 ${v.missing} 条` : ''}</span></div>
        <span class="pill ${cls} plain">${label}</span>
      </div>
      <div class="hbars">${bars}</div>
      <div class="mgrid">${mrow}</div>
      ${v.action ? `<div class="alert good" style="margin-top:2px"><svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg><div>${esc(v.action)}</div></div>` : ''}
      ${v.note ? `<div class="alert warn" style="margin-top:2px"><svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg><div>${esc(v.note)}</div></div>` : ''}
      <details class="src"><summary>方法与代价</summary><span>怎么测：${esc(v.how)} ｜ 代价：${esc(v.risk)}</span></details>
      ${(v.stratified.detail || []).length ? `<details class="src"><summary>分层明细 · ${v.stratified.detail.length} 层</summary><span>${v.stratified.detail.map(s => `${esc(s.stratum.replace('|', ' · '))}：${s.arms.map(a => `${a.arm === s.winner ? '<b>' : ''}${esc(a.arm)} ${Math.round(a.median).toLocaleString('en-US')}（${a.n}）${a.arm === s.winner ? '</b>' : ''}`).join(' / ')}`).join('<br>')}</span></details>` : ''}
    </div>`;
  }).join('');

  const curve = d.curve.length ? d.curve.map(c => `<tr>
      <td class="num">#${c.postId}</td>
      <td>${sparkline([c.firstRead, c.v1h, c.v3h, c.v8h, c.v24h])}</td>
      <td class="num">${c.firstRead ?? '—'}</td>
      <td class="num">${c.v8h ?? c.v3h ?? '—'}</td>
      <td class="num"${tip('首小时增速', [['20 分钟 → 1 小时', c.growth1h == null ? '读数不足' : c.growth1h.toFixed(2) + '×'], ['含义', '接近 1 表示基本没被再推；越大表示持续被分发']])}>${c.growth1h == null ? '—' : c.growth1h.toFixed(2) + '×'}</td>
      <td>${c.surfaced ? `<span class="pill on">${esc(c.boardKind || '上过榜')}</span>${c.hoursToBoard != null ? `<span class="sub">${c.hoursToBoard} 小时后上榜</span>` : ''}` : '<span class="pill plain">未上榜</span>'}</td>
      <td>${Object.keys(c.arms || {}).length ? Object.entries(c.arms).map(([k, a]) => `<span class="tag">${esc(k.replace('h_', ''))}=${esc(a)}</span>`).join(' ') : '<span class="muted">早于实验</span>'}</td>
    </tr>`).join('') : '<tr><td colspan="7"><div class="empty"><b>还没有分发曲线</b><span>帖子发出 20 分钟后出现第一个读数。</span></div></td></tr>';

  const mem = d.memory.length ? d.memory.map(m => `<tr>
      <td><span class="pill plain">${esc(m.kind)}</span></td>
      <td>${esc(m.text)}<span class="sub">${esc(m.key)} · 来自 ${esc(m.source)}${m.history_n > 1 ? ` · 这是第 ${m.history_n} 版` : ''}</span></td>
      <td class="num"${tip('置信度', [['置信', (m.confidence * 100).toFixed(0) + '%'], ['证据', m.evidence_n + ' 条'], ['被引用', m.use_count + ' 次'], ['记下于', fmtTs(m.created_at)]])}>${(m.confidence * 100).toFixed(0)}%</td>
      <td class="num">${m.evidence_n}</td>
      <td class="num">${ago(m.created_at)}</td>
      <td><button class="btn sm danger" onclick="forgetMemory('${esc(m.key)}')">撤销</button></td>
    </tr>`).join('') : '<tr><td colspan="6"><div class="empty"><b>还没有形成任何长期判断</b><span>当某条假设的样本与差距同时够了，结论会写进这里，并在之后每次写作时被读到。</span></div></td></tr>';

  const knobLabel = Object.fromEntries((d.knobs ?? []).map(k => [k.key, k.label]));
  const PARAM_STATUS = {
    pending: ['plain', '待应用'], applied: ['warn', '验证中'], improved: ['on', '见效，已保留'],
    rolled_back: ['bad', '没改善，已自动回滚'], no_effect: ['bad', '没有变化'], rejected: ['plain', '被拒绝'],
  };
  const proposed = (d.proposals ?? []).length ? d.proposals.map(p => `<tr>
      <td>${esc(p.claim)}<span class="sub">${p.source_text ? `AI 大脑原话：「${esc(p.source_text)}」` : 'AI 大脑提议'}</span></td>
      <td><span class="pill plain">${esc(p.dimension_label)}</span><span class="sub">${esc(p.metric)} · 每臂要 ${p.min_samples} 条</span></td>
      <td class="muted">${esc(p.risk)}</td>
      <td style="white-space:nowrap"><button class="btn sm primary" onclick="resolveHypothesis('${esc(p.id)}',true)">批准</button> <button class="btn sm" onclick="resolveHypothesis('${esc(p.id)}',false)">不要</button></td>
    </tr>`).join('') : '<tr><td colspan="4"><div class="empty"><b>没有在等待审批的提议</b><span>AI 大脑提的随机实验会落到这里 —— 它要占真实发帖流量，所以由你点头，不由它自己决定。</span></div></td></tr>';

  const paramRows = (d.paramChanges ?? []).length ? d.paramChanges.map(c => {
    const [cls, label] = PARAM_STATUS[c.status] ?? ['', c.status];
    return `<tr>
      <td>${esc(knobLabel[c.key] ?? c.key)}<span class="sub">${esc(c.reason)}</span></td>
      <td class="num">${c.from_value} → ${c.to_value}</td>
      <td><span class="pill ${cls}">${label}</span>${c.reject_reason ? `<span class="sub">${esc(c.reject_reason)}</span>` : ''}</td>
      <td class="num"${tip('怎么判定留不留', [['判定指标', c.metric], ['改动前中位', c.before_median == null ? '—' : c.before_median], ['改动后中位', c.after_median == null ? '还没到评估点' : c.after_median], ['应用时刻', c.applied_at ? fmtTs(c.applied_at) : '—'], ['评估时刻', c.evaluate_at ? fmtTs(c.evaluate_at) : '—'], ['规则', '没改善就回滚；窗口跑完仍凑不够样本，也按未知回滚']])}>${c.before_median == null ? '—' : c.before_median}${c.after_median != null ? ` → ${c.after_median}` : ''}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="4"><div class="empty"><b>系统还没有改动过任何参数</b><span>它有权动的只有下面几个旋钮，单次最多 ±25%，且同时只允许一个在验证。</span></div></td></tr>';

  const knobList = (d.knobs ?? []).map(k => `<span class="tag"${tip(k.key, [['当前值', k.current], ['合法区间', `${k.min} – ${k.max}`], ['判定指标', k.judge], ['为什么是它', k.purpose]])}>${esc(k.label)} ${k.current}</span>`).join(' ');

  const selfCard = `
    <div class="how" style="margin-top:0">假设必须用<b>已有维度 × 已有指标</b>才登记得进来（表达不出来的不是假设，是感想）；参数改动必须<b>有界、单个在途、到期自动判定</b>，没改善或判不出来都自动回滚。<b>只记成功不记失败的系统不是在优化，是在积累偏见</b> —— 所以被拒和回滚的记录也留在这儿。发帖量、时段、间隔、日额度不在可改之列。</div>
    <div class="tw" style="margin-top:12px"><table><thead><tr><th>等审批的新假设</th><th>维度 / 指标</th><th>代价</th><th></th></tr></thead><tbody>${proposed}</tbody></table></div>
    <div class="sub" style="margin:12px 0 4px">可自动调整的旋钮（鼠标放上去看合法区间和判定指标）：</div>
    <div>${knobList}</div>
    <div class="tw" style="margin-top:12px"><table><thead><tr><th>参数改动</th><th class="num">变化</th><th>状态</th><th class="num">判定指标中位数</th></tr></thead><tbody>${paramRows}</tbody></table></div>
  `;

  const acting = d.playbook?.acting?.length
    ? `<div class="alert"><svg viewBox="0 0 24 24"><path d="M12 16v-4M12 8h.01"/><circle cx="12" cy="12" r="9"/></svg>
       <div>这一轮正在生效：${d.playbook.acting.map(a => esc(a.text)).join('； ')}。主题标签 ${d.playbook.hashtagTopics} 个 · ${d.playbook.attachChart ? '带图' : '不带图'} · 收尾${d.playbook.opening === 'question' ? '提问' : '陈述'}</div></div>`
    : '<div class="hint" style="margin-top:10px">现在还没有任何一条判断在影响写法 —— 每一篇仍按默认（带图、1 个主题标签、陈述收尾）。这不是没生效，是它还没拿到足够样本。</div>';

  const heat = d.heat || { bands: [], byAccount: [], unbanded: 0 };
  const heatMax = Math.max(1, ...heat.bands.map(b => b.medianViews ?? 0), ...heat.byAccount.map(a => a.medianViews ?? 0));
  const heatBar = (name, sub, m, n) => `<div class="hbar big${m == null ? ' off' : ''}">
      <span>${esc(name)}${sub ? `<span class="sub" style="display:block">${esc(sub)}</span>` : ''}</span>
      <span class="track"><i style="width:${m == null ? 0 : Math.max(3, (m / heatMax) * 100)}%;background:var(--blue)"></i></span>
      <span class="v">${m == null ? '—' : m.toLocaleString('en-US')}<span class="muted">${n} 条</span></span>
    </div>`;
  const heatCard = `<div class="card" style="margin-top:14px">
    <div class="card-hd"><h3>币的热度对浏览有多大影响</h3><span class="sub">24h 浏览中位数，只算满 24 小时的帖子。各档差得越多，下面的实验就越要看「分层比」，而不是混在一起的中位数</span></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;margin-top:8px">
      <div><div class="cap">按币的 24h 成交额</div><div class="hbars">${heat.bands.map(b => heatBar(b.band, b.label, b.medianViews, b.n)).join('')}</div></div>
      <div><div class="cap">按账号</div><div class="hbars">${heat.byAccount.map(a => heatBar(a.label || String(a.accountId), '', a.medianViews, a.n)).join('') || '<div class="muted">还没有满 24 小时的帖子</div>'}</div></div>
    </div>
    ${heat.unbanded ? `<div class="hint">另有 ${heat.unbanded} 条的素材没记下成交额，分层时退回用采集评分分档。</div>` : ''}
  </div>`;

  return `
  <div class="card">
    <div class="card-hd"><h3>流量引擎</h3><span class="sub">读不到币安的算法，所以用实验去问它</span>
      <span class="right">
        <div class="chips">${chips}</div>
        <button class="btn sm" onclick="rankReflect()">立即归纳一次</button>
      </span></div>
    <div style="margin-top:12px">${kpis}</div>
    ${targetReadout(d.target)}
    ${acting}
    <details class="fold"><summary>这套引擎怎么工作<i></i></summary><div class="fold-in"><div class="how">流程是固定的：先写下可被证伪的假设 → 机器人在发帖前按臂分配并记录 → 分档回看把浏览曲线变成分发事实 → 只有样本量和差距同时够格，才升为规则 → 规则写进长期记忆，之后每次写作前被读到。任何一条测出反果，旧结论会被新结论覆盖而不是删除，「我们曾经以为」也是要留下的。</div></div></details>
  </div>
  ${convObs}
  ${heatCard}
  <details class="fold"><summary>系统能改自己的两个地方 · 假设登记与参数旋钮<i></i></summary><div class="fold-in">${selfCard}</div></details>
  ${cards}
  <div class="card" style="margin-top:14px">
    <div class="card-hd"><h3>每条帖子的分发形状</h3><span class="sub">绝对浏览量混着币本身的热度，曲线形状才是引擎的决定</span></div>
    <div class="tw"><table><thead><tr><th class="num">帖子</th><th>20m→24h</th><th class="num"${tip('首读', [['含义', '发布后 20 分钟拿到的第一个读数']])}>首读</th><th class="num"${tip('最新', [['含义', '最近一档回看的读数（8 小时档，缺了就用 3 小时）']])}>最新</th><th class="num"${tip('首小时增速', [['怎么读', '20 分钟 → 1 小时的倍数；接近 1＝没被再推，越大＝引擎持续在分发']])}>首小时增速</th><th>上榜</th><th>本篇实验臂</th></tr></thead>
      <tbody>${curve}</tbody></table></div>
  </div>
  <div class="card" style="margin-top:14px">
    <div class="card-hd"><h3>长期记忆</h3><span class="sub">机器人现在记得的事，以及每条的出处和证据量</span></div>
    <div class="tw"><table><thead><tr><th>类型</th><th>内容</th><th class="num">置信</th><th class="num">证据</th><th class="num">记下于</th><th></th></tr></thead>
      <tbody>${mem}</tbody></table></div>
    <div class="hint">撤销一条记忆后，它不会在下一轮又被 AI 想出来 —— 只有重新测出同样的结果才会再写进来。</div>
  </div>`;
}

async function rankReflect() {
  toast('归纳中…');
  try {
    const r = await api('/api/rank/reflect', { method: 'POST' });
    // The rejections are the interesting half: a proposal that was refused tells you what the
    // model tried and why it could not be measured, which is how it stops repeating the same idea.
    toast(`写入 ${r.stored.length} 条判断${r.notes.length ? ' · ' + r.notes.slice(0, 2).join(' · ') : ''}`);
    await render();
  } catch (e) { toast('归纳失败：' + e.message, true); }
}

async function resolveHypothesis(id, approve) {
  if (!approve && !confirm('拒绝这条提议？它会作为「已拒绝」留下，避免下周又被提一次。')) return;
  const r = await api('/api/hypotheses/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, approve }) });
  if (r.error) return toast(r.error, true);
  toast(approve ? '已批准，下一轮发帖开始分配这个臂' : '已拒绝');
  await render();
}

async function forgetMemory(key) {
  if (!confirm('撤销这条判断？它会保留在历史里，但不再影响写作。')) return;
  await api('/api/memory/forget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
  toast('已撤销');
  await render();
}
/* ------------------------------------------------------------------ 工作室 --- */

let STUDIO_OPEN = 0;

async function studioView() {
  const d = await api('/api/studio');

  const bindCard = d.tracks.length === 0
    ? `<div class="card">
        <div class="card-hd"><h3>还没有账号绑定赛道</h3></div>
        ${d.unboundAccounts.length ? `
          <div class="muted" style="margin-bottom:10px">绑定后该账号会从短帖矩阵中退出 —— 一个账号同时服务两种人设，等于没有赛道。</div>
          ${d.unboundAccounts.map(a => `<div class="kv" style="margin-bottom:8px">
            <span class="b">${esc(a.label)}</span>
            ${d.availableTracks.map(t => `<button class="btn" onclick="bindTrack(${a.id},'${t.id}')">按「${esc(t.label)}」深耕</button>`).join('')}
          </div>`).join('')}
        ` : '<div class="muted">没有已启用的空闲账号。先到「账号」页启用一个并填 Key。</div>'}
        <div class="gh" style="margin-top:18px">其余四条赛道：现在不做，以及为什么</div>
        ${d.unimplemented.map(u => `<div class="kv" style="gap:10px;padding:6px 0;border-top:1px solid var(--line)">
          <span class="b" style="min-width:130px">${esc(u.label)}</span><span class="muted">${esc(u.reason)}</span></div>`).join('')}
      </div>`
    : '';

  const trackBlocks = d.tracks.map(t => {
    const tiers = {};
    for (const p of t.performance) (tiers[p.tier] ??= []).push(p);
    const ladder = Object.keys(tiers).sort((a, b) => a - b).map(tier => `
      <div class="grp">
        <div class="card-hd"><h3>第 ${tier} 层</h3><span class="sub">前置概念写完才会解锁下一层</span></div>
        <div class="tw"><table><thead><tr>
          <th>概念</th><th class="num">状态</th><th class="num">篇数</th><th class="num">读数</th>
          <th class="num">中位浏览</th><th class="num">互动/千</th><th class="num">订阅</th><th class="num">上榜</th>
        </tr></thead><tbody>
        ${tiers[tier].map(p => `<tr${p.rankable ? '' : ' class="off"'}>
          <td>${esc(p.title)}${p.needsUpdate ? ' <span class="pill warn">例子过期</span>' : ''}</td>
          <td class="num">${p.written ? '已发' : '未写'}</td>
          <td class="num">${p.articles}</td>
          <td class="num">${p.measured}${p.rankable ? '' : ' <span class="muted">不足</span>'}</td>
          <td class="num">${p.medianViews ? fmtN(p.medianViews) : '—'}</td>
          <td class="num">${p.engagementPer1k}</td>
          <td class="num">${p.subscribers || '—'}</td>
          <td class="num">${p.onBoard || '—'}</td>
        </tr>`).join('')}
        </tbody></table></div>
      </div>`).join('');

    return `<div class="card" style="margin-top:14px">
      <div class="kv">
        <span class="pill on">${esc(t.label)}</span>
        <span class="b">${esc(t.trackLabel)}</span>
        <span class="muted">每天 ${t.articlesPerDay ?? 2} 篇 · 已从短帖矩阵退出</span>
        <span class="spacer" style="flex:1"></span>
        <button class="btn" onclick="runStudio(false)">生成草稿</button>
        <button class="btn danger" onclick="unbindTrack(${t.accountId})">解除绑定</button>
      </div>
      <div class="gh" style="margin-top:16px">下一步写什么 · 以及为什么</div>
      ${t.next.length ? t.next.map(n => `<div class="kv" style="gap:10px;padding:7px 0;border-top:1px solid var(--line);align-items:flex-start">
        <span class="b" style="min-width:230px">${esc(n.title)}</span>
        <span class="muted" style="flex:1">${n.why.map(esc).join('；')}${n.forcedByExploration ? '（探索位）' : ''}</span>
      </div>`).join('') : '<div class="muted">当前数据源支撑不了任何待写概念。</div>'}
      <div class="gh" style="margin-top:16px">课程进度</div>
      ${t.summary.map(s => `<div class="hint">· ${esc(s)}</div>`).join('')}
      ${ladder}
    </div>`;
  }).join('');

  const conceptTitles = {};
  for (const t of d.tracks) for (const p of t.performance) conceptTitles[p.conceptId] = p.title;

  const articles = d.articles.length ? d.articles.map(a => {
    const st = a.stats;
    return `<div class="post">
      <div class="meta">
        <span class="st ${esc(a.status)}">${esc(STATUS_LABELS[a.status] || a.status)}</span>
        <span class="b">#${a.id}</span>
        <span>${esc(conceptTitles[a.concept_id] || a.concept_id)}</span>
        <span class="muted">${a.body.length} 字</span>
        <span class="spacer" style="flex:1"></span>
        ${a.status === 'published' && st
          ? `<span class="kv" style="gap:10px">${[['浏览', fmtN(st.views || 0)], ['赞', st.likes || 0], ['评', st.comments || 0], ['订阅', st.subscribers ?? 0]]
            .map(([k, v]) => `<span class="kv" style="gap:4px"><i class="sk">${k}</i><b>${v}</b></span>`).join('')}</span>`
          : a.status === 'published' ? '<span class="pill warn">尚无数据</span>' : ''}
      </div>
      <div class="b" style="margin:4px 0 8px;font-size:14px">${esc(a.title)}</div>
      ${STUDIO_OPEN === a.id ? `<div class="hint">赛道拒发清单命中：${a.refusal_hits ? esc(a.refusal_hits) : '无'}</div>
        ${(a.sections || []).map(sec => `<div class="grp">
          <div class="gh">${esc(sec.label || sec.id)} ${sec.rendered ? '' : '<span class="pill warn">未渲染</span>'}</div>
          <div class="body" style="white-space:pre-wrap;font-size:13.5px;line-height:1.75">${esc(sec.text || ('跳过原因：' + (sec.skipped || '')))}</div>
        </div>`).join('')}` : `<div class="body">${esc(a.body.slice(0, 160))}…</div>`}
      ${a.error ? `<div class="alert bad" style="margin-top:10px"><svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg><div>${esc(a.error)}</div></div>` : ''}
      <div class="post-ft">
        ${['draft', 'rejected'].includes(a.status) ? `<button class="btn sm primary" onclick="studioAct(${a.id},'approve')">通过</button>
          <button class="btn sm" onclick="studioPolish(${a.id})">AI 润色</button>
          <button class="btn sm danger" onclick="studioAct(${a.id},'reject')">驳回</button>` : ''}
        <button class="btn sm" onclick="toggleStudioArticle(${a.id})">${STUDIO_OPEN === a.id ? '收起结构' : '看五段结构'}</button>
        ${a.square_post_id ? `<a class="btn sm ghost" href="${esc(a.url || '#')}" target="_blank" rel="noopener">在广场查看 ↗</a>` : ''}
        <span class="muted" style="margin-left:auto">${a.status === 'published' ? '发布 ' + fmtTs(a.published_at) : '生成 ' + fmtTs(a.created_at)}</span>
      </div>
    </div>`;
  }).join('') : '<div class="empty"><b>还没有文章</b><span>点「生成草稿」，或等自动循环跑到工作室这一档。绑定赛道后这个号只会长文，不再出短帖。</span></div>';

  const refusals = d.tracks.length
    ? `<div class="card" style="margin-top:14px"><div class="card-hd"><h3>这个账号被禁止说什么</h3><span class="sub">发布前会再查一遍</span></div>
        ${[...new Set(d.availableTracks.find(t => t.id === d.tracks[0].trackId)?.refusals || [])].map(r => `<div class="hint">· ${esc(r)}</div>`).join('')}
        <div class="hint" style="margin-top:8px">润色后复检，因为「改写」正是把一句描述变成一句建议的方式 —— 那是语气的改变，不是词表的改变。</div>
      </div>` : '';

  const lessons = d.lessons.length
    ? `<div class="card" style="margin-top:14px"><div class="card-hd"><h3>它从数据里学到的</h3><span class="sub">被证伪的说法会记在这里，并让对应概念标记为需要重写</span></div>
        ${d.lessons.map(l => `<div class="hint">· <b>${esc(l.kind)}</b> ${esc(l.detail)}</div>`).join('')}
      </div>` : '';

  const warn = (STATE.warnings ?? []).length
    ? STATE.warnings.map(w => `<div class="alert bad" style="margin-top:14px">
        <svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>
        <div>${esc(w)}</div></div>`).join('')
    : '';

  return `${bindCard}${warn}${trackBlocks}${refusals}
    <div class="card" style="margin-top:14px"><div class="card-hd"><h3>文章队列</h3><span class="sub">${d.articles.length} 篇</span></div>${articles}</div>
    ${lessons}`;
}

async function bindTrack(accountId, trackId) {
  await api('/api/studio/bind', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId, trackId }) });
  toast('已绑定，该账号从短帖矩阵退出'); await render();
}
async function unbindTrack(accountId) {
  if (!confirm('解除绑定后该账号会回到短帖矩阵，已生成的文章草稿保留。')) return;
  await api('/api/studio/unbind', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId }) });
  toast('已解除绑定'); await render();
}
async function runStudio(live) {
  toast(live ? '工作室运行中…' : '生成草稿中…');
  const r = await api('/api/studio/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ live: !!live }) });
  const drafted = (r.accounts || []).reduce((s, a) => s + a.drafted.length, 0);
  const skipped = (r.accounts || []).flatMap(a => a.skipped);
  toast(`草稿 ${drafted} 篇${skipped.length ? ' · ' + skipped[0] : ''}`, !drafted);
  await render();
}
async function studioAct(id, act) {
  try {
    await api(`/api/studio/articles/${id}/${act}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    toast(act === 'approve' ? '已通过，等下一轮发布' : '已驳回'); await render();
  } catch (e) { toast(e.message, true); }
}
async function studioPolish(id) {
  toast('AI 润色中…');
  const r = await api(`/api/studio/articles/${id}/polish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  toast(r.changed ? '已润色（越界会被拒绝）' : '未采纳：' + (r.reason || ''));
  await render();
}
function toggleStudioArticle(id) { STUDIO_OPEN = STUDIO_OPEN === id ? 0 : id; render(); }

async function edit(id) {
  const p = await api('/api/posts/' + id);
  const host = $(`#post-${id}`);
  host.innerHTML = `<div class="meta"><span class="st ${esc(p.status)}">${esc(p.status)}</span><span class="b">#${p.id}</span></div>
    <textarea id="ta-${id}">${esc(p.text)}</textarea>
    <div class="row" style="margin-top:8px">
      <button class="btn primary" onclick="save(${id})">保存</button>
      <button class="btn" onclick="render()">取消</button>
      <span class="muted" id="cnt-${id}">${p.text.length} 字</span>
    </div>`;
  $(`#ta-${id}`).addEventListener('input', e => $(`#cnt-${id}`).textContent = `${e.target.value.length} 字`);
}
async function save(id) {
  try {
    await api('/api/posts/' + id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: $(`#ta-${id}`).value }) });
    toast('已保存'); await render();
  } catch (e) { toast('保存失败：' + e.message, true); }
}

async function toggleTrace(id) {
  const host = $(`#trace-${id}`);
  if (!host.classList.contains('hide')) { host.classList.add('hide'); host.innerHTML = ''; return; }
  host.innerHTML = '<div class="muted" style="padding:10px 0">读取中…</div>';
  host.classList.remove('hide');
  try {
    const p = await api('/api/posts/' + id);
    host.innerHTML = traceHtml(p);
  } catch (e) { host.innerHTML = `<div class="muted" style="color:var(--bad)">读取失败：${esc(e.message)}</div>`; }
}

const CHECK_LABELS = ['20 分钟', '1 小时', '3 小时', '8 小时', '24 小时', '72 小时'];

function curveHtml(curve) {
  if (!(curve || []).length) return '';
  const first = curve[0], last = curve[curve.length - 1];
  const growth = curve.length > 1 && first.views ? ` · 较首次 ${last.views >= first.views ? '+' : ''}${Math.round((last.views / first.views - 1) * 100)}%` : '';
  return `<div style="margin-top:12px"><div class="lbl">效果回看（按发布后时长分档实测）${esc(growth)}</div>
    <table style="margin-top:4px"><thead><tr><th>发布后</th><th>浏览</th><th>点赞</th><th>评论</th><th>转发</th><th>表态</th><th>测量时间</th></tr></thead>
    <tbody>${curve.map(c => `<tr><td class="muted">${esc(CHECK_LABELS[c.checkpoint] ?? '#' + c.checkpoint)}</td><td>${c.views ?? '—'}</td><td>${c.likes ?? '—'}</td><td>${c.comments ?? '—'}</td><td>${c.shares ?? '—'}</td><td>${c.reactions ?? '—'}</td><td class="muted">${fmtTs(c.at)}</td></tr>`).join('')}</tbody></table>
    <div class="muted" style="margin-top:6px">数字直接读广场自己的帖子接口（公开、无需鉴权），所以帖子不用上榜也测得到。取不到只可能是网络问题，不会是「0 阅读」被误当成「没数据」。</div></div>`;
}

function traceHtml(p) {
  const t = p.trace || {}, m = p.material, tpl = p.template;
  const kv = (o) => Object.entries(o || {}).filter(([k]) => !['literal'].includes(k))
    .map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td>${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</td></tr>`).join('');
  const ledger = (p.factLedger || []).filter(f => f.field !== 'literal');
  return `
  <div class="card" style="background:var(--panel2);margin-top:12px;padding:12px 14px">
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px">
      <div>
        <div class="lbl">素材</div>
        ${m ? `<div style="margin-top:4px"><span class="tag">${esc(m.category)}/${esc(m.subType)}</span>
          <div class="b" style="margin-top:4px">${esc(m.title)}</div>
          <div class="muted">热度 ${m.score?.toFixed?.(0) ?? m.score} · ${esc(m.source)} · ${fmtTs(m.at)} · <a href="#" onclick="showFacts(${p.id});return false">引用字段</a></div>
          <div id="facts-${p.id}" class="hide" style="margin-top:6px"><table><tbody>${kv(m.facts)}</tbody></table></div></div>`
        : '<div class="muted">无关联素材（手动创建或素材已清理）</div>'}
      </div>
      <div>
        <div class="lbl">模版</div>
        <div style="margin-top:4px">
          <span class="b">${esc(tpl?.name || p.template_id || '—')}</span>
          <div class="muted">${esc(tpl?.id || '')} · 风格 ${esc(tpl?.style || '')} · 权重 ${tpl?.weight ?? '—'}</div>
          ${tpl ? `<details style="margin-top:6px"><summary class="muted" style="cursor:pointer">模版源码</summary><pre style="white-space:pre-wrap;font-size:11.5px;color:var(--dim)">${esc(tpl.body)}</pre></details>` : ''}
        </div>
      </div>
      <div>
        <div class="lbl">生成过程</div>
        <div class="muted" style="margin-top:4px">seed ${esc(String(t.seed ?? '—'))} · 润色 ${esc(t.polish || '未启用')}</div>
        ${(t.banks||[]).length ? `<div style="margin-top:6px"><span class="muted">词库</span> ${(t.banks||[]).map(b=>`<span class="tag">${esc(b)}</span>`).join(' ')}</div>`:''}
        ${(t.pools||[]).length ? `<div style="margin-top:4px"><span class="muted">随机选词</span> ${(t.pools||[]).map(b=>`<span class="tag">${esc(b)}</span>`).join(' ')}</div>`:''}
        ${(t.branches||[]).length ? `<div style="margin-top:4px"><span class="muted">分支</span> ${(t.branches||[]).map(b=>`<span class="tag">${esc(b)}</span>`).join(' ')}</div>`:''}
      </div>
    </div>

    ${ledger.length ? `<div style="margin-top:12px"><div class="lbl">事实台账（正文里每个数字的出处）</div>
      <table style="margin-top:4px"><thead><tr><th>字段</th><th>输出值</th></tr></thead>
      <tbody>${ledger.map(f=>`<tr><td class="muted">${esc(f.field)}</td><td>${esc(f.surface)}</td></tr>`).join('')}</tbody></table></div>` : ''}

    ${curveHtml(p.curve)}

    ${p.alternatives && p.alternatives.length ? `
    <div class="row" style="margin-top:14px">
      <span class="muted">同素材其他模版：</span>
      <select id="alt-${p.id}" style="max-width:280px">${p.alternatives.map(a=>`<option value="${esc(a.id)}">${esc(a.name)}（${esc(a.style)}）</option>`).join('')}</select>
      <button class="btn" onclick="reroll(${p.id}, true)">用所选模版重写</button>
      <button class="btn" onclick="reroll(${p.id}, false)">同模版换一批</button>
    </div>` : `<div class="row" style="margin-top:14px"><button class="btn" onclick="reroll(${p.id}, false)">同模版换一批</button></div>`}
    <div class="muted" style="margin-top:6px">重写只换措辞与分支选择，素材里的事实数字不变；每次结果都会重新过事实台账校验。</div>
  </div>`;
}

function showFacts(id) { $(`#facts-${id}`).classList.toggle('hide'); }

async function reroll(id, useAlt) {
  const body = useAlt ? { templateId: $(`#alt-${id}`)?.value } : {};
  try {
    const r = await api(`/api/posts/${id}/reroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    toast(r.note === 'ai_polished' ? '已重写（AI 润色通过）' : '已重写');
    await render();
    await toggleTrace(id);
  } catch (e) { toast('重写失败：' + e.message, true); }
}

/**
 * 发帖记录卡上的 通过 / 驳回 / 撤回审核。
 * 这四个调用点原本指向一个不存在的函数（postAct 在全仓没有定义），所以队列里每一条草稿的
 * 审批按钮点了都没有反应 —— 服务端 /api/posts/:id/:action 一直是好的，坏的是界面。
 * approve 命中结构重复时服务端返回 409 与原因，这里如实弹出来，不静默。
 */
async function postAct(id, action) {
  try {
    await api(`/api/posts/${id}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    toast(action === 'approve' ? '已通过，等下一轮发布' : action === 'unapprove' ? '已撤回审核，回到草稿' : '已驳回');
    await render();
  } catch (e) { toast(e.message, true); }
}

async function templatesView() {
  const rows = await api('/api/templates');
  const byCat = {};
  for (const t of rows) byCat[t.categoryCn || '通用'] = (byCat[t.categoryCn || '通用'] || 0) + 1;
  return `<div class="card">
    <div class="card-hd"><h3>模版库</h3><span class="sub">${rows.length} 条骨架 · ${Object.keys(byCat).length} 类素材 · 权重按实测浏览自动调整</span></div>
    <div class="hint" style="margin-top:0">权重决定被选中的相对概率；关掉某条模版后，它对所有账号都不再生成。同一模版攒够 3 条有读数的帖子才会动权重。</div>
  </div>
  <div class="card" style="margin-top:14px"><div class="tw"><table>
    <thead><tr><th>启用</th><th class="num">权重</th><th>名称</th><th>适配素材</th><th>风格</th><th>ID</th></tr></thead>
    <tbody>${rows.map(t => `<tr>
      <td><input type="checkbox" style="width:auto" ${t.enabled ? 'checked' : ''} onchange="setTpl('${esc(t.id)}',{enabled:this.checked})"></td>
      <td class="num"><input type="number" style="width:66px;text-align:right" step="0.1" min="0" max="5" value="${t.weight}" onchange="setTpl('${esc(t.id)}',{weight:+this.value})"></td>
      <td><span class="b">${esc(t.name)}</span></td>
      <td><span class="tag">${esc(t.categoryCn || '不限')}</span>${t.sub_type ? `<span class="sub">${esc(t.signalCn || t.sub_type)}</span>` : ''}</td>
      <td class="muted">${esc(t.styleCn || t.style || '')}</td>
      <td class="muted" style="font-size:11.5px">${esc(t.id)}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}
async function setTpl(id, patch) {
  await api('/api/templates/' + id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  toast('模版已更新');
}

function settingsView() {
  const s = STATE.settings;
  const num = (key, label, hint) => `<div class="field"><span class="cap">${label}</span>
    <input type="number" id="set-${key}" value="${s[key]}"><div class="hint">${hint}</div></div>`;
  const sel = (key, label, options, hint) => `<div class="field"><span class="cap">${label}</span>
    <select id="set-${key}">${options.map(([v, l]) => `<option value="${v}" ${String(s[key]) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>
    ${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  const section = (title, sub, body) => `<div class="card"><div class="card-hd"><h3>${title}</h3><span class="sub">${sub}</span></div>
    <div class="form-grid">${body}</div></div>`;

  return `
  ${section('节奏与额度', '一天发多少、隔多久发、几点到几点发', `
    ${num('postsPerDay', '目标帖数 / 天', '活跃时段内按这个条数均匀铺开')}
    ${num('dailyCap', '每日硬上限', '留些余量给手动发布，不超过币安 100')}
    ${num('minIntervalMinutes', '两帖最小间隔（分钟）', '任何情况下都不比这更密')}
    ${sel('activeStartHour', '发帖时段开始（北京时间）', [0, 6, 8, 9, 10, 12].map(v => [v, `${v}:00`]))}
    ${sel('activeEndHour', '发帖时段结束', [12, 18, 20, 22, 23, 24].map(v => [v, `${v === 24 ? 24 : v}:00`]))}`)}
  ${section('发布方式', '谁来决定一条草稿能不能发出去', `
    ${sel('autoPublish', '发布方式', [['false', '人工审核（默认）'], ['true', '自动发布']], '关掉后草稿停在「待审核」，你在发帖记录里点通过')}
    ${sel('autoRun', '自动循环', [['true', '开（自己采集 / 生成 / 采样 / 发布）'], ['false', '关（只响应手动按钮）']])}
    ${num('tickMinutes', '循环间隔（分钟）', '3 – 240')}`)}
  ${section('内容策略', '写什么语气、文末带什么', `
    ${sel('style', '写作风格', [['mixed', '混合风格'], ['tech', '技术分析派'], ['news', '快讯速递派'], ['data', '数据派'], ['capital', '资金追踪派'], ['emotion', '情绪派'], ['chat', '唠嗑派'], ['joke', '段子手']], '单账号的岗位在「账号」页里各自设置，这里是兜底')}
    ${sel('appendDisclaimer', '文末免责声明', [['true', '加上'], ['false', '不加']])}
    ${sel('appendHashtags', '文末 #币种 标签', [['true', '加上（进话题页）'], ['false', '不加']])}
    <div class="field" style="grid-column:1/-1"><span class="cap">敏感词（逗号分隔，命中即不生成）</span>
      <input type="text" id="set-sensitiveWords" value="${esc(s.sensitiveWords.join(', '))}"></div>`)}
  ${section('配图', 'K 线只能自己画', `
    ${sel('attachChart', 'K 线图配图', [['true', '带上自绘 K 线'], ['false', '纯文字']])}
    ${sel('chartInterval', 'K 线周期', [['1h', '1 小时'], ['4h', '4 小时'], ['1d', '日线']])}
    <div class="hint" style="grid-column:1/-1">实测过：正文里的 <b>$币种</b> 会被广场换成一张实时价格小卡，但编辑器那个 K 线组件走接口发不出去 —— 真发过一条，币安收下了帖子、把组件字段丢了。所以图只能作为附件上传。</div>`)}
  ${section('多账号与数据', '号与号之间怎么错开，旧数据留多久', `
    ${num('crossAccountGapMinutes', '跨号最小间隔（分钟）', '任何两个号之间')}
    ${num('crossAccountCoinExclusionMinutes', '币独占时长（分钟）', '一个币多久之内只允许一个号发')}
    ${num('dataRetentionDays', '数据保留（天）', '超出的素材 / 样本 / 日志会被清理')}`)}
  <div class="row" style="margin-top:14px">
    <button class="btn primary" onclick="saveSettings()">保存设置</button>
    <span class="muted">改这里不会动到币安的任何设置，只影响本工具的排期与文案策略。</span>
  </div>`;
}
async function saveSettings() {
  const g = id => $(`#set-${id}`).value;
  const patch = {
    postsPerDay: +g('postsPerDay'), dailyCap: +g('dailyCap'), minIntervalMinutes: +g('minIntervalMinutes'),
    activeStartHour: +g('activeStartHour'), activeEndHour: +g('activeEndHour'),
    style: g('style'), autoPublish: g('autoPublish') === 'true', appendDisclaimer: g('appendDisclaimer') === 'true',
    appendHashtags: g('appendHashtags') === 'true', attachChart: g('attachChart') === 'true', chartInterval: g('chartInterval'),
    autoRun: g('autoRun') === 'true', tickMinutes: +g('tickMinutes'),
    crossAccountGapMinutes: +g('crossAccountGapMinutes'), crossAccountCoinExclusionMinutes: +g('crossAccountCoinExclusionMinutes'),
    dataRetentionDays: +g('dataRetentionDays'),
    sensitiveWords: g('sensitiveWords').split(/[,，]/).map(x => x.trim()).filter(Boolean),
  };
  await api('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  toast('设置已保存'); await render();
}

let MODELS = [];

/*
 * The AI form spans several fields but is committed by one button, and almost every
 * other action on this page re-renders it from server state. Without this, typing a
 * base URL and then pressing 「保存 Key」 or 「拉取模型」 silently reverted the URL you
 * had just typed — the field looked like it had never accepted it.
 */
const LLM_DRAFT = {};
const LLM_FIELDS = { 'in-base': 'llmBaseUrl', 'in-model': 'llmModel', 'in-maxtok': 'llmMaxTokens', 'in-temp': 'llmTemperature', 'in-llmkey': 'llmKeyPending', 'in-sqkey': 'sqKeyPending' };

const FIELD_NAMES = { llmBaseUrl: 'Base URL', llmModel: '模型', llmMaxTokens: '最大 token', llmTemperature: '温度', llmEnabled: '启用' };

function captureLlmForm() {
  for (const [id, key] of Object.entries(LLM_FIELDS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const v = String(el.value ?? '');
    if (v.trim()) LLM_DRAFT[key] = v; else delete LLM_DRAFT[key];
  }
  const on = document.getElementById('in-llmon');
  if (on) LLM_DRAFT.llmEnabled = on.checked ? 'true' : 'false';
}

/** Draft wins over server state, because the draft is what the user is looking at. */
function dv(key, serverValue) {
  return key in LLM_DRAFT ? LLM_DRAFT[key] : serverValue;
}

const GATEWAY_PRESETS = [
  { label: 'OpenAI', provider: 'openai', url: 'https://api.openai.com/v1' },
  { label: 'Anthropic', provider: 'anthropic', url: 'https://api.anthropic.com/v1' },
  { label: 'OpenRouter', provider: 'openai', url: 'https://openrouter.ai/api/v1' },
  { label: 'DeepSeek', provider: 'openai', url: 'https://api.deepseek.com/v1' },
  { label: 'LM Studio', provider: 'openai', url: 'http://localhost:1234/v1' },
  { label: 'Ollama', provider: 'openai', url: 'http://localhost:11434/v1' },
];

function showResult(id, kind, msg) {
  const el = $(id);
  if (!el) return;
  el.className = `result show ${kind ?? 'busy'}`;
  el.innerHTML = msg;
}

async function connectView() {
  const sec = await api('/api/secrets');
  const s = STATE.settings;
  const find = n => sec.items.find(i => i.name === n) || {};
  const sq = find('squareApiKey');
  const provider = s.llmProvider || 'openai';
  const keyName = provider === 'anthropic' ? 'anthropicApiKey' : 'openaiApiKey';
  const lk = find(keyName);
  // What the user sees in a box is not necessarily what the server has. Say so.
  const dirty = Object.keys(LLM_DRAFT).filter(k => k !== 'llmKeyPending' && k !== 'sqKeyPending')
    .filter(k => String(LLM_DRAFT[k]) !== String(s[k] ?? ''));

  return `
  <div class="card" style="margin-bottom:14px">
    <div class="card-hd"><h3>币安广场 OpenAPI Key</h3>
      <span class="sub">在币安广场「创作者中心 → OpenAPI」生成，发布帖子需要它</span>
      <span class="right"><span class="pill ${sq.set ? 'on' : 'warn'}">${sq.set ? '已配置' + (sq.fromEnv ? '（来自 .env）' : '') : '未配置'}</span></span>
    </div>
    <div class="field">
      <span class="cap">Key</span>
      <div class="inputline">
        <input type="password" id="in-sqkey" value="${esc(LLM_DRAFT.sqKeyPending || '')}" placeholder="${sq.set ? '已保存 ' + esc(sq.masked) + ' · 留空则不改动' : '粘贴 sk_… 开头的广场 Key'}" autocomplete="off" onkeydown="if(event.key==='Enter')saveSqKey()">
        <button class="btn primary" onclick="saveSqKey()">保存</button>
        <button class="btn" onclick="testSqKey()">验证</button>
        ${sq.set ? '<button class="btn danger" onclick="clearSqKey()">清除</button>' : ''}
      </div>
      <div class="hint"><b style="color:var(--warn)">只填广场 Key。</b>交易所的 API Key / Secret 能提现能交易，绝对不要填进来——广场 Key 只有发帖权限，碰不到资金。</div>
      <div class="hint">「验证」会发一次<b>空正文</b>请求：鉴权先于内容校验，返回「正文为空」即证明 Key 有效，且不会发出任何帖子。</div>
      <div class="result" id="sqResult"></div>
    </div>
  </div>

  <div class="card">
    <div class="card-hd"><h3>AI 连接</h3>
      <span class="sub">Base URL、Key、模型、润色开关都搬到了「AI 大脑」页，和大脑共用同一个连接。</span>
      <span class="right"><span class="pill ${s.llmEnabled ? 'on' : ''}">${s.llmEnabled ? '已启用 · ' + esc(s.llmModel || '未选模型') : '未启用'}</span></span>
    </div>
    <div class="row" style="margin-top:8px"><button class="btn primary" onclick="go('brain')">去 AI 大脑页配置</button></div>
    </div>`;
}

async function saveSqKey() {
  const v = $('#in-sqkey').value.trim();
  if (!v) return toast('输入框是空的', true);
  await api('/api/secrets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'squareApiKey', value: v }) });
  $('#in-sqkey').value = '';
  toast('广场 Key 已保存'); await render();
}
async function clearSqKey() {
  if (!confirm('清除本机保存的广场 Key？')) return;
  await api('/api/secrets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'squareApiKey', value: '' }) });
  toast('已清除'); await render();
}
async function testSqKey() {
  showResult('#sqResult', 'busy', '正在验证…（发一次空正文请求，不会发帖）');
  try {
    const r = await api('/api/secrets/square/test', { method: 'POST' });
    showResult('#sqResult', r.ok ? 'good' : 'bad', (r.ok ? '✓ ' : '✗ ') + esc(r.label) + (r.code ? ` <span class="muted">(code ${esc(r.code)})</span>` : ''));
    toast(r.ok ? 'Key 有效' : 'Key 有问题', !r.ok);
  } catch (e) { showResult('#sqResult', 'bad', '验证失败：' + esc(e.message)); }
}

function currentProvider() { return STATE.settings?.llmProvider || 'openai'; }

function pickModel(id) {
  $('#in-model').value = id;
  LLM_DRAFT.llmModel = id;
}

/**
 * render() re-reads the DOM before drawing, so dropping the draft alone is not enough —
 * the boxes have to be emptied too, after which the next capture finds nothing and the
 * server values show through again.
 */
function discardLlmDraft() {
  for (const k of Object.keys(LLM_DRAFT)) delete LLM_DRAFT[k];
  for (const id of Object.keys(LLM_FIELDS)) {
    const el = document.getElementById(id);
    if (el) el.value = '';
  }
  render();
}

function defaultBaseFor(p) { return GATEWAY_PRESETS.find(g => g.provider === p)?.url || ''; }

async function switchProvider(p, baseUrl) {
  const cur = dv('llmBaseUrl', STATE.settings.llmBaseUrl || '');
  // Switching to Anthropic with api.openai.com still in the box only produces a 401, so
  // a stock URL follows the provider. Anything the user typed by hand is left alone.
  const stock = GATEWAY_PRESETS.some(g => g.provider !== p && g.url === cur);
  const url = baseUrl || (stock || !cur.trim() ? defaultBaseFor(p) : cur);
  LLM_DRAFT.llmBaseUrl = url;
  try {
    const next = await api('/api/llm/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ llmProvider: p, llmBaseUrl: url }) });
    // A different provider means a different key and a different model catalogue.
    MODELS = [];
    STATE.settings = { ...STATE.settings, ...next };
    await render();
  } catch (e) { toast('切换失败：' + e.message, true); }
}

function applyPreset(provider, url) {
  switchProvider(provider, url);
}

async function saveLlmKey() {
  const key = $('#in-llmkey').value.trim();
  if (!key) return toast('输入框是空的', true);
  await api('/api/llm/key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: currentProvider(), value: key }) });
  delete LLM_DRAFT.llmKeyPending; // it lives on the server now; the rest of the form stays as typed
  toast('Key 已保存'); await render();
}

function llmFormPayload() {
  return {
    llmEnabled: $('#in-llmon').checked,
    llmProvider: currentProvider(),
    llmBaseUrl: $('#in-base').value.trim(),
    llmModel: $('#in-model').value.trim(),
    llmMaxTokens: +$('#in-maxtok').value,
    llmTemperature: +$('#in-temp').value,
  };
}

async function saveLlm() {
  const key = $('#in-llmkey').value.trim();
  if (key) await api('/api/llm/key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: currentProvider(), value: key }) });
  const next = await api('/api/llm/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(llmFormPayload()) });
  STATE.settings = { ...STATE.settings, ...next };
  delete LLM_DRAFT.llmKeyPending;
  toast('配置已保存'); await render();
}

async function fetchModels() {
  showResult('#llmResult', 'busy', '正在拉取模型列表…');
  try {
    const r = await api('/api/llm/models', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: currentProvider(), baseUrl: $('#in-base').value.trim(), apiKey: $('#in-llmkey').value.trim() }),
    });
    MODELS = r.models;
    await render();
    showResult('#llmResult', r.count ? 'good' : 'bad', r.count ? `✓ 拉到 ${r.count} 个模型，在下方列表里点选` : '该接口返回了 0 个模型，可直接在输入框手填模型名');
  } catch (e) { showResult('#llmResult', 'bad', '拉取失败：' + esc(e.message)); }
}

async function testLlm() {
  showResult('#llmResult', 'busy', '正在请求一次对话…');
  try {
    await api('/api/llm/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(llmFormPayload()) });
    const r = await api('/api/llm/test', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: $('#in-llmkey').value.trim() }),
    });
    showResult('#llmResult', 'good', `✓ ${esc(r.model)} 回复：${esc(r.reply)}`);
    toast('AI 连通');
  } catch (e) { showResult('#llmResult', 'bad', '测试失败：' + esc(e.message)); }
}

async function act(kind) {  const btn = event.target; btn.disabled = true;
  try {
    if (kind === 'collect') {
      toast('抓取中…');
      const r = await api('/api/collect', { method: 'POST' });
      toast(`抓到 ${r.fetched} 条，入库 ${r.inserted} 条${r.errors.length ? `，${r.errors.length} 个源失败` : ''}`);
    } else {
      const r = await api('/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n: STATE.settings.postsPerDay }) });
      toast(`生成 ${r.created.length} 条草稿${r.skipped.length ? `，跳过 ${r.skipped.length}` : ''}`);
    }
    await render();
  } catch (e) { toast('失败：' + e.message, true); }
  btn.disabled = false;
}

async function publish() {
  const live = STATE.hasKey && confirm('点「确定」= 真实发布到币安广场；点「取消」= 仅演练。\n\n真实发布会把队列中已到时间的「已通过」帖子直接发到你账号上。');
  try {
    const r = await api('/api/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ live }) });
    toast(`${live ? '真实' : '演练'}：成功 ${r.published.length} · 待确认 ${r.uncertain.length} · 失败 ${r.failed.length}${r.paused ? ' · 已暂停' : ''}`, r.paused);
    await render();
  } catch (e) { toast('发布失败：' + e.message, true); }
}

/* --------------------------------------------------------------- 运行台 --- */

/**
 * 状态词汇只有一套：shared/告警总线契约v1.md（后端定版）。这一层不另造等级名，也不把
 * 「总线给的」和「面板现在自己算的」混成同一栏 —— 总线还没上线，界面必须说清每条读数的出处，
 * 否则面板绿了而没人知道它在读什么。
 *
 * 面板自算的项目只覆盖 /api/status 已有的事实；要靠服务端算的（应发 vs 实发的差、回执不符、
 * 缺图、放大被挡）在这里显式列成「还没接上」，不假装通过。
 */
const SEVERITY = ['info', 'warning', 'fault', 'breach'];
const sevRank = s => { const i = SEVERITY.indexOf(s); return i < 0 ? 0 : i; };
/** 契约 §4：带因由码的「没发」是计划内空档，没码的「没发」才是故障。 */
const PLANNED_CODES = new Set(['no_material', 'quota_spent', 'breaker_on', 'human_pause']);
/** 契约 §2 的 kind（v1.1 起 15 个：原 13 + loop_stalled + credential_missing）。 */
const CONTRACT_KINDS = new Set(['collect_gap', 'collect_gap_clear', 'publish_stall_warning', 'publish_stall_fault',
  'publish_stall_breach', 'expected_gap', 'account_pool_empty', 'breaker_tripped', 'receipt_mismatch',
  'degrade_declared', 'image_missing', 'font_subset_missing', 'surge_blocked', 'loop_stalled', 'credential_missing']);
const HOUR = 3600_000;

const KIND_CN = {
  collect_gap: '长文观察读不到', collect_gap_clear: '观察空洞已恢复',
  publish_stall_warning: '停发预警（5h）', publish_stall_fault: '停发故障（12h）', publish_stall_breach: 'R2 违约（24h）',
  expected_gap: '应发与实发有差', account_pool_empty: '可发布账号集合为空', breaker_tripped: '发布门熔断（总线台账）',
  receipt_mismatch: '回执与声明不符', degrade_declared: '发布前显式降级', image_missing: '广场侧无图',
  font_subset_missing: 'CJK 子集缺失', surge_blocked: '放大未入队',
  loop_stalled: '主循环停摆', credential_missing: '发布凭据不可用',
};
/** 契约 §3 v1.1：loop_stalled / credential_missing 用 subreason 分态，不另开 kind。 */
const SUBREASON_CN = {
  tick_never_ran: '这个进程还没跑过一轮 tick', tick_stale: '最后一轮 tick 距今超过 2 小时',
  tick_reports_failure: '上一轮 tick 记了失败', auto_run_off: '自动循环被关着',
  square_key_missing: '没有广场 Key，只能演练', key_decrypt_fail: '密钥读不出来',
};
const CODE_CN = { no_material: '素材荒（供给不足）', quota_spent: '配额用尽', breaker_on: '熔断中（发布门那枚）', human_pause: '人为暂停' };
/** 契约里靠服务端产出、面板此刻读不到的那些 —— 明写出来，别让它沉默地变成绿色。 */
const NOT_WIRED_YET = ['publish_stall_warning', 'publish_stall_fault', 'publish_stall_breach', 'receipt_mismatch',
  'image_missing', 'degrade_declared', 'surge_blocked', 'collect_gap', 'font_subset_missing'];

const envelope = (kind, severity, key, detail, o = {}) => ({
  kind, severity, key, detail, firstAt: null, lastAt: null, count: 1, ageHours: null,
  reasonCode: null, samplesInWindow: null, acked: false, source: 'panel', ...o,
});

/** 契约 §3 的去重与升档：同类按 kind+key 合并，severity 单调升，acked 由总线说了算。 */
function mergeAlerts(items) {
  const by = new Map();
  for (const it of items) {
    const id = `${it.kind}|${it.key}`;
    const prev = by.get(id);
    if (!prev) { by.set(id, { ...it, subreasons: it.subreasons || (it.subreason ? [it.subreason] : undefined) }); continue; }
    if (sevRank(it.severity) > sevRank(prev.severity)) { prev.severity = it.severity; if (it.subreason) prev.subreason = it.subreason; }
    if (it.subreasons) prev.subreasons = [...new Set([...(prev.subreasons || []), ...it.subreasons])];
    prev.count = (prev.count || 1) + (it.count || 1);
    prev.lastAt = Math.max(prev.lastAt || 0, it.lastAt || 0) || null;
    prev.firstAt = prev.firstAt || it.firstAt || null;
    if (it.detail) prev.detail = it.detail;
    if (it.reasonCode) prev.reasonCode = it.reasonCode;
    prev.displayOnly = Boolean(prev.displayOnly) && Boolean(it.displayOnly);
    if (it.source === 'bus') prev.source = 'bus';
  }
  return [...by.values()];
}

/** 把 /api/status 变成契约信封。纯函数：不碰 DOM，可单测。 */
function opsState(state, now = Date.now()) {
  const s = state.settings || {};
  const accounts = state.accounts || [];
  const enabled = accounts.filter(a => a.enabled);
  const matrixPool = enabled.filter(a => !a.trackId);
  const tick = state.loop && state.loop.lastTick ? state.loop.lastTick : null;
  const out = [];

  for (const a of (state.alerts || [])) out.push({ ...a, source: 'bus', acked: Boolean(a.acked) });

  if (state.pause && state.pause.paused) {
    out.push(envelope('expected_gap', 'info', 'pause', `已暂停：${state.pause.reason || '原因未记录'}`, { reasonCode: 'human_pause', firstAt: state.pause.at || null }));
  } else if (!enabled.length) {
    out.push(envelope('account_pool_empty', 'fault', 'enabled',
      '一个启用中的账号都没有。面板读不到审计事件，分不清这是人为停用还是故障 —— 有因由码才算计划内，所以这里按故障记。'));
  } else if (!matrixPool.length) {
    out.push(envelope('account_pool_empty', 'fault', 'matrix',
      `短帖通路没有可用账号：${enabled.length} 个启用号全被长文工作室占用。这正是上一轮「启用了号还是发不出」的形态。`));
  }
  if (state.hasKey === false) out.push(envelope('credential_missing', 'fault', 'square', '没有广场 Key —— 现在只能演练，发不出去。', { subreason: 'square_key_missing' }));
  // 契约 v1.1：主循环的四态折叠成一条 loop_stalled（key 固定 "loop"），只有 auto_run_off 单独出现时降 warning。
  const loop = [];
  if (!tick) loop.push({ subreason: 'tick_never_ran', detail: SUBREASON_CN.tick_never_ran, severity: 'fault' });
  else {
    const ageHours = tick.at ? (now - tick.at) / HOUR : null;
    if (ageHours != null && ageHours > 2) loop.push({ subreason: 'tick_stale', detail: `最后一轮 tick 是 ${ageHours.toFixed(1)} 小时前 · ${SUBREASON_CN.tick_stale}`, severity: 'fault' });
    if (tick.failed > 0) loop.push({ subreason: 'tick_reports_failure', detail: `上一轮记了 ${tick.failed} 次失败（不等于丢帖，但一定有事）。`, severity: 'fault' });
  }
  if (s.autoRun === false) loop.push({ subreason: 'auto_run_off', detail: `${SUBREASON_CN.auto_run_off}，系统不会自己发任何东西。`, severity: 'warning' });
  if (loop.length) {
    const worstLoop = loop.reduce((w, l) => (sevRank(l.severity) > sevRank(w.severity) ? l : w), loop[0]);
    out.push(envelope('loop_stalled', worstLoop.severity, 'loop', loop.map(l => l.detail).join('；'), { subreason: worstLoop.subreason, subreasons: loop.map(l => l.subreason) }));
  }
  // orphan_posts 不设总线 kind（契约 v1.1）：后端从「草稿必须挂账号」那条线消灭它，面板只展示、不驱动灯。
  if (state.orphanPending > 0) out.push(envelope('orphan_posts', 'info', 'queue', `${state.orphanPending} 条草稿/已通过没有归属账号，没有号会去发它们。`, { displayOnly: true }));
  if (state.unused === 0) out.push(envelope('expected_gap', 'info', 'supply', '素材池没有够格的新素材 —— 这是供给不足，不是停发。', { reasonCode: 'no_material' }));
  if (s.dailyCap && (state.publishedToday || 0) >= s.dailyCap) {
    out.push(envelope('expected_gap', 'info', 'quota', `今日 ${state.publishedToday}/${s.dailyCap} 已用满。`, { reasonCode: 'quota_spent' }));
  }

  const all = mergeAlerts(out);
  const isPlanned = a => a.reasonCode && PLANNED_CODES.has(a.reasonCode);
  const live = all.filter(a => !a.acked && !isPlanned(a) && !a.displayOnly);
  const worst = live.reduce((w, a) => (sevRank(a.severity) > sevRank(w) ? a.severity : w), 'info');
  return { all, live, shown: all.filter(a => a.displayOnly && !a.acked), planned: all.filter(isPlanned), worst };
}

/* --------------------------------------- 可达性三件套：灯 · 图标 · 系统通知 --- */

const LIGHT = { breach: ['■', '#e5484d'], fault: ['■', '#e5484d'], warning: ['▲', '#f5a524'], info: ['●', '#22c55e'] };

/** 浏览器标签页标题灯：不打开运行台也能从任务栏看见。 */
function paintOpsTitle(res) {
  const [mark] = LIGHT[res.worst] || LIGHT.info;
  const top = res.live.slice().sort((a, b) => sevRank(b.severity) - sevRank(a.severity))[0];
  const tail = res.worst === 'info' ? '正常' : `${KIND_CN[top.kind] || top.kind}${top.count > 1 ? ` ×${top.count}` : ''}`;
  document.title = `${mark} ${tail} · squareforge`;
}

function paintOpsFavicon(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="${color}"/>`
    + '<circle cx="16" cy="16" r="6" fill="#0b0d12"/></svg>';
  let link = document.querySelector('link[rel="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
  link.type = 'image/svg+xml';
  link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}

/**
 * 系统通知：同类按 kind+key 计，20 小时内不重复（沿用测试线「同类警报 20h 不重复」的节流口径），
 * 只在 fault / breach 上发 —— 预警洪水会让人关掉权限，那等于没有告警。
 */
function opsNotify(res, now = Date.now()) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return [];
  const fired = [];
  for (const a of res.live) {
    if (sevRank(a.severity) < 2) continue;
    const id = `sf-notify-${a.kind}-${a.key}`;
    let last = 0;
    try { last = Number(localStorage.getItem(id) || 0); } catch (_) { last = 0; }
    if (now - last < 20 * HOUR) continue;
    try { localStorage.setItem(id, String(now)); } catch (_) { /* 存不下也要通知出去 */ }
    new Notification(`${KIND_CN[a.kind] || a.kind} · squareforge`, { body: a.detail, tag: id });
    fired.push(a);
  }
  return fired;
}

function opsRefresh(state) {
  const res = opsState(state);
  const [, color] = LIGHT[res.worst] || LIGHT.info;
  paintOpsTitle(res);
  paintOpsFavicon(color);
  opsNotify(res);
  OPS_LAST = res;
  return res;
}
let OPS_LAST = null;

async function opsAskPermission() {
  if (typeof Notification === 'undefined') return toast('这个浏览器没有 Notification API', true);
  const r = await Notification.requestPermission();
  toast(r === 'granted' ? '系统通知已开启：故障与违约会直接弹到桌面' : `通知权限：${r} —— 没给也不影响，标题灯和图标照常`);
  await render();
}

async function opsView() {
  const res = OPS_LAST || opsState(STATE);
  const sort = (a, b) => sevRank(b.severity) - sevRank(a.severity) || (b.lastAt || 0) - (a.lastAt || 0);
  const sevCls = x => (x === 'breach' || x === 'fault' ? 'bad' : x === 'warning' ? 'warn' : 'ok');
  const SEV_WORD = { breach: '故障', fault: '故障', warning: '预警', info: '正常' };
  // 行卡化：状态灯 + 中文名做主体；key／出处／次数／最近／因由码压成一行小字，全文进悬浮。
  // 两态分开：acked:false 有"从未签"与"签后过 24h 窗重火"，只有 ackedAt 能区分（§7.79）。
  const row = a => {
    const ack = a.acked
      ? `<span class="pill on plain">已确认${a.ackedBy ? ' · ' + esc(a.ackedBy) : ''}</span>`
      : a.ackedAt ? '<span class="pill warn plain">签后过窗重火（需再签）</span>' : '<span class="pill bad plain">从未签</span>';
    const subBits = [
      a.source === 'bus' ? '总线' : '面板自算',
      a.count > 1 ? `×${a.count}` : null,
      a.lastAt ? ago(a.lastAt) : null,
      a.reasonCode ? (CODE_CN[a.reasonCode] || a.reasonCode) : null,
      a.subreason ? (SUBREASON_CN[a.subreason] || a.subreason) : null,
    ].filter(Boolean);
    return `<tr>
      <td><span class="opill ${sevCls(a.severity)}" title="${esc(a.kind)} · key ${esc(a.key)}${a.firstAt ? ` · 首次 ${fmtTs(a.firstAt)}` : ''}"><i></i>${esc(KIND_CN[a.kind] || a.kind)}</span>
        <span class="sub">${esc(subBits.join(' · '))}</span></td>
      <td class="dline" title="${esc(a.detail || '')}">${esc(a.detail || '—')}</td>
      <td class="num">${ack}</td>
    </tr>`;
  };
  const live = res.live.slice().sort(sort);
  const shown = (res.shown || []).slice().sort(sort);
  const ackedRows = res.all.filter(a => a.acked);
  const planned = res.planned.slice().sort(sort);
  let legacy = null;
  try { const b = await api('/api/brain'); legacy = (b.alarms || []).filter(x => x.code !== 'outlier_good' && x.code !== 'gate_a_cleared'); } catch (_) { legacy = null; }
  const notWired = NOT_WIRED_YET.map(k => `<span class="tag">${esc(KIND_CN[k])}</span>`).join(' ');
  const kinds = alertKinds(res.all);
  const brk = breakerGrid(STATE.alerts ? STATE.alerts : null);
  // 三分出处（§9c 判据 4 加）：这一页比概览多一枚旧告警码面（legacy），note 面在此才完整。
  const faces = blockerFaces({ alerts: STATE.alerts, ops: res, notes: STATE.loop?.lastTick?.notes ?? null, alarms: legacy });
  const kindRows = kinds.rows.map(r => `<tr>
      <td><span class="pill ${r.severity === 'breach' || r.severity === 'fault' ? 'bad' : r.severity === 'warning' ? 'warn' : 'plain'}">${esc(KIND_CN[r.kind] || r.kind)}</span> <span class="muted">${esc(r.kind)}</span></td>
      <td class="muted">${r.bus && r.panel ? '总线＋面板' : r.bus ? '总线' : '面板自算'}</td>
      <td class="num">${r.total}</td>
      <td class="num${r.unacked ? ' bad' : ''}">${r.unacked}</td>
      <td class="muted dline" title="${esc(r.keys.join(' / '))}">${esc(r.keys.join(' / ') || '未记录')}</td></tr>`).join('');

  const tbl = body => `<div class="tw"><table><thead><tr><th>状态</th><th>说明</th><th class="num">确认</th></tr></thead><tbody>${body}</tbody></table></div>`;
  const grp = (title, note, body) => `<details class="grp"><summary><span class="gh">${title}<span class="muted">（${note}）</span></span></summary>${tbl(body)}</details>`;

  return `<div class="card">
    <div class="card-hd"><h3>运行台</h3><span class="sub">总线给的与面板自算的，不混成一栏</span></div>
    <div class="opsline ${sevCls(res.worst)}">
      <span class="ops-lamp"><i></i><b>${SEV_WORD[res.worst] || esc(res.worst)}</b></span>
      <span class="ops-count">未确认 <b>${live.length}</b> · 计划内 <b>${planned.length}</b> · 只展示 <b>${shown.length}</b> · 已确认 <b>${ackedRows.length}</b></span>
      <span class="ops-side"><button class="btn sm" onclick="opsAskPermission()">${typeof Notification !== 'undefined' && Notification.permission === 'granted' ? '已开启系统通知' : '开启系统通知'}</button></span>
    </div>
    <details class="proof"><summary>规则与通知说明</summary><div class="proof-in">
      <div class="gatewhy">规则来自告警总线契约：带因由码的「没发」算计划内空档，<b>没码的「没发」本身就是故障</b>。同类告警按 kind+key 合并、等级只升不降，确认后同类 24 小时静默。</div>
      <div class="gatewhy">灯与图标每 20 秒刷新一次 · 系统通知：${typeof Notification === 'undefined' ? '浏览器不支持' : esc(Notification.permission)}（fault／breach 只发一次，20 小时节流）。</div>
    </div></details>

    <div class="grp-h">按 kind 摊全量与残量</div>
    <div class="tw"><table><thead><tr><th>kind</th><th>出处</th><th class="num">全量</th><th class="num">残量</th><th>key 清单</th></tr></thead>
      <tbody>${kindRows || '<tr><td colspan="5" class="muted">这一轮台账＋面板自算都没有条目 —— 这是"读到空集"，不是"无挡止"；note 面见下面三分出处。</td></tr>'}</tbody></table></div>
    ${blockerFacesHtml(faces)}
    <div class="brk">
      <div class="brk-cell ${brk.ok ? (brk.never + brk.refire > 0 ? 'bad' : 'ok') : 'unk'}"><b>${brk.ok ? brk.never : '—'}</b><span>从未签</span></div>
      <div class="brk-cell"><b>${brk.ok ? brk.refire : '—'}</b><span>签后重火</span></div>
      <div class="brk-cell"><b>${brk.ok ? brk.acked : '—'}</b><span>已签</span></div>
      <div class="brk-cap">${brk.ok ? '熔断台账（发布门那枚，非旧码面浏览量熔断）' : '熔断台账：/api/status 未带 alerts · 残量不可判'}</div>
    </div>
    ${brk.ok ? `<details class="proof"><summary>残量口径</summary><div class="proof-in"><div class="gatewhy">acked:false 是两态 —— 只有 ackedAt 能区分"从未签"与"签后过 24h 窗重火"，所以不并成一栏。</div></div></details>` : ''}
    ${srcLine(tupleOf(kinds.rows.reduce((a, r) => a + r.total, 0), `kind 全量／(kind,key) 残量分列 · 总线 ${STATE.alerts ? '已给' : '未给'}，其余为面板自算`,
      `ledger 双字段 acked/ackedAt（唯一写点 bus.ts:137）· 本灯表不代替总线`))}

    <div class="grp-h">未确认 —— 驱动灯的活故障与预警</div>
    ${live.length ? tbl(live.map(row).join('')) : '<div class="empty"><b>没有未确认的故障或预警</b><span>这只说明面板能看见的那几项正常，总线那几项要看上面 kind 表与三分出处。</span></div>'}
    ${grp(`计划内空档 · ${planned.length}`, '有因由码，不算故障', planned.map(row).join('') || '<tr><td colspan="3" class="muted">现在没有任何带因由码的空档。</td></tr>')}
    ${shown.length ? grp(`只展示 · 不驱动灯 · ${shown.length}`, '后端从源头消灭的那类', shown.map(row).join('')) : ''}
    <div class="alert" style="margin-top:14px"><svg viewBox="0 0 24 24"><path d="M12 16v-4M12 8h.01"/><circle cx="12" cy="12" r="9"/></svg>
      <div><b>这几项还没接上，界面无法代替它们变绿：</b>${notWired}。总线一落到 <code>/api/status.alerts</code>，这一层换源、渲染不动。</div></div>
    ${ackedRows.length ? grp(`已确认 · ${ackedRows.length}`, '同类 24 小时内静默', ackedRows.map(row).join('')) : ''}
  </div>
  <div class="card" style="margin-top:14px">
    <div class="card-hd"><h3>旧告警码（brain_alarms）</h3><span class="sub">总线上线前还在写的这一批，读得到就一并摆出来 · 尺＝最近 20 行（LIMIT 20，不是全表）</span></div>
    <div class="tw"><table><thead><tr><th class="num">时间</th><th>码</th><th>说明</th></tr></thead>
      <tbody>${legacy?.length ? legacy.map(a => `<tr><td class="num">${esc(fmtTs(a.at))}</td><td>${legacyCodeCell(a.code)}</td><td class="dline" title="${esc(a.detail)}">${esc(a.detail)}</td></tr>`).join('')
        : '<tr><td colspan="3" class="muted">' + (legacy ? '最近 20 条里没有未消化的旧告警（读到的是空集，不推"无挡止"）。' : '/api/brain 没读到 ⇒ 旧告警码面不可判（这一面缺位时禁推"无挡止"）。') + '</td></tr>'}</tbody></table></div>
    <div class="hint">${esc(GATE_KIND_NOTE.breaker_tripped)}。反过来说：旧码面那枚 <code>breaker</code> 的谓词是浏览中位数低于 floor（<code>sentinel.ts:29-34</code>），它<b>不是</b>发布门条件里的那一枚，签它也不解除总线那枚。</div>
  </div>`;
}

document.documentElement.dataset.theme = localStorage.getItem('sf-theme') || 'dark';
api('/api/auth/session').then(session => {
  $('#logoutBtn').hidden = !session.enabled;
}).catch(() => {});
{
  const fromHash = location.hash.replace('#', '');
  if (NAV_FLAT.some(([k]) => k === fromHash)) TAB = fromHash;
}
renderNav();
render();
setInterval(() => { if (TAB === 'overview' || TAB === 'board' || TAB === 'queue' || TAB === 'ops') render(); }, 30000);
// 标题灯与图标必须独立于页面渲染：开着别的标签页也要能看见出事。
setInterval(async () => {
  try { STATE = await api('/api/status'); opsRefresh(STATE); } catch (_) { /* 拉不到状态：把灯打到最亮的那一档比假装正常诚实 */
    document.title = '■ 面板读不到状态 · squareforge'; paintOpsFavicon('#e5484d');
  }
}, 20000);
