# eh-backup-server

EH-Assistant（EH 发布助手油猴脚本）的远程备份接收服务器。客户端把全量数据 POST 过来，服务器落盘为带时间戳的 JSON 文件。

本项目支持 **GitHub Actions 自动构建镜像并推送到 GHCR**，在 Unraid 上只需一条 `docker run` 即可部署，**无需本机构建、无需 docker-compose**。

## 🚀 快速开始（GitHub 远程构建）

### 1. 推送代码到 GitHub 并触发自动构建

1. 在 GitHub 创建仓库（如 `eh-backup-server`），把本项目文件推上去。
2. 修改 [`Dockerfile`](Dockerfile) 中 `org.opencontainers.image.source` 的 `YOUR_GITHUB_USERNAME` 为你的用户名（可选，仅影响镜像元信息）。
3. 推送到 `main` 分支后，[GitHub Actions](.github/workflows/docker-build.yml) 会自动：
   - 构建 `linux/amd64` 和 `linux/arm64` 双架构镜像（适配 Unraid 常见硬件）
   - 推送到 `ghcr.io/<你的用户名>/eh-backup-server`
   - `main` 分支推送 → `latest` 标签；打 `v1.0.0` 标签 → `1.0.0` 等版本标签

> 💡 首次推送到 GHCR 的镜像默认是 **private** 的，Unraid 拉取会报 401。请到 GitHub → 你的仓库 → `Packages` → 找到该包 → `Package settings` → 把可见性改为 **Public**（或在 Unraid 中配置 GHCR 登录凭据）。

### 2. Unraid 上部署

在 Unraid 终端执行（**不需要 docker-compose，不需要本地构建**）：

```bash
# 生成强随机令牌（记住它，客户端要用）
openssl rand -hex 16

docker run -d \
  --name eh-backup-server \
  --restart unless-stopped \
  -p 3010:3000 \
  -e BACKUP_TOKEN="你的强随机令牌" \
  -e MAX_BACKUPS=30 \
  -e PUID=99 \
  -e PGID=100 \
  -v /mnt/user/temp/backups:/backups \
  ghcr.io/你的GitHub用户名/eh-backup-server:latest
```

> 💡 `PUID=99 PGID=100` 是 Unraid 默认的 `nobody:users` 用户/组。设置后备份文件的属主就是它，通过 SMB 访问备份目录时可以正常读写删除；不设置则以 root 运行（文件属主 root，SMB 用户只能读不能删）。

也可以用 Unraid 的 **Docker 页面 → Add Container** 图形化添加，字段对应关系：

| 字段 | 值 |
|---|---|
| Repository | `ghcr.io/你的GitHub用户名/eh-backup-server:latest` |
| Host Port | `3010`（Container Port 固定 `3000`） |
| Variable | `BACKUP_TOKEN`（必填） |
| Variable | `MAX_BACKUPS`（可选，默认 30） |
| Path | 映射 `/mnt/user/temp/backups` → `/backups` |

### 3. 更新镜像

```bash
docker pull ghcr.io/你的GitHub用户名/eh-backup-server:latest
docker rm -f eh-backup-server
# 再执行上面第 2 步的 docker run 命令
```

## ⚙️ 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `BACKUP_TOKEN` | ✅ | 无（缺失则拒绝启动） | Bearer 认证令牌，客户端需配置相同值。用 `openssl rand -hex 16` 生成 |
| `PORT` | ❌ | `3000` | 容器内监听端口 |
| `BACKUP_DIR` | ❌ | `/backups` | 备份文件存放目录（需映射数据卷） |
| `MAX_BACKUPS` | ❌ | `30` | 最多保留的备份份数，超出自动清理最旧的；设 `0` 禁用清理 |
| `CORS_ORIGIN` | ❌ | `*` | CORS 白名单（逗号分隔），默认允许所有来源 |
| `MAX_AUTH_FAILS` | ❌ | `5` | 同一 IP 连续认证失败多少次后临时锁定（防暴力破解） |
| `AUTH_LOCK_MS` | ❌ | `600000` | 锁定持续毫秒数（默认 10 分钟） |
| `PUID` | ❌ | `0` | 以指定用户 UID 运行（Unraid 用 `99` = nobody），不设置则以 root 运行 |
| `PGID` | ❌ | `0` | 以指定组 GID 运行（Unraid 用 `100` = users） |

## 📡 API

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `POST` | `/backup` | Bearer Token | 接收客户端备份数据（请求体为 JSON），落盘并返回文件名 |
| `GET` | `/backups` | Bearer Token | 列出已备份的文件、大小、时间 |
| `GET` | `/health` | 无 | 健康检查（供 Docker HEALTHCHECK 使用） |

客户端请求示例：

```
POST http://<unraid-ip>:3010/backup
Authorization: Bearer <BACKUP_TOKEN>
Content-Type: application/json

{ "ai_providers": [...], "galleries": [...], ... }
```

## 🛠️ 本地开发（可选）

```bash
npm install
BACKUP_TOKEN=test node server.js
```

## 🔒 安全提示

- 备份数据含你的 EH 相关配置与 Cookie 等敏感信息，**务必设置强令牌**（≥ 32 位随机字符）。
- 如暴露公网，建议在前面加 Caddy/Nginx 反代并启用 HTTPS。
- 已内置请求体 50MB 上限、备份自动轮转，避免磁盘被撑爆。
