# 构建上下文 = 仓库根：docker build -f worker/Dockerfile -t agent-worker:latest .
FROM node:22-bookworm

# 用 package.json 里 packageManager 字段钉死的 pnpm 版本（与开发机一致），
# 避免 corepack 拉最新版触发不同的供应链策略导致构建不可复现
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared packages/shared
COPY worker worker

RUN pnpm install --frozen-lockfile --filter "@agent-platform/worker..."

RUN mkdir -p /work /task && chown -R node:node /work /task /app

USER node
WORKDIR /app/worker
ENV NODE_ENV=production

ENTRYPOINT ["pnpm", "exec", "tsx", "src/main.ts"]
