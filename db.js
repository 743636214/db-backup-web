const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const dbName = process.env.DB_NAME || 'db_backup_web';
const connectionConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
};
const pool = mysql.createPool({
  ...connectionConfig,
  database: dbName,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
});

function parseJson(value) {
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

function readLegacy(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

async function initialize(legacyDir) {
  if (!connectionConfig.user) {
    throw new Error('请先配置 DB_HOST、DB_USER 和 DB_PASSWORD（可在 .env 中设置）');
  }
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) throw new Error('DB_NAME 只能包含英文字母、数字和下划线');
  const bootstrap = await mysql.createConnection(connectionConfig);
  try { await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); }
  finally { await bootstrap.end(); }
  await pool.query('SELECT 1');
  await pool.query(`CREATE TABLE IF NOT EXISTS backup_tasks (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    position INT NOT NULL,
    config_json JSON NOT NULL,
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS backup_runs (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    task_id VARCHAR(36) NOT NULL,
    run_at VARCHAR(32) NOT NULL,
    record_json JSON NOT NULL,
    INDEX idx_backup_runs_at (run_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS backup_app_meta (
    meta_key VARCHAR(100) NOT NULL PRIMARY KEY,
    meta_value VARCHAR(255) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  const [meta] = await pool.execute('SELECT meta_value FROM backup_app_meta WHERE meta_key = ?', ['legacy_json_imported']);
  if (!meta.length) {
    const [taskRows] = await pool.query('SELECT id FROM backup_tasks LIMIT 1');
    const [runRows] = await pool.query('SELECT id FROM backup_runs LIMIT 1');
    const legacyTasks = !taskRows.length ? readLegacy(path.join(legacyDir, 'tasks.json')) : [];
    const legacyRuns = !runRows.length ? readLegacy(path.join(legacyDir, 'runs.json')) : [];
    if (Array.isArray(legacyTasks) && legacyTasks.length) await saveTasks(legacyTasks);
    if (Array.isArray(legacyRuns) && legacyRuns.length) await saveRuns(legacyRuns);
    await pool.execute('INSERT INTO backup_app_meta (meta_key, meta_value) VALUES (?, ?)', ['legacy_json_imported', new Date().toISOString()]);
  }
}

async function loadState() {
  const [taskRows] = await pool.query('SELECT config_json FROM backup_tasks ORDER BY position ASC');
  const [runRows] = await pool.query('SELECT record_json FROM backup_runs ORDER BY run_at DESC LIMIT 200');
  return { tasks: taskRows.map(row => parseJson(row.config_json)), runs: runRows.map(row => parseJson(row.record_json)) };
}

async function saveTasks(tasks) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM backup_tasks');
    if (tasks.length) {
      const values = tasks.map((task, position) => [task.id, position, JSON.stringify(task)]);
      await connection.query('INSERT INTO backup_tasks (id, position, config_json) VALUES ?', [values]);
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

async function saveRuns(runs) {
  const limited = runs.slice(0, 200);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM backup_runs');
    if (limited.length) {
      const values = limited.map(run => [run.id, run.taskId, run.at, JSON.stringify(run)]);
      await connection.query('INSERT INTO backup_runs (id, task_id, run_at, record_json) VALUES ?', [values]);
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

async function close() { await pool.end(); }

module.exports = { initialize, loadState, saveTasks, saveRuns, close };
