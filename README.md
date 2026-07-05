# 开发 Agent 平台

自托管的团队开发 agent：成员在 Web 界面提交开发任务，agent 在隔离容器中
自主编码并向自建 GitLab/Gitea 提 MR，或只读回答仓库问题。

## 部署

前置：Linux 服务器 + Docker + Docker Compose，能访问内网 GitLab/Gitea 与模型 API。

    cp .env.example .env        # 按注释填写模型 key 与管理员密码
    docker build -f worker/Dockerfile -t agent-worker:latest .
    docker compose up -d --build

浏览器访问 http://<服务器>:8787，用 admin + ADMIN_PASSWORD 登录。

## 使用

1. **加用户**（管理员）：调用 `POST /api/users`（暂无界面）：
   `curl -b "sid=<登录后的cookie>" -H 'content-type: application/json' -d '{"name":"bob","password":"..."}' http://localhost:8787/api/users`
2. **加仓库**（管理员）：`POST /api/repos`，示例见 docs/acceptance.md。
   GitLab token 用 Project Access Token（角色 Developer，勾选 api + read_repository + write_repository）。
3. **提任务**：登录后「新建任务」，选仓库、选模式、写需求。code 模式产出 MR 链接，人工 review 合并。

## 模型切换

改 `.env` 里的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `MODEL` 三项，
`docker compose up -d` 重启即可，代码零改动。

## 开发

    pnpm install
    pnpm --filter @agent-platform/server dev    # API: 8787
    pnpm --filter @agent-platform/web dev       # 前端: 5173（代理 /api）
    pnpm test                                    # 全部测试

## 架构

见 docs/superpowers/specs/2026-07-05-team-dev-agent-platform-design.md
