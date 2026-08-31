// server.js
const express = require('express');
const cors = require('cors');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const archiver = require('archiver');
const cron = require('node-cron');
const crypto = require('crypto');
const app = express();

// ===== 配置（全部支持环境变量覆盖，适配 Unraid / Docker 部署） =====
const PORT = parseInt(process.env.PORT || '3000', 10);
const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS || '30', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const PACK_DIR = path.join(BACKUP_DIR, 'packs');       // ZIP 包存放目录
const CONFIG_FILE = path.join(BACKUP_DIR, 'pack_config.json'); // 打包配置持久化

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

// Bearer Token 认证（/health 和 /admin 界面除外，供 Docker healthcheck 和管理界面使用）
app.use((req, res, next) => {
    if (req.path === '/health' || req.path === '/admin' || req.path === '/admin/' || req.path.startsWith('/admin/')) return next();
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

// ===== 管理界面静态文件（需认证的页面，前端通过 API 认证） =====
app.use('/admin', express.static(path.join(__dirname, 'public')));

// ===== 管理界面 API（全部需要 Bearer Token） =====

// 获取打包配置
app.get('/api/pack-config', async (req, res) => {
    try {
        const cfg = await loadPackConfig();
        res.json(cfg);
    } catch (e) {
        res.status(500).json({ error: '读取配置失败' });
    }
});

// 保存打包配置
app.post('/api/pack-config', async (req, res) => {
    try {
        const cfg = {
            enabled: !!req.body.enabled,
            time: req.body.time || '02:00',        // 每天打包时间 HH:mm
            keepDays: parseInt(req.body.keepDays || '30', 10), // 保留最近 N 天的 ZIP
            dateOnly: req.body.dateOnly !== false, // 只打包当天文件（按文件名日期）
        };
        if (!/^\d{2}:\d{2}$/.test(cfg.time)) {
            return res.status(400).json({ error: '时间格式应为 HH:mm，如 02:00' });
        }
        await fs.mkdir(BACKUP_DIR, { recursive: true });
        await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
        setupCron(); // 重新加载定时任务
        console.log(`[${new Date().toISOString()}] ⚙️ 打包配置已更新:`, cfg);
        res.json({ ok: true, config: cfg });
    } catch (e) {
        console.error('[配置保存失败]', e);
        res.status(500).json({ error: '保存配置失败' });
    }
});

// 立即打包（手动触发）
app.post('/api/pack/now', async (req, res) => {
    try {
        const result = await packBackups();
        res.json(result);
    } catch (e) {
        console.error('[手动打包失败]', e);
        res.status(500).json({ error: '打包失败: ' + e.message });
    }
});

// ZIP 包列表
app.get('/api/packs', async (req, res) => {
    try {
        await fs.mkdir(PACK_DIR, { recursive: true });
        const files = (await fs.readdir(PACK_DIR))
            .filter(f => f.endsWith('.zip'))
            .sort()
            .reverse();
        const packs = await Promise.all(files.map(async (f) => {
            const st = await fs.stat(path.join(PACK_DIR, f));
            return { file: f, size: st.size, modifiedAt: st.mtime };
        }));
        res.json({ count: packs.length, packs });
    } catch (e) {
        res.status(500).json({ error: '读取打包目录失败' });
    }
});

// 下载 ZIP 包
app.get('/api/packs/download/:name', async (req, res) => {
    try {
        const name = path.basename(req.params.name); // 防路径穿越
        const filePath = path.join(PACK_DIR, name);
        if (!name.endsWith('.zip') || !fsSync.existsSync(filePath)) {
            return res.status(404).json({ error: '文件不存在' });
        }
        res.download(filePath, name);
    } catch (e) {
        res.status(500).json({ error: '下载失败' });
    }
});

// 删除 ZIP 包
app.delete('/api/packs/:name', async (req, res) => {
    try {
        const name = path.basename(req.params.name);
        const filePath = path.join(PACK_DIR, name);
        if (!name.endsWith('.zip')) return res.status(400).json({ error: '非法文件名' });
        await fs.unlink(filePath);
        console.log(`[${new Date().toISOString()}] 🗑️ 已删除 ZIP: ${name}`);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: '删除失败' });
    }
});

// 手动删除单个备份文件
app.delete('/api/backups/:name', async (req, res) => {
    try {
        const name = path.basename(req.params.name);
        const filePath = path.join(BACKUP_DIR, name);
        if (!name.startsWith('eh_assistant_backup_') || !name.endsWith('.json')) {
            return res.status(400).json({ error: '非法文件名' });
        }
        await fs.unlink(filePath);
        console.log(`[${new Date().toISOString()}] 🗑️ 已删除备份: ${name}`);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: '删除失败' });
    }
});

// ===== 打包配置加载 =====
async function loadPackConfig() {
    const defaults = { enabled: false, time: '02:00', keepDays: 30, dateOnly: true };
    try {
        const raw = await fs.readFile(CONFIG_FILE, 'utf8');
        return { ...defaults, ...JSON.parse(raw) };
    } catch (e) {
        return defaults;
    }
}

// ===== 打包逻辑：把指定日期（默认当天）的备份文件打成 ZIP =====
async function packBackups() {
    const cfg = await loadPackConfig();
    await fs.mkdir(PACK_DIR, { recursive: true });

    // 收集备份文件
    const allFiles = (await fs.readdir(BACKUP_DIR))
        .filter(f => f.startsWith('eh_assistant_backup_') && f.endsWith('.json'));

    let targets = allFiles;
    if (cfg.dateOnly) {
        // 只打包当天文件：文件名中的日期部分（eh_assistant_backup_2026-08-31T06-...）
        const today = new Date().toISOString().slice(0, 10); // 2026-08-31
        targets = allFiles.filter(f => f.includes(today));
    }
    if (targets.length === 0) {
        return { ok: false, message: '没有找到需要打包的备份文件', files: 0 };
    }

    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const zipName = `eh_pack_${stamp}.zip`;
    const zipPath = path.join(PACK_DIR, zipName);

    await new Promise((resolve, reject) => {
        const output = fsSync.createWriteStream(zipPath);
        // 兼容 archiver 不同版本导出（新版本导出对象，旧版本直接导出函数）
        const ArchiverCtor = (typeof archiver === 'function') ? archiver : archiver.Archiver;
        const archive = ArchiverCtor('zip', { zlib: { level: 9 } });
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);
        for (const f of targets) {
            archive.file(path.join(BACKUP_DIR, f), { name: f });
        }
        archive.finalize();
    });

    console.log(`[${new Date().toISOString()}] 📦 已打包 ${targets.length} 个文件 → ${zipName}`);

    // 清理旧 ZIP（保留最近 keepDays 份）
    await cleanupOldPacks(cfg.keepDays);

    return { ok: true, file: zipName, files: targets.length };
}

// 清理旧 ZIP 包
async function cleanupOldPacks(keepDays) {
    if (!keepDays || keepDays <= 0) return;
    try {
        const files = (await fs.readdir(PACK_DIR))
            .filter(f => f.startsWith('eh_pack_') && f.endsWith('.zip'))
            .sort();
        const excess = files.length - keepDays;
        for (let i = 0; i < excess; i++) {
            await fs.unlink(path.join(PACK_DIR, files[i])).catch(() => {});
            console.log(`[${new Date().toISOString()}] 🧹 清理旧 ZIP: ${files[i]}`);
        }
    } catch (e) {}
}

// ===== 定时任务：每天指定时间打包 =====
let cronTask = null;
async function setupCron() {
    if (cronTask) { cronTask.stop(); cronTask = null; }
    const cfg = await loadPackConfig();
    if (!cfg.enabled) {
        console.log(`[${new Date().toISOString()}] ⏰ 定时打包未启用`);
        return;
    }
    const [hour, minute] = cfg.time.split(':').map(Number);
    const expr = `${minute} ${hour} * * *`;
    cronTask = cron.schedule(expr, async () => {
        console.log(`[${new Date().toISOString()}] ⏰ 定时打包触发`);
        try {
            const result = await packBackups();
            console.log(`[${new Date().toISOString()}] ⏰ 定时打包结果:`, result.message || result.file);
        } catch (e) {
            console.error('[定时打包失败]', e);
        }
    }, { timezone: process.env.TZ || 'Asia/Shanghai' });
    console.log(`[${new Date().toISOString()}] ⏰ 定时打包已启用: 每天 ${cfg.time}（保留最近 ${cfg.keepDays} 份）`);
}

// ===== 启动 =====
app.listen(PORT, async () => {
    console.log(`EH Assistant Backup Server is listening on port ${PORT}`);
    console.log(`备份目录: ${BACKUP_DIR}（请确保已映射宿主机数据卷）`);
    console.log(`ZIP 目录: ${PACK_DIR}`);
    console.log(`最多保留: ${MAX_BACKUPS} 份备份`);
    console.log(`管理界面: http://localhost:${PORT}/admin`);
    await fs.mkdir(PACK_DIR, { recursive: true }).catch(() => {});
    await setupCron();
});
