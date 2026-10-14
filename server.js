const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = __dirname;

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env'));
const database = require('./db');
const PORT = Number(process.env.PORT || 3080);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const BACKUP_TIMEOUT_MS = Math.max(10_000, Number(process.env.BACKUP_TIMEOUT_MS || 15 * 60 * 1000));
const RESTORE_TIMEOUT_MS = Math.max(10_000, Number(process.env.RESTORE_TIMEOUT_MS || 30 * 60 * 1000));
const DATA_FILE = path.join(DATA_DIR, 'tasks.json');
const LOG_FILE = path.join(DATA_DIR, 'runs.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const timers = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '[]', 'utf8');

let tasks = [];
let runs = [];
const save = () => database.saveTasks(tasks);
const saveRuns = () => database.saveRuns(runs);
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const safeName = (value) => String(value || 'backup').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'backup';

function publicTask(task) {
  const { password, ...rest } = task;
  return { ...rest, hasPassword: Boolean(password) };
}
function isRestoreRun(run) { return run.operation === 'restore' || (!run.operation && /恢复|还原/.test(run.message || '')); }

async function writeRun(task, status, message, file = '', log = message, startedAt = Date.now(), operation = 'backup') {
  const at = now();
  const entry = { id: id(), taskId: task.id, taskName: task.name, operation, status, message, file, log, at, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt };
  runs.unshift(entry); runs = runs.slice(0, 200); await saveRuns();
  task.lastRunAt = entry.at; task.lastStatus = status; task.lastMessage = message; await save();
  return entry;
}

function validate(input, old = {}) {
  const t = { ...old, ...input };
  const required = ['name', 'dbType', 'host', 'database', 'username', 'backupDir', 'scheduleType'];
  for (const key of required) if (!String(t[key] || '').trim()) throw new Error(`缺少字段：${key}`);
  if (!['mysql', 'postgres'].includes(t.dbType)) throw new Error('数据库类型仅支持 MySQL 或 PostgreSQL');
  if (!['interval', 'daily'].includes(t.scheduleType)) throw new Error('调度类型不正确');
  if (t.scheduleType === 'interval' && (!Number.isFinite(Number(t.intervalMinutes)) || Number(t.intervalMinutes) < 1)) throw new Error('间隔分钟数必须大于等于 1');
  if (t.scheduleType === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t.dailyTime || '')) throw new Error('每日时间格式应为 HH:mm');
  const retentionDays = Number(t.retentionDays ?? 0);
  if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 36500) throw new Error('备份保留天数必须是 0 到 36500 的整数');
  t.retentionDays = retentionDays;
  return t;
}

function cleanupExpiredBackups(task, currentFile) {
  const retentionDays = Number(task.retentionDays || 0);
  if (retentionDays <= 0) return { deleted: 0, errors: [] };
  const prefix = `${safeName(task.name)}_`;
  const extension = task.dbType === 'mysql' ? '.sql' : '.dump';
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  const errors = [];
  let entries;
  try { entries = fs.readdirSync(task.backupDir, { withFileTypes: true }); }
  catch (error) { return { deleted, errors: [`读取备份目录失败：${error.message}`] }; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(extension)) continue;
    const file = path.join(task.backupDir, entry.name);
    if (path.resolve(file) === path.resolve(currentFile)) continue;
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.unlinkSync(file);
        deleted++;
      }
    } catch (error) { errors.push(`清理 ${entry.name} 失败：${error.message}`); }
  }
  return { deleted, errors };
}

function schedule(task) {
  clearSchedule(task.id);
  if (!task.enabled) return;
  if (task.scheduleType === 'interval') {
    const timer = setInterval(() => runBackup(task), Math.max(1, Number(task.intervalMinutes)) * 60 * 1000);
    timers.set(task.id, timer);
  } else {
    const timer = setInterval(() => {
      const d = new Date();
      const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      if (hhmm === task.dailyTime) runBackup(task);
    }, 60 * 1000);
    timers.set(task.id, timer);
  }
}
function clearSchedule(taskId) { if (timers.has(taskId)) { clearInterval(timers.get(taskId)); timers.delete(taskId); } }

async function runBackup(task) {
  if (task.running || task.restoring) return Promise.resolve({ status: 'skipped', message: '任务仍在运行中' });
  const startedAt = Date.now();
  task.running = true; await save();
  const ext = task.dbType === 'mysql' ? 'sql' : 'dump';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(task.backupDir, `${safeName(task.name)}_${stamp}.${ext}`);
  try { fs.mkdirSync(task.backupDir, { recursive: true }); } catch (e) {
    task.running = false; const message = `创建备份目录失败：${e.message}`; return writeRun(task, 'failed', message, '', message, startedAt);
  }
  const args = task.dbType === 'mysql'
    ? ['--host', task.host, '--port', String(task.port || 3306), '--user', task.username, '--single-transaction', '--routines', '--events', task.database]
    : ['--host', task.host, '--port', String(task.port || 5432), '--username', task.username, '--format', 'custom', '--file', file, task.database];
  const command = task.dbType === 'mysql' ? 'mysqldump' : 'pg_dump';
  const env = { ...process.env, ...(task.dbType === 'mysql' ? { MYSQL_PWD: task.password || '' } : { PGPASSWORD: task.password || '' }) };
  return new Promise((resolve) => {
    let child; let settled = false; let outputError = '';
    const output = task.dbType === 'mysql' ? fs.createWriteStream(file) : null;
    let stderr = '';
    let timeout;
    const finish = (code, spawnError = '') => {
      if (settled) return;
      settled = true; task.running = false;
      if (timeout) clearTimeout(timeout);
      const detail = [spawnError, outputError, stderr.trim()].filter(Boolean).join('\n');
      if (code === 0 && !outputError) {
        const cleanup = cleanupExpiredBackups(task, file);
        const message = cleanup.deleted ? `备份完成，已清理 ${cleanup.deleted} 个过期文件` : '备份完成';
        const log = [detail || `${command} 执行成功，退出码 0`, cleanup.deleted ? `过期备份清理：删除 ${cleanup.deleted} 个文件` : '', ...cleanup.errors].filter(Boolean).join('\n');
        resolve(writeRun(task, 'success', message, file, log, startedAt));
      }
      else {
        try { fs.rmSync(file, { force: true }); } catch {}
        const message = spawnError ? `未找到 ${command}，请确认已安装并加入 PATH` : detail || `备份进程退出码：${code}`;
        resolve(writeRun(task, 'failed', message, '', detail || message, startedAt));
      }
    };
    if (output) output.on('error', e => { outputError = `写入备份文件失败：${e.message}`; });
    try { child = spawn(command, args, { env, windowsHide: true }); } catch (e) { finish(null, `启动 ${command} 失败：${e.message}`); return; }
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-65536); });
    if (output) child.stdout.pipe(output);
    timeout = setTimeout(() => {
      if (settled) return;
      stderr = `${stderr}\n备份进程超过 ${Math.round(BACKUP_TIMEOUT_MS / 60000)} 分钟，已自动终止`;
      child.kill('SIGTERM');
      setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 5000).unref();
    }, BACKUP_TIMEOUT_MS);
    child.on('error', (e) => { if (output) output.destroy(); finish(null, `启动 ${command} 失败：${e.message}`); });
    child.on('close', (code) => {
      if (output && !output.writableFinished && !outputError) output.once('finish', () => finish(code));
      else finish(code);
    });
  });
}

function listBackups({ taskId = '', ip = '', organization = '', page = 1, pageSize = 20 } = {}) {
  const ipQuery = ip.trim().toLowerCase();
  const organizationQuery = organization.trim().toLowerCase();
  const matchingTasks = tasks.filter(task => (!taskId || task.id === taskId)
    && (!ipQuery || String(task.host || '').toLowerCase().includes(ipQuery))
    && (!organizationQuery || String(task.organization || '').toLowerCase().includes(organizationQuery)));
  const all = matchingTasks.flatMap(task => {
    try {
      return fs.readdirSync(task.backupDir, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
        const file = path.join(task.backupDir, entry.name); const stat = fs.statSync(file);
        return { taskId: task.id, taskName: task.name, organization: task.organization || '', dbType: task.dbType, host: task.host, port: task.port || (task.dbType === 'mysql' ? 3306 : 5432), database: task.database, name: entry.name, size: stat.size, modifiedAt: stat.mtime.toISOString(), downloadUrl: `api/backups/${encodeURIComponent(task.id)}/${encodeURIComponent(entry.name)}` };
      });
    } catch { return []; }
  }).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const total = all.length;
  const totalPages = Math.ceil(total / pageSize);
  const currentPage = Math.min(page, Math.max(1, totalPages));
  const start = (currentPage - 1) * pageSize;
  return { items: all.slice(start, start + pageSize), total, page: currentPage, pageSize, totalPages };
}

function testDatabaseConnection(input, password) {
  const port = Number(input.port || (input.dbType === 'mysql' ? 3306 : 5432));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve({ success: false, message: '端口必须是 1 到 65535 之间的整数' });
  const args = input.dbType === 'mysql'
    ? ['--host', input.host, '--port', String(port), '--user', input.username, '--connect-timeout=8', '--batch', '--skip-column-names', '--execute', 'SELECT 1', input.database]
    : ['--no-psqlrc', '--quiet', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1', '--host', input.host, '--port', String(port), '--username', input.username, '--dbname', input.database, '--command', 'SELECT 1'];
  const command = input.dbType === 'mysql' ? 'mysql' : 'psql';
  const env = { ...process.env, ...(input.dbType === 'mysql' ? { MYSQL_PWD: password || '' } : { PGPASSWORD: password || '' }) };
  return new Promise(resolve => {
    let child; let settled = false; let stderr = '';
    const finish = (success, message) => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      resolve({ success, message });
    };
    let timeout;
    try { child = spawn(command, args, { env, windowsHide: true }); }
    catch (error) { return finish(false, `启动 ${command} 失败：${error.message}`); }
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8192); });
    timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 1500).unref();
      finish(false, '连接测试超时，请检查网络、地址及防火墙');
    }, 10_000);
    child.on('error', error => finish(false, `启动 ${command} 失败，请确认数据库客户端已安装并加入 PATH：${error.message}`));
    child.on('close', code => finish(code === 0, code === 0 ? '连接成功，SELECT 1 执行正常' : `连接失败：${stderr.trim() || `客户端退出码 ${code}`}`));
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8') { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(type.startsWith('application/json') ? JSON.stringify(body) : body); }
function parseBody(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', (c) => { raw += c; if (raw.length > 2e6) reject(new Error('请求体过大')); }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('JSON 格式错误')); } }); req.on('error', reject); }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/test-connection' && req.method === 'POST') {
      const input = await parseBody(req);
      if (!['mysql', 'postgres'].includes(input.dbType)) return send(res, 400, { error: '数据库类型仅支持 MySQL 或 PostgreSQL' });
      for (const key of ['host', 'database', 'username']) if (!String(input[key] || '').trim()) return send(res, 400, { error: `请填写${({ host: '主机地址', database: '数据库名', username: '用户名' })[key]}` });
      let existing;
      if (input.taskId) {
        existing = tasks.find(task => task.id === input.taskId);
        if (!existing) return send(res, 404, { error: '任务不存在或已删除' });
      }
      const result = await testDatabaseConnection(input, input.password || existing?.password || '');
      return send(res, 200, result);
    }
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, { tasks: tasks.map(publicTask), runs, stats: { total: tasks.length, enabled: tasks.filter(t => t.enabled).length, success: runs.filter(r => r.status === 'success' && !isRestoreRun(r)).length, failed: runs.filter(r => r.status === 'failed').length } });
    if (url.pathname === '/api/backups' && req.method === 'GET') {
      const page = Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1));
      const pageSize = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get('pageSize')) || 20)));
      return send(res, 200, listBackups({ taskId: url.searchParams.get('taskId') || '', ip: url.searchParams.get('ip') || '', organization: url.searchParams.get('organization') || '', page, pageSize }));
    }
    const restoreMatch = url.pathname.match(/^\/api\/backups\/([^/]+)\/restore$/);
    if (restoreMatch && req.method === 'POST') {
      const task = tasks.find(t => t.id === restoreMatch[1]);
      if (!task) return send(res, 404, { error: '备份任务不存在' });
      if (task.running || task.restoring) return send(res, 409, { error: '该任务正在运行，请稍后再试' });
      const body = await parseBody(req);
      const name = String(body.name || '');
      if (!name || name.includes('/') || name.includes('\\') || path.basename(name) !== name) return send(res, 400, { error: '文件名不合法' });
      if (body.confirmRestore !== true) return send(res, 400, { error: '未确认恢复操作' });
      const expectedExt = task.dbType === 'mysql' ? '.sql' : '.dump';
      if (!['mysql', 'postgres'].includes(task.dbType) || path.extname(name).toLowerCase() !== expectedExt) return send(res, 400, { error: '备份文件类型与任务数据库不匹配' });
      const root = path.resolve(task.backupDir); const file = path.resolve(root, name); const relative = path.relative(root, file);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.existsSync(file) || !fs.lstatSync(file).isFile()) return send(res, 404, { error: '备份文件不存在' });
      if (!task.host || !task.database || !task.username) return send(res, 400, { error: '任务数据库连接信息不完整' });
      task.restoring = true;
      const startedAt = Date.now();
      const command = task.dbType === 'mysql' ? 'mysql' : 'pg_restore';
      const args = task.dbType === 'mysql'
        ? ['--host', task.host, '--port', String(task.port || 3306), '--user', task.username, task.database]
        : ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--exit-on-error', '--host', task.host, '--port', String(task.port || 5432), '--username', task.username, '--dbname', task.database, file];
      const env = { ...process.env, ...(task.dbType === 'mysql' ? { MYSQL_PWD: task.password || '' } : { PGPASSWORD: task.password || '' }) };
      const outcome = await new Promise(resolve => {
        let child; let settled = false; let stderr = ''; let timeout;
        const finish = (code, spawnError = '') => {
          if (settled) return;
          settled = true; task.restoring = false;
          if (timeout) clearTimeout(timeout);
          const detail = [spawnError, stderr.trim()].filter(Boolean).join('\n');
          const success = code === 0 && !spawnError;
          const message = success ? '数据库恢复完成' : spawnError ? `未找到 ${command}，请确认已安装并加入 PATH` : detail || `恢复进程退出码：${code}`;
          const outcome = { status: success ? 'success' : 'failed', message };
          writeRun(task, success ? 'success' : 'failed', message, '', detail || message, startedAt, 'restore').then(() => resolve(outcome), () => resolve(outcome));
        };
        try { child = spawn(command, args, { env, windowsHide: true }); } catch (error) { finish(null, `启动 ${command} 失败：${error.message}`); return; }
        child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-65536); });
        if (task.dbType === 'mysql') {
          child.stdin.on('error', () => {});
          const input = fs.createReadStream(file);
          input.on('error', error => { stderr = `读取备份文件失败：${error.message}`; child.kill('SIGTERM'); });
          child.on('close', code => finish(code));
          input.pipe(child.stdin);
        }
        timeout = setTimeout(() => {
          if (settled) return;
          stderr = `${stderr}\n恢复进程超过 ${Math.round(RESTORE_TIMEOUT_MS / 60000)} 分钟，已自动终止`;
          child.kill('SIGTERM');
          setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 5000).unref();
        }, RESTORE_TIMEOUT_MS);
        child.on('error', error => finish(null, `启动 ${command} 失败：${error.message}`));
        if (task.dbType !== 'mysql') child.on('close', code => finish(code));
      });
      return send(res, 200, outcome);
    }
    const downloadMatch = url.pathname.match(/^\/api\/backups\/([^/]+)\/(.+)$/);
    if (downloadMatch && req.method === 'GET') {
      const task = tasks.find(t => t.id === downloadMatch[1]);
      if (!task) return send(res, 404, { error: '备份任务不存在' });
      let name;
      try { name = decodeURIComponent(downloadMatch[2]); } catch { return send(res, 400, { error: '文件名格式错误' }); }
      if (!name || path.basename(name) !== name) return send(res, 400, { error: '文件名不合法' });
      const root = path.resolve(task.backupDir); const file = path.resolve(root, name); const relative = path.relative(root, file);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.existsSync(file) || !fs.lstatSync(file).isFile()) return send(res, 404, { error: '备份文件不存在' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(file).size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store' });
      const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res); return;
    }
    if (url.pathname === '/api/tasks' && req.method === 'POST') { const input = await parseBody(req); const task = validate(input); task.id = id(); task.createdAt = now(); task.enabled = input.enabled !== false; task.password = input.password || ''; task.running = false; tasks.unshift(task); await save(); schedule(task); return send(res, 201, publicTask(task)); }
    const match = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(run|toggle))?$/);
    if (match) {
      const task = tasks.find(t => t.id === match[1]); if (!task) return send(res, 404, { error: '任务不存在' });
      if (match[2] === 'run' && req.method === 'POST') return send(res, 200, await runBackup(task));
      if (task.restoring && req.method !== 'GET') return send(res, 409, { error: '任务正在恢复，暂不能修改' });
      if (match[2] === 'toggle' && req.method === 'POST') { task.enabled = !task.enabled; await save(); schedule(task); return send(res, 200, publicTask(task)); }
      if (!match[2] && req.method === 'PUT') { const input = await parseBody(req); validate(input, task); Object.assign(task, input); if (input.password === undefined) task.password = task.password || ''; await save(); schedule(task); return send(res, 200, publicTask(task)); }
      if (!match[2] && req.method === 'DELETE') { clearSchedule(task.id); tasks = tasks.filter(t => t.id !== task.id); await save(); return send(res, 200, { ok: true }); }
    }
    if (req.method === 'GET') { const file = url.pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, url.pathname); if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain; charset=utf-8'); const ext = path.extname(file); const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }; return send(res, 200, fs.readFileSync(file), types[ext] || 'application/octet-stream'); }
    send(res, 404, { error: '接口不存在' });
  } catch (e) { send(res, 400, { error: e.message || '请求失败' }); }
});

async function start() {
  await database.initialize(DATA_DIR);
  const state = await database.loadState();
  tasks = state.tasks.map(task => ({ ...task, running: false, restoring: false }));
  runs = state.runs;
  await save();
  tasks.forEach(schedule);
  server.listen(PORT, HOST, () => console.log(`DB Backup Web running at http://${HOST}:${PORT}`));
}

start().catch(async error => {
  console.error(`Unable to start: ${error.message}`);
  await database.close().catch(() => {});
  process.exitCode = 1;
});
