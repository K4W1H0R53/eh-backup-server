FROM node:18-alpine

# 镜像元信息（GitHub Actions 构建时可通过 metadata-action 自动补充）
LABEL org.opencontainers.image.title="eh-backup-server" \
      org.opencontainers.image.description="A simple backup receiver for EH-Assistant" \
      org.opencontainers.image.source="https://github.com/K4W1H0R53/eh-backup-server" \
      org.opencontainers.image.licenses="MIT"

# su-exec: 用于 PUID/PGID 降权运行
RUN apk add --no-cache su-exec

# 设置工作目录
WORKDIR /usr/src/app

# 复制 package.json 和 package-lock.json (如果存在)
COPY package*.json ./

# 安装依赖（生产环境，跳过 devDependencies）
RUN npm install --omit=dev

# 复制应用代码
COPY . .

# 入口脚本可执行
RUN chmod +x /usr/src/app/entrypoint.sh

# 暴露端口
EXPOSE 3000

# 健康检查：请求 /health 接口，无需认证
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# 启动服务（入口脚本支持 PUID/PGID 降权）
ENTRYPOINT [ "/usr/src/app/entrypoint.sh" ]
CMD [ "npm", "start" ]
