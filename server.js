// server.js
const express = require('express');
const cors = require('cors');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const archiver = require('archiver');
const cron = require('node-cron');
const app = express();

// ===== 配置（全部支持环境变量覆盖，适配 Unraid / Docker 部署） =====
const PORT = parseInt(process.env.PORT || '3000', 10);
const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS || '30', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const DEFAULT_APP = process.env.DEFAULT_APP || 'eh_assistant'; // 默认应用名（兼容旧路径）

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
    if (MAX_FAILS <= 0) return; // MAX_AUTH_FAILS=0 时禁用锁定（私网/可信环境）
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
    if (MAX_FAILS > 0 && isLocked(req.ip)) {
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

// ===== 应用（多租户）工具函数 =====
// 应用名白名单校验：只允许字母数字下划线，防止路径穿越
const APP_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
// 保留名：这些路径被系统占用，不能作为应用名（避免与 /health、/admin、/api 冲突）
const RESERVED_APPS = new Set(['admin', 'health', 'api', 'backup', 'backups', 'packs', 'pack_config']);

function getAppDir(appName) {
    const name = appName || DEFAULT_APP;
    if (!APP_NAME_RE.test(name) || RESERVED_APPS.has(name)) return null;
    return path.join(BACKUP_DIR, name);
}

function getPackDir(appName) {
    const dir = getAppDir(appName);
    return dir ? path.join(dir, 'packs') : null;
}

function getConfigFile(appName) {
    const dir = getAppDir(appName);
    return dir ? path.join(dir, 'pack_config.json') : null;
}

// 获取所有应用列表（读取 BACKUP_DIR 下的一级子目录）
async function listApps() {
    try {
        const entries = await fs.readdir(BACKUP_DIR, { withFileTypes: true });
        const apps = entries
            .filter(e => e.isDirectory() && APP_NAME_RE.test(e.name))
            .map(e => e.name);
        if (!apps.includes(DEFAULT_APP)) apps.push(DEFAULT_APP);
        return apps.sort();
    } catch (e) {
        return [DEFAULT_APP];
    }
}

// ===== 备份轮转：保留最近 MAX_BACKUPS 份，自动清理更旧的 =====
async function rotateBackups(appDir) {
    if (MAX_BACKUPS <= 0) return;
    try {
        const files = (await fs.readdir(appDir))
            .filter(f => f.startsWith('eh_assistant_backup_') && f.endsWith('.json'))
            .sort(); // 文件名含时间戳，字典序即时间序（最旧的在前）
        const excess = files.length - MAX_BACKUPS;
        for (let i = 0; i < excess; i++) {
            await fs.unlink(path.join(appDir, files[i])).catch(() => {});
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

// ===== 应用列表（需认证，供管理界面选择） =====
app.get('/api/apps', async (req, res) => {
    try {
        const apps = await listApps();
        res.json({ apps, defaultApp: DEFAULT_APP });
    } catch (e) {
        res.status(500).json({ error: '读取应用列表失败' });
    }
});

// ===== 通用备份接口实现 =====
async function handleBackup(appName, body, res) {
    const appDir = getAppDir(appName);
    if (!appDir) return res.status(400).json({ error: '非法的应用名' });
    try {
        // mode 775：属主+组可读写执行，确保 SMB 用户（属于组）能删除目录内文件
        await fs.mkdir(appDir, { recursive: true, mode: 0o775 });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `eh_assistant_backup_${timestamp}.json`;
        const filePath = path.join(appDir, filename);
        await fs.writeFile(filePath, JSON.stringify(body, null, 2), 'utf8');
        // 文件权限 664：属主+组可读写，SMB 用户可修改/删除
        await fs.chmod(filePath, 0o664);
        console.log(`[${new Date().toISOString()}] ✅ [${appName}] 已保存备份: ${filename}`);
        await rotateBackups(appDir);
        res.status(200).json({ message: 'Backup successful', app: appName, file: filename });
    } catch (error) {
        console.error('[备份失败]', error);
        res.status(500).json({ error: 'Backup failed' });
    }
}

// ===== 通用备份列表实现 =====
async function handleBackupList(appName, res) {
    const appDir = getAppDir(appName);
    if (!appDir) return res.status(400).json({ error: '非法的应用名' });
    try {
        const files = (await fs.readdir(appDir))
            .filter(f => f.startsWith('eh_assistant_backup_') && f.endsWith('.json'))
            .sort()
            .reverse();
        const backups = await Promise.all(files.map(async (f) => {
            const st = await fs.stat(path.join(appDir, f));
            return { file: f, size: st.size, modifiedAt: st.mtime };
        }));
        res.json({ app: appName, count: backups.length, maxRetention: MAX_BACKUPS, backups });
    } catch (e) {
        res.status(500).json({ error: '无法读取备份目录' });
    }
}

// ===== 通用删除备份实现 =====
async function handleDeleteBackup(appName, fileName, res) {
    const appDir = getAppDir(appName);
    if (!appDir) return res.status(400).json({ error: '非法的应用名' });
    try {
        const name = path.basename(fileName);
        const filePath = path.join(appDir, name);
        if (!name.startsWith('eh_assistant_backup_') || !name.endsWith('.json')) {
            return res.status(400).json({ error: '非法文件名' });
        }
        await fs.unlink(filePath);
        console.log(`[${new Date().toISOString()}] 🗑️ [${appName}] 已删除备份: ${name}`);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: '删除失败' });
    }
}

// ===== 核心备份接口（默认应用，兼容旧客户端） =====
app.post('/backup', (req, res) => handleBackup(DEFAULT_APP, req.body, res));
app.get('/backups', (req, res) => handleBackupList(DEFAULT_APP, res));
app.delete('/backups/:name', (req, res) => handleDeleteBackup(DEFAULT_APP, req.params.name, res));

// ===== 多应用备份接口（路径前缀为应用名） =====
// 直接 POST 到应用根路径（如 https://backups.ostdb.top/eh_assistant）即备份
app.post('/:app', (req, res) => handleBackup(req.params.app, req.body, res));
// POST /eh_assistant/backup（兼容旧多应用路径）
app.post('/:app/backup', (req, res) => handleBackup(req.params.app, req.body, res));
// GET /eh_assistant/backups
app.get('/:app/backups', (req, res) => handleBackupList(req.params.app, res));
// DELETE /eh_assistant/backups/xxx.json
app.delete('/:app/backups/:name', (req, res) => handleDeleteBackup(req.params.app, req.params.name, res));

// ===== 管理界面静态文件（需认证的页面，前端通过 API 认证） =====
app.use('/admin', express.static(path.join(__dirname, 'public')));

// ===== 管理界面 API（全部需要 Bearer Token） =====

// 获取打包配置（按应用）
app.get('/api/pack-config', async (req, res) => {
    try {
        const appName = req.query.app || DEFAULT_APP;
        const cfg = await loadPackConfig(appName);
        res.json({ ...cfg, app: appName });
    } catch (e) {
        res.status(500).json({ error: '读取配置失败' });
    }
});

// 保存打包配置（按应用）
app.post('/api/pack-config', async (req, res) => {
    try {
        const appName = req.body.app || DEFAULT_APP;
        const cfg = {
            enabled: !!req.body.enabled,
            time: req.body.time || '02:00',        // 每天打包时间 HH:mm
            keepDays: parseInt(req.body.keepDays || '30', 10), // 保留最近 N 天的 ZIP
            dateOnly: req.body.dateOnly !== false, // 只打包当天文件（按文件名日期）
            deleteAfterPack: !!req.body.deleteAfterPack, // 打包完成后删除已打包的源文件
        };
        if (!/^\d{2}:\d{2}$/.test(cfg.time)) {
            return res.status(400).json({ error: '时间格式应为 HH:mm，如 02:00' });
        }
        const appDir = getAppDir(appName);
        if (!appDir) return res.status(400).json({ error: '非法的应用名' });
        await fs.mkdir(appDir, { recursive: true });
        await fs.writeFile(getConfigFile(appName), JSON.stringify(cfg, null, 2), 'utf8');
        setupCron(); // 重新加载定时任务
        console.log(`[${new Date().toISOString()}] ⚙️ [${appName}] 打包配置已更新:`, cfg);
        res.json({ ok: true, app: appName, config: cfg });
    } catch (e) {
        console.error('[配置保存失败]', e);
        res.status(500).json({ error: '保存配置失败' });
    }
});

// 立即打包（手动触发，按应用）
app.post('/api/pack/now', async (req, res) => {
    try {
        const appName = req.body.app || DEFAULT_APP;
        const result = await packBackups(appName);
        res.json(result);
    } catch (e) {
        console.error('[手动打包失败]', e);
        res.status(500).json({ error: '打包失败: ' + e.message });
    }
});

// ZIP 包列表（按应用）
app.get('/api/packs', async (req, res) => {
    try {
        const appName = req.query.app || DEFAULT_APP;
        const packDir = getPackDir(appName);
        if (!packDir) return res.status(400).json({ error: '非法的应用名' });
        await fs.mkdir(packDir, { recursive: true });
        const files = (await fs.readdir(packDir))
            .filter(f => f.endsWith('.zip'))
            .sort()
            .reverse();
        const packs = await Promise.all(files.map(async (f) => {
            const st = await fs.stat(path.join(packDir, f));
            return { file: f, size: st.size, modifiedAt: st.mtime };
        }));
        res.json({ app: appName, count: packs.length, packs });
    } catch (e) {
        res.status(500).json({ error: '读取打包目录失败' });
    }
});

// 下载 ZIP 包（按应用）
app.get('/api/packs/download/:app/:name', async (req, res) => {
    try {
        const appName = req.params.app;
        const packDir = getPackDir(appName);
        if (!packDir) return res.status(400).json({ error: '非法的应用名' });
        const name = path.basename(req.params.name); // 防路径穿越
        const filePath = path.join(packDir, name);
        if (!name.endsWith('.zip') || !fsSync.existsSync(filePath)) {
            return res.status(404).json({ error: '文件不存在' });
        }
        res.download(filePath, name);
    } catch (e) {
        res.status(500).json({ error: '下载失败' });
    }
});

// 删除 ZIP 包（按应用）
app.delete('/api/packs/:app/:name', async (req, res) => {
    try {
        const appName = req.params.app;
        const packDir = getPackDir(appName);
        if (!packDir) return res.status(400).json({ error: '非法的应用名' });
        const name = path.basename(req.params.name);
        const filePath = path.join(packDir, name);
        if (!name.endsWith('.zip')) return res.status(400).json({ error: '非法文件名' });
        await fs.unlink(filePath);
        console.log(`[${new Date().toISOString()}] 🗑️ [${appName}] 已删除 ZIP: ${name}`);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: '删除失败' });
    }
});

// ===== 打包配置加载（按应用） =====
async function loadPackConfig(appName) {
    const defaults = { enabled: false, time: '02:00', keepDays: 30, dateOnly: true, deleteAfterPack: false };
    try {
        const raw = await fs.readFile(getConfigFile(appName), 'utf8');
        return { ...defaults, ...JSON.parse(raw) };
    } catch (e) {
        return defaults;
    }
}

// ===== 打包逻辑：把指定日期（默认当天）的备份文件打成 ZIP（按应用） =====
async function packBackups(appName) {
    const appDir = getAppDir(appName);
    if (!appDir) throw new Error('非法的应用名');
    const packDir = getPackDir(appName);
    const cfg = await loadPackConfig(appName);
    await fs.mkdir(packDir, { recursive: true, mode: 0o775 });

    // 收集备份文件
    const allFiles = (await fs.readdir(appDir))
        .filter(f => f.startsWith('eh_assistant_backup_') && f.endsWith('.json'));

    let targets = allFiles;
    if (cfg.dateOnly) {
        // 只打包当天文件：文件名中的日期部分（eh_assistant_backup_2026-08-31T06-...）
        const today = new Date().toISOString().slice(0, 10); // 2026-08-31
        targets = allFiles.filter(f => f.includes(today));
    }
    if (targets.length === 0) {
        return { ok: false, app: appName, message: '没有找到需要打包的备份文件', files: 0 };
    }

    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const zipName = `eh_pack_${stamp}.zip`;
    const zipPath = path.join(packDir, zipName);

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
            archive.file(path.join(appDir, f), { name: f });
        }
        archive.finalize();
    });

    // ZIP 文件权限 664：SMB 用户可修改/删除
    await fs.chmod(zipPath, 0o664).catch(() => {});
    console.log(`[${new Date().toISOString()}] 📦 [${appName}] 已打包 ${targets.length} 个文件 → ${zipName}`);

    // 打包完成后删除已打包的源文件（可选）
    if (cfg.deleteAfterPack) {
        for (const f of targets) {
            await fs.unlink(path.join(appDir, f)).catch(() => {});
        }
        console.log(`[${new Date().toISOString()}] 🗑️ [${appName}] 已删除 ${targets.length} 个已打包源文件`);
    }

    // 清理旧 ZIP（保留最近 keepDays 份）
    await cleanupOldPacks(packDir, cfg.keepDays);

    return { ok: true, app: appName, file: zipName, files: targets.length, deletedAfterPack: !!cfg.deleteAfterPack };
}

// 清理旧 ZIP 包
async function cleanupOldPacks(packDir, keepDays) {
    if (!keepDays || keepDays <= 0) return;
    try {
        const files = (await fs.readdir(packDir))
            .filter(f => f.startsWith('eh_pack_') && f.endsWith('.zip'))
            .sort();
        const excess = files.length - keepDays;
        for (let i = 0; i < excess; i++) {
            await fs.unlink(path.join(packDir, files[i])).catch(() => {});
            console.log(`[${new Date().toISOString()}] 🧹 清理旧 ZIP: ${files[i]}`);
        }
    } catch (e) {}
}

// ===== 定时任务：每天指定时间打包（对所有启用配置的应用） =====
let cronTask = null;
async function setupCron() {
    if (cronTask) { cronTask.stop(); cronTask = null; }

    // 收集所有启用定时打包的应用
    const apps = await listApps();
    const schedules = [];
    for (const appName of apps) {
        const cfg = await loadPackConfig(appName);
        if (cfg.enabled && /^\d{2}:\d{2}$/.test(cfg.time)) {
            schedules.push({ app: appName, cfg });
        }
    }
    if (schedules.length === 0) {
        console.log(`[${new Date().toISOString()}] ⏰ 定时打包未启用（无应用开启）`);
        return;
    }

    // 为每个应用注册自己的定时任务
    for (const { app: appName, cfg } of schedules) {
        const [hour, minute] = cfg.time.split(':').map(Number);
        const expr = `${minute} ${hour} * * *`;
        cron.schedule(expr, async () => {
            console.log(`[${new Date().toISOString()}] ⏰ [${appName}] 定时打包触发`);
            try {
                const result = await packBackups(appName);
                console.log(`[${new Date().toISOString()}] ⏰ [${appName}] 定时打包结果:`, result.message || result.file);
            } catch (e) {
                console.error(`[${appName}] 定时打包失败`, e);
            }
        }, { timezone: process.env.TZ || 'Asia/Shanghai' });
    }
    console.log(`[${new Date().toISOString()}] ⏰ 定时打包已启用: ${schedules.map(s => `${s.app}@${s.cfg.time}`).join(', ')}`);
}

// ===== 启动 =====
app.listen(PORT, async () => {
    console.log(`EH Assistant Backup Server is listening on port ${PORT}`);
    console.log(`备份根目录: ${BACKUP_DIR}（请确保已映射宿主机数据卷）`);
    console.log(`默认应用: ${DEFAULT_APP}`);
    console.log(`最多保留: ${MAX_BACKUPS} 份备份`);
    console.log(`管理界面: http://localhost:${PORT}/admin`);
    await fs.mkdir(path.join(BACKUP_DIR, DEFAULT_APP), { recursive: true }).catch(() => {});
    await setupCron();
});
