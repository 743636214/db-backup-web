const BASE_PATH = new URL('.', window.location.href).pathname;
const $ = (s) => document.querySelector(s); let cache = { tasks: [], runs: [], backups: [], backupPage: { total: 0, page: 1, pageSize: 20, totalPages: 1 }, stats: { total: 0, enabled: 0, success: 0, failed: 0 } };
const backupFilters = { taskId: '', ip: '', organization: '', page: 1, pageSize: 20 };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url, options) { const r = await fetch(`${BASE_PATH}${url.replace(/^\/+/, '')}`, { headers: { 'Content-Type': 'application/json' }, ...options }); const data = await r.json(); if (!r.ok) throw new Error(data.error || '请求失败'); return data; }
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2600); }
function scheduleText(t) { return t.scheduleType === 'daily' ? `每天 ${t.dailyTime}` : `每 ${t.intervalMinutes} 分钟`; }
function render() { $('#total').textContent = cache.stats.total; $('#enabled').textContent = cache.stats.enabled; $('#success').textContent = cache.stats.success; $('#failed').textContent = cache.stats.failed; const list = $('#taskList'); $('#empty').hidden = cache.tasks.length > 0; list.innerHTML = cache.tasks.map(t => `<div class="task"><div class="task-main"><div class="task-title">${esc(t.name)} <span class="badge ${t.enabled ? 'success' : 'pending'}">${t.enabled ? '已启用' : '已停用'}</span></div><div class="task-meta task-details"><span class="task-org">企业：${esc(t.organization || '未设置')}</span><span class="task-host">备份主机 <strong>${esc(t.host)}:${esc(t.port || '')}</strong></span><span>${t.dbType.toUpperCase()} · ${esc(t.username)} / ${esc(t.database)}</span><span>${scheduleText(t)}</span><span>保留：${Number(t.retentionDays || 0) > 0 ? `${esc(t.retentionDays)} 天` : '不自动清理'}</span></div><div class="task-meta">${t.lastRunAt ? `上次运行：${new Date(t.lastRunAt).toLocaleString()} · ${esc(t.lastMessage || '')}` : '尚未运行'}</div></div><span class="badge ${t.lastStatus === 'success' ? 'success' : t.lastStatus === 'failed' ? 'failed' : 'pending'}">${t.lastStatus === 'success' ? '最近成功' : t.lastStatus === 'failed' ? '最近失败' : '待运行'}</span><div class="actions"><button class="icon-btn" data-action="run" data-id="${t.id}">立即备份</button><button class="icon-btn" data-action="toggle" data-id="${t.id}">${t.enabled ? '停用' : '启用'}</button><button class="icon-btn" data-action="edit" data-id="${t.id}">编辑</button><button class="icon-btn" data-action="delete" data-id="${t.id}">删除</button></div></div>`).join(''); $('#runList').innerHTML = cache.runs.slice(0, 200).map(r => `<tr><td>${esc(r.taskName)}</td><td><span class="badge ${r.status === 'success' ? 'success' : 'failed'}">${r.status === 'success' ? '成功' : '失败'}</span></td><td>${new Date(r.at).toLocaleString()}</td><td title="${esc(r.message)}">${esc(r.file || r.message)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">暂无运行记录</td></tr>'; }
function backupQueryUrl() { const params = new URLSearchParams(Object.entries(backupFilters).map(([key, value]) => [key, String(value)])); return `/api/backups?${params}`; }
async function fetchBackupPage() { const backupPage = await api(backupQueryUrl()); backupFilters.page = backupPage.page; cache.backups = backupPage.items; cache.backupPage = backupPage; render(); }
async function load() { const state = await api('/api/state'); if (backupFilters.taskId && !state.tasks.some(task => task.id === backupFilters.taskId)) { backupFilters.taskId = ''; backupFilters.page = 1; } const backupPage = await api(backupQueryUrl()); backupFilters.page = backupPage.page; cache = { ...state, backups: backupPage.items, backupPage }; render(); }
function openModal(task) { $('#modal').hidden = false; $('#modalTitle').textContent = task ? '编辑备份任务' : '新建备份任务'; $('#taskId').value = task?.id || ''; ['name','organization','dbType','host','port','database','username','backupDir','retentionDays','scheduleType','intervalMinutes','dailyTime'].forEach(k => { const el = $('#'+k); if (el) el.value = task?.[k] ?? (k === 'port' ? (task?.dbType === 'postgres' ? 5432 : 3306) : k === 'retentionDays' ? 0 : el.value); }); $('#password').value = ''; $('#enabled').checked = task ? task.enabled : true; updateScheduleFields(); }
function closeModal() { $('#modal').hidden = true; }
function updateScheduleFields() { const daily = $('#scheduleType').value === 'daily'; $('#dailyWrap').hidden = !daily; $('#intervalWrap').hidden = daily; }
function activatePage(name) { const page = ['overview','tasks','runs','backups'].includes(name) ? name : 'overview'; document.querySelectorAll('.page-view').forEach(view => { view.hidden = view.id !== page; }); document.querySelectorAll('nav a[href^="#"]').forEach(link => link.classList.toggle('active', link.hash === `#${page}`)); if (location.hash !== `#${page}`) history.replaceState(null, '', `#${page}`); window.scrollTo({ top: 0, behavior: 'smooth' }); }
document.querySelector('nav').addEventListener('click', e => { const link = e.target.closest('a[href^="#"]'); if (!link) return; e.preventDefault(); activatePage(link.hash.slice(1)); });
window.addEventListener('hashchange', () => activatePage(location.hash.slice(1)));
$('#newTask').onclick = () => openModal(); $('#taskNew').onclick = () => openModal(); $('#emptyNew').onclick = () => openModal(); $('#close').onclick = closeModal; $('#cancel').onclick = closeModal; $('#scheduleType').onchange = updateScheduleFields; $('#refresh').onclick = load; $('#runRefresh').onclick = load; $('#runTypeFilter').onchange = () => render(); $('#backupRefresh').onclick = load;
$('#backupSearch').onclick = async () => { backupFilters.taskId = $('#backupTaskFilter').value; backupFilters.ip = $('#backupIpFilter').value.trim(); backupFilters.organization = $('#backupOrganizationFilter').value.trim(); backupFilters.page = 1; try { await fetchBackupPage(); } catch (err) { toast(err.message); } };
$('#backupReset').onclick = async () => { backupFilters.taskId = ''; backupFilters.ip = ''; backupFilters.organization = ''; backupFilters.page = 1; try { await fetchBackupPage(); } catch (err) { toast(err.message); } };
$('#backupPrev').onclick = async () => { if (backupFilters.page <= 1) return; backupFilters.page--; try { await fetchBackupPage(); } catch (err) { toast(err.message); } };
$('#backupNext').onclick = async () => { backupFilters.page++; try { await fetchBackupPage(); } catch (err) { backupFilters.page--; toast(err.message); } };
$('#backupPageSize').onchange = async () => { backupFilters.pageSize = Number($('#backupPageSize').value) || 20; backupFilters.taskId = $('#backupTaskFilter').value; backupFilters.ip = $('#backupIpFilter').value.trim(); backupFilters.organization = $('#backupOrganizationFilter').value.trim(); backupFilters.page = 1; try { await fetchBackupPage(); } catch (err) { toast(err.message); } };
['backupIpFilter','backupOrganizationFilter'].forEach(id => $('#'+id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#backupSearch').click(); } }));
$('#taskForm').onsubmit = async (e) => { e.preventDefault(); const id = $('#taskId').value; const data = {}; ['name','organization','dbType','host','port','database','username','password','backupDir','retentionDays','scheduleType','intervalMinutes','dailyTime'].forEach(k => { data[k] = $('#'+k).value; }); data.retentionDays = Number(data.retentionDays || 0); data.enabled = $('#enabled').checked; if (!data.password) delete data.password; try { await api(id ? `/api/tasks/${id}` : '/api/tasks', { method: id ? 'PUT' : 'POST', body: JSON.stringify(data) }); closeModal(); await load(); toast(id ? '任务已更新' : '任务已创建'); } catch (err) { toast(err.message); } };
$('#testConnection').onclick = async () => {
  const btn = $('#testConnection');
  const data = { taskId: $('#taskId').value, dbType: $('#dbType').value, host: $('#host').value.trim(), port: $('#port').value, database: $('#database').value.trim(), username: $('#username').value.trim(), password: $('#password').value };
  const missing = [['host','主机地址'],['database','数据库名'],['username','用户名']].find(([key]) => !data[key]);
  if (missing) return toast(`请先填写${missing[1]}`);
  btn.disabled = true; btn.textContent = '测试中…';
  try {
    const result = await api('/api/test-connection', { method: 'POST', body: JSON.stringify(data) });
    toast(result.message);
  } catch (err) { toast(err.message); }
  finally { btn.disabled = false; btn.textContent = '测试连接'; }
};
$('#taskList').onclick = async (e) => { const btn = e.target.closest('[data-action]'); if (!btn) return; const t = cache.tasks.find(x => x.id === btn.dataset.id); if (!t) return; try { if (btn.dataset.action === 'edit') return openModal(t); if (btn.dataset.action === 'delete' && !confirm(`确定删除“${t.name}”？`)) return; const action = btn.dataset.action; const endpoint = action === 'run' ? `/api/tasks/${t.id}/run` : action === 'toggle' ? `/api/tasks/${t.id}/toggle` : `/api/tasks/${t.id}`; if (action === 'run') { btn.disabled = true; btn.textContent = '备份中…'; toast('备份正在执行，请稍候'); } await api(endpoint, { method: action === 'run' || action === 'toggle' ? 'POST' : 'DELETE' }); await load(); toast(action === 'run' ? '备份已完成，请查看运行记录和已备份文件' : '操作完成'); } catch (err) { toast(err.message); } finally { btn.disabled = false; } };
const renderBase = render;
function runOperation(run) { return run.operation === 'restore' || (!run.operation && /恢复|还原/.test(run.message || '')) ? 'restore' : 'backup'; }
render = function() {
  renderBase();
  const selectedType = $('#runTypeFilter').value;
  const visibleRuns = cache.runs.slice(0, 200).filter(r => selectedType === 'all' || runOperation(r) === selectedType);
  $('#runList').innerHTML = visibleRuns.map(r => { const operation = runOperation(r); return `<tr><td>${esc(r.taskName)}</td><td><span class="badge ${operation}-type">${operation === 'restore' ? '还原' : '备份'}</span></td><td><span class="badge ${r.status === 'success' ? 'success' : 'failed'}">${r.status === 'success' ? '成功' : '失败'}</span></td><td>${new Date(r.at).toLocaleString()}</td><td>${r.durationMs == null ? '—' : `${(r.durationMs / 1000).toFixed(1)} 秒`}</td><td><details><summary>查看日志</summary><pre>${esc(r.log || r.message || '无日志')}</pre>${r.file ? `<div class="log-file">备份文件：${esc(r.file)}</div>` : ''}</details></td></tr>`; }).join('') || '<tr><td colspan="6" class="muted">当前分类暂无运行记录</td></tr>';
  const taskFilter = $('#backupTaskFilter');
  taskFilter.innerHTML = '<option value="">全部任务</option>' + cache.tasks.map(task => `<option value="${esc(task.id)}">${esc(task.name)}</option>`).join('');
  taskFilter.value = backupFilters.taskId;
  $('#backupIpFilter').value = backupFilters.ip;
  $('#backupOrganizationFilter').value = backupFilters.organization;
  $('#backupPageSize').value = String(backupFilters.pageSize);
  $('#backupList').innerHTML = cache.backups.map(f => `<tr><td>${esc(f.name)}</td><td>${esc(f.taskName)}</td><td>${formatSize(f.size)}</td><td>${new Date(f.modifiedAt).toLocaleString()}</td><td class="backup-actions"><button class="icon-btn restore-btn" data-action="restore" data-task-id="${esc(f.taskId)}" data-file="${esc(f.name)}">还原</button><a class="download-link" href="${BASE_PATH}${esc(f.downloadUrl)}" download>下载</a></td></tr>`).join('') || '<tr><td colspan="5" class="muted">没有符合条件的备份文件</td></tr>';
  const page = cache.backupPage;
  $('#backupPageSummary').textContent = `共 ${page.total} 条`;
  $('#backupPageNumber').textContent = `第 ${page.page} / ${Math.max(1, page.totalPages)} 页`;
  $('#backupPrev').disabled = page.page <= 1;
  $('#backupNext').disabled = page.page >= page.totalPages;
};
$('#backupList').addEventListener('click', async e => {
  const btn = e.target.closest('[data-action="restore"]');
  if (!btn) return;
  const backup = cache.backups.find(item => item.taskId === btn.dataset.taskId && item.name === btn.dataset.file);
  if (!backup) return toast('备份文件已不存在，请刷新列表');
  const target = `${backup.organization ? `企业：${backup.organization}；` : ''}主机：${backup.host}:${backup.port}；数据库：${backup.database}`;
  if (!confirm(`即将把备份文件“${backup.name}”恢复到以下数据库：\n${target}\n\n恢复会覆盖目标数据库中的现有数据，且不可撤销。请确保已另行备份当前数据。确定继续吗？`)) return;
  btn.disabled = true; btn.textContent = '恢复中…';
  try {
    const result = await api(`/api/backups/${encodeURIComponent(backup.taskId)}/restore`, { method: 'POST', body: JSON.stringify({ name: backup.name, confirmRestore: true }) });
    await load();
    toast(result.status === 'success' ? '数据库恢复完成，请查看运行记录' : `恢复失败：${result.message}`);
  } catch (err) { toast(err.message); }
  finally { btn.disabled = false; btn.textContent = '还原'; }
});
function formatSize(bytes) { if (bytes < 1024) return `${bytes} B`; const units = ['KB','MB','GB','TB']; let n = bytes / 1024; let i = 0; while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; } return `${n.toFixed(1)} ${units[i]}`; }
activatePage(location.hash.slice(1) || 'overview');
load().catch(err => toast(err.message));
