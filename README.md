# DB Backup Web

Node.js Web 控制台，用于配置远程 MySQL / PostgreSQL 数据库的定时备份。应用本身使用 Node.js `mysql2` 驱动直连 MySQL，保存任务、运行日志和运行状态；支持 Windows、Linux 原生运行及 Docker 部署。

## Docker 部署（Windows / Linux）

安装并启动 Docker Desktop（Windows）或 Docker Engine + Compose（Linux）。将 `.env.example` 复制为 `.env`，填写数据库连接信息后，在项目目录运行：

```sh
docker compose up -d --build
```

打开 <http://localhost:3080>。备份文件保存在项目目录 `backups`；任务中的备份目录填写 `/backups`。Docker 镜像包含 `mysqldump` 和 `pg_dump`。首次启动会创建应用数据库 `DB_NAME`（默认 `db_backup_web`）和所需数据表，数据库账号需要创建数据库及数据表的权限。

停止服务：`docker compose down`。升级代码后运行 `docker compose up -d --build` 重新构建。

Linux 首次启动如遇 `data` 或 `backups` 写入权限错误，请将目录所有权授予容器进程 UID 1000，或按本机 Docker 配置调整权限。

## Windows 原生运行

安装 Node.js 18 或更高版本，在 PowerShell 执行：

```powershell
cd E:\codes\db-backup-web
npm ci
Copy-Item .env.example .env
# 编辑 .env，填写数据库连接信息
node server.js
```

打开 <http://localhost:3080>。MySQL 任务需安装提供 `mysqldump` 的 MySQL 客户端；PostgreSQL 任务需安装提供 `pg_dump` 的客户端，并确保命令在 PATH 中。

## Linux 原生运行

安装 Node.js 18 或更高版本和数据库客户端。Debian / Ubuntu 示例：

```sh
sudo apt-get update
sudo apt-get install -y default-mysql-client postgresql-client
cd /path/to/db-backup-web
npm ci
cp .env.example .env
# 编辑 .env，填写数据库连接信息
node server.js
```

默认仅允许本机访问。需要从其他机器访问时，在 `.env` 设置 `HOST=0.0.0.0`，并先通过反向代理配置 HTTPS 与访问控制，再开放防火墙端口。每日任务使用服务器本地时区；部署前请设置系统时区或 `TZ` 环境变量。

## 数据库、备份文件和环境变量

- `.env` 中的 `DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_USER`、`DB_PASSWORD` 用于 Node.js 直连应用数据库。
- `DB_NAME` 不填写时默认创建并使用 `db_backup_web`。首次启动会将旧 `data/tasks.json` 和 `data/runs.json` 导入数据库一次，原 JSON 文件保留不删除。
- 运行记录和日志保存在 MySQL 的 `backup_runs` 表；任务配置保存在 `backup_tasks` 表。
- `/api/backups` 按任务配置的备份目录列出文件；Web 的“已备份文件”页可下载。
- 备份目录需按实际运行环境填写：Windows 如 `D:\\db-backups`，Linux 如 `/var/backups/db`，Docker 填 `/backups`。
- `HOST` 默认 `127.0.0.1`（仅本机访问），`PORT` 默认 `3080`。每日计划按服务器本地时间触发。需要从其他机器访问时，可设置 `HOST=0.0.0.0`，并先为服务加上访问控制和 HTTPS。

数据库凭据保存在 `.env`，该文件已加入 `.gitignore`。建议给应用建立单独的 MySQL 用户，仅授予 `DB_NAME` 数据库的建表和读写权限；不要将 `.env` 提交到版本库。
