let BACKUP_VIEW = null;
let BACKUP_POLL = null;
let BACKUP_BUSY = false;
let BACKUP_REMOTE = [];

function backupSize(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return (bytes / 1024 ** 3).toFixed(2) + ' GB';
}

async function backupView() {
  BACKUP_REMOTE = [];
  BACKUP_VIEW = await api('/api/backups/status');
  const c = BACKUP_VIEW.config;
  return `<div class="backup-intro">
    <div><span class="backup-eyebrow">DATA CONTINUITY</span><h2>数据有备份，迁移有退路</h2><p>数据库、账号配置、AI 记忆与图片一起保存到 S3。换服务器后，连接同一个桶即可导入。</p></div>
    <a class="btn ghost" href="#settings" onclick="go('settings');return false">返回系统设置</a>
  </div>
  <div class="grid backup-summary">
    <div class="card"><span class="backup-eyebrow">自动备份</span><strong>${c.enabled ? `每 ${c.intervalHours} 小时` : '未开启'}</strong><span>独立运行，业务暂停时继续备份</span></div>
    <div class="card"><span class="backup-eyebrow">云端保留</span><strong>30 天</strong><span>S3 生命周期自动清理到期归档</span></div>
    <div class="card"><span class="backup-eyebrow">最近成功</span><strong id="backup-last">—</strong><span id="backup-next">等待连接 S3</span></div>
  </div>
  <div class="card">
    <div class="card-hd"><h3>S3 连接与备份设置</h3><span class="sub">凭据保存在当前服务器，页面只显示已保存状态。</span></div>
    <form id="backup-form" onsubmit="backupSave(event)">
      <div class="form-grid">
        <label class="field"><span class="cap">存储桶</span><input name="bucket" value="${esc(c.bucket)}" placeholder="squareforge-backups-tokyo-…" required autocomplete="off"></label>
        <label class="field"><span class="cap">AWS 地区</span><input name="region" value="${esc(c.region)}" placeholder="ap-northeast-1" required></label>
        <label class="field"><span class="cap">备份目录</span><input name="prefix" value="${esc(c.prefix)}" required></label>
        <label class="field"><span class="cap">自动备份周期</span><select name="intervalHours">${[1, 3, 6, 12, 24].map(h => `<option value="${h}" ${c.intervalHours === h ? 'selected' : ''}>每 ${h} 小时${h === 6 ? '（推荐）' : ''}</option>`).join('')}</select></label>
        <label class="field"><span class="cap">Access Key ID</span><input name="accessKeyId" type="password" autocomplete="new-password" placeholder="${c.hasCredentials ? '已保存 ' + esc(c.accessKeyHint) + '，留空保持' : '输入 Access Key ID'}"></label>
        <label class="field"><span class="cap">Secret Access Key</span><input name="secretAccessKey" type="password" autocomplete="new-password" placeholder="${c.hasCredentials ? '已保存，留空保持' : '输入 Secret Access Key'}"></label>
      </div>
      <details class="backup-advanced"><summary>临时凭据设置</summary><label class="field"><span class="cap">Session Token（使用临时凭据时填写）</span><input name="sessionToken" type="password" autocomplete="new-password" placeholder="${c.hasSessionToken ? '已保存，留空保持' : '可选'}"></label><label><input type="checkbox" name="clearSessionToken"> 清除已保存的 Session Token</label></details>
      <div class="backup-actions"><label><input name="enabled" type="checkbox" ${c.enabled ? 'checked' : ''}> 开启自动备份</label><span class="top-spacer"></span><button class="btn" type="button" onclick="backupConnect()">测试已保存连接</button><button class="btn primary" type="submit">保存配置</button></div>
    </form>
    <p class="hint">连接时会验证读写权限，并为备份目录配置 30 天保留规则。AWS 凭据和服务器登录密码不包含在迁移包中。</p>
    <p id="backup-connection" class="hint" role="status"></p>
  </div>
  <div class="card">
    <div class="card-hd"><h3>云端备份与一键导入</h3><span class="sub">新服务器：保存连接 → 读取备份 → 一键导入。</span><div class="right"><button class="btn" onclick="backupRefreshList()">刷新列表</button><button class="btn" id="backup-import-latest" onclick="backupImportLatest()" disabled>一键导入最新备份</button><button class="btn primary" onclick="backupRun()">立即备份</button></div></div>
    <div id="backup-job" class="backup-job" role="status" aria-live="polite"></div>
    <div class="backup-migration-note">导入会替换当前数据库与图片，先将当前数据保存在本机。导入后自动发布保持暂停；确认旧服务器已停止，再开启新服务器的发布。</div>
    <div class="table-wrap"><table><thead><tr><th>备份时间（北京时间）</th><th>大小</th><th>备份文件</th><th>操作</th></tr></thead><tbody id="backup-list"><tr><td colspan="4" class="muted">${c.hasCredentials && c.bucket ? '正在读取备份…' : '请先保存 S3 连接配置'}</td></tr></tbody></table></div>
    <p class="hint">每份归档包含数据库一致性快照、图片和 SHA-256 校验清单。过期对象由 S3 异步删除。</p>
  </div>
  <dialog id="backup-restore-dialog" class="backup-dialog">
    <form method="dialog"><h3>导入这份备份？</h3><p id="backup-restore-name"></p><p>当前数据会先保存在本机，然后导入备份中的账号、配置、内容与图片。当前服务器的 S3 连接和登录密码会保留。</p><p>导入后自动发布将暂停。</p><div class="backup-actions"><button class="btn" value="cancel">取消</button><button class="btn primary" id="backup-confirm-restore" value="confirm">确认导入</button></div></form>
  </dialog>`;
}

function backupPaint(s) {
  BACKUP_VIEW = s;
  BACKUP_BUSY = Boolean(s.job);
  const last = document.querySelector('#backup-last');
  if (!last) return;
  last.textContent = s.lastSuccess ? fmtTs(s.lastSuccess.at) : '尚无成功记录';
  document.querySelector('#backup-next').textContent = s.config.enabled ? '下次检查：' + (s.nextAt <= Date.now() ? '即将执行' : fmtTs(s.nextAt)) : '自动备份已关闭';
  const job = document.querySelector('#backup-job');
  job.textContent = s.job ? '正在' + (s.job.kind === 'restore' ? '导入：' : s.job.kind === 'check' ? '检查：' : '备份：') + s.job.stage : s.lastError ? '最近任务失败：' + s.lastError : s.lastRestore ? '最近导入完成：' + fmtTs(s.lastRestore.at) + '。自动发布已暂停。' : s.lastSuccess ? '最近备份已上传并完成校验。' : '保存连接后可立即创建第一份备份。';
  job.classList.toggle('backup-error', Boolean(s.lastError && !s.job));
  document.querySelectorAll('#backup-form button, #backup-form input, #backup-form select, [data-backup-restore]').forEach(el => { el.disabled = BACKUP_BUSY; });
  document.querySelector('#backup-import-latest').disabled = BACKUP_BUSY || !BACKUP_REMOTE.length;
}

function backupPoll() {
  clearTimeout(BACKUP_POLL);
  backupPaint(BACKUP_VIEW);
  if (BACKUP_VIEW.config.hasCredentials && BACKUP_VIEW.config.bucket) backupRefreshList();
  async function poll() {
    if (TAB !== 'backup') return;
    try {
      const wasBusy = BACKUP_BUSY;
      backupPaint(await api('/api/backups/status'));
      if (wasBusy && !BACKUP_BUSY) {
        await backupRefreshList();
        STATE = await api('/api/status'); renderChrome();
      }
    } catch (e) { const el = document.querySelector('#backup-job'); if (el) el.textContent = e.message; }
    BACKUP_POLL = setTimeout(poll, BACKUP_BUSY ? 1000 : 10000);
  }
  BACKUP_POLL = setTimeout(poll, 1000);
}

async function backupSave(event) {
  event.preventDefault();
  const f = new FormData(event.target);
  const body = Object.fromEntries(f.entries());
  body.enabled = f.has('enabled'); body.clearSessionToken = f.has('clearSessionToken'); body.intervalHours = Number(body.intervalHours);
  try {
    await api('/api/backups/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    for (const name of ['accessKeyId', 'secretAccessKey', 'sessionToken']) event.target.elements[name].value = '';
    toast('备份配置已保存'); await render();
  } catch (e) { toast(e.message, true); }
}

async function backupConnect() {
  const el = document.querySelector('#backup-connection');
  el.textContent = '正在验证连接和 30 天保留规则…';
  try {
    const r = await api('/api/backups/check', { method: 'POST' });
    el.textContent = `连接成功，读写权限正常，云端保留 ${r.retentionDays} 天。`;
    backupPaint(await api('/api/backups/status')); await backupRefreshList();
  } catch (e) { el.textContent = e.message; toast(e.message, true); }
}

async function backupRefreshList() {
  const el = document.querySelector('#backup-list');
  if (!el) return;
  try {
    const { backups } = await api('/api/backups');
    if (!document.contains(el)) return;
    BACKUP_REMOTE = backups;
    document.querySelector('#backup-import-latest').disabled = BACKUP_BUSY || !backups.length;
    el.innerHTML = backups.length ? backups.map(b => `<tr><td>${esc(fmtTs(Date.parse(b.createdAt)))}</td><td>${esc(backupSize(b.bytes))}</td><td class="backup-key" title="${esc(b.key)}">${esc(b.key.split('/').pop())}</td><td><button class="btn" data-backup-restore="${esc(b.key)}" ${BACKUP_BUSY ? 'disabled' : ''}>导入此备份</button></td></tr>`).join('') : '<tr><td colspan="4" class="muted">还没有备份，点击“立即备份”创建第一份。</td></tr>';
    el.querySelectorAll('[data-backup-restore]').forEach(button => button.addEventListener('click', () => backupRestore(button.dataset.backupRestore)));
  } catch (e) { if (document.contains(el)) el.innerHTML = `<tr><td colspan="4" class="muted">${esc(e.message)}</td></tr>`; }
}

async function backupRun() {
  try {
    await api('/api/backups/run', { method: 'POST' });
    backupPaint(await api('/api/backups/status')); toast('已开始备份');
  } catch (e) { toast(e.message, true); }
}

function backupRestore(key) {
  const dialog = document.querySelector('#backup-restore-dialog');
  document.querySelector('#backup-restore-name').textContent = key;
  dialog.onclose = async () => {
    if (dialog.returnValue !== 'confirm') return;
    try {
      await api('/api/backups/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, confirm: true }) });
      backupPaint(await api('/api/backups/status')); toast('已开始下载并校验备份');
    } catch (e) { toast(e.message, true); }
  };
  dialog.showModal();
}

function backupImportLatest() {
  if (!BACKUP_REMOTE.length || BACKUP_BUSY) return;
  backupRestore(BACKUP_REMOTE[0].key);
}
