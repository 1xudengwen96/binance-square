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
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
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
  accounts: '<path d="M16 20v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM21 20v-1a4 4 0 00-3-3.9M16 4.1a4 4 0 010 7.8"/>',
  studio: '<path d="M4 19.5V6a2 2 0 012-2h12v16H6a2 2 0 00-2 2 2 2 0 002-2h12"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16M9 4v4M15 10v4M7 16v4"/>',
  connect: '<path d="M9 3v5M15 3v5M6 8h12v4a6 6 0 01-12 0zM12 18v3"/>',
};

/**
 * Navigation is grouped by what the operator is doing, not by data table. Eleven flat tabs
 * force a search for the right one every time; four groups let the eye go straight to the
 * section, and each page states in one line what question it answers.
 */
const NAV = [
  ['总览', [
    ['overview', '概览', '现在的状态、今天发了什么、下一步会发生什么', ICON.overview],
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
    ['settings', '设置', '全局规则：额度、节奏、敏感词、保留期', ICON.settings],
    ['connect', '接入与 AI', '广场 Key、代理、润色模型', ICON.connect],
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
  if (id === 'overview') return s.autoRun ? 0 : 0;
  return 0;
}

function renderNav() {
  $('#nav').innerHTML = NAV.map(([group, items]) => `
    <div class="nav-group">
      <i>${esc(group)}</i>
      ${items.map(([id, label, , icon]) => {
        const n = navCount(id);
        return `<button class="${id === TAB ? 'on' : ''}" onclick="go('${id}')" title="${esc(label)}">
          <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
          <span>${esc(label)}</span>${n ? `<span class="cnt">${n}</span>` : ''}
        </button>`;
      }).join('')}
    </div>`).join('');
}
async function go(tab) { TAB = tab; renderNav(); await render(); }

function fmtTs(ms) {
  if (!ms) return '—';
  const d = new Date(ms + 8 * 3600000);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return '刚刚';
  if (s < 5400) return Math.round(s / 60) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  return Math.round(s / 86400) + ' 天前';
}
const scoreCls = n => n >= 70 ? 's-high' : n >= 55 ? 's-mid' : 's-low';

/** The always-visible strip: what the machine is doing right now, without opening a page. */
function renderChrome() {
  const s = STATE.settings || {};
  const [, , sub] = pageMeta(TAB);
  $('#pageTitle').textContent = NAV_FLAT.find(([k]) => k === TAB)?.[1] ?? '概览';
  $('#pageSub').textContent = sub;
  const paused = STATE.pause?.paused;
  const chips = [
    paused ? ['bad', `已暂停：${STATE.pause.reason}`] : [s.autoPublish ? 'on' : 'info', s.autoPublish ? '自动发布中' : '人工审核中'],
    ['plain', `今日 ${STATE.publishedToday ?? 0} / ${s.dailyCap ?? 0}`],
    STATE.pending ? ['plain', `队列 ${STATE.pending} 条`] : ['plain', '队列空'],
    [STATE.hasKey ? 'on' : 'warn', STATE.hasKey ? '广场 Key 已配置' : '未配 Key（只能演练）'],
  ];
  $('#topStatus').innerHTML = chips.map(([cls, t]) => `<span class="pill ${cls}">${esc(t)}</span>`).join('');
  const cap = s.dailyCap ?? 0;
  const used = cap ? Math.min(100, ((STATE.publishedToday ?? 0) / cap) * 100) : 0;
  $('#sideFoot').innerHTML = `
    <div class="meter">
      <div class="mt"><span>今日额度</span><b>${STATE.publishedToday ?? 0} / ${cap}</b></div>
      <div class="track"><i style="width:${used}%"></i></div>
    </div>
    <div class="mt"><span>自动循环</span><b>${s.autoRun ? (STATE.loop?.lastTick ? ago(STATE.loop.lastTick.at) : '未跑过') : '已关闭'}</b></div>
    <div class="mt"><span>下一帖</span><b>${STATE.next?.allowed ? fmtTs(STATE.next.at) : '暂不可发'}</b></div>`;
}

async function render() {
  captureLlmForm();
  STATE = await api('/api/status');
  renderChrome();
  renderNav();
  $('#pubBtn').textContent = STATE.hasKey ? '发布（需确认）' : '演练发布';
  const el = $('#main');
  if (TAB === 'overview') el.innerHTML = await overview();
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
const CADENCE_PRESETS = [['轻松', 12], ['标准', 24], ['积极', 40]];
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
function intervalHint(ppd, start, end) {
  const span = (end === 24 ? 1440 : end * 60) - start * 60;
  if (span <= 0 || !ppd) return '';
  return `平均每 ${Math.max(1, Math.round(span / ppd))} 分钟一帖`;
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
      ${mini('今日', `${a.today}<small>/${a.trackId ? `${a.articlesPerDay} 篇` : ppd}</small>`, a.trackId ? '长文额度' : '短帖额度',
        [['已发', `${a.today}`], ['上限', `${a.trackId ? `${a.articlesPerDay} 篇长文` : `${ppd} 帖`}`], ['口径', '长文与短帖共用同一个 Key 的日额度']])}
      ${mini('队列', a.pending ?? 0, a.pending ? '已排好分钟' : '空的，下一轮现写',
        [['待发布', `${a.pending ?? 0} 条`], ['说明', a.pending ? '到点由自动循环发出' : '队列空时下一轮会现写现发']])}
      ${mini('下一帖', a.next?.allowed && a.next.at ? hhmm(a.next.at) : '不可发', a.next?.allowed ? fmtTs(a.next.at).slice(0, 5) : esc(a.next?.reason ?? ''),
        [['时间', a.next?.allowed && a.next.at ? fmtTs(a.next.at) : '不可发'], ['依据', a.next?.reason ?? '']])}
      ${mini('节奏', a.trackId ? `${a.articlesPerDay}<small> 篇/天</small>` : `${intervalHint(ppd, start, end).replace('平均每 ', '').replace(' 分钟一帖', '')}<small> 分钟/帖</small>`,
        a.trackId ? '长文赛道自带的间隔' : `时段 ${start}:00–${end}:00 · 每天 ${ppd} 帖`,
        [['最小间隔', `${a.min_interval_minutes ?? STATE.settings.minIntervalMinutes} 分钟`], ['每天目标', `${a.trackId ? `${a.articlesPerDay} 篇长文` : `${ppd} 帖`}`], ['发帖时段', `${start}:00 – ${end}:00`], ['错峰偏移', `${a.phase_minutes} 分钟`]])}
    </div>
    ${open ? `
    <div class="grp"><div class="gh">发帖节奏</div>
      <div class="kv" style="margin-bottom:8px">
        ${CADENCE_PRESETS.map(([l, n]) => `<button class="btn ${ppd === n ? 'primary' : ''}" onclick="setCadence(${a.id}, ${n})">${l} · ${n} 帖/天</button>`).join('')}
        <span class="muted">自定义</span>
        <input type="number" id="ac-ppd-${a.id}" min="1" max="100" value="${ppd}" style="width:74px" oninput="cadenceHint(${a.id})">
        <input type="hidden" id="ac-start-${a.id}" value="${start}"><input type="hidden" id="ac-end-${a.id}" value="${end}">
        <span class="pill" id="ac-hint-${a.id}">${esc(intervalHint(ppd, start, end))}</span>
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
  await api('/api/accounts/' + id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await render();
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
  await patchAccount(id, body);
  toast('已保存');
}

function cadenceHint(id) {
  const ppd = +$(`#ac-ppd-${id}`).value, start = +$(`#ac-start2-${id}`).value, end = +$(`#ac-end2-${id}`).value;
  $(`#ac-hint-${id}`).textContent = intervalHint(ppd, start, end);
}

async function setCadence(id, n) {
  const start = +$(`#ac-start2-${id}`).value, end = +$(`#ac-end2-${id}`).value;
  await patchAccount(id, { postsPerDay: n, activeStartHour: start, activeEndHour: end });
  toast(`已设为 ${n} 帖/天`);
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
  const recent = await api('/api/posts?status=published&limit=8').catch(() => []);
  const cap = s.dailyCap || 1;
  const tiles = [
    ['运行状态', STATE.pause.paused ? '已暂停' : (s.autoRun ? '运行中' : '已停摆'),
      STATE.pause.paused ? esc(STATE.pause.reason) : (s.autoRun ? `每 ${s.tickMinutes} 分钟一轮 · ${STATE.loop?.lastTick ? '上次 ' + ago(STATE.loop.lastTick.at) : '还没跑过'}` : '自动循环已在设置里关闭'),
      STATE.pause.paused ? 'bad' : s.autoRun ? 'good' : 'warn',
      [['自动发布', s.autoPublish ? '开（到点直接发）' : '关（等人工审核）'], ['自动循环', s.autoRun ? `每 ${s.tickMinutes} 分钟` : '已关闭'], ['上次循环', STATE.loop?.lastTick ? fmtTs(STATE.loop.lastTick.at) : '还没跑过'], ['广场 Key', STATE.hasKey ? '已配置' : '未配置，只能演练']]],
    ['今日已发', `${STATE.publishedToday}<small>/ ${s.dailyCap}</small>`, `币安硬上限 100 帖/天/Key`, '',
      [['今日已发', `${STATE.publishedToday} 条`], ['自设上限', `${s.dailyCap} 条`], ['官方上限', '100 条 / Key / 天'], ['口径', '短帖与长文共用同一个额度']]],
    ['下一帖', STATE.next.allowed ? `<span style="font-size:19px">${fmtTs(STATE.next.at)}</span>` : '<span style="font-size:19px">暂不可发</span>',
      esc(STATE.next.allowed ? `距今 ${Math.max(0, Math.round((STATE.next.at - Date.now()) / 60000))} 分钟` : STATE.next.reason), '',
      [['时间', STATE.next.allowed ? fmtTs(STATE.next.at) : '不可发'], ['依据', STATE.next.reason], ['目标间隔', `${nominalHint()} 分钟`], ['发帖时段', `${s.activeStartHour}:00 – ${s.activeEndHour}:00`]]],
    ['待发布', `${STATE.pending ?? 0}<small>条</small>`, STATE.orphanPending ? `<span style="color:var(--red)">${STATE.orphanPending} 条没有归属账号</span>` : '已排好分钟，到点自动发', '',
      (STATE.accounts || []).map(a => [`${a.label}（${a.trackId ? '长文' : '短帖'}）`, `队列 ${a.pending} · 今日 ${a.today}/${a.articlesPerDay ?? a.posts_per_day ?? s.postsPerDay}`])],
    ['待用素材', `${STATE.unused}<small>条</small>`, '近 6 小时抓到、还没生成过', '', null],
  ];

  const acctRows = (STATE.accounts || []).map(a => `<tr>
      <td><span class="b">${esc(a.label)}</span>${a.owner ? `<span class="sub">${esc(a.owner)}</span>` : ''}</td>
      <td>${a.trackId ? `<span class="pill on">${esc(a.trackLabel)} 长文</span>` : a.enabled ? '<span class="pill on">短帖矩阵</span>' : '<span class="pill">已停用</span>'}</td>
      <td class="num">${a.today} <span class="muted">/ ${a.articlesPerDay ?? a.posts_per_day ?? s.postsPerDay}</span></td>
      <td class="num">${a.pending}</td>
      <td class="num">${a.next?.allowed ? hhmm(a.next.at) : '<span class="muted">不可发</span>'}<span class="sub">${a.next?.allowed ? '' : esc(a.next?.reason ?? '')}</span></td>
      <td>${a.key?.set ? '<span class="pill on plain">Key 已配</span>' : '<span class="pill warn plain">缺 Key</span>'}${a.proxy_url ? '' : ' <span class="pill warn plain">共用 IP</span>'}</td>
    </tr>`).join('');

  const feed = recent.length ? recent.map(p => `<div class="feed-row">
      <span class="feed-t">${ago(p.published_at ?? p.created_at)}</span>
      <span class="feed-x">${esc((p.text || '').split('\n')[0].slice(0, 46))}</span>
      <span class="feed-v">${p.stats ? fmtN(p.stats.views) + ' 看' : '读数中'}</span>
    </div>`).join('') : '<div class="empty"><b>还没有发出内容</b><span>第一条发出去之后，这里会按时间倒序列出最近的帖子。</span></div>';

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

  return `
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
      <div class="tw"><table><thead><tr><th>账号</th><th>岗位</th><th class="num">今日</th><th class="num">队列</th><th class="num">下一帖</th><th>密钥与出口</th></tr></thead>
        <tbody>${acctRows || '<tr><td colspan="6"><div class="empty"><b>还没有账号</b><span>加一个号、填上它的广场 Key，再打开开关。</span></div></td></tr>'}</tbody></table></div>
    </div>
    <div class="card">
      <div class="card-hd"><h3>刚刚发出去</h3><span class="sub">最近 8 条 · 按时间</span>
        <span class="right"><button class="btn sm" onclick="go('queue')">全部记录</button></span></div>
      <div class="feed">${feed}</div>
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
    <div class="card-hd"><h3>素材库</h3><span class="sub">最近抓到的 ${rows.length} 条原始素材 · 分数越高越值得发</span>
      <span class="right"><button class="btn sm" onclick="act('collect')">抓取素材</button></span></div>
    <div class="hint" style="margin-top:0">每条素材都有保质期：多空比、费率这类数字一小时后就是错的陈述。过期素材会在自动循环里被作废，不会变成帖子。</div>
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
  const posts = await api(`/api/posts?${POST_FILTER === '全部' ? '' : 'status=' + encodeURIComponent(POST_FILTER) + '&'}sort=${POST_SORT}`);
  const counts = await api('/api/posts');
  const byStatus = {};
  for (const p of counts) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;

  const tabs = ['全部', 'published', 'draft', 'approved', 'rejected', 'failed', 'uncertain'];
  const label = { 全部: '全部', published: '已发布', draft: '待审核', approved: '已通过', rejected: '已驳回', failed: '失败', uncertain: '状态未知' };
  const chips = tabs
    .filter(t => t === '全部' || (byStatus[t] ?? 0) > 0)
    .map(t => `<button class="chip ${t === POST_FILTER ? 'on' : ''}" onclick="setPostFilter('${t}')">${label[t] ?? t}${t === '全部' ? ` ${counts.length}` : ` ${(byStatus[t] ?? 0)}`}</button>`)
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
    <div class="card-hd"><h3>发帖记录</h3><span class="sub">${counts.length} 条 · 筛选与排序</span>
      <span class="right"><div class="seg">
        <button class="${POST_SORT === 'recent' ? 'on' : ''}" onclick="setPostSort('recent')">最新</button>
        <button class="${POST_SORT === 'views' ? 'on' : ''}" onclick="setPostSort('views')">浏览最多</button>
      </div></span></div>
    <div class="chips">${chips}</div>
    ${banner}
    <div class="hint">按浏览量排序时，还没拿到读数的帖子排在最后，不会被当成 0 浏览。</div>
  </div>
  ${warn}
  ${posts.length ? `<div style="margin-top:14px">${posts.map(postCard).join('')}</div>`
    : '<div class="card" style="margin-top:14px"><div class="empty"><b>这个筛选下没有记录</b><span>先「抓取素材」再「生成草稿」，草稿会出现在这里等审核或直接发布。</span></div></div>'}`;
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
      <div class="chips">${days}</div>
      <div class="muted" style="margin-top:12px">还没有已发布的帖子，所以没有任何效果数据。等第一条发出去约 20 分钟，第一个读数会自己进来。</div>
    </div>`;
  }

  const kpi = (label, value, sub, rows) => `<div class="tile"${rows ? tip(label, rows) : ''}>
      <div class="lbl">${label}</div><div class="v" style="font-size:22px">${value}</div>
      ${sub ? `<div class="s">${sub}</div>` : ''}
    </div>`;

  // The reach/attraction pair is the whole point of this page, so it is shown side by side
  // rather than merged into one "performance" number that would hide the difference.
  const kpis = `<div class="grid gkpi">
    ${kpi('已发布', t.posts, `${t.measured} 条拿到读数`, [['已发布', `${t.posts} 条`], ['拿到读数', `${t.measured} 条`], ['还没读数', `${t.posts - t.measured} 条`], ['口径', '发布后按 20 分钟 / 1 / 3 / 8 / 24 / 72 小时回看']])}
    ${kpi('总浏览', fmtN(t.views), `中位 ${fmtN(t.medianViews)}`, [['累计浏览', fmtN(t.views)], ['单条中位', fmtN(t.medianViews)], ['为什么用中位数', '浏览量是长尾分布，一条爆款会把平均值抬到没有意义']])}
    ${kpi('互动（赞+评+转）', t.likes + t.comments + t.shares, `每千次浏览 ${t.engagementPer1k} 次回应`, [['赞', String(t.likes)], ['评论', String(t.comments)], ['转发', String(t.shares)], ['每千次浏览', `${t.engagementPer1k} 次回应`], ['口径', '用「每千次浏览」而不是百分比：浏览量本身是基数，百分比会被它骗']])}
    ${kpi('上过公开榜', t.surfaced, t.posts ? `上榜率 ${((t.surfaced / t.posts) * 100).toFixed(0)}%` : '—', [['上过榜', `${t.surfaced} 条`], ['上榜率', t.posts ? `${((t.surfaced / t.posts) * 100).toFixed(0)}%` : '—'], ['含义', '被广场算法推出去过，和「被人看到」是两件事']])}
    ${kpi('广场热榜中位', fmtN(r.benchmark.trendMedian), `快讯流中位 ${fmtN(r.benchmark.newsMedian)}`, [['热榜中位', fmtN(r.benchmark.trendMedian)], ['快讯流中位', fmtN(r.benchmark.newsMedian)], ['基准样本', `${r.benchmark.pool} 条`], ['提醒', '榜上的帖子已经赢过一次算法筛选，直接对比会高估我们']])}
  </div>`;

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
    <div class="chips">${days}</div>
    <div class="kv" style="margin-top:10px">
      ${r.conclusive
        ? `<span class="pill on">样本足够（${t.measured} 条读数）</span>`
        : `<span class="pill warn">样本不足：还差 ${r.neededForFirstRank} 条读数才能让任何一个分组可比</span>`}
      <span class="muted">排名一律用中位数：广场的浏览量是长尾分布，一条爆款就能把均值抬到毫无意义。</span>
    </div>
  </div>
  <div style="margin-top:14px">${kpis}</div>
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
  const days = [3, 7, 14, 30].map(n => `<button class="chip ${n === BOARD_DAYS ? 'on' : ''}" onclick="setBoardDays(${n})">最近 ${n} 天</button>`).join('');

  const kpi = (label, value, sub, rows) => `<div class="tile"${rows ? tip(label, rows) : ''}>
    <div class="lbl">${label}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`;

  const today = d.accounts.reduce((a, x) => a + x.today, 0);
  const kpis = `<div class="grid gkpi">
    ${kpi('区间内发布', `${d.totals.posts + d.totals.articles} 篇`, `短帖 ${d.totals.posts} · 长文 ${d.totals.articles}`,
      [['短帖', d.totals.posts + ' 篇'], ['长文', d.totals.articles + ' 篇'], ['拿到读数', `${d.totals.measured} 篇`], ['还没读到数', `${d.totals.posts + d.totals.articles - d.totals.measured} 篇`]])}
    ${kpi('累计浏览', fmtN(d.totals.views), `单条中位 ${fmtN(d.totals.medianViews ?? 0)}`,
      [['累计浏览', fmtN(d.totals.views)], ['单条中位', fmtN(d.totals.medianViews ?? 0)], ['互动合计', `${d.totals.engagement} 次`]])}
    ${kpi('中位间隔', c.actualMedianMinutes == null ? '—' : `${Math.round(c.actualMedianMinutes)} 分`, `目标 ${c.intendedMinutes} 分一帖`,
      [['实测中位间隔', c.actualMedianMinutes == null ? '数据不足' : Math.round(c.actualMedianMinutes) + ' 分钟'], ['设定目标', c.intendedMinutes + ' 分钟'], ['同分钟挤发', c.bursts + ' 次'], ['最长空档', c.longestIdleHours == null ? '—' : c.longestIdleHours + ' 小时']])}
    ${kpi('待发布', `${d.accounts.reduce((a, x) => a + x.pending, 0)} 条`, d.orphanPending ? `<span style="color:var(--bad)">${d.orphanPending} 条没有归属账号</span>` : '全部都有账号可发',
      d.accounts.map(a => [a.label, `待发布 ${a.pending} · 今日 ${a.today}/${a.cap}`]).concat(d.orphanPending ? [['无归属', d.orphanPending + ' 条']] : []))}
    ${kpi('今日已发', `${today} 篇`, `额度：${d.accounts.map(a => `${a.label} ${a.today}/${a.cap}${a.capUnit === '篇长文' ? '篇' : '帖'}`).join(' · ')}`)}
  </div>`;

  const verdict = [];
  if (c.bursts) verdict.push(['bad', `${c.bursts} 次同一分钟挤发 —— 应当为 0`]);
  else verdict.push(['on', '没有同一分钟挤发']);
  if (c.actualMedianMinutes != null && c.actualMedianMinutes < c.intendedMinutes) verdict.push(['warn', `中位间隔 ${Math.round(c.actualMedianMinutes)} 分，比目标 ${c.intendedMinutes} 分密`]);
  else if (c.actualMedianMinutes != null) verdict.push(['on', `中位间隔 ${Math.round(c.actualMedianMinutes)} 分，符合目标 ${c.intendedMinutes} 分`]);
  if (c.idleWindow) verdict.push(['warn', `最长空档 ${c.longestIdleHours} 小时：${c.idleWindow.from} → ${c.idleWindow.to}`]);
  if (d.orphanPending) verdict.push(['bad', `${d.orphanPending} 条待发布没有归属账号，谁也发不出去`]);

  const sect = (title, how, body) => `<div class="card" style="margin-top:14px">
    <div class="card-hd"><h3>${title}</h3></div><div class="how">${how}</div>${body}</div>`;

  const acctRows = d.accounts.map(a => `<tr>
      <td><span class="b">${esc(a.label)}</span>${a.enabled ? '' : ' <span class="pill">已停用</span>'}</td>
      <td><span class="pill ${a.trackId ? 'on' : a.enabled ? 'on' : ''}">${esc(a.role)}</span></td>
      <td class="num"${tip('今日额度', [['已发', `${a.today} ${a.capUnit}`], ['上限', `${a.cap} ${a.capUnit}`], ['口径', '长文与短帖共用同一个 Key 的日额度']])}>${a.today} <span class="muted">/ ${a.cap} ${a.capUnit}</span></td>
      <td class="num"${tip('队列', [['待发布', a.pending + ' 条'], ['说明', a.pending ? '这些已经排好分钟，到点自动发' : '队列是空的，下一轮会现写']])}>${a.pending}</td>
      <td class="num"${tip('下一帖', [['时间', a.nextAt ? fmtTs(a.nextAt) : '不可发'], ['依据', a.nextReason]])}>${a.nextAt ? hhmm(a.nextAt) : '<span class="muted">不可发</span>'}<span class="muted" style="display:block;font-size:11px">${a.nextAt ? '' : esc(a.nextReason)}</span></td>
      <td class="num"${tip('发布条数', [['短帖', a.posts + ' 篇'], ['长文', a.articles + ' 篇'], ['有读数', a.measured + ' 篇']])}>${a.posts} <span class="muted">+${a.articles}</span></td>
      <td class="num"${tip('中位浏览', [['中位', a.medianViews == null ? '无读数' : fmtN(a.medianViews)], ['合计', fmtN(a.views)], ['说明', '取一半帖子达到的那条线，不会被一条爆款拉高']])}>${a.medianViews == null ? '—' : fmtN(a.medianViews)}</td>
      <td class="num"${tip('互动', [['赞+评+转', a.engagement + ' 次'], ['每千次浏览', a.engagementPer1k + ' 次']])}>${a.engagementPer1k}</td>
      <td class="num"${tip('订阅', [['长文订阅数', String(a.subscribers)], ['说明', '只有长文有这个指标，这是能被反复打开的资产']])}>${a.subscribers || '—'}</td>
      <td>${rolePicker(a)}</td>
    </tr>`).join('');

  return `
  <div class="card">
    <div class="chips">${days}</div>
    <div class="kv" style="margin-top:10px">${verdict.map(([cls, t]) => `<span class="pill ${cls === 'bad' ? 'warn' : cls}">${esc(t)}</span>`).join('')}</div>
    <div style="margin-top:12px">${kpis}</div>
  </div>
  ${sect('发帖时间轴 · 一行一天',
    '横轴是北京时间 0–24 点，底色区间是你设定的发帖时段。鼠标停在任何一个点上，会看到它具体是几点、哪个账号发的、写的什么、多少人看。没有内容的日子照样占一行 —— 空行就是空档。',
    stripChart(d))}
  <div class="grid g2" style="margin-top:14px">
    ${sect('每天发了多少、被看了多少', '柱子＝当天发布条数，黄线＝当天内容的浏览量。鼠标停在柱子上看当天明细。', dayChart(d))}
    ${sect('几点发的，几点有人看', '蓝柱＝该时段发布条数，黄点＝该时段单条中位浏览。两个都高，才是值得加码的时段。', hourChart(d))}
  </div>
  ${sect('相邻两帖的间隔分布',
    `两帖之间隔了多久。目标是 ${c.intendedMinutes} 分钟一帖：红色＝同一分钟挤发，黄色＝比目标密，蓝色＝正常或偏松。`,
    gapChart(c))}
  ${sect('每个账号在干什么',
    '岗位直接决定它发什么内容：短帖矩阵按热度出短帖，长文赛道深耕一个领域。右侧按钮当场换岗，不用去别的页面。',
    `<div class="tw"><table><thead><tr>
      <th>账号</th><th>岗位</th><th class="num">今日额度</th><th class="num">队列</th><th class="num">下一帖</th>
      <th class="num">短帖+长文</th><th class="num">中位浏览</th><th class="num">互动/千</th><th class="num">订阅</th><th>改岗位</th>
    </tr></thead><tbody>${acctRows || '<tr><td colspan="10" class="muted">还没有账号</td></tr>'}</tbody></table></div>`)}
  <div class="grid g2" style="margin-top:14px">
    ${sect('哪类内容有人看 · 按信号', '每条的中位浏览从高到低排。条数少的先别下结论，鼠标停上去能看到它有几篇拿到了读数。', rankBars(d.cells.slice(0, 10), '互动'))}
    ${sect('哪种写法有人看 · 按风格', '同一类内容用不同语气写，谁的效果好。样本都很小时，这张表只说明方向，不说明结论。', rankBars(d.styles.slice(0, 10), '互动'))}
  </div>
  <div class="hint" style="margin-top:12px">这页的每个数字都来自已经写入库的发布记录，不来自设置项。「效果分析」回答的是哪类内容吸引人，需要样本量；这页回答的是机器有没有按你说的在跑，不需要。</div>`;
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
    toast(`已记录，归因到 ${r.attributed.posts} 条帖子${r.attributed.unattributed ? `（${r.attributed.unattributed} 没能分下去）` : ''}`);
    await render();
  } catch (e) { toast(e.message, true); }
}

async function setTarget(t) {
  try {
    await api('/api/conversion/target', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: t }) });
    toast(t === 'money' ? '实验结论今后按「每千次浏览返佣」判定' : '实验结论按浏览量判定');
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
  const convCard = `<div class="card" style="margin-top:14px">
    <div class="card-hd"><h3>今天从币安后台抄三个数</h3><span class="sub">广场不给点击和返佣接口，只能手填 —— 30 秒，填了系统才有资格谈"哪条内容挣钱"</span></div>
    <div class="form-grid">
      <div class="field"><span class="cap">日期</span><input type="date" id="cv-day" value="${today}"></div>
      <div class="field"><span class="cap">链接点击</span><input type="number" id="cv-clicks" min="0" placeholder="0"></div>
      <div class="field"><span class="cap">新增粉丝</span><input type="number" id="cv-followers" min="0" placeholder="0"></div>
      <div class="field"><span class="cap">返佣（USDT）</span><input type="number" id="cv-rebate" min="0" step="0.01" placeholder="0"></div>
    </div>
    <div class="row"><button class="btn primary" onclick="saveConversion()">记下</button>
      <span class="seg">
        <button class="${cv.target === 'views' ? 'on' : ''}" onclick="setTarget('views')">按浏览量优化</button>
        <button class="${cv.target === 'money' ? 'on' : ''}" onclick="setTarget('money')">按返佣优化</button>
      </span>
      <span class="muted">${entered ? `已录 ${entered} 天，累计返佣 ${money.toFixed(2)} USDT，归因到 ${cv.attributed.posts} 条帖子` : '一天都还没录 —— 「按返佣优化」要等你录入至少一天'}</span></div>
    <div class="hint">返佣是怎么分到每条帖子头上的：把当天总额按各帖<b>当时已积累的浏览量</b>加权摊下去，回看窗口 ${ATTRIBUTION_WINDOW} 小时。这是近似，不是账单 —— 它假设"看得多就点得多"，而这恰恰是待验证的东西。所以按返佣选出来的规则，要等它和按浏览量的结论对得上，才值得信。</div>
    ${cv.days.length ? `<div class="tw" style="margin-top:10px"><table><thead><tr><th>日期</th><th class="num">点击</th><th class="num">新粉</th><th class="num">返佣</th><th>录入于</th></tr></thead><tbody>
      ${cv.days.slice(0, 8).map(x => `<tr><td>${esc(x.day)}</td><td class="num">${x.clicks ?? '—'}</td><td class="num">${x.followers ?? '—'}</td><td class="num">${x.rebate_usd != null ? x.rebate_usd.toFixed(2) : '—'}</td><td class="muted">${ago(x.entered_at)}</td></tr>`).join('')}
    </tbody></table></div>` : ''}
  </div>`;

  const kpis = `<div class="grid gkpi">
    ${tile('已成立的规则', counts.rule, counts.rule ? '已写入长期记忆，正在影响写法' : '还没有任何一条判断攒够样本',
      d.verdicts.filter(v => v.status === 'rule').map(v => [v.id, v.arms.map(a => `${a.arm}:${a.median ?? '—'}`).join(' ')]) )}
    ${tile('正在观察', counts.observing, `另有 ${counts.leaning} 条已现倾向`, d.verdicts.filter(v => v.status === 'observing').map(v => [v.id, `还差 ${v.missing} 条`] ))}
    ${tile('已观察帖子', d.curve.length, '按 20 分钟 / 1 / 3 / 8 / 24 小时回看', null)}
    ${tile('每千次浏览返佣', per1k == null ? '<span style="font-size:18px">还没录</span>' : `${per1k.toFixed(2)}<small> USDT</small>`,
      per1k == null ? '录一次后台数字，系统才开始优化真正挣钱那一环' : `累计 ${money.toFixed(2)} USDT / ${entered} 天`,
      [['累计返佣', `${money.toFixed(2)} USDT`], ['录入天数', `${entered} 天`], ['当前优化目标', d.target === 'money' ? '每千次浏览返佣' : '浏览量'], ['归因方式', `${ATTRIBUTION_WINDOW} 小时窗口内按已积累浏览量加权`], ['提醒', '这是近似：它假设看得多就点得多，而这正是要验证的假设']])}
    ${tile('长期记忆', d.memory.length, '条当前生效的判断', d.memory.slice(0, 6).map(m => [m.kind, `${m.text.slice(0, 28)}… 置信 ${(m.confidence * 100).toFixed(0)}%`]))}
    ${tile('AI 大脑', d.brain ? '已接入' : '未启用', d.brain ? `${d.brain.provider} · ${d.brain.model}` : '没有大脑也照常运转：规则由测量直接得出',
      d.brain ? [['提供方', d.brain.provider], ['模型', d.brain.model], ['权限', '只改写与排序，不得新增数字或币种']] : [['状态', '未配置或已关闭'], ['影响', '自我迭代仍在工作，只是少一层归纳']] )}
  </div>`;

  const cards = d.verdicts.map(v => {
    const [cls, label] = RANK_STATUS[v.status] ?? ['', v.status];
    const max = Math.max(0, ...v.arms.map(a => a.median ?? 0));
    const bars = v.arms.map(a => `<div class="hbar${a.median == null ? ' off' : ''}">
        <span>${esc(a.arm)}</span>
        <span class="track"><i style="width:${a.median == null || !max ? 0 : Math.max(3, (a.median / max) * 100)}%;background:${v.winner === a.arm ? 'var(--green)' : 'var(--blue)'}"></i></span>
        <span class="v"${tip(`${v.id} · ${a.arm}`, [['中位', a.median == null ? '无读数' : Math.round(a.median).toLocaleString('en-US')], ['样本', `${a.n} 条`], ['最好一条', a.best == null ? '—' : Math.round(a.best).toLocaleString('en-US')]])}>${a.median == null ? '—' : Math.round(a.median).toLocaleString('en-US')}<span class="muted">${a.n} 条</span></span>
      </div>`).join('');
    return `<div class="card" style="margin-top:14px">
      <div class="card-hd"><h3>${esc(v.claim)}</h3>
        <span class="right"><span class="pill ${cls}">${label}</span>${v.status === 'observing' ? `<span class="muted">还差 ${v.missing} 条</span>` : ''}</span></div>
      <div class="kv" style="gap:8px;margin-bottom:10px">
        <span class="pill plain">${v.mode === 'experiment' ? '主动实验：机器人随机分配' : '观察：从已发生的事里读'}</span>
        <span class="pill plain">指标 ${esc(v.metric)}</span>
        <span class="pill plain">置信 ${(v.confidence * 100).toFixed(0)}%</span>
        <span class="pill ${v.stratified.strata >= 2 ? 'plain' : 'warn'}" ${tip('分层比较', [['可比层数', `${v.stratified.strata} 层`], ['被丢掉的层', `${v.stratified.dropped} 层（层内只有一个臂）`], ['层内差距', v.stratified.gap == null ? '—' : v.stratified.gap], ['相对差距', v.stratified.rel == null ? '—' : ((v.stratified.rel * 100).toFixed(0) + '%')], ['为什么分层', '浏览量最大的影响因素是哪个币、它当时多热，比写法的影响大一到两个数量级']], true)}>${v.stratified.strata} 层内比</span>
        <span class="pill ${v.replicated === true ? 'on' : v.replicated === false ? 'bad' : 'plain'}"${tip('时间对半验证', [['前半段赢家', v.replicated == null ? '无法判定' : '见后半'], ['结论', v.replicated === true ? '两半一致' : v.replicated === false ? '两半不一致 —— 噪声' : '样本不够分两半']])}>${v.replicated === true ? '两半一致' : v.replicated === false ? '两半打架' : '未验证'}</span>
        <span class="pill ${Math.abs(v.effect) >= 0.15 ? 'warn' : 'plain'}"${tip('混比（不分层）', [['相对差距', (v.effect * 100).toFixed(0) + '%'], ['用途', '只作对照：如果混比很大而分层很小，说明那个差是币的热度']])}>混比 ${(v.effect * 100).toFixed(0)}%</span>
        ${v.status === 'observing' ? `<span class="muted">还差 ${v.missing} 条</span>` : ''}
      </div>
      <div class="hbars">${bars}</div>
      ${v.action ? `<div class="alert good" style="margin-top:10px"><svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg><div>${esc(v.action)}</div></div>` : ''}
      ${v.note ? `<div class="alert warn" style="margin-top:10px"><svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg><div>${esc(v.note)}</div></div>` : ''}
      <div class="hint" style="margin-top:9px"><b>怎么测：</b>${esc(v.how)}<br><b>代价：</b>${esc(v.risk)}</div>
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

  const acting = d.playbook?.acting?.length
    ? `<div class="alert"><svg viewBox="0 0 24 24"><path d="M12 16v-4M12 8h.01"/><circle cx="12" cy="12" r="9"/></svg>
       <div>这一轮正在生效：${d.playbook.acting.map(a => esc(a.text)).join('； ')}。主题标签 ${d.playbook.hashtagTopics} 个 · ${d.playbook.attachChart ? '带图' : '不带图'} · 收尾${d.playbook.opening === 'question' ? '提问' : '陈述'}</div></div>`
    : '<div class="hint" style="margin-top:10px">现在还没有任何一条判断在影响写法 —— 每一篇仍按默认（带图、1 个主题标签、陈述收尾）。这不是没生效，是它还没拿到足够样本。</div>';

  return `
  <div class="card">
    <div class="card-hd"><h3>流量引擎</h3><span class="sub">读不到币安的算法，所以用实验去问它</span>
      <span class="right">
        <div class="chips">${chips}</div>
        <button class="btn sm" onclick="rankReflect()">立即归纳一次</button>
      </span></div>
    <div class="hint" style="margin-top:0">流程是固定的：先写下可被证伪的假设 → 机器人在发帖前按臂分配并记录 → 分档回看把浏览曲线变成分发事实 → 只有样本量和差距同时够格，才升为规则 → 规则写进长期记忆，之后每次写作前被读到。任何一条测出反果，旧结论会被新结论覆盖而不是删除，「我们曾经以为」也是要留下的。</div>
    ${acting}
    <div style="margin-top:12px">${kpis}</div>
  </div>
  ${convCard}
  ${cards}
  <div class="card" style="margin-top:14px">
    <div class="card-hd"><h3>每条帖子的分发形状</h3><span class="sub">绝对浏览量混着币本身的热度，曲线形状才是引擎的决定</span></div>
    <div class="tw"><table><thead><tr><th class="num">帖子</th><th>20m→24h</th><th class="num">首读</th><th class="num">最新</th><th class="num">首小时增速</th><th>上榜</th><th>本篇实验臂</th></tr></thead>
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
    toast(`写入 ${r.stored.length} 条判断${r.notes.length ? ' · ' + r.notes[0] : ''}`);
    await render();
  } catch (e) { toast('归纳失败：' + e.message, true); }
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
    <div class="card-hd"><h3>AI 润色（可选）</h3>
      <span class="sub">模型只允许改写模版已填好事实的句子，不得新增数字或币种；生成后做数字回比，对不上就退回模版原文</span>
      <span class="right"><span class="pill ${s.llmEnabled ? (lk.set ? 'on' : 'warn') : ''}">${s.llmEnabled ? (lk.set ? '已启用' : '缺 Key') : '未启用'}</span></span>
    </div>

    <div class="field">
      <span class="cap">接口类型</span>
      <div class="seg">
        <button class="${provider === 'openai' ? 'on' : ''}" onclick="switchProvider('openai')">OpenAI 通用</button>
        <button class="${provider === 'anthropic' ? 'on' : ''}" onclick="switchProvider('anthropic')">Anthropic</button>
      </div>
      <div class="hint">「OpenAI 通用」覆盖 OpenRouter、DeepSeek、new-api / one-api、LM Studio、Ollama 等所有兼容网关。</div>
    </div>

    <div class="field">
      <span class="cap">常用网关（点击填入）</span>
      <div class="kv">${GATEWAY_PRESETS.map(g => `<button class="btn" onclick="applyPreset('${g.provider}','${g.url}')">${esc(g.label)}</button>`).join('')}</div>
    </div>

    <div class="field">
      <span class="cap">Base URL（填到 /v1 为止）</span>
      <input type="text" id="in-base" value="${esc(dv('llmBaseUrl', s.llmBaseUrl || ''))}" placeholder="https://api.openai.com/v1">
    </div>

    <div class="field">
      <span class="cap">${provider === 'anthropic' ? 'Anthropic' : 'OpenAI / 兼容'} Key</span>
      <div class="inputline">
        <input type="password" id="in-llmkey" value="${esc(LLM_DRAFT.llmKeyPending || '')}" placeholder="${lk.set ? '已保存 ' + esc(lk.masked) + ' · 留空则不改动' : '粘贴 Key'}" autocomplete="off" onkeydown="if(event.key==='Enter')saveLlmKey()">
        <button class="btn" onclick="saveLlmKey()">保存 Key</button>
      </div>
      <div class="hint">Key 只存在本机 SQLite，接口永不回传明文，页面上只显示首尾几位。</div>
    </div>

    <div class="field">
      <span class="cap">模型</span>
      <div class="inputline">
        <input type="text" id="in-model" value="${esc(dv('llmModel', s.llmModel || ''))}" placeholder="点「拉取模型」选择，或直接输入模型名">
        <button class="btn" onclick="fetchModels()">拉取模型</button>
      </div>
      ${MODELS.length ? `<div class="modelgrid">${MODELS.map(m => `<label><input type="radio" name="mdl" value="${esc(m.id)}" ${dv('llmModel', s.llmModel || '') === m.id ? 'checked' : ''} onchange="pickModel(this.value)">${esc(m.id)}<span class="mn">${esc(m.name)}</span></label>`).join('')}</div><div class="hint">共 ${MODELS.length} 个，点选即填入上方输入框。</div>` : ''}
    </div>

    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      <div class="field"><span class="cap">最大输出 token</span><input type="number" id="in-maxtok" value="${esc(dv('llmMaxTokens', s.llmMaxTokens || 1024))}"></div>
      <div class="field"><span class="cap">温度（0–2）</span><input type="number" id="in-temp" step="0.1" min="0" max="2" value="${esc(dv('llmTemperature', s.llmTemperature ?? 0.7))}"></div>
    </div>

    <div class="kv" style="margin-top:4px">
      <label class="kv" style="cursor:pointer"><input type="checkbox" id="in-llmon" style="width:auto" ${dv('llmEnabled', s.llmEnabled ? 'true' : 'false') === 'true' ? 'checked' : ''}> <span>启用 AI 润色</span></label>
      <button class="btn primary" onclick="saveLlm()">保存配置</button>
      <button class="btn" onclick="testLlm()">测试对话</button>
      ${dirty.length ? `<span class="pill warn">未保存：${esc(dirty.map(k => FIELD_NAMES[k] || k).join('、'))}</span><button class="btn" onclick="discardLlmDraft()">放弃修改</button>` : '<span class="pill on">已是最新</span>'}
    </div>
    <div class="hint">「测试对话」会先把当前填的内容保存再发请求；「保存 Key」只存 Key，其余框里的值不会丢，但仍要点「保存配置」才生效。</div>
    <div class="result" id="llmResult"></div>
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

document.documentElement.dataset.theme = localStorage.getItem('sf-theme') || 'dark';
renderNav();
render();
setInterval(() => { if (TAB === 'overview' || TAB === 'board' || TAB === 'queue') render(); }, 30000);
