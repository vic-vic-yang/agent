# 构建上下文 = 仓库根：docker compose 使用；内含 web 构建
FROM node:22-bookworm

RUN corepack enable

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agent-platform/web build

ENV NODE_ENV=production
ENV WEB_DIST=/app/apps/web/dist
WORKDIR /app/apps/server

CMD ["pnpm", "exec", "tsx", "src/index.ts"]
