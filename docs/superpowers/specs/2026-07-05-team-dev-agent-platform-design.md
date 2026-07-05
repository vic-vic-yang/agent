# 团队开发 Agent 平台 — 设计文档（一期 MVP）

日期：2026-07-05
状态：已与需求方确认

## 1. 背景与目标

为 2～5 人的小型开发团队搭建一个自托管的 Web 平台：成员通过浏览器给 AI agent 下发开发任务，agent 在隔离容器中自主完成编码并向自建 GitLab/Gitea 提交 Merge Request，或以只读方式回答针对代码仓库的问题。

**分期规划**（本文档只覆盖一期）：

- **一期（本设计）**：任务式写代码 + 提 MR；仓库代码问答。
- **二期**：Code Review（GitLab webhook 触发，agent 审查 MR 并留评论）。
- **三期**：团队知识库 / 文档问答。

二、三期复用一期的任务队列与容器执行基础设施，届时单独设计。

## 2. 核心决策

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 产品形态 | Web 平台 | 成员浏览器提交任务，服务端执行 |
| agent 核心 | Claude Agent SDK（TypeScript） | 自带工具循环、文件操作、命令执行、权限控制，自研代码量最少 |
| 模型 | GLM-4.6 起步，经 Anthropic 兼容端点接入；Kimi K2 备选 | 成本可控、生态验证充分；切换 Claude API 或其他兼容模型只改 `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` 两个配置 |
| 代码托管对接 | 自建 GitLab / Gitea | 团队现状；走各自 REST API 建 MR |
| 技术栈 | TypeScript / Node.js 全栈 | 团队熟悉；与 Agent SDK TS 版一致 |
| 执行隔离 | Docker，每任务一容器 | 任务互不干扰、环境可复现、失败零副作用 |
| 队列 | SQLite 任务表轮询，不引入 Redis | 单机 5 人规模足够，减少运维组件 |
| 登录 | 用户表 + 密码 | 小团队不上 OAuth |

## 3. 架构

```
浏览器 (React)
   │  HTTP / SSE
   ▼
API 服务 (Node/Fastify) ──── SQLite (users/repos/tasks/task_logs)
   │  同进程后台模块
   ▼
Runner（轮询领任务，管理容器生命周期）
   │  docker run，每任务一个
   ▼
agent-worker 容器 (Claude Agent SDK + git + 构建工具链)
   │  clone / push / MR API
   ▼
自建 GitLab / Gitea
```

### 3.1 组件职责

1. **Web 前端**（React + Vite）
   - 登录；新建任务：选仓库 + 需求描述 + 模式（`code`：写代码提 MR / `qa`：只读问答）；
   - 任务列表；任务详情页：SSE 实时日志、最终结果（MR 链接或 markdown 回答）。

2. **API 服务**（Fastify + TypeScript）
   - REST 接口 + SSE 日志推流；
   - 用户管理（管理员建账号）、仓库配置管理（GitLab 地址 + 项目路径 + access token，管理员录入）。

3. **SQLite 数据库**：四张表
   - `users`（id, name, password_hash, is_admin）
   - `repos`（id, name, git_url, platform: gitlab|gitea, api_base, access_token, default_branch）
   - `tasks`（id, user_id, repo_id, mode, prompt, status, result_json, created_at, started_at, finished_at）
   - `task_logs`（id, task_id, seq, line, created_at）
   - 任务状态机：`queued → running → done | failed | done_with_warning`

4. **Runner**（API 服务同进程的后台循环，非独立部署单元）
   - 每几秒轮询 `queued` 任务；并发上限可配，默认 2；
   - 领取后 `docker run` worker 容器，经环境变量与挂载卷传参；
   - 逐行收集容器 stdout：普通行写 `task_logs` 并推 SSE，结尾结构化 JSON 行作为任务结果；
   - 容器结束后销毁容器与任务卷。

5. **agent-worker 镜像**
   - 基础：Node LTS + git + 常见构建工具链；
   - 入口脚本：读 `task.json` → clone 仓库 → 调 Agent SDK `query()` 执行任务 → （code 模式）检测变更、建分支 `agent/task-<id>`、commit、push、调 GitLab/Gitea API 建 MR → 输出结构化结果 JSON。

### 3.2 部署形态

`docker compose up` 启动主服务容器（API + Runner），挂载：

- Docker socket（用于起 worker 容器）；
- SQLite 数据卷；
- 配置文件（模型端点/key、并发数、超时等）。

## 4. 任务生命周期（code 模式）

1. **提交**：前端 POST 任务 → 插入 `queued` 记录 → 返回任务 ID → 前端挂 SSE。
2. **领取**：Runner 轮询到任务且并发未满 → 标记 `running` → 起容器。传参：
   - 环境变量：`ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY`、GitLab 地址与 token、任务模式；
   - 任务卷：`task.json`（需求、仓库信息、目标分支）。
3. **执行**（容器内）：
   - clone（项目级 token，内网地址）；
   - Agent SDK `query()`，系统提示词约定：先读代码理解结构 → 修改 → 有测试则跑测试 → 改动限制在工作目录内；
   - 有实际变更 → 分支/commit/push → 调 API 建 MR（标题、描述由 agent 生成，描述附需求原文与改动摘要）；无变更 → 输出说明；
   - stdout 末尾输出一行结构化 JSON：`{ok, mrUrl?, summary}` 或 `{ok: false, error}`。
4. **回传**：Runner 写日志、推 SSE、按结果 JSON 更新状态、销毁容器。
5. **查看**：任务页展示日志与 MR 链接；**人工在 GitLab review 并合并——agent 永不直接合并**。

**qa 模式差异**：只读 clone（不注入 push 凭证）、系统提示词禁止修改、结果为 markdown 回答直接展示。

**并发**：每任务独立容器/克隆/分支，天然隔离；同仓库并发任务的冲突留给 MR 合并阶段人工处理。

## 5. 错误处理

| 场景 | 处理 |
|------|------|
| 任务超时 | 容器硬超时（默认 30 分钟，可配），Runner `docker kill`，任务 `failed`，日志保留 |
| agent 失败（模型报错/测试不过/死循环） | 入口脚本捕获异常输出结构化错误退出；未完成的工作不 push，容器销毁即归零，对仓库零副作用 |
| 服务重启 | 启动时将所有 `running` 任务标记 `failed`，清理孤儿容器；不做断点续跑 |
| MR 创建失败（代码已 push） | 日志给出分支名供手动开 MR，任务标记 `done_with_warning` |

## 6. 安全边界

- worker 容器：不挂 Docker socket、非 root 运行、只挂自己的任务卷；
- GitLab token：project-level 最小权限（read_repository + write_repository + api），不用 Owner 级；
- agent 只提 MR、不合并；
- 模型 API key 仅存在服务端配置，前端不可见；
- qa 模式容器不注入写凭证。

## 7. 测试策略

- **单元测试**（Vitest）：入口脚本纯逻辑——结果解析、MR 描述生成、变更检测；
- **接口测试**：任务生命周期状态机（提交→领取→完成/失败/超时）；
- **验收任务集**：3～5 个固定任务在 demo 仓库上真实执行，大改后手动跑一遍看成功率；agent 端到端不做自动化断言（不稳定且贵）。

## 8. 项目结构

```
agent-platform/            # monorepo, pnpm workspace
├── apps/
│   ├── server/            # Fastify API + Runner
│   └── web/               # React 前端
├── packages/
│   └── shared/            # 类型定义、任务协议（task.json / 结果 JSON schema）
├── worker/                # agent-worker 镜像：Dockerfile + 入口脚本
└── docker-compose.yml
```

## 9. 明确不做（一期）

- OAuth / SSO、多租户、权限分级（只有 admin / 普通用户两级）；
- Redis / 消息队列 / K8s；
- 任务断点续跑；
- agent 自动合并 MR；
- Code Review 与知识库（二、三期）。
