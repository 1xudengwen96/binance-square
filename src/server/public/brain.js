/*
 * The AI 大脑 page.
 *
 * One form owns the connection (provider, base URL, key, model) and the brain's own settings; the
 * rest of the page is read-only evidence plus the few operator-only actions (reset the breaker,
 * approve a report). A key is typed here and never comes back: the server answers with a mask.
 *
 * Unsaved edits live in BRAIN_DRAFT so that pressing 「拉取模型」 or 「保存 Key」, which both
 * re-render the page, does not throw away what was typed in the other boxes.
 */

// Wrapped so its helpers (fmtN, PURPOSE_CN, …) cannot collide with app.js: both are classic scripts
// sharing one global scope, and a duplicate top-level name aborts the whole file.
(() => {
let BRAIN = null;
let BRAIN_DRAFT = {};
let BRAIN_MODELS = [];
let BRAIN_SECONDARY_MODELS = [];
let BRAIN_OPEN_REPORT = null;

const BRAIN_PRESETS = [
  { label: 'Anthropic', provider: 'anthropic', url: 'https://api.anthropic.com/v1' },
  { label: 'OpenAI', provider: 'openai', url: 'https://api.openai.com/v1' },
  { label: 'OpenRouter', provider: 'openai', url: 'https://openrouter.ai/api/v1' },
  { label: 'DeepSeek', provider: 'openai', url: 'https://api.deepseek.com/v1' },
  { label: 'Ollama', provider: 'openai', url: 'http://localhost:11434/v1' },
];

const BRAIN_JOBS = [
  ['brainDaily', 'brainMaxTokensDaily', '每日反思', '每 20 小时一次：读各假设的测量结果，提出新比较或一次有界的参数调整。'],
  ['brainSentinel', 'brainMaxTokensSentinel', '异常哨兵', '代码每轮盯指标，出现新警报才唤醒大脑写一段诊断；每天唤醒次数有上限。'],
  ['brainWeekly', 'brainMaxTokensWeekly', '周复盘', '每周日 22:00 后一次：六节结构化周报，最多一条建议，批准后才会走闸门执行。'],
];

const bdv = (k, server) => (k in BRAIN_DRAFT ? BRAIN_DRAFT[k] : server);
const bset = (k, v) => { BRAIN_DRAFT[k] = v; };
const bjson = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const bnum = v => (v === '' || v == null ? '' : v);

function brainPill(ok, yes, no) {
  return `<span class="pill ${ok ? 'on' : 'warn'}">${esc(ok ? yes : no)}</span>`;
}

function brainDirty() {
  if (!BRAIN) return [];
  return Object.keys(BRAIN_DRAFT).filter(k => !k.startsWith('__') && JSON.stringify(BRAIN_DRAFT[k]) !== JSON.stringify(BRAIN.settings[k]));
}

function brainCaptureForm() {
  const read = (id, key, kind) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (kind === 'bool') BRAIN_DRAFT[key] = el.checked;
    else if (kind === 'num') { if (el.value !== '') BRAIN_DRAFT[key] = Number(el.value); }
    else BRAIN_DRAFT[key] = el.value;
  };
  read('bn-base', 'llmBaseUrl', 'text');
  read('bn-model', 'llmModel', 'text');
  read('bn-brainmodel', 'brainModel', 'text');
  read('bs-provider', 'brainSecondaryProvider', 'text');
  read('bs-base', 'brainSecondaryBaseUrl', 'text');
  read('bs-model', 'brainSecondaryModel', 'text');
  read('bs-fallback', 'brainFallbackEnabled', 'bool');
  read('bs-review', 'brainReviewEnabled', 'bool');
  read('bs-attemptcap', 'brainAttemptCapPerDay', 'num');
  read('bs-tokencap', 'brainTokenCapPerDay', 'num');
  const secondaryKey = document.getElementById('bs-key');
  if (secondaryKey && secondaryKey.value.trim()) BRAIN_DRAFT.__secondaryKey = secondaryKey.value;
  else if (secondaryKey) delete BRAIN_DRAFT.__secondaryKey;
  read('bn-enabled', 'llmEnabled', 'bool');
  read('bn-polish', 'llmPolish', 'bool');
  read('bn-polishtemp', 'llmTemperature', 'num');
  read('bn-polishtok', 'llmMaxTokens', 'num');
  read('bn-temp', 'brainTemperature', 'num');
  read('bn-wake', 'brainWakeCapPerDay', 'num');
  read('bn-breaker', 'breakerEnabled', 'bool');
  read('bn-webhook', 'alertWebhook', 'text');
  read('bn-colmode', 'columnMode', 'bool');
  read('bn-colper', 'columnPostsPerDay', 'num');
  for (const [on, tok] of BRAIN_JOBS) { read('bn-' + on, on, 'bool'); read('bn-' + tok, tok, 'num'); }
  const key = document.getElementById('bn-key');
  if (key && key.value.trim()) BRAIN_DRAFT.__key = key.value; else if (key) delete BRAIN_DRAFT.__key;
  const notes = document.getElementById('bn-notes');
  if (notes) BRAIN_DRAFT.__notes = notes.value;
}

const fmtN = v => (v == null ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-US') : String(v)) : String(v));

function gateRow(label, passed, big, sub) {
  return `<div class="tile ${passed ? 'good' : ''}"><div class="lbl">${esc(label)}</div>
    <div class="v">${big}</div><div class="s">${sub}</div></div>`;
}

function brainGateCards(d) {
  const g = d.gates, L = d.gateLines;
  const modeTxt = d.settings.targetMode === 'auto' ? '自动' : '手动';
  return `<div class="grid gkpi" style="margin-bottom:14px">
    ${gateRow('关卡 A · 被分发', g.A.passed, `${g.A.streakDays}<small>/ ${g.A.daysNeeded} 天</small>`,
      `每天 ≥ ${L.minPostsPerDay} 条满 24 小时的帖子，浏览中位数 ≥ ${L.viewsMedian}。近 7 天中位数 ${fmtN(g.A.median7d == null ? null : Math.round(g.A.median7d))}`)}
    ${gateRow('关卡 B · 有人回应', g.B.passed, g.B.commentsPer1k == null ? '—' : `${g.B.commentsPer1k}<small>/ ${g.B.line}</small>`,
      `近 ${g.B.windowDays} 天满 24 小时的 ${fmtN(g.B.posts)} 条帖子（与 A 同一批）合并评论率。${g.B.comments} 条评论 / ${g.B.views} 次 24h 浏览${g.B.immature ? `；另有 ${g.B.immature} 条没有 24h 读数（未满 24 小时或错过回抓），不计入` : ''}`)}
    ${gateRow('关卡 C · 二次分发', g.C.passed, `${g.C.secondRound}<small>/ ${g.C.needed} 条</small>`,
      `发帖 3 小时后浏览仍翻倍的帖子。粉丝数读不到，用它代替`)}
    <div class="tile"><div class="lbl">现在按什么判定实验</div><div class="v" style="font-size:19px">${esc({ views: '浏览量', engagement: '互动质量', money: '返佣' }[d.target] || d.target)}</div>
      <div class="s">${modeTxt}模式 · ${esc(g.reason)}</div></div>
  </div>`;
}

function brainBreakerCard(d) {
  const b = d.breaker;
  const state = !b.enabled ? ['warn', '已关闭'] : b.tripped ? ['bad', '已触发，自动发布已停'] : ['on', '正常'];
  return `<div class="card" style="margin-bottom:14px">
    <div class="card-hd"><h3>熔断</h3>
      <span class="sub">连续 ${b.window} 条帖子的浏览中位数低于 ${b.floor}（账号自己基线的一半），就停掉自动发布。之后手动发的帖子回到线上、或停满 48 小时，会自动恢复；你也可以直接恢复。大脑碰不到这个按钮。</span>
      <span class="right"><span class="pill ${state[0]}">${state[1]}</span></span></div>
    <div class="kv" style="margin:6px 0 4px">
      <span class="pill plain">窗口内 ${b.n} 条</span>
      <span class="pill plain">中位数 ${b.median == null ? '样本不足' : Math.round(b.median)}</span>
      <span class="pill plain">起算 ${esc(fmtTs(b.since))}</span>
      ${b.trippedAt ? `<span class="pill bad">触发于 ${esc(fmtTs(b.trippedAt))}</span>` : ''}
    </div>
    <div class="hint">窗口从首次评估或上次恢复起算。熔断期间参数回路冻结，恢复时把在途窗口顺延同样的时长。</div>
    <div class="row" style="margin-top:8px">
      <label class="kv" style="cursor:pointer"><input type="checkbox" id="bn-breaker" style="width:auto" ${bdv('breakerEnabled', d.settings.breakerEnabled) ? 'checked' : ''}> <span>启用熔断</span></label>
    </div>
    <div class="row" style="margin-top:8px">
      <label class="kv" for="bn-webhook"><span>报警 Webhook</span></label>
      <input id="bn-webhook" type="url" placeholder="https://…（飞书/钉钉/Slack 机器人，留空只在本页显示）" value="${esc(bdv('alertWebhook', d.settings.alertWebhook || ''))}" style="flex:1;min-width:min(260px,100%)">
    </div>
    <div class="row" style="margin-top:8px">
      ${b.tripped ? '<button class="btn primary" onclick="brainResetBreaker()">我看过了，恢复自动发布</button>' : ''}
    </div>
  </div>`;
}
function brainConnectionCard(d) {
  const s = d.settings;
  const provider = bdv('llmProvider', s.llmProvider);
  const dirty = brainDirty();
  const keyPending = BRAIN_DRAFT.__key || '';
  const modelVal = bdv('llmModel', s.llmModel || '');
  return `<div class="card" style="margin-bottom:14px">
    <div class="card-hd"><h3>主模型</h3>
      <span class="sub">日常反思、哨兵与周报优先使用这套连接；帖子润色与长文润色也使用它。第二模型在下方独立配置。</span>
      <span class="right">${d.ready ? '<span class="pill on">大脑可用</span>' : `<span class="pill warn">${esc(d.readyWhy || '未就绪')}</span>`}</span></div>

    <div class="field"><span class="cap">接口类型</span>
      <div class="seg">
        <button class="${provider === 'anthropic' ? 'on' : ''}" onclick="brainSwitch('anthropic')">Anthropic（Claude）</button>
        <button class="${provider === 'openai' ? 'on' : ''}" onclick="brainSwitch('openai')">OpenAI 通用</button>
      </div>
      <div class="hint">「OpenAI 通用」覆盖 OpenRouter、DeepSeek、new-api / one-api、Ollama 等兼容网关。</div></div>

    <div class="field"><span class="cap">常用地址（点击填入）</span>
      <div class="kv">${BRAIN_PRESETS.map((g, i) => `<button class="btn" onclick="brainPreset(${i})">${esc(g.label)}</button>`).join('')}</div></div>

    <div class="field"><span class="cap">Base URL（API 根地址，例如 /v1）</span>
      <input type="text" id="bn-base" value="${esc(bdv('llmBaseUrl', s.llmBaseUrl || ''))}" placeholder="https://api.anthropic.com/v1" autocomplete="off"><div class="hint">${esc(d.connections.primary.endpoint || d.connections.primary.error || '地址无效')}（已保存的请求路径）</div></div>

    <div class="field"><span class="cap">${provider === 'anthropic' ? 'Anthropic' : 'OpenAI / 兼容'} Key</span>
      <div class="inputline">
        <input type="password" id="bn-key" value="${esc(keyPending)}" autocomplete="off"
          placeholder="${d.key.set ? '已保存 ' + esc(d.key.masked) + (d.key.fromEnv ? '（来自 .env）' : '') + ' · 留空则不改动' : '粘贴 Key'}"
          onkeydown="if(event.key==='Enter')brainSaveKey()">
        <button class="btn" onclick="brainSaveKey()">保存 Key</button>
        ${d.key.set && !d.key.fromEnv ? '<button class="btn danger" onclick="brainClearKey()">清除</button>' : ''}
      </div>
      <div class="hint">Key 只存在本机数据库，接口永不回传明文，页面上只显示首尾几位。</div></div>

    <div class="field"><span class="cap">模型（润色与默认）</span>
      <div class="inputline">
        <input type="text" id="bn-model" value="${esc(modelVal)}" placeholder="点「拉取模型」，或直接输入模型名" autocomplete="off">
        <button class="btn" onclick="brainFetchModels()">拉取模型</button>
      </div>
      ${BRAIN_MODELS.length ? `<div class="modelgrid"><select aria-label="选择主模型" onchange="brainPick('llmModel',this.value)">${BRAIN_MODELS.map(m => `<option value="${esc(m.id)}" ${modelVal === m.id ? 'selected' : ''}>${esc(m.id)}</option>`).join('')}</select></div><div class="hint">共 ${BRAIN_MODELS.length} 个，点选即填入。</div>` : ''}</div>

    <div class="field"><span class="cap">大脑用的模型（留空 = 同上）</span>
      <div class="inputline"><input type="text" id="bn-brainmodel" value="${esc(bdv('brainModel', s.brainModel || ''))}" placeholder="判断类任务建议用更强的模型" autocomplete="off">
        ${BRAIN_MODELS.length ? '<span class="hint" style="margin:0">在上面的列表里点选后会填进「模型」；这一栏手填。</span>' : ''}</div></div>

    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr))">
      <div class="field"><span class="cap">润色最大输出 token</span><input type="number" id="bn-polishtok" value="${bnum(bdv('llmMaxTokens', s.llmMaxTokens))}"></div>
      <div class="field"><span class="cap">润色温度（0–2）</span><input type="number" step="0.1" min="0" max="2" id="bn-polishtemp" value="${bnum(bdv('llmTemperature', s.llmTemperature))}"></div>
    </div>

    <div class="kv" style="margin-top:4px">
      <label class="kv" style="cursor:pointer"><input type="checkbox" id="bn-enabled" style="width:auto" ${bdv('llmEnabled', s.llmEnabled) ? 'checked' : ''}> <span>启用连接</span></label>
      <label class="kv" style="cursor:pointer"><input type="checkbox" id="bn-polish" style="width:auto" ${bdv('llmPolish', s.llmPolish) ? 'checked' : ''}> <span>用它润色帖子措辞</span></label>
    </div>
    <div class="kv" style="margin-top:10px">
      <button class="btn primary" onclick="brainSave()">保存</button>
      <button class="btn" onclick="brainTest()">测试大脑</button>
      ${dirty.length ? `<span class="pill warn">未保存：${esc(dirty.map(k => k.replace(/^llm|^brain/, '')).join('、'))}</span><button class="btn" onclick="brainDiscard()">放弃修改</button>` : '<span class="pill on">已是最新</span>'}
    </div>
    <div class="hint">「测试大脑」走和真实任务同一条路径（用大脑的模型和温度），会记进下面的调用记录。</div>
    <div class="result" id="bn-result"></div>
  </div>`;
}

function brainSecondaryCard(d) {
  const s = d.settings, c = d.connections.secondary;
  const provider = bdv('brainSecondaryProvider', s.brainSecondaryProvider);
  const model = bdv('brainSecondaryModel', s.brainSecondaryModel);
  return `<div class="card" style="margin-bottom:14px">
    <div class="card-hd"><h3>第二模型 · 备用与独立审查</h3><span class="sub">地址、协议、Key、模型名都与主模型分开。可配置 OpenAI、Claude 或兼容网关。</span>
      <span class="right">${brainPill(c.ready, '已配置', c.error || '未配置')}</span></div>
    <div class="field"><span class="cap">接口协议</span><select id="bs-provider" onchange="brainSecondarySwitch(this.value)">
      <option value="openai" ${provider === 'openai' ? 'selected' : ''}>OpenAI / 兼容接口</option>
      <option value="anthropic" ${provider === 'anthropic' ? 'selected' : ''}>Anthropic / Claude</option></select></div>
    <div class="field"><span class="cap">常用地址（只填入，不自动保存）</span><div class="kv">${BRAIN_PRESETS.map((p, i) => `<button class="btn" onclick="brainSecondaryPreset(${i})">${esc(p.label)}</button>`).join('')}</div></div>
    <div class="field"><span class="cap">Base URL（API 根地址，例如 /v1）</span>
      <input id="bs-base" value="${esc(bdv('brainSecondaryBaseUrl', s.brainSecondaryBaseUrl))}" autocomplete="off">
      <div class="hint">${esc(c.endpoint || c.error || '地址无效')}（已保存的请求路径）</div></div>
    <div class="field"><span class="cap">第二模型专用 Key</span><div class="inputline">
      <input type="password" id="bs-key" value="${esc(BRAIN_DRAFT.__secondaryKey || '')}" autocomplete="off" placeholder="${c.key.set ? '已保存 ' + esc(c.key.masked) + ' · 留空不改动' : '粘贴独立 Key'}">
      ${c.key.set && !c.key.fromEnv ? '<button class="btn danger" onclick="brainClearSecondaryKey()">清除第二模型 Key</button>' : ''}</div>
      <div class="hint">独立保存，接口不回传明文；清除此 Key 不影响主模型。</div></div>
    <div class="field"><span class="cap">模型名</span><div class="inputline">
      <input id="bs-model" value="${esc(model)}" autocomplete="off" placeholder="直接填写模型名，或拉取后选择">
      <button class="btn" onclick="brainSecondaryModels()">拉取第二模型列表</button></div>
      ${BRAIN_SECONDARY_MODELS.length ? `<select aria-label="选择第二模型" onchange="brainPickSecondary(this.value)"><option value="">选择模型…</option>${BRAIN_SECONDARY_MODELS.map(m => `<option value="${esc(m.id)}" ${model === m.id ? 'selected' : ''}>${esc(m.name || m.id)}</option>`).join('')}</select>` : ''}</div>
    <div class="kv"><label class="kv"><input type="checkbox" id="bs-fallback" style="width:auto" ${bdv('brainFallbackEnabled', s.brainFallbackEnabled) ? 'checked' : ''}>主模型失败时使用第二模型</label></div>
    <div class="kv" style="margin-top:8px"><label class="kv"><input type="checkbox" id="bs-review" style="width:auto" ${bdv('brainReviewEnabled', s.brainReviewEnabled) ? 'checked' : ''}>周复盘启用第二模型独立审查</label></div>
    <div class="hint">审查只做一轮：核对证据与口径。出现分歧、引用不符或审查失败时保留报告，建议动作暂停；两模型同意也仍需人工批准。若两个模型共用同一中转，中转故障可能同时影响它们。</div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));margin-top:12px">
      <div class="field"><span class="cap">每天最多请求尝试（含重试／审查）</span><input id="bs-attemptcap" type="number" min="1" max="200" value="${bnum(bdv('brainAttemptCapPerDay', s.brainAttemptCapPerDay))}"></div>
      <div class="field"><span class="cap">每天 token 预算</span><input id="bs-tokencap" type="number" min="1000" max="2000000" value="${bnum(bdv('brainTokenCapPerDay', s.brainTokenCapPerDay))}"></div></div>
    <div class="hint">单个任务主模型最多尝试 2 次，再给备用 1 次；同一任务最多补跑 2 轮。缺少实际 token 用量时按输入字节和最大输出来保守预留；费用以通道账单为准。</div>
    <div class="kv" style="margin-top:10px"><button class="btn primary" onclick="brainSave()">保存全部修改</button><button class="btn" onclick="brainTestSecondary()">单独测试第二模型</button></div>
    <div class="result" id="bs-result"></div>
  </div>`;
}

function brainReliabilityCard(d) {
  const r = d.reliability, budget = r.budget;
  const windows = r.windows.map(w => `<tr><td>近 ${w.days === 1 ? '24 小时' : '7 天'}</td><td>${w.total}</td><td>${w.firstSuccess}</td><td>${w.retrySuccess}</td><td>${w.fallbackSuccess}</td><td>${w.failed}</td><td>${w.legacy}</td></tr>`).join('');
  const states = { pending: '等待补跑', running: '执行中', done: '完成', failed: '已达补跑上限', expired: '已过期' };
  const jobs = r.jobs.map(j => `<tr><td>${esc(PURPOSE_CN[j.purpose] || j.purpose)}</td><td>${esc(states[j.status] || j.status)}</td><td>${j.runs}/3</td><td>${j.status === 'pending' ? esc(fmtTs(j.next_at)) : '—'}</td><td>${esc(j.error || '')}</td></tr>`).join('');
  const attempts = r.attempts.map(a => `<tr><td>${esc(fmtTs(a.at))}</td><td>${esc(PURPOSE_CN[a.purpose] || a.purpose)}</td><td>${a.connection === 'secondary' ? '第二模型' : '主模型'}<br>${esc(a.model)}</td><td>${a.ok ? '成功' : esc(a.error_kind === 'in_progress' ? '进行中／结果未记录' : a.error_kind || '失败')}</td><td>${a.ms} ms</td><td>${a.input_tokens == null || a.output_tokens == null ? '未提供（按预留计预算）' : `${a.input_tokens} / ${a.output_tokens}`}</td><td>${esc(a.error || '')}${a.endpoint ? `<details><summary>接口诊断</summary>${esc(a.endpoint)}<br>HTTP ${esc(a.status ?? '—')} · ${esc(a.content_type || '未知类型')}<br>Request ID: ${esc(a.request_id || '未提供')}</details>` : ''}</td></tr>`).join('');
  return `<div class="card" style="margin-bottom:14px"><div class="card-hd"><h3>调用恢复与补跑</h3><span class="sub">业务任务统计不含手工测试和独立审查；每次 HTTP 尝试单独登记。历史失败保留。</span></div>
    <div class="tablewrap"><table><thead><tr><th>窗口</th><th>任务调用</th><th>首试成功</th><th>重试成功</th><th>备用成功</th><th>最终失败</th><th>旧版无尝试明细</th></tr></thead><tbody>${windows}</tbody></table></div>
    <div class="hint">旧记录仍计入总数与最终失败，但无法还原是否重试。最近 24 小时已用 ${budget.attempts}/${d.settings.brainAttemptCapPerDay} 次尝试，token 预算已用 ${fmtN(budget.tokens)}/${fmtN(d.settings.brainTokenCapPerDay)}${budget.estimated ? `（${budget.estimated} 次含保守预留）` : ''}；接口费用未提供时显示未知，不用字符数冒充费用。</div>
    ${jobs ? `<details style="margin-top:10px"><summary>最近任务与补跑状态</summary><div class="tablewrap"><table><thead><tr><th>任务</th><th>状态</th><th>轮次</th><th>下次补跑</th><th>原因</th></tr></thead><tbody>${jobs}</tbody></table></div></details>` : ''}
    ${attempts ? `<details style="margin-top:10px"><summary>最近请求尝试与错误原因</summary><div class="tablewrap"><table><thead><tr><th>时间</th><th>任务</th><th>连接 / 模型</th><th>结果</th><th>耗时</th><th>输入 / 输出 token</th><th>错误与诊断</th></tr></thead><tbody>${attempts}</tbody></table></div></details>` : '<div class="hint">新版本尚无请求尝试记录。</div>'}
  </div>`;
}

function brainJobsCard(d) {
  const s = d.settings;
  const rows = BRAIN_JOBS.map(([on, tok, name, what]) => `<tr>
    <td><b>${esc(name)}</b><span class="sub" style="display:block">${esc(what)}</span></td>
    <td class="num"><label style="cursor:pointer"><input type="checkbox" id="bn-${on}" style="width:auto" ${bdv(on, s[on]) ? 'checked' : ''}> 开</label></td>
    <td class="num"><input type="number" id="bn-${tok}" style="width:90px" value="${bnum(bdv(tok, s[tok]))}"></td>
  </tr>`).join('');
  return `<div class="card" style="margin-bottom:14px">
    <div class="card-hd"><h3>任务</h3><span class="sub">关掉一项只是不叫模型；确定性的那一半（归纳、哨兵警报、熔断）照常跑。</span></div>
    <div class="tablewrap"><table><thead><tr><th>任务</th><th class="num">开关</th><th class="num">最大输出 token</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr));margin-top:12px">
      <div class="field"><span class="cap">大脑温度（0–1）</span><input type="number" step="0.05" min="0" max="1" id="bn-temp" value="${bnum(bdv('brainTemperature', s.brainTemperature))}"></div>
      <div class="field"><span class="cap">哨兵每天最多唤醒几次</span><input type="number" min="0" max="10" id="bn-wake" value="${bnum(bdv('brainWakeCapPerDay', s.brainWakeCapPerDay))}"></div>
    </div>
    <div class="hint">今天已唤醒 ${d.wakesToday} 次。判断类任务温度建议 0.2；润色的温度在上面的「连接」里单独设置，互不影响。</div>
    <div class="field" style="margin-top:10px"><span class="cap">给大脑的补充说明（可选，≤ 1000 字）</span>
      <textarea id="bn-notes" rows="3" style="width:100%" placeholder="只影响取舍和措辞，不会放宽任何限制">${esc(bdv('__notes', d.notes))}</textarea>
      <div class="row" style="margin-top:6px"><button class="btn" onclick="brainSaveNotes()">保存说明</button></div></div>
  </div>`;
}

function brainColumnCard(d) {
  const s = d.settings;
  return `<div class="card" style="margin-bottom:14px">
    <div class="card-hd"><h3>栏目与实验</h3><span class="sub">开启后，账号只发固定栏目，不再发混合短帖。</span></div>
    <div class="kv" style="margin:6px 0">
      <label class="kv" style="cursor:pointer"><input type="checkbox" id="bn-colmode" style="width:auto" ${bdv('columnMode', s.columnMode) ? 'checked' : ''}> <span>启用固定栏目</span></label>
      <span class="cap" style="margin-left:10px">每天最多</span>
      <input type="number" min="1" max="6" id="bn-colper" style="width:70px" value="${bnum(bdv('columnPostsPerDay', s.columnPostsPerDay))}"> <span class="hint" style="margin:0">条（是上限，不是目标；市场没有够格的素材就不发）</span>
    </div>
    <div class="field"><span class="cap">实验判定指标</span>
      <div class="targetbar">
        <span class="pill ${s.targetMode === 'auto' ? 'on' : 'warn'}">${s.targetMode === 'auto' ? '自动跟关卡' : '手动固定'}</span>
        <b>${esc({ views: 'v24h 浏览', engagement: '每千次浏览互动质量', money: '每千次浏览返佣' }[s.targetMetric] || String(s.targetMetric ?? '未知'))}</b>
        <span class="muted">只读 · 面板不再提供切换按钮</span>
      </div>
      <div class="hint">改口径＝开新假设，走口径库审批（只收紧不放宽）；关卡 A 未过期间互动与返佣只作观察列，不参与判定。<b>这里改不了口径，是设计如此</b>：三个按钮即时改全局 targetMetric 的那条通路，正是把全零样本判成「差别不大」并写进长期记忆的复发通道。</div></div>
    <div class="hint">正在分配流量的实验：${d.settings.activeExperiments ? d.settings.activeExperiments.map(x => `<code>${esc(x)}</code>`).join(' ') : '全部已登记的'}。其余只做观察，不占样本。</div>
  </div>`;
}
const PURPOSE_CN = { reflect: '每日反思', sentinel: '哨兵', weekly: '周复盘', review: '独立审查', test: '测试' };
const UPG_STATUS = { open: ['gold', '待处理'], doing: ['info', '处理中'], done: ['on', '已完成'], wontfix: ['plain', '不做'] };
const UPG_SOURCE = { weekly: '周复盘', sentinel: '哨兵', reflect: '每日反思', operator: '手动' };

function upgradeRow(u, areas) {
  const [cls, label] = UPG_STATUS[u.status] || ['plain', u.status];
  const btn = (status, text, primary) => `<button class="btn sm${primary ? ' primary' : ''}" onclick="brainUpgrade(${u.id}, '${status}')">${text}</button>`;
  const actions = u.status === 'open' ? `${btn('doing', '开始做')}${btn('done', '已完成', true)}${btn('wontfix', '不做')}`
    : u.status === 'doing' ? `${btn('done', '已完成', true)}${btn('wontfix', '不做')}${btn('open', '退回')}`
    : btn('open', '重新打开');
  return `<tr>
    <td class="num">${u.id}</td>
    <td style="white-space:nowrap"><span class="tag">${esc(areas[u.area] || u.area)}</span></td>
    <td><b>${esc(u.title)}</b>
      <details class="src"><summary>证据 · ${esc(UPG_SOURCE[u.source] || u.source)}${u.report_id ? ` #${u.report_id}` : ''}</summary><span>${esc(u.why)}${u.resolution ? `<br><b>处理说明：</b>${esc(u.resolution)}` : ''}</span></details></td>
    <td class="num">${u.times > 1 ? `<span class="pill warn">${u.times} 次</span>` : '1 次'}</td>
    <td><span class="pill ${cls}">${label}</span><span class="sub" style="display:block">${esc(fmtTs(u.last_seen_at))}</span></td>
    <td style="white-space:nowrap"><div class="kv" style="flex-wrap:nowrap">${actions}</div></td>
  </tr>`;
}

function brainUpgradesCard(d) {
  const rows = d.upgrades.rows;
  const live = rows.filter(u => u.status === 'open' || u.status === 'doing');
  const closed = rows.filter(u => u.status === 'done' || u.status === 'wontfix');
  const count = s => rows.filter(u => u.status === s).length;
  const head = '<thead><tr><th class="num">#</th><th>领域</th><th>需求</th><th class="num">被提出</th><th>状态</th><th></th></tr></thead>';
  return `<div class="card" style="margin-bottom:14px">
    <div class="card-hd"><h3>要改代码的事</h3>
      <span class="sub">大脑发现了、但它自己改不了的问题。做完标「已完成」并写一句做了什么，下次复盘它会检查改了有没有用；标「不做」它就不再提。</span>
      <span class="right">${live.length ? '<button class="btn sm primary" onclick="brainCopyUpgrades()">复制给开发</button>' : ''}</span></div>
    <div class="kv" style="margin:6px 0">
      <span class="pill gold">待处理 ${count('open')}</span><span class="pill info">处理中 ${count('doing')}</span>
      <span class="pill on">已完成 ${count('done')}</span><span class="pill plain">不做 ${count('wontfix')}</span>
    </div>
    ${live.length ? `<div class="tablewrap"><table>${head}<tbody>${live.map(u => upgradeRow(u, d.upgrades.areas)).join('')}</tbody></table></div>`
      : '<div class="empty"><b>没有待处理的需求</b><span>周复盘、哨兵、每日反思发现只有改代码才能解决的问题时，会登记在这里。</span></div>'}
    ${closed.length ? `<details class="src" style="margin-top:8px"><summary>已处理 ${closed.length} 条 · 展开</summary>
      <div class="tablewrap"><table>${head}<tbody>${closed.map(u => upgradeRow(u, d.upgrades.areas)).join('')}</tbody></table></div></details>` : ''}
    <div class="result" id="bn-upgrade-result"></div>
  </div>`;
}
const STATUS_CN = { pending: '待审阅', approved: '已批准', dismissed: '已忽略', failed: '批准后全被拒' };
const ALARM_CN = { breaker: '熔断（浏览量低于线）', no_comments: '无评论', outlier_good: '异常好', gate_a_cleared: '关卡 A 过线', calls_failing: '判断不成立', no_posts: '停发', brain_failing: '大脑调用失败', stats_stalled: '回抓停了' };
// 裁定八十六 §二：旧码面这枚 breaker 与发布门里那枚 busBreaker 只是同名（谓词＝sentinel.ts:29-34），
// 页面上必须说清，否则"签它"会被当成能解除发布门。
const ALARM_GATE_NOTE = '这枚 breaker 不是发布门那枚：谓词＝浏览中位数低于 floor（sentinel.ts:29-34）。发布门的熔断残量看运行台的总线台账。';

function brainReportsCard(d) {
  const rows = d.reports.map(r => `<tr>
    <td class="num">${r.id}</td><td>${esc(fmtTs(r.created_at))}</td>
    <td>${esc(r.title)}</td>
    <td><span class="pill ${r.status === 'pending' ? 'gold' : r.status === 'approved' ? 'on' : r.status === 'failed' ? 'bad' : 'plain'}">${esc(STATUS_CN[r.status] || r.status)}</span></td>
    <td><button class="btn sm" onclick="brainOpenReport(${r.id})">${BRAIN_OPEN_REPORT && BRAIN_OPEN_REPORT.id === r.id ? '收起' : '查看'}</button></td>
  </tr>`).join('');
  const open = BRAIN_OPEN_REPORT;
  let detail = '';
  if (open) {
    const acts = JSON.parse(open.actions_json || '[]');
    const res = open.result_json ? JSON.parse(open.result_json) : null;
    detail = `<div class="result show" style="white-space:pre-wrap;line-height:1.7">${esc(open.body)}</div>
      ${acts.length ? `<div class="hint" style="margin-top:10px"><b>待执行的建议（批准才会走闸门）：</b><ul style="margin:6px 0 0 18px">${acts.map(a => `<li>${esc(actionText(a))}</li>`).join('')}</ul></div>` : '<div class="hint">这份报告没有可执行的建议。</div>'}
      ${res ? `<div class="hint"><b>闸门的答复：</b><ul style="margin:6px 0 0 18px">${res.map(x => `<li>${x.ok ? '✓' : '✗'} ${esc(actionText(x.action))} —— ${esc(x.detail)}</li>`).join('')}</ul></div>` : ''}
      ${open.status === 'pending' ? `<div class="row" style="margin-top:10px">
        ${acts.length ? '<button class="btn primary" onclick="brainApprove()">批准并执行</button>' : ''}
        <button class="btn" onclick="brainDismiss()">忽略</button></div>` : ''}`;
  }
  return `<div class="card" style="margin-bottom:14px">
    <div class="card-hd"><h3>报告</h3><span class="sub">周复盘和哨兵诊断。建议不会自己生效：批准后每一条都要过它自己的闸门，被拒的会记下来，下次复盘能读到。</span>
      <span class="right"><button class="btn sm" onclick="brainRunWeekly()">现在生成一份周复盘</button></span></div>
    ${rows ? `<div class="tablewrap"><table><thead><tr><th class="num">#</th><th>时间</th><th>标题</th><th>状态</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty"><b>还没有报告</b><span>周复盘每周日 22:00 后自动生成；哨兵有新警报且还没到唤醒上限时会写一份诊断。</span></div>'}
    ${detail}
    <div class="result" id="bn-report-result"></div>
  </div>`;
}

function actionText(a) {
  if (a.type === 'TEST') return `登记比较：${a.claim}（维度 ${a.dimension} / 指标 ${a.metric} / ${a.mode}）`;
  if (a.type === 'PARAM') return `参数 ${a.key} 调到 ${a.to}：${a.reason}`;
  if (a.type === 'VARIANT_OFF') return `下线变体 #${a.id}：${a.reason}`;
  if (a.type === 'VARIANT_ADD') return `加变体（${a.kind}/${a.slot}）：${a.text}`;
  return JSON.stringify(a);
}

function brainAlarmsCard(d) {
  const rows = d.alarms.map(a => `<tr><td>${esc(fmtTs(a.at))}</td><td><span class="pill ${a.code === 'breaker' ? 'bad' : 'info'}">${esc(ALARM_CN[a.code] || a.code)}</span>${a.code === 'breaker' ? '<span class="tag">≠ 发布门那枚</span>' : ''}</td><td>${esc(a.detail)}</td>
    <td>${a.woke ? '<span class="pill gold">叫了大脑</span>' : '<span class="pill plain">只记录</span>'}</td></tr>`).join('');
  return `<div class="card" style="margin-bottom:14px">
    <div class="card-hd"><h3>哨兵警报</h3><span class="sub">由代码判定。同一种警报 20 小时内不重复。母体＝brain_alarms 最近 20 行。</span>
      <span class="right"><button class="btn sm" onclick="brainRunSentinel()">现在检查一次</button></span></div>
    ${rows ? `<div class="tablewrap"><table><thead><tr><th>时间</th><th>警报</th><th>内容</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty"><b>这一轮读到 0 条警报</b><span>多数日子什么都没发生；但这是"读到空集"，不等于没有东西挡着发布 —— 挡止面看运行台的三分出处。</span></div>'}
    <div class="hint">${esc(ALARM_GATE_NOTE)}</div>
    <div class="result" id="bn-sentinel-result"></div>
  </div>`;
}

function brainVariantsCard(d) {
  const slotCn = { ask: '提问', watch: '接下来看', close: '收尾' };
  const kindCn = { question: '盘中一问', anomaly: '今日反常', recap: '昨日对账' };
  const rows = d.variants.map(v => `<tr style="${v.status === 'off' ? 'opacity:.55' : ''}">
    <td>${esc(kindCn[v.kind] || v.kind)}</td><td>${esc(slotCn[v.slot] || v.slot)}</td><td>${esc(v.text)}</td>
    <td>${v.origin === 'operator' ? '<span class="pill info">自加</span>' : '<span class="pill plain">内置</span>'}</td>
    <td><button class="btn sm" onclick="brainToggleVariant(${v.id})">${v.status === 'active' ? '下线' : '恢复'}</button></td></tr>`).join('');
  return `<div class="card" style="margin-bottom:14px">
    <div class="card-hd"><h3>栏目措辞变体</h3><span class="sub">变体是一句短话：不能有数字、币种、第一人称或买卖字眼，所以它碰不到事实，也不会冒充持仓。</span></div>
    <div class="tablewrap"><table><thead><tr><th>栏目</th><th>位置</th><th>短语</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="row" style="margin-top:10px">
      <select id="bn-vkind"><option value="question">盘中一问</option><option value="anomaly">今日反常</option><option value="recap">昨日对账</option></select>
      <select id="bn-vslot"><option value="ask">提问</option><option value="watch">接下来看</option><option value="close">收尾</option></select>
      <input type="text" id="bn-vtext" placeholder="4–40 字，无数字" style="flex:1;min-width:200px" autocomplete="off">
      <button class="btn" onclick="brainAddVariant()">加入</button></div>
  </div>`;
}

function brainCallsCard(d) {
  const t = d.calls_ledger.tally;
  const ruleName = kind => ({ funding_persists: '旧口径：费率至少保留一半', payer_persists: '新口径：同一边仍在付费' })[kind] || kind;
  const cohorts = Object.entries(t.byKind).map(([kind, c]) => `<tr><td>${esc(ruleName(kind))}${kind === t.currentKind ? '（当前）' : ''}</td>
    <td class="num">${c.total}</td><td class="num">${c.held}</td><td class="num">${c.heldRate == null ? '—' : (c.heldRate * 100).toFixed(1) + '%'}</td>
    <td class="num">${c.faded}</td><td class="num">${c.flipped}</td><td class="num">${c.open}</td><td class="num">${c.void}</td>
    <td>${c.firstRegisteredAt == null ? '暂无登记' : `${esc(fmtTs(c.firstRegisteredAt))} ～ ${esc(fmtTs(c.lastRegisteredAt))}`}</td></tr>`).join('');
  const recent = d.calls_ledger.recent.map(c => `<tr><td>$${esc(c.symbol)}</td><td>${esc(c.payer)}付</td><td class="num">${(c.rate_at * 100).toFixed(3)}%</td>
    <td class="num">${c.rate_after == null ? '—' : (c.rate_after * 100).toFixed(3) + '%'}</td>
    <td>${c.outcome ? `<span class="pill ${c.outcome === 'held' ? 'on' : 'warn'}">${{ held: '成立', faded: '减弱', flipped: '反转', void: '作废', late: '作废' }[c.outcome] || esc(c.outcome)}</span>` : '<span class="pill plain">待裁决</span>'}</td><td>${esc(ruleName(c.kind))}</td></tr>`).join('');
  const use = d.usage7d.map(u => `<span class="pill plain">${esc(PURPOSE_CN[u.purpose] || u.purpose)} ${u.n} 次${u.failed ? `（失败 ${u.failed}）` : ''}</span>`).join(' ');
  const calls = d.calls.map(c => `<tr><td>${esc(fmtTs(c.at))}</td><td>${esc(PURPOSE_CN[c.purpose] || c.purpose)}</td><td>${esc(c.model)}</td>
    <td class="num">${c.ms} ms</td><td class="num">${c.in_chars} / ${c.out_chars}</td><td>${c.ok ? `<span class="pill on">${c.connection === 'secondary' && c.purpose !== 'review' && c.purpose !== 'test' ? '备用成功' : c.attempt_count > 1 ? '重试成功' : '成功'}</span>` : `<span class="pill bad" title="${esc(c.error || '')}">失败</span>`}</td></tr>`).join('');
  return `<div class="card" style="margin-bottom:14px">
    <div class="card-hd"><h3>判断记录与调用记录</h3><span class="sub">栏目帖子发出时登记一条可检验的判断，隔天由代码核对，「昨日对账」栏目用这些记录。</span></div>
    <div class="kv" style="margin:6px 0"><span class="pill info">历史合计（混合口径）已裁决 ${t.total}</span><span class="pill on">成立 ${t.held}</span><span class="pill warn">减弱 ${t.faded}</span><span class="pill warn">反转 ${t.flipped}</span><span class="pill plain">待裁决 ${t.open}</span></div>
    <div class="tablewrap"><table><thead><tr><th>成立口径</th><th>已裁决</th><th>成立</th><th>成立率</th><th>减弱</th><th>反转</th><th>待裁决</th><th>作废</th><th>登记时间范围</th></tr></thead><tbody>${cohorts}</tbody></table></div>
    <div class="hint">成立率只计算该口径的已裁决记录；待裁决和作废不进分母，没有裁决时显示 —。旧结果按原口径保留；低成立率告警只评估当前口径，至少 5 条裁决才判断。</div>
    ${recent ? `<div class="tablewrap"><table><thead><tr><th>币</th><th>当时</th><th class="num">当时费率</th><th class="num">隔天费率</th><th>结果</th><th>口径</th></tr></thead><tbody>${recent}</tbody></table></div>` : ''}
    <div class="hint" style="margin-top:12px"><b>近 7 天的模型调用：</b> ${use || '没有'}</div>
    ${calls ? `<div class="tablewrap"><table><thead><tr><th>时间</th><th>任务</th><th>模型</th><th class="num">耗时</th><th class="num">输入 / 输出（字）</th><th></th></tr></thead><tbody>${calls}</tbody></table></div>` : ''}
  </div>`;
}

function brainBenchmarkCard(d) {
  const c = d.benchmark.composition, by = d.benchmark.byLang;
  const pct = x => (x * 100).toFixed(0) + '%';
  return `<div class="card" style="margin-bottom:14px">
    <div class="card-hd"><h3>对照：中文榜</h3><span class="sub">账号写中文，只和中文榜比。英文样本仍保留（${by.other} 条），但不进比较。</span></div>
    <div class="kv" style="margin:6px 0">
      <span class="pill info">中文样本 ${by.zh}</span>
      <span class="pill plain">浏览中位数 ${fmtN(c.medianViews)}</span>
      <span class="pill plain">每千次浏览：赞 ${fmtN(c.likesPer1k)} / 评论 ${fmtN(c.commentsPer1k)}</span>
    </div>
    ${c.n ? `<div class="kv"><span class="pill plain">提问 ${pct(c.shares.question)}</span><span class="pill plain">第一人称 ${pct(c.shares.firstPerson)}</span><span class="pill plain">带价位 ${pct(c.shares.pricePoint)}</span><span class="pill plain">快讯流 ${pct(c.shares.news)}</span><span class="pill plain">带图 ${pct(c.shares.image)}（带图中位数 ${fmtN(c.medianViewsImage)} / 不带 ${fmtN(c.medianViewsNoImage)}）</span></div>` : '<div class="empty"><b>还没有中文榜样本</b><span>基准采样每 4 轮一次，下一轮会开始存中文榜。</span></div>'}
    <div class="hint">${esc(c.caveat)}</div>
  </div>`;
}

let BRAIN_SKIP_CAPTURE = false;
async function brainView() {
  if (!BRAIN_SKIP_CAPTURE) brainCaptureForm();
  BRAIN_SKIP_CAPTURE = false;
  BRAIN = await api('/api/brain');
  const d = BRAIN;
  return `
    ${brainGateCards(d)}
    ${brainUpgradesCard(d)}
    ${brainConnectionCard(d)}
    ${brainSecondaryCard(d)}
    ${brainReliabilityCard(d)}
    ${brainJobsCard(d)}
    ${brainColumnCard(d)}
    ${brainBreakerCard(d)}
    ${brainReportsCard(d)}
    ${brainAlarmsCard(d)}
    ${brainVariantsCard(d)}
    ${brainCallsCard(d)}
    ${brainBenchmarkCard(d)}
    <div class="card"><div class="card-hd"><h3>大脑被告知的规则</h3><span class="sub">只读。权限由代码里的闸门决定，改提示词不会放宽任何一条。</span></div>
      <details><summary>每日反思 / 通用规则</summary><pre class="result show" style="white-space:pre-wrap">${esc(d.prompts.rules)}</pre></details>
      <details><summary>周复盘提示词</summary><pre class="result show" style="white-space:pre-wrap">${esc(d.prompts.weekly)}</pre></details>
      <details><summary>哨兵提示词</summary><pre class="result show" style="white-space:pre-wrap">${esc(d.prompts.sentinel)}</pre></details>
    </div>`;
}

/* ------------------------------------------------------------- actions --- */

function brainResult(id, kind, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `result show ${kind || 'busy'}`;
  el.innerHTML = msg;
}

function brainPayload() {
  brainCaptureForm();
  const out = {};
  for (const [k, v] of Object.entries(BRAIN_DRAFT)) if (!k.startsWith('__')) out[k] = v;
  return out;
}

async function brainSave(quiet = false) {
  try {
    const body = brainPayload();
    if (BRAIN_DRAFT.__key) body.primaryApiKey = BRAIN_DRAFT.__key;
    if (BRAIN_DRAFT.__secondaryKey) body.secondaryApiKey = BRAIN_DRAFT.__secondaryKey;
    const r = await api('/api/brain/config', bjson(body));
    BRAIN_DRAFT = {};
    for (const id of ['bn-key', 'bs-key']) { const el = document.getElementById(id); if (el) el.value = ''; }
    if (!quiet) toast(`配置已保存（${r.changed.length} 项，密钥独立保存）`);
    await render();
    return true;
  } catch (e) {
    brainResult('bn-result', 'bad', '保存失败：' + esc(e.message));
    brainResult('bs-result', 'bad', '保存失败：' + esc(e.message));
    toast(e.message, true);
    return false;
  }
}

async function brainSaveKey(quiet) {
  brainCaptureForm();
  if (!BRAIN_DRAFT.__key) { toast('输入框是空的', true); return false; }
  return brainSave(Boolean(quiet));
}

async function brainClearKey() {
  if (!confirm('清除本机保存的这个 Key？')) return;
  await api('/api/brain/key', bjson({ provider: BRAIN.settings.llmProvider, value: '' }));
  delete BRAIN_DRAFT.__key;
  const el = document.getElementById('bn-key'); if (el) el.value = '';
  toast('已清除'); await render();
}

function brainPick(key, id) {
  BRAIN_DRAFT[key] = id;
  const el = document.getElementById(key === 'llmModel' ? 'bn-model' : 'bn-brainmodel');
  if (el) el.value = id;
}

function brainDiscard() {
  BRAIN_DRAFT = {};
  BRAIN_SKIP_CAPTURE = true;
  render();
}

async function brainSwitch(p) {
  brainCaptureForm();
  const cur = bdv('llmBaseUrl', BRAIN.settings.llmBaseUrl || '');
  const stock = BRAIN_PRESETS.some(g => g.provider !== p && g.url === cur);
  const url = stock || !cur.trim() ? (BRAIN_PRESETS.find(g => g.provider === p)?.url || cur) : cur;
  BRAIN_DRAFT.llmProvider = p;
  BRAIN_DRAFT.llmBaseUrl = url;
  const el = document.getElementById('bn-base'); if (el) el.value = url;
  BRAIN_MODELS = [];
  await render();
}

async function brainPreset(i) {
  const g = BRAIN_PRESETS[i];
  brainCaptureForm();
  BRAIN_DRAFT.llmProvider = g.provider;
  BRAIN_DRAFT.llmBaseUrl = g.url;
  const el = document.getElementById('bn-base'); if (el) el.value = g.url;
  BRAIN_MODELS = [];
  await render();
}

async function brainFetchModels() {
  brainCaptureForm();
  brainResult('bn-result', 'busy', '正在拉取模型列表…');
  try {
    const typed = document.getElementById('bn-key');
    const r = await api('/api/brain/models', bjson({ provider: bdv('llmProvider', BRAIN.settings.llmProvider), baseUrl: bdv('llmBaseUrl', BRAIN.settings.llmBaseUrl), apiKey: typed ? typed.value.trim() : '' }));
    BRAIN_MODELS = r.models;
    await render();
    brainResult('bn-result', r.count ? 'good' : 'bad', r.count ? `✓ 拉到 ${r.count} 个模型，在上方列表里点选` : '该接口返回了 0 个模型，可直接手填模型名');
  } catch (e) { brainResult('bn-result', 'bad', '拉取失败：' + esc(e.message)); }
}

async function brainTest() {
  brainResult('bn-result', 'busy', '正在请求一次对话…');
  try {
    brainCaptureForm();
    if (brainDirty().length || BRAIN_DRAFT.__key || BRAIN_DRAFT.__secondaryKey) { if (!await brainSave(true)) return; }
    const r = await api('/api/brain/test', bjson({ connection: 'primary' }));
    brainResult('bn-result', 'good', `✓ ${esc(r.provider)} / ${esc(r.model)} 回复「${esc(r.reply)}」（${r.ms} ms）`);
    toast('大脑连通');
    const list = await api('/api/brain'); BRAIN = list;
  } catch (e) { brainResult('bn-result', 'bad', '测试失败：' + esc(e.message)); }
}

async function brainSaveNotes() {
  const el = document.getElementById('bn-notes');
  await api('/api/brain/notes', bjson({ text: el ? el.value : '' }));
  delete BRAIN_DRAFT.__notes;
  toast('已保存'); await render();
}

async function brainResetBreaker() {
  if (!confirm('确认恢复自动发布？\n\n建议先看一下上面的报告和哨兵诊断，确认原因处理过了。恢复后窗口重新起算。')) return;
  const r = await api('/api/brain/breaker/reset', bjson({}));
  toast(r.shifted ? `已恢复，${r.shifted} 个在途参数窗口已顺延` : '已恢复');
  await render();
}

async function brainOpenReport(id) {
  if (BRAIN_OPEN_REPORT && BRAIN_OPEN_REPORT.id === id) { BRAIN_OPEN_REPORT = null; return render(); }
  BRAIN_OPEN_REPORT = await api('/api/brain/reports/' + id);
  await render();
}

async function brainApprove() {
  if (!BRAIN_OPEN_REPORT) return;
  try {
    const r = await api(`/api/brain/reports/${BRAIN_OPEN_REPORT.id}/approve`, bjson({}));
    BRAIN_OPEN_REPORT = await api('/api/brain/reports/' + BRAIN_OPEN_REPORT.id);
    toast(r.results.some(x => x.ok) ? '已执行，闸门的答复在报告里' : '闸门全部拒绝，原因在报告里', !r.results.some(x => x.ok));
    await render();
  } catch (e) { toast(e.message, true); }
}

async function brainDismiss() {
  if (!BRAIN_OPEN_REPORT) return;
  await api(`/api/brain/reports/${BRAIN_OPEN_REPORT.id}/dismiss`, bjson({}));
  BRAIN_OPEN_REPORT = null;
  toast('已忽略'); await render();
}

async function brainRunWeekly() {
  brainResult('bn-report-result', 'busy', '正在生成周复盘…（要调用一次模型，可能要几十秒）');
  try {
    const r = await api('/api/brain/weekly', bjson({}));
    brainResult('bn-report-result', 'good', '✓ ' + esc(r.note));
    BRAIN_OPEN_REPORT = r.reportId ? await api('/api/brain/reports/' + r.reportId) : null;
    await render();
  } catch (e) { brainResult('bn-report-result', 'bad', esc(e.message)); }
}

async function brainRunSentinel() {
  brainResult('bn-sentinel-result', 'busy', '检查中…');
  try {
    const r = await api('/api/brain/sentinel', bjson({}));
    brainResult('bn-sentinel-result', r.raised.length ? 'good' : 'busy',
      r.raised.length ? `发现 ${r.raised.length} 条新警报。${r.woke ? '已唤醒大脑并生成了诊断。' : esc(r.skippedWhy || '')}` : '没有新警报。');
    if (r.raised.length) await render();
  } catch (e) { brainResult('bn-sentinel-result', 'bad', esc(e.message)); }
}

async function brainAddVariant() {
  try {
    await api('/api/brain/variants', bjson({ kind: $('#bn-vkind').value, slot: $('#bn-vslot').value, text: $('#bn-vtext').value }));
    toast('已加入'); await render();
  } catch (e) { toast(e.message, true); }
}

async function brainToggleVariant(id) {
  await api(`/api/brain/variants/${id}/toggle`, bjson({}));
  await render();
}

async function brainUpgrade(id, status) {
  let note = '';
  if (status === 'done') {
    note = prompt('做了什么？一句话就行。\n（大脑下次复盘会读到它，判断改动有没有用）', '') ?? '';
    if (!note.trim()) return;
  } else if (status === 'wontfix') {
    note = prompt('为什么不做？一句话就行。\n（大脑读到后就不再提这条）', '') ?? '';
    if (!note.trim()) return;
  }
  try {
    await api(`/api/brain/upgrades/${id}`, bjson({ status, note }));
    toast({ doing: '已标为处理中', done: '已完成', wontfix: '已标为不做', open: '已退回待处理' }[status] || '已更新');
    await render();
  } catch (e) { toast(e.message, true); }
}

async function brainCopyUpgrades() {
  try {
    const r = await fetch('/api/brain/upgrades.md');
    const md = await r.text();
    try {
      await navigator.clipboard.writeText(md);
      toast('已复制，粘贴给开发（或 Qoder）就能开工');
    } catch {
      brainResult('bn-upgrade-result', 'good', `<textarea rows="10" style="width:100%" readonly>${esc(md)}</textarea><div class="hint">浏览器不让自动复制，请手动全选复制。</div>`);
    }
  } catch (e) { toast(e.message, true); }
}

function brainSecondarySwitch(provider) {
  brainCaptureForm();
  const current = bdv('brainSecondaryBaseUrl', BRAIN.settings.brainSecondaryBaseUrl);
  const stock = BRAIN_PRESETS.some(p => p.url === current && p.provider !== provider);
  const url = stock ? BRAIN_PRESETS.find(p => p.provider === provider).url : current;
  BRAIN_DRAFT.brainSecondaryProvider = provider;
  BRAIN_DRAFT.brainSecondaryBaseUrl = url;
  document.getElementById('bs-base').value = url;
  BRAIN_SECONDARY_MODELS = [];
  render();
}
function brainSecondaryPreset(index) {
  brainCaptureForm();
  const preset = BRAIN_PRESETS[index];
  BRAIN_DRAFT.brainSecondaryProvider = preset.provider;
  BRAIN_DRAFT.brainSecondaryBaseUrl = preset.url;
  document.getElementById('bs-provider').value = preset.provider;
  document.getElementById('bs-base').value = preset.url;
  BRAIN_SECONDARY_MODELS = [];
  render();
}
function brainPickSecondary(model) {
  BRAIN_DRAFT.brainSecondaryModel = model;
  document.getElementById('bs-model').value = model;
}
async function brainSecondaryModels() {
  brainCaptureForm();
  brainResult('bs-result', 'busy', '正在拉取第二模型列表…');
  try {
    const result = await api('/api/brain/models', bjson({ connection: 'secondary',
      provider: bdv('brainSecondaryProvider', BRAIN.settings.brainSecondaryProvider),
      baseUrl: bdv('brainSecondaryBaseUrl', BRAIN.settings.brainSecondaryBaseUrl), apiKey: BRAIN_DRAFT.__secondaryKey || '' }));
    BRAIN_SECONDARY_MODELS = result.models;
    await render();
    brainResult('bs-result', result.count ? 'good' : 'bad', `返回 ${result.count} 个模型，可选择或手填模型名`);
  } catch (e) { brainResult('bs-result', 'bad', '拉取失败：' + esc(e.message)); }
}
async function brainTestSecondary() {
  brainCaptureForm();
  if (brainDirty().length || BRAIN_DRAFT.__key || BRAIN_DRAFT.__secondaryKey) { if (!await brainSave(true)) return; }
  brainResult('bs-result', 'busy', '正在单独请求第二模型…');
  try {
    const result = await api('/api/brain/test', bjson({ connection: 'secondary' }));
    brainResult('bs-result', 'good', `✓ ${esc(result.provider)} / ${esc(result.model)} 回复「${esc(result.reply)}」（${result.ms} ms）`);
  } catch (e) { brainResult('bs-result', 'bad', '测试失败：' + esc(e.message)); }
}
async function brainClearSecondaryKey() {
  if (!confirm('清除第二模型的 Key？主模型不受影响。')) return;
  await api('/api/brain/key', bjson({ connection: 'secondary', value: '' }));
  delete BRAIN_DRAFT.__secondaryKey;
  const el = document.getElementById('bs-key'); if (el) el.value = '';
  await render();
}
window.brainSecondarySwitch = brainSecondarySwitch;
window.brainSecondaryPreset = brainSecondaryPreset;
window.brainPickSecondary = brainPickSecondary;
window.brainSecondaryModels = brainSecondaryModels;
window.brainTestSecondary = brainTestSecondary;
window.brainClearSecondaryKey = brainClearSecondaryKey;
window.brainView = brainView;
window.brainUpgrade = brainUpgrade;
window.brainCopyUpgrades = brainCopyUpgrades;
window.brainSave = brainSave;
window.brainSaveKey = brainSaveKey;
window.brainClearKey = brainClearKey;
window.brainPick = brainPick;
window.brainDiscard = brainDiscard;
window.brainSwitch = brainSwitch;
window.brainPreset = brainPreset;
window.brainFetchModels = brainFetchModels;
window.brainTest = brainTest;
window.brainSaveNotes = brainSaveNotes;
window.brainResetBreaker = brainResetBreaker;
window.brainOpenReport = brainOpenReport;
window.brainApprove = brainApprove;
window.brainDismiss = brainDismiss;
window.brainRunWeekly = brainRunWeekly;
window.brainRunSentinel = brainRunSentinel;
window.brainAddVariant = brainAddVariant;
window.brainToggleVariant = brainToggleVariant;
})();
