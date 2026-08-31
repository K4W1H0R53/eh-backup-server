// server.js
const express = require('express');
const cors = require('cors');
const fs = require('fs/promises');
const path = require('path');
const app = express();

// ===== 配置（全部支持环境变量覆盖，适配 Unraid / Docker 部署） =====
const PORT = parseInt(process.env.PORT || '3000', 10);
const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS || '30', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// 认证令牌：必须通过环境变量 BACKUP_TOKEN 显式设置（客户端侧需要配置相同的值）
const SECRET_TOKEN = process.env.BACKUP_TOKEN || '';
if (!SECRET_TOKEN) {
    console.error('[启动失败] 必须设置环境变量 BACKUP_TOKEN（客户端将使用它作为 Bearer 令牌）。');
    console.error('示例: docker run -e BACKUP_TOKEN="your-strong-random-token" ...');
    console.error('生成强随机令牌: openssl rand -hex 16');
    process.exit(1);
}

// ===== 中间件 =====
// CORS：默认全开；可通过 CORS_ORIGIN 指定逗号分隔的来源白名单
const corsOptions = CORS_ORIGIN === '*' ? {} : { origin: CORS_ORIGIN.split(',').map(s => s.trim()) };
app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));

// ===== 简单防暴力破解（无需额外依赖）：同 IP 连续认证失败 N 次后临时锁定 =====
const MAX_FAILS = parseInt(process.env.MAX_AUTH_FAILS || '5', 10);
const LOCK_MS = parseInt(process.env.AUTH_LOCK_MS || (10 * 60 * 1000).toString(), 10); // 默认 10 分钟
const failTracker = new Map(); // ip -> { fails, lockedUntil }

function isLocked(ip) {
    const rec = failTracker.get(ip);
    if (!rec || !rec.lockedUntil) return false;
    if (Date.now() < rec.lockedUntil) return true;
    failTracker.delete(ip); // 锁定期已过，清除记录
    return false;
}

function recordFail(ip) {
    const rec = failTracker.get(ip) || { fails: 0, lockedUntil: 0 };
    rec.fails += 1;
    if (rec.fails >= MAX_FAILS) {
        rec.lockedUntil = Date.now() + LOCK_MS;
        rec.fails = 0;
        console.warn(`[${new Date().toISOString()}] 🔒 IP ${ip} 因连续认证失败被锁定 ${LOCK_MS / 1000}s`);
    }
    failTracker.set(ip, rec);
}

// Bearer Token 认证（/health 除外，供 Docker healthcheck 使用）
app.use((req, res, next) => {
    if (req.path === '/health') return next();
    if (isLocked(req.ip)) {
        console.warn(`[${new Date().toISOString()}] 拒绝已被锁定的 IP ${req.ip}`);
        return res.status(429).json({ error: 'Too Many Failed Attempts, temporarily locked' });
    }
    const authHeader = req.headers.authorization || '';
    if (authHeader !== `Bearer ${SECRET_TOKEN}`) {
        console.warn(`[${new Date().toISOString()}] 拒绝未授权请求 from ${req.ip}`);
        recordFail(req.ip);
        return res.status(403).json({ error: 'Forbidden: Invalid or missing token' });
    }
    next();
});

// ===== 备份轮转：保留最近 MAX_BACKUPS 份，自动清理更旧的 =====
async function rotateBackups() {
    if (MAX_BACKUPS <= 0) return;
    try {
        const files = (await fs.readdir(BACKUP_DIR))
            .filter(f => f.startsWith('eh_assistant_backup_') && f.endsWith('.json'))
            .sort(); // 文件名含时间戳，字典序即时间序（最旧的在前）
        const excess = files.length - MAX_BACKUPS;
        for (let i = 0; i < excess; i++) {
            await fs.unlink(path.join(BACKUP_DIR, files[i])).catch(() => {});
            console.log(`[${new Date().toISOString()}] 🧹 清理旧备份: ${files[i]}`);
        }
    } catch (e) {
        // 目录不存在等情况忽略
    }
}

// ===== 健康检查（无需认证，供 Docker HEALTHCHECK 使用） =====
app.get('/health', async (req, res) => {
    try {
        await fs.access(BACKUP_DIR);
        res.json({ status: 'ok', backupsDir: BACKUP_DIR });
    } catch (e) {
        res.status(503).json({ status: 'degraded', error: '备份目录不可访问' });
    }
});

// ===== 备份列表（需认证） =====
app.get('/backups', async (req, res) => {
    try {
        const files = (await fs.readdir(BACKUP_DIR))
            .filter(f => f.startsWith('eh_assistant_backup_') && f.endsWith('.json'))
            .sort()
            .reverse();
        const backups = await Promise.all(files.map(async (f) => {
            const st = await fs.stat(path.join(BACKUP_DIR, f));
            return { file: f, size: st.size, modifiedAt: st.mtime };
        }));
        res.json({ count: backups.length, maxRetention: MAX_BACKUPS, backups });
    } catch (e) {
        res.status(500).json({ error: '无法读取备份目录' });
    }
});

// ===== 核心备份接口 =====
app.post('/backup', async (req, res) => {
    try {
        await fs.mkdir(BACKUP_DIR, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `eh_assistant_backup_${timestamp}.json`;
        await fs.writeFile(path.join(BACKUP_DIR, filename), JSON.stringify(req.body, null, 2), 'utf8');
        console.log(`[${new Date().toISOString()}] ✅ 已保存备份: ${filename}`);
        await rotateBackups();
        res.status(200).json({ message: 'Backup successful', file: filename });
    } catch (error) {
        console.error('[备份失败]', error);
        res.status(500).json({ error: 'Backup failed' });
    }
});

// ===== 启动 =====
app.listen(PORT, () => {
    console.log(`EH Assistant Backup Server is listening on port ${PORT}`);
    console.log(`备份目录: ${BACKUP_DIR}（请确保已映射宿主机数据卷）`);
    console.log(`最多保留: ${MAX_BACKUPS} 份备份`);
});
