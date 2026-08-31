#!/bin/sh
# 入口脚本：支持 PUID/PGID 降权运行（Unraid 风格）
# 用法: PUID=99 PGID=100（Unraid 默认 nobody:users）
# 不设置时默认以 root 运行（保持向后兼容）

set -e

# 读取 PUID/PGID（默认 root:root）
PUID="${PUID:-0}"
PGID="${PGID:-0}"

echo "[entrypoint] PUID=${PUID} PGID=${PGID}"

# 备份目录需以目标用户可写
if [ -n "${BACKUP_DIR}" ]; then
    mkdir -p "${BACKUP_DIR}"
fi

# 只有非 root 才需要降权（root 直接跑）
if [ "${PUID}" -ne 0 ] || [ "${PGID}" -ne 0 ]; then
    # 确保目标 GID 存在（不存在则创建）
    if ! getent group "${PGID}" > /dev/null 2>&1; then
        addgroup -g "${PGID}" ehgroup
        TARGET_GROUP="ehgroup"
    else
        TARGET_GROUP="$(getent group "${PGID}" | cut -d: -f1)"
    fi

    # 确保目标 UID 存在（不存在则创建）
    if ! getent passwd "${PUID}" > /dev/null 2>&1; then
        adduser -D -H -u "${PUID}" -G "${TARGET_GROUP}" ehuser
        TARGET_USER="ehuser"
    else
        TARGET_USER="$(getent passwd "${PUID}" | cut -d: -f1)"
    fi

    # 备份目录属主改为目标用户，保证可写
    if [ -n "${BACKUP_DIR}" ]; then
        chown -R "${PUID}:${PGID}" "${BACKUP_DIR}" || true
        # 目录 775 + 文件 664：确保 SMB 用户（组内）可读写删除
        find "${BACKUP_DIR}" -type d -exec chmod 775 {} + 2>/dev/null || true
        find "${BACKUP_DIR}" -type f -exec chmod 664 {} + 2>/dev/null || true
    fi

    echo "[entrypoint] 以 ${TARGET_USER} (${PUID}:${PGID}) 运行"
    exec su-exec "${PUID}:${PGID}" node server.js
else
    echo "[entrypoint] 以 root 运行"
    # 备份目录存在时也统一权限（属主 root，但组可写，SMB 用户属于组可访问）
    if [ -n "${BACKUP_DIR}" ] && [ -d "${BACKUP_DIR}" ]; then
        find "${BACKUP_DIR}" -type d -exec chmod 775 {} + 2>/dev/null || true
        find "${BACKUP_DIR}" -type f -exec chmod 664 {} + 2>/dev/null || true
    fi
    exec node server.js
fi
