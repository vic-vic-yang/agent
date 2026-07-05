# 团队开发 Agent 平台一期 MVP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建自托管 Web 平台：团队成员提交开发任务，agent 在 Docker 容器内自主编码并向自建 GitLab/Gitea 提 MR，或只读回答仓库问题。

**Architecture:** pnpm monorepo。`apps/server` 是 Fastify API + 内嵌 Runner（轮询 SQLite 任务表、经 dockerode 每任务起一个 worker 容器、收集 stdout 推 SSE）；`worker/` 是容器镜像（Claude Agent SDK + git，克隆→编码→push→建 MR，结尾输出 `@@RESULT@@{json}` 协议行）；`apps/web` 是 React 前端；`packages/shared` 定义任务协议类型。

**Tech Stack:** TypeScript (ESM, strict), Node 22, pnpm, Fastify 5, better-sqlite3, dockerode, @anthropic-ai/claude-agent-sdk, execa, React 18 + Vite, Vitest。

**设计文档:** `docs/superpowers/specs/2026-07-05-team-dev-agent-platform-design.md`

## Global Constraints

- Node ≥ 20（开发用 22），pnpm ≥ 9，全部包 `"type": "module"`（ESM）。
- TypeScript strict 模式；运行时统一用 tsx，不做 tsc 构建产物（`tsc --noEmit` 只做类型检查）。
- 测试框架统一 Vitest，测试文件与源码同目录，命名 `*.test.ts`。
- 不引入：Redis、消息队列、K8s、OAuth、ORM（直接写 SQL）。
- agent 只提 MR，永不合并；worker 容器非 root、不挂 Docker socket。
- worker 与 Runner 的 stdout 协议：普通行 = 日志；`@@RESULT@@` 前缀行 = 结构化结果（`packages/shared` 定义）。
- 任务状态机：`queued → running → done | failed | done_with_warning`。
- 界面文案用中文。
- 模型经 Anthropic 兼容端点接入，只通过 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `MODEL` 三个环境变量配置。
- 设计文档 §6 的细化：qa 模式克隆私有仓库仍需 token，但克隆完成后立即从 git remote 中清除凭证（所有模式都这么做），push 时（仅 code 模式）才临时重新注入；qa 模式同时禁用 Write/Edit 工具。

---

### Task 1: Monorepo 脚手架

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`
- Modify: git index（移除已误提交的 `.claude/settings.local.json`）

**Interfaces:**
- Consumes: 无
- Produces: workspace 布局 `apps/*`、`packages/*`、`worker`；根脚本 `pnpm -r test`、`pnpm -r typecheck`；`tsconfig.base.json` 供各包 extends

- [ ] **Step 1: 写根配置文件**

`package.json`:

```json
{
  "name": "agent-platform",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "typescript": "^5.6.0"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
  - worker
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noEmit": true
  }
}
```

`.gitignore`:

```
node_modules/
dist/
data/
.env
.claude/settings.local.json
*.tsbuildinfo
```

- [ ] **Step 2: 清理误提交文件并安装**

```bash
git rm --cached .claude/settings.local.json
pnpm install
```

预期：生成 `pnpm-lock.yaml`，无报错。

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "chore: monorepo 脚手架（pnpm workspace + 基础 tsconfig）"
```

---

### Task 2: shared 包 — 任务协议

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/index.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（后续所有任务依赖，签名必须一字不差）:
  - `type TaskMode = "code" | "qa"`
  - `type TaskStatus = "queued" | "running" | "done" | "failed" | "done_with_warning"`
  - `interface RepoInfo { gitUrl: string; platform: "gitlab" | "gitea"; apiBase: string; projectPath: string; defaultBranch: string }`
  - `interface TaskSpec { taskId: number; mode: TaskMode; prompt: string; repo: RepoInfo }`
  - `type TaskResult = { ok: true; mrUrl?: string; summary: string; warning?: string } | { ok: false; error: string }`
  - `const RESULT_PREFIX = "@@RESULT@@"`
  - `function serializeResult(r: TaskResult): string` — 返回 `@@RESULT@@` + JSON 单行
  - `function parseResultLine(line: string): TaskResult | null` — 非前缀行或非法 JSON 返回 null

- [ ] **Step 1: 建包并写失败测试**

`packages/shared/package.json`:

```json
{
  "name": "@agent-platform/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p ."
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

`packages/shared/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseResultLine, RESULT_PREFIX, serializeResult, type TaskResult } from "./index.js";

describe("任务结果协议", () => {
  it("序列化后可解析回原值", () => {
    const r: TaskResult = { ok: true, mrUrl: "https://git.internal/mr/1", summary: "加了过滤" };
    const line = serializeResult(r);
    expect(line.startsWith(RESULT_PREFIX)).toBe(true);
    expect(line).not.toContain("\n");
    expect(parseResultLine(line)).toEqual(r);
  });

  it("普通日志行返回 null", () => {
    expect(parseResultLine("正在克隆仓库...")).toBeNull();
    expect(parseResultLine('{"ok":true}')).toBeNull();
  });

  it("前缀后 JSON 非法时返回 null", () => {
    expect(parseResultLine(`${RESULT_PREFIX}{oops`)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @agent-platform/shared test`
预期：FAIL（`./index.js` 不存在）。

- [ ] **Step 3: 实现**

`packages/shared/src/index.ts`:

```ts
export type TaskMode = "code" | "qa";
export type TaskStatus = "queued" | "running" | "done" | "failed" | "done_with_warning";

export interface RepoInfo {
  gitUrl: string;
  platform: "gitlab" | "gitea";
  apiBase: string;
  projectPath: string;
  defaultBranch: string;
}

export interface TaskSpec {
  taskId: number;
  mode: TaskMode;
  prompt: string;
  repo: RepoInfo;
}

export type TaskResult =
  | { ok: true; mrUrl?: string; summary: string; warning?: string }
  | { ok: false; error: string };

export const RESULT_PREFIX = "@@RESULT@@";

export function serializeResult(r: TaskResult): string {
  return RESULT_PREFIX + JSON.stringify(r);
}

export function parseResultLine(line: string): TaskResult | null {
  if (!line.startsWith(RESULT_PREFIX)) return null;
  try {
    return JSON.parse(line.slice(RESULT_PREFIX.length)) as TaskResult;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @agent-platform/shared test`
预期：3 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/shared pnpm-lock.yaml
git commit -m "feat(shared): 任务协议类型与结果行序列化"
```

---

### Task 3: server 脚手架 — 配置与数据库

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/src/config.ts`, `apps/server/src/db.ts`
- Test: `apps/server/src/db.test.ts`, `apps/server/src/config.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface Config { port: number; dataDir: string; hostDataDir: string; adminPassword: string; anthropicBaseUrl: string; anthropicApiKey: string; model: string; workerImage: string; concurrency: number; taskTimeoutMs: number; webDist: string | null }`
  - `function loadConfig(env?: NodeJS.ProcessEnv): Config`
  - `type DB = Database.Database`（better-sqlite3）
  - `function initDb(file: string): DB` — 建全部表，可传 `":memory:"`
  - 行类型：`interface UserRow { id: number; name: string; password_hash: string; is_admin: number }`、`interface RepoRow { id: number; name: string; git_url: string; platform: "gitlab" | "gitea"; api_base: string; project_path: string; access_token: string; default_branch: string }`、`interface TaskRow { id: number; user_id: number; repo_id: number; mode: string; prompt: string; status: string; result_json: string | null; created_at: string; started_at: string | null; finished_at: string | null }`

- [ ] **Step 1: 建包并写失败测试**

`apps/server/package.json`:

```json
{
  "name": "@agent-platform/server",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc -p ."
  },
  "dependencies": {
    "@agent-platform/shared": "workspace:*",
    "@fastify/cookie": "^11.0.0",
    "@fastify/static": "^8.0.0",
    "better-sqlite3": "^11.5.0",
    "dockerode": "^4.0.2",
    "fastify": "^5.1.0",
    "tsx": "^4.19.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/dockerode": "^3.3.31",
    "@types/node": "^22.9.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`apps/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src"]
}
```

`apps/server/src/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("无环境变量时给出默认值", () => {
    const c = loadConfig({});
    expect(c.port).toBe(8787);
    expect(c.concurrency).toBe(2);
    expect(c.taskTimeoutMs).toBe(30 * 60 * 1000);
    expect(c.workerImage).toBe("agent-worker:latest");
    expect(c.hostDataDir).toBe(c.dataDir);
  });

  it("从环境变量读取覆盖值", () => {
    const c = loadConfig({
      PORT: "9000",
      DATA_DIR: "/data",
      HOST_DATA_DIR: "/srv/agent/data",
      CONCURRENCY: "3",
      TASK_TIMEOUT_MINUTES: "10",
      ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
      ANTHROPIC_API_KEY: "sk-x",
      MODEL: "glm-4.6"
    });
    expect(c.port).toBe(9000);
    expect(c.hostDataDir).toBe("/srv/agent/data");
    expect(c.taskTimeoutMs).toBe(600000);
    expect(c.model).toBe("glm-4.6");
  });
});
```

`apps/server/src/db.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { initDb, type UserRow } from "./db.js";

describe("initDb", () => {
  it("建表后可读写各表", () => {
    const db = initDb(":memory:");
    db.prepare("INSERT INTO users (name, password_hash, is_admin) VALUES (?, ?, 1)").run("admin", "x:y");
    const u = db.prepare("SELECT * FROM users WHERE name = ?").get("admin") as UserRow;
    expect(u.is_admin).toBe(1);

    db.prepare(
      "INSERT INTO repos (name, git_url, platform, api_base, project_path, access_token) VALUES (?,?,?,?,?,?)"
    ).run("demo", "https://git.internal/g/demo.git", "gitlab", "https://git.internal/api/v4", "g/demo", "tok");

    db.prepare("INSERT INTO tasks (user_id, repo_id, mode, prompt) VALUES (1, 1, 'code', '加个接口')").run();
    const t = db.prepare("SELECT status FROM tasks WHERE id = 1").get() as { status: string };
    expect(t.status).toBe("queued");
  });

  it("platform 约束拒绝非法值", () => {
    const db = initDb(":memory:");
    expect(() =>
      db.prepare(
        "INSERT INTO repos (name, git_url, platform, api_base, project_path, access_token) VALUES ('a','b','svn','c','d','e')"
      ).run()
    ).toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm install && pnpm --filter @agent-platform/server test`
预期：FAIL（config.js / db.js 不存在）。

- [ ] **Step 3: 实现**

`apps/server/src/config.ts`:

```ts
export interface Config {
  port: number;
  dataDir: string;
  hostDataDir: string;
  adminPassword: string;
  anthropicBaseUrl: string;
  anthropicApiKey: string;
  model: string;
  workerImage: string;
  concurrency: number;
  taskTimeoutMs: number;
  webDist: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.DATA_DIR ?? "./data";
  return {
    port: Number(env.PORT ?? 8787),
    dataDir,
    // Runner 给 worker 容器挂卷时用的是宿主机路径；server 自己在容器里跑时两者不同
    hostDataDir: env.HOST_DATA_DIR ?? dataDir,
    adminPassword: env.ADMIN_PASSWORD ?? "admin123",
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL ?? "",
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    model: env.MODEL ?? "",
    workerImage: env.WORKER_IMAGE ?? "agent-worker:latest",
    concurrency: Number(env.CONCURRENCY ?? 2),
    taskTimeoutMs: Number(env.TASK_TIMEOUT_MINUTES ?? 30) * 60 * 1000,
    webDist: env.WEB_DIST ?? null
  };
}
```

`apps/server/src/db.ts`:

```ts
import Database from "better-sqlite3";

export type DB = Database.Database;

export interface UserRow {
  id: number;
  name: string;
  password_hash: string;
  is_admin: number;
}

export interface RepoRow {
  id: number;
  name: string;
  git_url: string;
  platform: "gitlab" | "gitea";
  api_base: string;
  project_path: string;
  access_token: string;
  default_branch: string;
}

export interface TaskRow {
  id: number;
  user_id: number;
  repo_id: number;
  mode: string;
  prompt: string;
  status: string;
  result_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export function initDb(file: string): DB {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      git_url TEXT NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('gitlab','gitea')),
      api_base TEXT NOT NULL,
      project_path TEXT NOT NULL,
      access_token TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main'
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      mode TEXT NOT NULL CHECK (mode IN ('code','qa')),
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      result_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      seq INTEGER NOT NULL,
      line TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id, seq);
  `);
  return db;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @agent-platform/server test`
预期：4 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/server pnpm-lock.yaml
git commit -m "feat(server): 配置加载与 SQLite schema"
```

---

### Task 4: server 认证 — 密码、会话、用户管理

**Files:**
- Create: `apps/server/src/password.ts`, `apps/server/src/auth.ts`, `apps/server/src/app.ts`
- Test: `apps/server/src/password.test.ts`, `apps/server/src/auth.test.ts`

**Interfaces:**
- Consumes: `initDb`, `DB`, `UserRow`（Task 3）、`loadConfig`/`Config`（Task 3）
- Produces:
  - `function hashPassword(pw: string): string` / `function verifyPassword(pw: string, stored: string): boolean`
  - `function seedAdmin(db: DB, password: string): void` — users 表为空时插入 `admin` 管理员
  - `function buildApp(deps: { db: DB; config: Config; bus: LogBus }): FastifyInstance` — 后续路由任务都往这个工厂里加（Task 4 先不接 bus，签名里 bus 为可选：`bus?: LogBus`，Task 6 收紧）
  - 路由：`POST /api/login` `{name, password}` → 200 设 `sid` cookie / 401；`POST /api/logout`；`GET /api/me` → `{id, name, isAdmin}`；`POST /api/users`（仅管理员）`{name, password, isAdmin}` → `{id}`
  - Fastify request 装饰：`request.user: UserRow`（登录守卫注入；`/api/login` 之外的所有 `/api/*` 未登录一律 401）

- [ ] **Step 1: 写失败测试**

`apps/server/src/password.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("密码哈希", () => {
  it("正确密码校验通过，错误密码不通过", () => {
    const stored = hashPassword("s3cret");
    expect(stored).toContain(":");
    expect(verifyPassword("s3cret", stored)).toBe(true);
    expect(verifyPassword("wrong", stored)).toBe(false);
  });

  it("同一密码两次哈希盐不同", () => {
    expect(hashPassword("a")).not.toBe(hashPassword("a"));
  });

  it("损坏的存储格式返回 false 而不是抛错", () => {
    expect(verifyPassword("a", "garbage")).toBe(false);
  });
});
```

`apps/server/src/auth.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { seedAdmin } from "./auth.js";
import { initDb, type DB } from "./db.js";
import { loadConfig } from "./config.js";

let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = initDb(":memory:");
  seedAdmin(db, "admin123");
  app = buildApp({ db, config: loadConfig({}) });
  await app.ready();
});

async function login(name: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { name, password } });
  return res;
}

describe("认证", () => {
  it("错误密码返回 401", async () => {
    const res = await login("admin", "nope");
    expect(res.statusCode).toBe(401);
  });

  it("登录成功后 /api/me 返回用户信息", async () => {
    const res = await login("admin", "admin123");
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === "sid");
    expect(cookie).toBeDefined();
    const me = await app.inject({ method: "GET", url: "/api/me", cookies: { sid: cookie!.value } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ name: "admin", isAdmin: true });
  });

  it("未登录访问受保护接口返回 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
  });

  it("管理员可创建普通用户，普通用户不能建用户", async () => {
    const adminSid = (await login("admin", "admin123")).cookies[0].value;
    const created = await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: { sid: adminSid },
      payload: { name: "bob", password: "bobpass", isAdmin: false }
    });
    expect(created.statusCode).toBe(200);

    const bobSid = (await login("bob", "bobpass")).cookies[0].value;
    const denied = await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: { sid: bobSid },
      payload: { name: "eve", password: "x", isAdmin: false }
    });
    expect(denied.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @agent-platform/server test`
预期：新增测试 FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`apps/server/src/password.ts`:

```ts
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  try {
    return timingSafeEqual(scryptSync(pw, salt, 32), Buffer.from(hash, "hex"));
  } catch {
    return false;
  }
}
```

`apps/server/src/auth.ts`:

```ts
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DB, UserRow } from "./db.js";
import { hashPassword, verifyPassword } from "./password.js";

declare module "fastify" {
  interface FastifyRequest {
    user: UserRow;
  }
}

export function seedAdmin(db: DB, password: string): void {
  const count = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  if (count === 0) {
    db.prepare("INSERT INTO users (name, password_hash, is_admin) VALUES ('admin', ?, 1)").run(
      hashPassword(password)
    );
  }
}

export function registerAuth(app: FastifyInstance, db: DB): void {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/") || req.url === "/api/login") return;
    const sid = req.cookies.sid;
    const user = sid
      ? (db
          .prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?")
          .get(sid) as UserRow | undefined)
      : undefined;
    if (!user) return reply.code(401).send({ error: "未登录" });
    req.user = user;
  });

  app.post<{ Body: { name: string; password: string } }>("/api/login", async (req, reply) => {
    const { name, password } = req.body ?? ({} as { name: string; password: string });
    const user = db.prepare("SELECT * FROM users WHERE name = ?").get(name) as UserRow | undefined;
    if (!user || !verifyPassword(password, user.password_hash)) {
      return reply.code(401).send({ error: "用户名或密码错误" });
    }
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(token, user.id);
    reply.setCookie("sid", token, { path: "/", httpOnly: true, sameSite: "lax" });
    return { id: user.id, name: user.name, isAdmin: !!user.is_admin };
  });

  app.post("/api/logout", async (req, reply) => {
    if (req.cookies.sid) db.prepare("DELETE FROM sessions WHERE token = ?").run(req.cookies.sid);
    reply.clearCookie("sid", { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req) => ({
    id: req.user.id,
    name: req.user.name,
    isAdmin: !!req.user.is_admin
  }));

  app.post<{ Body: { name: string; password: string; isAdmin?: boolean } }>(
    "/api/users",
    async (req, reply) => {
      if (!req.user.is_admin) return reply.code(403).send({ error: "需要管理员权限" });
      const { name, password, isAdmin } = req.body;
      const info = db
        .prepare("INSERT INTO users (name, password_hash, is_admin) VALUES (?, ?, ?)")
        .run(name, hashPassword(password), isAdmin ? 1 : 0);
      return { id: Number(info.lastInsertRowid) };
    }
  );
}
```

`apps/server/src/app.ts`:

```ts
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import { registerAuth } from "./auth.js";
import type { LogBus } from "./logbus.js";

export interface AppDeps {
  db: DB;
  config: Config;
  bus?: LogBus;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(cookie);
  app.register(async (scoped) => {
    registerAuth(scoped, deps.db);
  });
  return app;
}
```

注意：`./logbus.js` 在 Task 6 才创建。本任务先建占位文件 `apps/server/src/logbus.ts`，内容只有 `export class LogBus {}`，Task 6 替换为完整实现。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @agent-platform/server test`
预期：全部 PASS。

如遇 cookie 未生效：`registerAuth` 必须在 `app.register(cookie)` 之后注册（如上）。preHandler hook 注册在 scoped 插件内只对该插件内路由生效——后续任务的路由都注册进同一个 scoped 插件（见 Task 5/6 的接入方式）。为使 hook 覆盖所有 `/api` 路由，将 `registerAuth` 的 hook 部分改挂到根实例：把 `app.addHook` 从 `registerAuth` 抽出为 `registerAuthGuard(app, db)` 挂根实例，路由部分保留在 `registerAuth`。若测试通过则维持现状。

- [ ] **Step 5: 提交**

```bash
git add apps/server
git commit -m "feat(server): 密码登录、会话与用户管理"
```

---

### Task 5: server 仓库配置接口

**Files:**
- Create: `apps/server/src/repos.ts`
- Modify: `apps/server/src/app.ts`（注册 repos 路由）
- Test: `apps/server/src/repos.test.ts`

**Interfaces:**
- Consumes: `buildApp`、`registerAuth`、`seedAdmin`（Task 4）、`RepoRow`（Task 3）
- Produces:
  - `function registerRepoRoutes(app: FastifyInstance, db: DB): void`
  - `GET /api/repos` → `Array<{id, name, platform, projectPath, defaultBranch}>`（**绝不返回 access_token 与 git_url 中的凭证**）
  - `POST /api/repos`（仅管理员）`{name, gitUrl, platform, apiBase, projectPath, accessToken, defaultBranch?}` → `{id}`
  - `DELETE /api/repos/:id`（仅管理员）→ `{ok: true}`

- [ ] **Step 1: 写失败测试**

`apps/server/src/repos.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { seedAdmin } from "./auth.js";
import { initDb, type DB } from "./db.js";
import { loadConfig } from "./config.js";

let db: DB;
let app: FastifyInstance;
let adminSid: string;

const repoPayload = {
  name: "demo",
  gitUrl: "https://git.internal/g/demo.git",
  platform: "gitlab",
  apiBase: "https://git.internal/api/v4",
  projectPath: "g/demo",
  accessToken: "glpat-secret"
};

beforeEach(async () => {
  db = initDb(":memory:");
  seedAdmin(db, "admin123");
  app = buildApp({ db, config: loadConfig({}) });
  await app.ready();
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { name: "admin", password: "admin123" } });
  adminSid = res.cookies[0].value;
});

describe("仓库配置", () => {
  it("管理员创建后列表可见，且不泄露 token", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/repos", cookies: { sid: adminSid }, payload: repoPayload
    });
    expect(created.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/api/repos", cookies: { sid: adminSid } });
    const repos = list.json();
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ name: "demo", platform: "gitlab", defaultBranch: "main" });
    expect(JSON.stringify(repos)).not.toContain("glpat-secret");
  });

  it("非管理员不能创建或删除", async () => {
    await app.inject({
      method: "POST", url: "/api/users", cookies: { sid: adminSid },
      payload: { name: "bob", password: "p", isAdmin: false }
    });
    const bobSid = (await app.inject({ method: "POST", url: "/api/login", payload: { name: "bob", password: "p" } }))
      .cookies[0].value;
    const res = await app.inject({ method: "POST", url: "/api/repos", cookies: { sid: bobSid }, payload: repoPayload });
    expect(res.statusCode).toBe(403);
  });

  it("管理员可删除", async () => {
    await app.inject({ method: "POST", url: "/api/repos", cookies: { sid: adminSid }, payload: repoPayload });
    const del = await app.inject({ method: "DELETE", url: "/api/repos/1", cookies: { sid: adminSid } });
    expect(del.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/repos", cookies: { sid: adminSid } });
    expect(list.json()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @agent-platform/server test`
预期：新增测试 FAIL。

- [ ] **Step 3: 实现**

`apps/server/src/repos.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { DB, RepoRow } from "./db.js";

export function registerRepoRoutes(app: FastifyInstance, db: DB): void {
  app.get("/api/repos", async () => {
    const rows = db.prepare("SELECT * FROM repos ORDER BY id").all() as RepoRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      platform: r.platform,
      projectPath: r.project_path,
      defaultBranch: r.default_branch
    }));
  });

  app.post<{
    Body: {
      name: string; gitUrl: string; platform: "gitlab" | "gitea";
      apiBase: string; projectPath: string; accessToken: string; defaultBranch?: string;
    };
  }>("/api/repos", async (req, reply) => {
    if (!req.user.is_admin) return reply.code(403).send({ error: "需要管理员权限" });
    const b = req.body;
    const info = db
      .prepare(
        `INSERT INTO repos (name, git_url, platform, api_base, project_path, access_token, default_branch)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(b.name, b.gitUrl, b.platform, b.apiBase, b.projectPath, b.accessToken, b.defaultBranch ?? "main");
    return { id: Number(info.lastInsertRowid) };
  });

  app.delete<{ Params: { id: string } }>("/api/repos/:id", async (req, reply) => {
    if (!req.user.is_admin) return reply.code(403).send({ error: "需要管理员权限" });
    db.prepare("DELETE FROM repos WHERE id = ?").run(Number(req.params.id));
    return { ok: true };
  });
}
```

`apps/server/src/app.ts` 的 scoped 插件内追加一行：

```ts
import { registerRepoRoutes } from "./repos.js";
// buildApp 内：
  app.register(async (scoped) => {
    registerAuth(scoped, deps.db);
    registerRepoRoutes(scoped, deps.db);
  });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @agent-platform/server test`
预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/server
git commit -m "feat(server): 仓库配置 CRUD（管理员）"
```

---

### Task 6: server 任务接口 — LogBus、任务 CRUD 与 SSE

**Files:**
- Create: `apps/server/src/logbus.ts`（替换 Task 4 的占位）、`apps/server/src/tasks.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/logbus.test.ts`, `apps/server/src/tasks.test.ts`

**Interfaces:**
- Consumes: Task 3/4/5 全部；`TaskStatus`（shared）
- Produces:
  - `interface LogEvent { taskId: number; seq: number; line: string }`
  - `interface DoneEvent { taskId: number; status: string }`
  - `class LogBus`：`emitLine(e: LogEvent)`、`emitDone(e: DoneEvent)`、`onLine(taskId: number, fn: (e: LogEvent) => void): () => void`（返回退订函数）、`onDone(taskId: number, fn: (e: DoneEvent) => void): () => void`
  - `function registerTaskRoutes(app: FastifyInstance, db: DB, bus: LogBus): void`
  - `POST /api/tasks` `{repoId, mode, prompt}` → `{id}`（repo 不存在 → 400）
  - `GET /api/tasks` → 任务数组（含 `userName`、`repoName`，倒序）
  - `GET /api/tasks/:id` → 详情，`result` 字段为解析后的 `TaskResult | null`
  - `GET /api/tasks/:id/logs` → `Array<{seq, line}>`
  - `GET /api/tasks/:id/events` → SSE（`event: log` 逐行；结束时 `event: done`）
  - `buildApp` 的 `bus` 参数由可选改为必填：`buildApp({ db, config, bus })`

- [ ] **Step 1: 写失败测试**

`apps/server/src/logbus.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LogBus } from "./logbus.js";

describe("LogBus", () => {
  it("按 taskId 分发，退订后不再收到", () => {
    const bus = new LogBus();
    const got: string[] = [];
    const off = bus.onLine(1, (e) => got.push(e.line));
    bus.onLine(2, (e) => got.push("其他任务:" + e.line));

    bus.emitLine({ taskId: 1, seq: 1, line: "a" });
    bus.emitLine({ taskId: 2, seq: 1, line: "b" });
    off();
    bus.emitLine({ taskId: 1, seq: 2, line: "c" });

    expect(got).toEqual(["a", "其他任务:b"]);
  });

  it("done 事件同样按 taskId 分发", () => {
    const bus = new LogBus();
    const got: string[] = [];
    bus.onDone(5, (e) => got.push(e.status));
    bus.emitDone({ taskId: 5, status: "done" });
    bus.emitDone({ taskId: 6, status: "failed" });
    expect(got).toEqual(["done"]);
  });
});
```

`apps/server/src/tasks.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { seedAdmin } from "./auth.js";
import { initDb, type DB } from "./db.js";
import { loadConfig } from "./config.js";
import { LogBus } from "./logbus.js";

let db: DB;
let app: FastifyInstance;
let sid: string;

beforeEach(async () => {
  db = initDb(":memory:");
  seedAdmin(db, "admin123");
  app = buildApp({ db, config: loadConfig({}), bus: new LogBus() });
  await app.ready();
  sid = (await app.inject({ method: "POST", url: "/api/login", payload: { name: "admin", password: "admin123" } }))
    .cookies[0].value;
  await app.inject({
    method: "POST", url: "/api/repos", cookies: { sid },
    payload: {
      name: "demo", gitUrl: "https://git.internal/g/demo.git", platform: "gitlab",
      apiBase: "https://git.internal/api/v4", projectPath: "g/demo", accessToken: "tok"
    }
  });
});

describe("任务接口", () => {
  it("创建任务后列表与详情可见", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/tasks", cookies: { sid },
      payload: { repoId: 1, mode: "code", prompt: "给导出接口加日期过滤" }
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;

    const list = await app.inject({ method: "GET", url: "/api/tasks", cookies: { sid } });
    expect(list.json()[0]).toMatchObject({ id, status: "queued", repoName: "demo", userName: "admin" });

    const detail = await app.inject({ method: "GET", url: `/api/tasks/${id}`, cookies: { sid } });
    expect(detail.json()).toMatchObject({ id, mode: "code", result: null });
  });

  it("repo 不存在时返回 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/tasks", cookies: { sid },
      payload: { repoId: 99, mode: "code", prompt: "x" }
    });
    expect(res.statusCode).toBe(400);
  });

  it("logs 接口返回已写入的日志行", async () => {
    const id = (await app.inject({
      method: "POST", url: "/api/tasks", cookies: { sid },
      payload: { repoId: 1, mode: "qa", prompt: "问个问题" }
    })).json().id;
    db.prepare("INSERT INTO task_logs (task_id, seq, line) VALUES (?, 1, '正在克隆')").run(id);
    const res = await app.inject({ method: "GET", url: `/api/tasks/${id}/logs`, cookies: { sid } });
    expect(res.json()).toEqual([{ seq: 1, line: "正在克隆" }]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @agent-platform/server test`
预期：新增测试 FAIL。

- [ ] **Step 3: 实现**

`apps/server/src/logbus.ts`（整体替换占位）:

```ts
import { EventEmitter } from "node:events";

export interface LogEvent {
  taskId: number;
  seq: number;
  line: string;
}

export interface DoneEvent {
  taskId: number;
  status: string;
}

export class LogBus {
  private ee = new EventEmitter().setMaxListeners(100);

  emitLine(e: LogEvent): void {
    this.ee.emit(`line:${e.taskId}`, e);
  }

  emitDone(e: DoneEvent): void {
    this.ee.emit(`done:${e.taskId}`, e);
  }

  onLine(taskId: number, fn: (e: LogEvent) => void): () => void {
    this.ee.on(`line:${taskId}`, fn);
    return () => this.ee.off(`line:${taskId}`, fn);
  }

  onDone(taskId: number, fn: (e: DoneEvent) => void): () => void {
    this.ee.on(`done:${taskId}`, fn);
    return () => this.ee.off(`done:${taskId}`, fn);
  }
}
```

`apps/server/src/tasks.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { parseResultLine, RESULT_PREFIX } from "@agent-platform/shared";
import type { DB, TaskRow } from "./db.js";
import type { LogBus } from "./logbus.js";

const ACTIVE = new Set(["queued", "running"]);

export function registerTaskRoutes(app: FastifyInstance, db: DB, bus: LogBus): void {
  app.post<{ Body: { repoId: number; mode: "code" | "qa"; prompt: string } }>(
    "/api/tasks",
    async (req, reply) => {
      const { repoId, mode, prompt } = req.body;
      if (!prompt?.trim()) return reply.code(400).send({ error: "需求描述不能为空" });
      const repo = db.prepare("SELECT id FROM repos WHERE id = ?").get(repoId);
      if (!repo) return reply.code(400).send({ error: "仓库不存在" });
      const info = db
        .prepare("INSERT INTO tasks (user_id, repo_id, mode, prompt) VALUES (?, ?, ?, ?)")
        .run(req.user.id, repoId, mode, prompt);
      return { id: Number(info.lastInsertRowid) };
    }
  );

  app.get("/api/tasks", async () => {
    return db
      .prepare(
        `SELECT t.id, t.mode, t.prompt, t.status, t.created_at AS createdAt,
                u.name AS userName, r.name AS repoName
         FROM tasks t JOIN users u ON u.id = t.user_id JOIN repos r ON r.id = t.repo_id
         ORDER BY t.id DESC LIMIT 200`
      )
      .all();
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(Number(req.params.id)) as TaskRow | undefined;
    if (!t) return reply.code(404).send({ error: "任务不存在" });
    return {
      id: t.id, mode: t.mode, prompt: t.prompt, status: t.status,
      createdAt: t.created_at, startedAt: t.started_at, finishedAt: t.finished_at,
      result: t.result_json ? parseResultLine(RESULT_PREFIX + t.result_json) : null
    };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/logs", async (req) => {
    return db
      .prepare("SELECT seq, line FROM task_logs WHERE task_id = ? ORDER BY seq")
      .all(Number(req.params.id));
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/events", (req, reply) => {
    const taskId = Number(req.params.id);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    const send = (event: string, data: unknown) =>
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const replay = (afterSeq: number): number => {
      const rows = db
        .prepare("SELECT seq, line FROM task_logs WHERE task_id = ? AND seq > ? ORDER BY seq")
        .all(taskId, afterSeq) as Array<{ seq: number; line: string }>;
      for (const r of rows) send("log", r);
      return rows.length ? rows[rows.length - 1].seq : afterSeq;
    };

    let lastSeq = replay(0);
    const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
    if (!task || !ACTIVE.has(task.status)) {
      send("done", { taskId, status: task?.status ?? "unknown" });
      reply.raw.end();
      return;
    }

    const offLine = bus.onLine(taskId, (e) => {
      if (e.seq > lastSeq) {
        lastSeq = e.seq;
        send("log", { seq: e.seq, line: e.line });
      }
    });
    const offDone = bus.onDone(taskId, (e) => {
      send("done", e);
      cleanup();
      reply.raw.end();
    });
    // 补发订阅建立前的空窗期日志
    lastSeq = replay(lastSeq);

    const cleanup = () => {
      offLine();
      offDone();
    };
    req.raw.on("close", cleanup);
  });
}
```

`apps/server/src/app.ts` 修改：`bus` 必填并注册任务路由：

```ts
import { registerTaskRoutes } from "./tasks.js";
import { LogBus } from "./logbus.js";

export interface AppDeps {
  db: DB;
  config: Config;
  bus: LogBus;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(cookie);
  app.register(async (scoped) => {
    registerAuth(scoped, deps.db);
    registerRepoRoutes(scoped, deps.db);
    registerTaskRoutes(scoped, deps.db, deps.bus);
  });
  return app;
}
```

同步修改 Task 4/5 的测试文件：`buildApp({ db, config: loadConfig({}), bus: new LogBus() })`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @agent-platform/server test`
预期：全部 PASS（含旧测试）。

- [ ] **Step 5: 提交**

```bash
git add apps/server
git commit -m "feat(server): 任务 CRUD、LogBus 与 SSE 日志流"
```

---

### Task 7: server 容器抽象 — ContainerRunner

**Files:**
- Create: `apps/server/src/container.ts`
- Test: `apps/server/src/container.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface ContainerRunSpec { image: string; env: Record<string, string>; binds: string[]; timeoutMs: number; onLine: (line: string) => void }`
  - `interface ContainerRunner { run(spec: ContainerRunSpec): Promise<{ exitCode: number; timedOut: boolean }> }`
  - `class DockerodeRunner implements ContainerRunner`（构造参数 `docker?: Docker`，默认 `new Docker()` 走本机 socket）
  - `function createLineSplitter(onLine: (line: string) => void): Writable` — 把字节流切成行（供 DockerodeRunner 内部与测试用）

- [ ] **Step 1: 写失败测试（针对可单测的行切分器）**

`apps/server/src/container.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createLineSplitter } from "./container.js";

describe("createLineSplitter", () => {
  it("跨 chunk 的行会被正确拼接", async () => {
    const lines: string[] = [];
    const w = createLineSplitter((l) => lines.push(l));
    w.write(Buffer.from("正在克"));
    w.write(Buffer.from("隆仓库\n第二行\n第三"));
    w.end(Buffer.from("行"));
    await new Promise((r) => w.on("finish", r));
    expect(lines).toEqual(["正在克隆仓库", "第二行", "第三行"]);
  });

  it("忽略空行", async () => {
    const lines: string[] = [];
    const w = createLineSplitter((l) => lines.push(l));
    w.end(Buffer.from("a\n\n\nb\n"));
    await new Promise((r) => w.on("finish", r));
    expect(lines).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @agent-platform/server test`
预期：FAIL。

- [ ] **Step 3: 实现**

`apps/server/src/container.ts`:

```ts
import { Writable } from "node:stream";
import Docker from "dockerode";

export interface ContainerRunSpec {
  image: string;
  env: Record<string, string>;
  binds: string[];
  timeoutMs: number;
  onLine: (line: string) => void;
}

export interface ContainerRunner {
  run(spec: ContainerRunSpec): Promise<{ exitCode: number; timedOut: boolean }>;
}

export function createLineSplitter(onLine: (line: string) => void): Writable {
  let buf = "";
  return new Writable({
    write(chunk: Buffer, _enc, cb) {
      buf += chunk.toString("utf8");
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const p of parts) if (p.trim()) onLine(p.trimEnd());
      cb();
    },
    final(cb) {
      if (buf.trim()) onLine(buf.trimEnd());
      cb();
    }
  });
}

export class DockerodeRunner implements ContainerRunner {
  constructor(private docker: Docker = new Docker()) {}

  async run(spec: ContainerRunSpec): Promise<{ exitCode: number; timedOut: boolean }> {
    const container = await this.docker.createContainer({
      Image: spec.image,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      HostConfig: {
        Binds: spec.binds,
        SecurityOpt: ["no-new-privileges"],
        Memory: 4 * 1024 * 1024 * 1024
      },
      Tty: false
    });

    const stream = await container.attach({ stream: true, stdout: true, stderr: true });
    const splitter = createLineSplitter(spec.onLine);
    container.modem.demuxStream(stream, splitter, splitter);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      container.kill().catch(() => {});
    }, spec.timeoutMs);

    try {
      await container.start();
      const status = (await container.wait()) as { StatusCode: number };
      return { exitCode: status.StatusCode, timedOut };
    } finally {
      clearTimeout(timer);
      splitter.end();
      await container.remove({ force: true }).catch(() => {});
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @agent-platform/server test`
预期：PASS。`DockerodeRunner` 本身不做单测（依赖 Docker 守护进程），在 Task 15 部署联调时验证。

- [ ] **Step 5: 提交**

```bash
git add apps/server
git commit -m "feat(server): Docker 容器执行抽象与行切分器"
```

---

### Task 8: server 任务执行器 — TaskRunner

**Files:**
- Create: `apps/server/src/runner.ts`, `apps/server/src/index.ts`
- Test: `apps/server/src/runner.test.ts`

**Interfaces:**
- Consumes: `ContainerRunner`/`ContainerRunSpec`（Task 7）、`LogBus`（Task 6）、`DB`/`RepoRow`/`TaskRow`/`Config`（Task 3）、`TaskSpec`/`parseResultLine`/`serializeResult`（Task 2）
- Produces:
  - `class TaskRunner`，构造参数 `{ db: DB; containers: ContainerRunner; bus: LogBus; config: Config }`
  - `markOrphans(): void` — 启动时把所有 `running` 置为 `failed`
  - `tick(): Promise<void>` — 领取任务直到并发满（测试直接调）
  - `start(): void` — `markOrphans()` + `setInterval(tick, 3000)`
  - `apps/server/src/index.ts` — 进程入口：加载配置 → initDb → seedAdmin → buildApp → 静态文件（若 `config.webDist`）→ listen → `new TaskRunner(...).start()`

- [ ] **Step 1: 写失败测试**

`apps/server/src/runner.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { serializeResult } from "@agent-platform/shared";
import { initDb, type DB, type TaskRow } from "./db.js";
import { loadConfig } from "./config.js";
import { LogBus } from "./logbus.js";
import { TaskRunner } from "./runner.js";
import type { ContainerRunner, ContainerRunSpec } from "./container.js";

let db: DB;
let bus: LogBus;

function seed(mode = "code") {
  db.prepare("INSERT INTO users (name, password_hash, is_admin) VALUES ('u','x:y',0)").run();
  db.prepare(
    "INSERT INTO repos (name, git_url, platform, api_base, project_path, access_token) VALUES ('demo','https://g/d.git','gitlab','https://g/api/v4','g/d','tok')"
  ).run();
  db.prepare("INSERT INTO tasks (user_id, repo_id, mode, prompt) VALUES (1, 1, ?, '做点事')").run(mode);
}

function fakeRunner(fn: (spec: ContainerRunSpec) => Promise<{ exitCode: number; timedOut: boolean }>): ContainerRunner {
  return { run: fn };
}

function makeRunner(containers: ContainerRunner, concurrency = 2) {
  const config = { ...loadConfig({ DATA_DIR: "./test-data" }), concurrency };
  return new TaskRunner({ db, containers, bus, config });
}

function task(id = 1): TaskRow {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow;
}

beforeEach(() => {
  db = initDb(":memory:");
  bus = new LogBus();
  seed();
});

describe("TaskRunner", () => {
  it("成功任务：日志入库、结果落库、状态 done", async () => {
    const runner = makeRunner(
      fakeRunner(async (spec) => {
        spec.onLine("正在克隆");
        spec.onLine(serializeResult({ ok: true, mrUrl: "https://g/mr/1", summary: "完成" }));
        return { exitCode: 0, timedOut: false };
      })
    );
    await runner.tick();
    expect(task().status).toBe("done");
    expect(JSON.parse(task().result_json!)).toMatchObject({ ok: true, mrUrl: "https://g/mr/1" });
    const logs = db.prepare("SELECT line FROM task_logs WHERE task_id = 1").all() as Array<{ line: string }>;
    expect(logs.map((l) => l.line)).toEqual(["正在克隆"]);
  });

  it("带 warning 的成功结果 → done_with_warning", async () => {
    const runner = makeRunner(
      fakeRunner(async (spec) => {
        spec.onLine(serializeResult({ ok: true, summary: "s", warning: "MR 创建失败" }));
        return { exitCode: 0, timedOut: false };
      })
    );
    await runner.tick();
    expect(task().status).toBe("done_with_warning");
  });

  it("超时 → failed，错误信息为超时", async () => {
    const runner = makeRunner(fakeRunner(async () => ({ exitCode: 137, timedOut: true })));
    await runner.tick();
    expect(task().status).toBe("failed");
    expect(JSON.parse(task().result_json!).error).toContain("超时");
  });

  it("容器异常退出且无结果行 → failed", async () => {
    const runner = makeRunner(fakeRunner(async () => ({ exitCode: 1, timedOut: false })));
    await runner.tick();
    expect(task().status).toBe("failed");
  });

  it("并发上限：concurrency=1 时一次 tick 只领一个", async () => {
    db.prepare("INSERT INTO tasks (user_id, repo_id, mode, prompt) VALUES (1, 1, 'qa', '第二个')").run();
    let resolveFirst!: () => void;
    const gate = new Promise<void>((r) => (resolveFirst = r));
    const runner = makeRunner(
      fakeRunner(async (spec) => {
        spec.onLine(serializeResult({ ok: true, summary: "ok" }));
        await gate;
        return { exitCode: 0, timedOut: false };
      }),
      1
    );
    const p = runner.tick();
    expect(task(2).status).toBe("queued");
    resolveFirst();
    await p;
    expect(task(1).status).toBe("done");
  });

  it("markOrphans 把 running 任务标为 failed", () => {
    db.prepare("UPDATE tasks SET status = 'running' WHERE id = 1").run();
    makeRunner(fakeRunner(async () => ({ exitCode: 0, timedOut: false }))).markOrphans();
    expect(task().status).toBe("failed");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @agent-platform/server test`
预期：FAIL（runner.js 不存在）。

- [ ] **Step 3: 实现**

`apps/server/src/runner.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseResultLine, type TaskResult, type TaskSpec } from "@agent-platform/shared";
import type { ContainerRunner } from "./container.js";
import type { Config } from "./config.js";
import type { DB, RepoRow, TaskRow } from "./db.js";
import type { LogBus } from "./logbus.js";

export interface RunnerDeps {
  db: DB;
  containers: ContainerRunner;
  bus: LogBus;
  config: Config;
}

export class TaskRunner {
  private running = new Set<number>();
  private ticking = false;

  constructor(private deps: RunnerDeps) {}

  markOrphans(): void {
    this.deps.db
      .prepare(
        `UPDATE tasks SET status = 'failed', finished_at = datetime('now'),
         result_json = ? WHERE status = 'running'`
      )
      .run(JSON.stringify({ ok: false, error: "服务重启，任务中断" } satisfies TaskResult));
  }

  start(): void {
    this.markOrphans();
    setInterval(() => void this.tick(), 3000);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const started: Promise<void>[] = [];
    try {
      while (this.running.size < this.deps.config.concurrency) {
        const task = this.claimNext();
        if (!task) break;
        this.running.add(task.id);
        started.push(
          this.execute(task)
            .catch((e) => this.finish(task.id, "failed", { ok: false, error: String(e?.message ?? e) }))
            .finally(() => this.running.delete(task.id))
        );
      }
    } finally {
      this.ticking = false;
    }
    await Promise.all(started);
  }

  private claimNext(): TaskRow | null {
    const claim = this.deps.db.transaction((): TaskRow | null => {
      const row = this.deps.db
        .prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY id LIMIT 1")
        .get() as TaskRow | undefined;
      if (!row) return null;
      this.deps.db
        .prepare("UPDATE tasks SET status = 'running', started_at = datetime('now') WHERE id = ?")
        .run(row.id);
      return row;
    });
    return claim();
  }

  private async execute(task: TaskRow): Promise<void> {
    const { db, config, containers } = this.deps;
    const repo = db.prepare("SELECT * FROM repos WHERE id = ?").get(task.repo_id) as RepoRow;

    const spec: TaskSpec = {
      taskId: task.id,
      mode: task.mode as TaskSpec["mode"],
      prompt: task.prompt,
      repo: {
        gitUrl: repo.git_url,
        platform: repo.platform,
        apiBase: repo.api_base,
        projectPath: repo.project_path,
        defaultBranch: repo.default_branch
      }
    };

    const taskDir = join(config.dataDir, "tasks", String(task.id));
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "task.json"), JSON.stringify(spec, null, 2));

    let seq = 0;
    let result: TaskResult | null = null;
    const onLine = (line: string) => {
      const parsed = parseResultLine(line);
      if (parsed) {
        result = parsed;
        return;
      }
      seq++;
      db.prepare("INSERT INTO task_logs (task_id, seq, line) VALUES (?, ?, ?)").run(task.id, seq, line);
      this.deps.bus.emitLine({ taskId: task.id, seq, line });
    };

    const { exitCode, timedOut } = await containers.run({
      image: config.workerImage,
      env: {
        ANTHROPIC_BASE_URL: config.anthropicBaseUrl,
        ANTHROPIC_API_KEY: config.anthropicApiKey,
        MODEL: config.model,
        GIT_TOKEN: repo.access_token,
        TASK_FILE: "/task/task.json"
      },
      binds: [`${join(config.hostDataDir, "tasks", String(task.id))}:/task:ro`],
      timeoutMs: config.taskTimeoutMs,
      onLine
    });

    let status: string;
    if (timedOut) {
      status = "failed";
      result = { ok: false, error: `任务超时（${config.taskTimeoutMs / 60000} 分钟），已强制终止` };
    } else if (result?.ok) {
      status = result.warning ? "done_with_warning" : "done";
    } else {
      status = "failed";
      result = result ?? { ok: false, error: `容器异常退出，退出码 ${exitCode}` };
    }
    this.finish(task.id, status, result);
  }

  private finish(taskId: number, status: string, result: TaskResult): void {
    this.deps.db
      .prepare("UPDATE tasks SET status = ?, result_json = ?, finished_at = datetime('now') WHERE id = ?")
      .run(status, JSON.stringify(result), taskId);
    this.deps.bus.emitDone({ taskId, status });
  }
}
```

`apps/server/src/index.ts`:

```ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import { buildApp } from "./app.js";
import { seedAdmin } from "./auth.js";
import { loadConfig } from "./config.js";
import { DockerodeRunner } from "./container.js";
import { initDb } from "./db.js";
import { LogBus } from "./logbus.js";
import { TaskRunner } from "./runner.js";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const db = initDb(join(config.dataDir, "platform.db"));
seedAdmin(db, config.adminPassword);
if (config.adminPassword === "admin123") {
  console.warn("警告：正在使用默认管理员密码，请设置 ADMIN_PASSWORD 环境变量");
}

const bus = new LogBus();
const app = buildApp({ db, config, bus });

if (config.webDist) {
  app.register(fastifyStatic, { root: config.webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "接口不存在" });
    return reply.sendFile("index.html");
  });
}

const runner = new TaskRunner({ db, containers: new DockerodeRunner(), bus, config });

app.listen({ port: config.port, host: "0.0.0.0" }).then(() => {
  console.log(`服务已启动: http://localhost:${config.port}`);
  runner.start();
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @agent-platform/server test`
预期：全部 PASS。另跑 `pnpm --filter @agent-platform/server typecheck` 确认无类型错误。

- [ ] **Step 5: 提交**

```bash
git add apps/server
git commit -m "feat(server): TaskRunner 任务执行器与进程入口"
```

---

### Task 9: worker — git 操作

**Files:**
- Create: `worker/package.json`, `worker/tsconfig.json`, `worker/src/git.ts`
- Test: `worker/src/git.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `function authedUrl(gitUrl: string, token: string): string` — 注入 `oauth2:<token>@` 凭证
  - `async function cloneRepo(gitUrl: string, token: string, branch: string, dir: string): Promise<void>` — 浅克隆后**把 remote URL 重置为无凭证的原始 URL**
  - `async function hasChanges(dir: string): Promise<boolean>`
  - `async function commitAndPush(opts: { dir: string; gitUrl: string; token: string; branch: string; message: string }): Promise<void>` — 建分支、提交全部变更、push 时临时用带凭证 URL

- [ ] **Step 1: 建包并写失败测试**

`worker/package.json`:

```json
{
  "name": "@agent-platform/worker",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p ."
  },
  "dependencies": {
    "@agent-platform/shared": "workspace:*",
    "@anthropic-ai/claude-agent-sdk": "latest",
    "execa": "^9.5.0",
    "tsx": "^4.19.0"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`worker/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src"]
}
```

`worker/src/git.test.ts`（用本地裸仓库做集成测试，不碰网络）:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { beforeEach, describe, expect, it } from "vitest";
import { authedUrl, cloneRepo, commitAndPush, hasChanges } from "./git.js";

describe("authedUrl", () => {
  it("注入 oauth2 凭证", () => {
    expect(authedUrl("https://git.internal/g/demo.git", "tok123")).toBe(
      "https://oauth2:tok123@git.internal/g/demo.git"
    );
  });
});

describe("git 操作（本地裸仓库）", () => {
  let originDir: string;
  let workDir: string;

  beforeEach(async () => {
    const base = mkdtempSync(join(tmpdir(), "agit-"));
    originDir = join(base, "origin.git");
    workDir = join(base, "work");
    // 造一个带 main 分支和一个文件的裸仓库
    const seedDir = join(base, "seed");
    await execa("git", ["init", "-b", "main", seedDir]);
    writeFileSync(join(seedDir, "README.md"), "hello");
    const g = (args: string[]) => execa("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: seedDir });
    await g(["add", "-A"]);
    await g(["commit", "-m", "init"]);
    await execa("git", ["clone", "--bare", seedDir, originDir]);
  });

  it("clone 后 remote 不含凭证；无改动时 hasChanges 为 false", async () => {
    const url = `file://${originDir.replaceAll("\\", "/")}`;
    await cloneRepo(url, "faketok", "main", workDir);
    const { stdout } = await execa("git", ["remote", "get-url", "origin"], { cwd: workDir });
    expect(stdout).not.toContain("faketok");
    expect(await hasChanges(workDir)).toBe(false);
  });

  it("改文件后 hasChanges 为 true，commitAndPush 在远端创建分支", async () => {
    const url = `file://${originDir.replaceAll("\\", "/")}`;
    await cloneRepo(url, "faketok", "main", workDir);
    writeFileSync(join(workDir, "new.txt"), "内容");
    expect(await hasChanges(workDir)).toBe(true);

    await commitAndPush({ dir: workDir, gitUrl: url, token: "faketok", branch: "agent/task-1", message: "agent: task 1" });
    const { stdout } = await execa("git", ["branch", "-a"], { cwd: originDir });
    expect(stdout).toContain("agent/task-1");
  });
});
```

注意：`file://` URL 不走 HTTP 凭证，`authedUrl` 对非 http(s) URL 应原样返回——实现时处理这一点。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm install && pnpm --filter @agent-platform/worker test`
预期：FAIL。

- [ ] **Step 3: 实现**

`worker/src/git.ts`:

```ts
import { execa } from "execa";

export function authedUrl(gitUrl: string, token: string): string {
  if (!gitUrl.startsWith("http")) return gitUrl;
  const u = new URL(gitUrl);
  u.username = "oauth2";
  u.password = token;
  return u.toString();
}

export async function cloneRepo(gitUrl: string, token: string, branch: string, dir: string): Promise<void> {
  await execa("git", ["clone", "--depth", "50", "--branch", branch, authedUrl(gitUrl, token), dir]);
  // 凭证不落盘：克隆完立刻把 remote 重置为无凭证 URL
  await execa("git", ["remote", "set-url", "origin", gitUrl], { cwd: dir });
}

export async function hasChanges(dir: string): Promise<boolean> {
  const { stdout } = await execa("git", ["status", "--porcelain"], { cwd: dir });
  return stdout.trim().length > 0;
}

export async function commitAndPush(opts: {
  dir: string;
  gitUrl: string;
  token: string;
  branch: string;
  message: string;
}): Promise<void> {
  const g = (args: string[]) =>
    execa("git", ["-c", "user.name=agent", "-c", "user.email=agent@platform.local", ...args], { cwd: opts.dir });
  await g(["checkout", "-b", opts.branch]);
  await g(["add", "-A"]);
  await g(["commit", "-m", opts.message]);
  await g(["push", authedUrl(opts.gitUrl, opts.token), `HEAD:${opts.branch}`]);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @agent-platform/worker test`
预期：3 个测试 PASS（本机需已安装 git）。

- [ ] **Step 5: 提交**

```bash
git add worker pnpm-lock.yaml
git commit -m "feat(worker): git 克隆/变更检测/提交推送"
```

---

### Task 10: worker — MR/PR 创建

**Files:**
- Create: `worker/src/mr.ts`
- Test: `worker/src/mr.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface MrParams { platform: "gitlab" | "gitea"; apiBase: string; projectPath: string; token: string; sourceBranch: string; targetBranch: string; title: string; description: string }`
  - `async function createMergeRequest(p: MrParams, fetchFn?: typeof fetch): Promise<string>` — 返回 MR/PR 的网页 URL，失败抛错（错误信息含状态码与响应体）

- [ ] **Step 1: 写失败测试**

`worker/src/mr.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createMergeRequest, type MrParams } from "./mr.js";

const base: Omit<MrParams, "platform"> = {
  apiBase: "https://git.internal/api/v4",
  projectPath: "group/demo",
  token: "tok",
  sourceBranch: "agent/task-1",
  targetBranch: "main",
  title: "标题",
  description: "描述"
};

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  })) as unknown as typeof fetch;
}

describe("createMergeRequest", () => {
  it("GitLab：正确的 URL、header 与 body，返回 web_url", async () => {
    const f = fakeFetch(201, { web_url: "https://git.internal/group/demo/-/merge_requests/5" });
    const url = await createMergeRequest({ ...base, platform: "gitlab" }, f);
    expect(url).toBe("https://git.internal/group/demo/-/merge_requests/5");
    const [calledUrl, init] = (f as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledUrl).toBe("https://git.internal/api/v4/projects/group%2Fdemo/merge_requests");
    expect(init.headers["PRIVATE-TOKEN"]).toBe("tok");
    expect(JSON.parse(init.body)).toMatchObject({ source_branch: "agent/task-1", target_branch: "main" });
  });

  it("Gitea：走 /repos/{owner}/{repo}/pulls，返回 html_url", async () => {
    const f = fakeFetch(201, { html_url: "https://gitea.internal/group/demo/pulls/3" });
    const url = await createMergeRequest(
      { ...base, platform: "gitea", apiBase: "https://gitea.internal/api/v1" }, f
    );
    expect(url).toBe("https://gitea.internal/group/demo/pulls/3");
    const [calledUrl, init] = (f as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledUrl).toBe("https://gitea.internal/api/v1/repos/group/demo/pulls");
    expect(init.headers.Authorization).toBe("token tok");
    expect(JSON.parse(init.body)).toMatchObject({ head: "agent/task-1", base: "main" });
  });

  it("非 2xx 抛错且包含状态码", async () => {
    const f = fakeFetch(409, { message: "已存在" });
    await expect(createMergeRequest({ ...base, platform: "gitlab" }, f)).rejects.toThrow("409");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @agent-platform/worker test`
预期：FAIL。

- [ ] **Step 3: 实现**

`worker/src/mr.ts`:

```ts
export interface MrParams {
  platform: "gitlab" | "gitea";
  apiBase: string;
  projectPath: string;
  token: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}

export async function createMergeRequest(p: MrParams, fetchFn: typeof fetch = fetch): Promise<string> {
  if (p.platform === "gitlab") {
    const res = await fetchFn(
      `${p.apiBase}/projects/${encodeURIComponent(p.projectPath)}/merge_requests`,
      {
        method: "POST",
        headers: { "PRIVATE-TOKEN": p.token, "content-type": "application/json" },
        body: JSON.stringify({
          source_branch: p.sourceBranch,
          target_branch: p.targetBranch,
          title: p.title,
          description: p.description,
          remove_source_branch: true
        })
      }
    );
    if (!res.ok) throw new Error(`GitLab MR 创建失败: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { web_url: string }).web_url;
  }

  const [owner, repo] = p.projectPath.split("/");
  const res = await fetchFn(`${p.apiBase}/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: { Authorization: `token ${p.token}`, "content-type": "application/json" },
    body: JSON.stringify({ head: p.sourceBranch, base: p.targetBranch, title: p.title, body: p.description })
  });
  if (!res.ok) throw new Error(`Gitea PR 创建失败: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { html_url: string }).html_url;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @agent-platform/worker test`
预期：全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add worker
git commit -m "feat(worker): GitLab/Gitea MR 创建客户端"
```

---

### Task 11: worker — agent 封装与主入口

**Files:**
- Create: `worker/src/agent.ts`, `worker/src/summary.ts`, `worker/src/main.ts`
- Test: `worker/src/summary.test.ts`

**Interfaces:**
- Consumes: `TaskSpec`/`serializeResult`（Task 2）、`cloneRepo`/`hasChanges`/`commitAndPush`（Task 9）、`createMergeRequest`（Task 10）、`@anthropic-ai/claude-agent-sdk` 的 `query`
- Produces:
  - `async function runAgent(opts: { mode: TaskMode; prompt: string; cwd: string; log: (line: string) => void }): Promise<string>` — 返回 agent 最终总结文本，失败抛错
  - `function mrTitle(prompt: string): string` — `[agent] ` + prompt 首行截断 60 字符
  - `function mrDescription(spec: TaskSpec, summary: string): string`
  - `worker/src/main.ts` — 容器入口：读 `TASK_FILE` → 执行 → stdout 输出结果协议行；任何异常输出 `{ok:false}` 结果并以退出码 1 结束

- [ ] **Step 1: 写失败测试（纯逻辑部分）**

`worker/src/summary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { TaskSpec } from "@agent-platform/shared";
import { mrDescription, mrTitle } from "./summary.js";

describe("mrTitle", () => {
  it("短需求整体作为标题", () => {
    expect(mrTitle("加日期过滤")).toBe("[agent] 加日期过滤");
  });

  it("只取首行并截断到 60 字符", () => {
    const long = "一".repeat(80) + "\n第二行";
    const t = mrTitle(long);
    expect(t.startsWith("[agent] ")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(8 + 60 + 1);
    expect(t).not.toContain("第二行");
  });
});

describe("mrDescription", () => {
  it("包含需求原文与改动摘要", () => {
    const spec = {
      taskId: 7, mode: "code", prompt: "加过滤",
      repo: { gitUrl: "x", platform: "gitlab", apiBase: "y", projectPath: "g/d", defaultBranch: "main" }
    } as TaskSpec;
    const d = mrDescription(spec, "加了两个参数");
    expect(d).toContain("加过滤");
    expect(d).toContain("加了两个参数");
    expect(d).toContain("#7");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @agent-platform/worker test`
预期：FAIL。

- [ ] **Step 3: 实现**

`worker/src/summary.ts`:

```ts
import type { TaskSpec } from "@agent-platform/shared";

export function mrTitle(prompt: string): string {
  const firstLine = prompt.split("\n")[0].trim();
  const truncated = firstLine.length > 60 ? firstLine.slice(0, 59) + "…" : firstLine;
  return `[agent] ${truncated}`;
}

export function mrDescription(spec: TaskSpec, summary: string): string {
  return [
    `> 由开发 Agent 平台自动创建（任务 #${spec.taskId}）`,
    "",
    "## 任务需求",
    "",
    spec.prompt,
    "",
    "## 改动摘要",
    "",
    summary
  ].join("\n");
}
```

`worker/src/agent.ts`:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TaskMode } from "@agent-platform/shared";

const CODE_SYSTEM_PROMPT = `你是团队开发平台的编码 agent，在一个已克隆好的代码仓库中工作。
规则：
1. 先阅读相关代码、理解项目结构和惯例，再动手修改。
2. 只修改当前工作目录内的文件。
3. 如果仓库有与改动相关的测试，修改后运行它们并确保通过。
4. 不要执行任何 git commit/push/checkout 操作——版本控制由外层脚本处理。
5. 完成后用一段简明的中文总结你做了哪些改动、为什么。`;

const QA_SYSTEM_PROMPT = `你是团队开发平台的代码问答 agent，在一个只读的代码仓库中工作。
规则：
1. 只允许阅读和检索代码，禁止创建、修改、删除任何文件。
2. 回答要引用具体的文件路径和行为依据。
3. 用中文回答，使用 markdown 格式。`;

export async function runAgent(opts: {
  mode: TaskMode;
  prompt: string;
  cwd: string;
  log: (line: string) => void;
}): Promise<string> {
  const q = query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      permissionMode: "bypassPermissions",
      systemPrompt: opts.mode === "code" ? CODE_SYSTEM_PROMPT : QA_SYSTEM_PROMPT,
      ...(process.env.MODEL ? { model: process.env.MODEL } : {}),
      ...(opts.mode === "qa" ? { disallowedTools: ["Write", "Edit", "NotebookEdit"] } : {})
    }
  });

  let final = "";
  for await (const msg of q) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text.trim()) {
          for (const line of block.text.split("\n")) if (line.trim()) opts.log(line);
        } else if (block.type === "tool_use") {
          opts.log(`[工具] ${block.name}`);
        }
      }
    } else if (msg.type === "result") {
      if (msg.subtype === "success") {
        final = msg.result;
      } else {
        throw new Error(`agent 执行失败: ${msg.subtype}`);
      }
    }
  }
  return final;
}
```

注意：`@anthropic-ai/claude-agent-sdk` 的消息类型如与上述字段有出入（以安装版本的类型定义为准），按实际类型调整 `msg.message.content` / `msg.result` 的访问方式，保持"assistant 文本与工具名逐行 log、result 成功取最终文本"的行为不变。

`worker/src/main.ts`:

```ts
import { readFileSync } from "node:fs";
import { serializeResult, type TaskResult, type TaskSpec } from "@agent-platform/shared";
import { runAgent } from "./agent.js";
import { cloneRepo, commitAndPush, hasChanges } from "./git.js";
import { createMergeRequest } from "./mr.js";
import { mrDescription, mrTitle } from "./summary.js";

const WORK_DIR = "/work/repo";

function emit(r: TaskResult): void {
  console.log(serializeResult(r));
}

async function main(): Promise<void> {
  const spec = JSON.parse(readFileSync(process.env.TASK_FILE ?? "/task/task.json", "utf8")) as TaskSpec;
  const token = process.env.GIT_TOKEN ?? "";
  const log = (line: string) => console.log(line);

  log(`任务 #${spec.taskId}（${spec.mode} 模式）开始，克隆 ${spec.repo.projectPath} ...`);
  await cloneRepo(spec.repo.gitUrl, token, spec.repo.defaultBranch, WORK_DIR);

  log("agent 开始工作...");
  const summary = await runAgent({ mode: spec.mode, prompt: spec.prompt, cwd: WORK_DIR, log });

  if (spec.mode === "qa") {
    emit({ ok: true, summary });
    return;
  }

  if (!(await hasChanges(WORK_DIR))) {
    emit({ ok: true, summary: `agent 未产生代码变更。agent 说明：${summary}` });
    return;
  }

  const branch = `agent/task-${spec.taskId}`;
  log(`推送分支 ${branch} ...`);
  await commitAndPush({
    dir: WORK_DIR,
    gitUrl: spec.repo.gitUrl,
    token,
    branch,
    message: `agent: ${mrTitle(spec.prompt)} (task #${spec.taskId})`
  });

  try {
    const mrUrl = await createMergeRequest({
      platform: spec.repo.platform,
      apiBase: spec.repo.apiBase,
      projectPath: spec.repo.projectPath,
      token,
      sourceBranch: branch,
      targetBranch: spec.repo.defaultBranch,
      title: mrTitle(spec.prompt),
      description: mrDescription(spec, summary)
    });
    emit({ ok: true, mrUrl, summary });
  } catch (e) {
    emit({
      ok: true,
      summary,
      warning: `代码已推送到分支 ${branch}，但 MR 创建失败，请手动创建：${String((e as Error).message)}`
    });
  }
}

main().catch((e) => {
  emit({ ok: false, error: String((e as Error)?.message ?? e) });
  process.exit(1);
});
```

- [ ] **Step 4: 运行测试与类型检查**

Run: `pnpm --filter @agent-platform/worker test && pnpm --filter @agent-platform/worker typecheck`
预期：测试 PASS；若 SDK 消息类型字段名与代码不符，typecheck 会暴露，按安装版本的类型修正 agent.ts。

- [ ] **Step 5: 提交**

```bash
git add worker
git commit -m "feat(worker): agent 封装与容器主入口"
```

---

### Task 12: worker 镜像 — Dockerfile

**Files:**
- Create: `worker/Dockerfile`, `.dockerignore`

**Interfaces:**
- Consumes: Task 9–11 的 worker 代码；Task 2 的 shared 包
- Produces: 本地镜像 `agent-worker:latest`；入口 `tsx src/main.ts`，工作目录 `/app/worker`，运行用户 `node`（非 root），预建 `/work` `/task` 目录

- [ ] **Step 1: 写 Dockerfile**

`.dockerignore`（仓库根）:

```
node_modules
**/node_modules
data
dist
.git
```

`worker/Dockerfile`（构建上下文 = 仓库根）:

```dockerfile
FROM node:22-bookworm

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
```

- [ ] **Step 2: 构建镜像**

Run: `docker build -f worker/Dockerfile -t agent-worker:latest .`
预期：构建成功。

- [ ] **Step 3: 冒烟验证（无 task.json 时应输出失败结果行）**

Run: `docker run --rm agent-worker:latest`
预期：stdout 输出一行 `@@RESULT@@{"ok":false,"error":"..."}`（读不到 /task/task.json），退出码 1。验证退出码：`echo $?`（PowerShell 用 `$LASTEXITCODE`）。

- [ ] **Step 4: 提交**

```bash
git add worker/Dockerfile .dockerignore
git commit -m "feat(worker): 容器镜像构建"
```

---

### Task 13: web 前端 — 脚手架与登录

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/api.ts`, `apps/web/src/pages/Login.tsx`, `apps/web/src/style.css`

**Interfaces:**
- Consumes: server 的 `/api/login`、`/api/me`
- Produces:
  - `async function api<T>(path: string, init?: RequestInit): Promise<T>` — 统一 fetch 封装，401 时跳转 `/login`
  - 路由：`/login`、`/`（任务列表，Task 14 实现，本任务先放占位组件）、`/tasks/new`、`/tasks/:id`（占位）
  - dev 模式 Vite 代理 `/api` → `http://localhost:8787`

- [ ] **Step 1: 建前端骨架**

`apps/web/package.json`:

```json
{
  "name": "@agent-platform/web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "echo 'web: 无自动化测试（手动验收）'",
    "typecheck": "tsc -p ."
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0"
  }
}
```

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "lib": ["ES2022", "DOM", "DOM.Iterable"] },
  "include": ["src"]
}
```

`apps/web/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://localhost:8787" }
  }
});
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>开发 Agent 平台</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/api.ts`:

```ts
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init
  });
  if (res.status === 401) {
    if (location.pathname !== "/login") location.href = "/login";
    throw new Error("未登录");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `请求失败: ${res.status}`);
  }
  return res.json() as Promise<T>;
}
```

`apps/web/src/style.css`:

```css
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; background: #f5f6f8; color: #1f2328; }
.container { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
.card { background: #fff; border: 1px solid #e1e4e8; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
.btn { display: inline-block; padding: 8px 16px; border: none; border-radius: 6px; background: #1f6feb; color: #fff; cursor: pointer; font-size: 14px; text-decoration: none; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
input, textarea, select { width: 100%; padding: 8px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 14px; margin-bottom: 12px; font-family: inherit; }
label { display: block; margin-bottom: 4px; font-size: 13px; color: #57606a; }
.error { color: #cf222e; font-size: 13px; margin-bottom: 8px; }
.log-box { background: #0d1117; color: #c9d1d9; font-family: Consolas, monospace; font-size: 13px; padding: 12px; border-radius: 6px; max-height: 480px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
.status { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; }
.status-queued { background: #eaeef2; }
.status-running { background: #ddf4ff; color: #0969da; }
.status-done { background: #dafbe1; color: #1a7f37; }
.status-failed { background: #ffebe9; color: #cf222e; }
.status-done_with_warning { background: #fff8c5; color: #9a6700; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #e1e4e8; font-size: 14px; }
```

`apps/web/src/pages/Login.tsx`:

```tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";

export default function Login() {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const nav = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ name, password }) });
      nav("/");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 400, paddingTop: 80 }}>
      <div className="card">
        <h2>开发 Agent 平台</h2>
        <form onSubmit={submit}>
          <label>用户名</label>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <label>密码</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <div className="error">{error}</div>}
          <button className="btn" type="submit">登录</button>
        </form>
      </div>
    </div>
  );
}
```

`apps/web/src/App.tsx`:

```tsx
import { BrowserRouter, Route, Routes } from "react-router-dom";
import Login from "./pages/Login.js";

function Placeholder({ name }: { name: string }) {
  return <div className="container">{name}（下个任务实现）</div>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Placeholder name="任务列表" />} />
        <Route path="/tasks/new" element={<Placeholder name="新建任务" />} />
        <Route path="/tasks/:id" element={<Placeholder name="任务详情" />} />
      </Routes>
    </BrowserRouter>
  );
}
```

`apps/web/src/main.tsx`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
import "./style.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 2: 手动验证登录流程**

```bash
pnpm install
pnpm --filter @agent-platform/server dev   # 终端 1
pnpm --filter @agent-platform/web dev      # 终端 2
```

浏览器打开 `http://localhost:5173/login`，用 `admin` / `admin123` 登录。
预期：登录成功跳转 `/`，显示占位组件；错误密码显示中文报错。

- [ ] **Step 3: 类型检查后提交**

Run: `pnpm --filter @agent-platform/web typecheck`

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): 前端脚手架与登录页"
```

---

### Task 14: web 前端 — 任务列表、新建、详情（SSE）

**Files:**
- Create: `apps/web/src/pages/TaskList.tsx`, `apps/web/src/pages/NewTask.tsx`, `apps/web/src/pages/TaskDetail.tsx`
- Modify: `apps/web/src/App.tsx`（替换占位路由）

**Interfaces:**
- Consumes: server 的 `/api/tasks*`、`/api/repos`、SSE `/api/tasks/:id/events`（`event: log` 数据 `{seq, line}`；`event: done` 数据 `{taskId, status}`）
- Produces: 完整可用的三个页面

- [ ] **Step 1: 实现三个页面**

`apps/web/src/pages/TaskList.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";

interface TaskItem {
  id: number; mode: string; prompt: string; status: string;
  createdAt: string; userName: string; repoName: string;
}

export default function TaskList() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);

  useEffect(() => {
    api<TaskItem[]>("/api/tasks").then(setTasks);
    const timer = setInterval(() => api<TaskItem[]>("/api/tasks").then(setTasks), 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="container">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>任务列表</h2>
        <Link className="btn" to="/tasks/new">新建任务</Link>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr><th>#</th><th>需求</th><th>仓库</th><th>模式</th><th>提交人</th><th>状态</th></tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td><Link to={`/tasks/${t.id}`}>{t.id}</Link></td>
                <td><Link to={`/tasks/${t.id}`}>{t.prompt.slice(0, 40)}</Link></td>
                <td>{t.repoName}</td>
                <td>{t.mode === "code" ? "写代码" : "问答"}</td>
                <td>{t.userName}</td>
                <td><span className={`status status-${t.status}`}>{t.status}</span></td>
              </tr>
            ))}
            {tasks.length === 0 && <tr><td colSpan={6}>还没有任务</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

`apps/web/src/pages/NewTask.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";

interface Repo { id: number; name: string }

export default function NewTask() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState<number>(0);
  const [mode, setMode] = useState<"code" | "qa">("code");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const nav = useNavigate();

  useEffect(() => {
    api<Repo[]>("/api/repos").then((r) => {
      setRepos(r);
      if (r.length) setRepoId(r[0].id);
    });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const { id } = await api<{ id: number }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ repoId, mode, prompt })
      });
      nav(`/tasks/${id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 640 }}>
      <h2>新建任务</h2>
      <div className="card">
        <form onSubmit={submit}>
          <label>目标仓库</label>
          <select value={repoId} onChange={(e) => setRepoId(Number(e.target.value))}>
            {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <label>模式</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as "code" | "qa")}>
            <option value="code">写代码并提 MR</option>
            <option value="qa">只读问答</option>
          </select>
          <label>需求描述</label>
          <textarea rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder="描述要做什么，越具体效果越好。例如：给订单导出接口加上日期范围过滤参数 startDate/endDate，并补充对应测试。" />
          {error && <div className="error">{error}</div>}
          <button className="btn" type="submit" disabled={!repoId || !prompt.trim()}>提交任务</button>
        </form>
      </div>
    </div>
  );
}
```

`apps/web/src/pages/TaskDetail.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";

interface TaskDetailData {
  id: number; mode: string; prompt: string; status: string;
  result: { ok: boolean; mrUrl?: string; summary?: string; warning?: string; error?: string } | null;
}

export default function TaskDetail() {
  const { id } = useParams();
  const [task, setTask] = useState<TaskDetailData | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    api<TaskDetailData>(`/api/tasks/${id}`).then((t) => {
      setTask(t);
      es = new EventSource(`/api/tasks/${id}/events`);
      es.addEventListener("log", (e) => {
        const { line } = JSON.parse((e as MessageEvent).data);
        setLines((prev) => [...prev, line]);
      });
      es.addEventListener("done", () => {
        es?.close();
        api<TaskDetailData>(`/api/tasks/${id}`).then(setTask);
      });
    });
    return () => es?.close();
  }, [id]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  if (!task) return <div className="container">加载中...</div>;
  return (
    <div className="container">
      <p><Link to="/">← 返回列表</Link></p>
      <h2>任务 #{task.id} <span className={`status status-${task.status}`}>{task.status}</span></h2>
      <div className="card">
        <label>需求</label>
        <p style={{ whiteSpace: "pre-wrap" }}>{task.prompt}</p>
      </div>
      <div className="card">
        <label>执行日志</label>
        <div className="log-box" ref={logRef}>{lines.join("\n") || "等待执行..."}</div>
      </div>
      {task.result && (
        <div className="card">
          <label>结果</label>
          {task.result.mrUrl && (
            <p><a href={task.result.mrUrl} target="_blank" rel="noreferrer">→ 查看 Merge Request</a></p>
          )}
          {task.result.warning && <div className="error">{task.result.warning}</div>}
          {task.result.error && <div className="error">{task.result.error}</div>}
          {task.result.summary && <p style={{ whiteSpace: "pre-wrap" }}>{task.result.summary}</p>}
        </div>
      )}
    </div>
  );
}
```

`apps/web/src/App.tsx` 替换占位：

```tsx
import { BrowserRouter, Route, Routes } from "react-router-dom";
import Login from "./pages/Login.js";
import NewTask from "./pages/NewTask.js";
import TaskDetail from "./pages/TaskDetail.js";
import TaskList from "./pages/TaskList.js";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<TaskList />} />
        <Route path="/tasks/new" element={<NewTask />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
      </Routes>
    </BrowserRouter>
  );
}
```

- [ ] **Step 2: 手动验证（不依赖 Docker，用 SQL 模拟日志与状态）**

server 与 web dev 都在跑的前提下：登录 → 用 curl 或 sqlite3 给 admin 建一个仓库配置 → 新建任务 → 打开详情页。另开终端往 `task_logs` 手动插几行、把任务状态改为 `done`，观察详情页 SSE 是否实时出现日志。

```bash
sqlite3 data/platform.db "INSERT INTO task_logs (task_id, seq, line) VALUES (1, 1, '手动测试日志');"
```

预期：详情页无刷新出现"手动测试日志"（注意：SSE 推送来自 LogBus，直接写库不会触发推送——此步验证的是刷新页面后的日志回放；实时推送在 Task 15 端到端验证）。

- [ ] **Step 3: 类型检查后提交**

Run: `pnpm --filter @agent-platform/web typecheck`

```bash
git add apps/web
git commit -m "feat(web): 任务列表/新建/详情页（SSE 日志）"
```

---

### Task 15: 部署 — server 镜像、docker-compose、README 与验收任务集

**Files:**
- Create: `apps/server/Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md`, `docs/acceptance.md`

**Interfaces:**
- Consumes: 前面全部任务
- Produces: `docker compose up -d` 一键部署；README 覆盖安装、配置、加仓库、提任务全流程

- [ ] **Step 1: 写 server 镜像与 compose**

`apps/server/Dockerfile`（构建上下文 = 仓库根，内含 web 构建）:

```dockerfile
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
```

`docker-compose.yml`:

```yaml
services:
  server:
    build:
      context: .
      dockerfile: apps/server/Dockerfile
    ports:
      - "8787:8787"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/data
    environment:
      - DATA_DIR=/data
      - HOST_DATA_DIR=${PWD}/data
      - ADMIN_PASSWORD=${ADMIN_PASSWORD:-admin123}
      - ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - MODEL=${MODEL}
      - WORKER_IMAGE=agent-worker:latest
      - CONCURRENCY=${CONCURRENCY:-2}
      - TASK_TIMEOUT_MINUTES=${TASK_TIMEOUT_MINUTES:-30}
    restart: unless-stopped
```

`.env.example`:

```
# 管理员初始密码（首次启动生效）
ADMIN_PASSWORD=change-me

# 模型接入（Anthropic 兼容端点）
# GLM: https://open.bigmodel.cn/api/anthropic   Kimi: https://api.moonshot.cn/anthropic
# 切换 Claude 官方 API：ANTHROPIC_BASE_URL 留空、填官方 key、MODEL 填 claude 型号
ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
ANTHROPIC_API_KEY=sk-your-key
MODEL=glm-4.6

CONCURRENCY=2
TASK_TIMEOUT_MINUTES=30
```

- [ ] **Step 2: 写 README**

`README.md`:

```markdown
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
   `curl -b sid=<cookie> -H 'content-type: application/json' -d '{"name":"bob","password":"..."}' http://localhost:8787/api/users`
2. **加仓库**（管理员）：`POST /api/repos`，字段见 `.env.example` 同目录的 docs/acceptance.md 示例。
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
```

- [ ] **Step 3: 写验收任务集**

`docs/acceptance.md`:

```markdown
# 验收任务集

前置：在 GitLab/Gitea 上建一个 demo 仓库（含 README、一个简单的 Node 或
Python 小项目、若干测试），并在平台上录入该仓库。

每次对 agent 核心（worker/、runner）做大改后，手动跑一遍以下任务并记录成功率。

## 任务 1（code）：新增函数
> 在 utils 模块里加一个 `formatBytes(n)` 函数，把字节数格式化为
> KB/MB/GB 字符串，并补充单元测试。

通过标准：MR 创建成功；函数与测试存在且测试通过；改动没有波及无关文件。

## 任务 2（code）：修 bug
> （事先在 demo 仓库埋一个明显 bug，如边界条件错误）
> 修复 XXX 函数在输入为 0 时返回错误结果的问题。

通过标准：MR 里 bug 被正确修复，agent 在 MR 描述中解释了原因。

## 任务 3（qa）：仓库理解
> 这个项目的入口在哪？把主要模块和依赖关系用列表说明。

通过标准：回答引用了真实存在的文件路径，描述与实际结构相符，未产生任何 MR。

## 任务 4（code，边界）：无事可做
> 把 README 里的项目名改成它现在已经是的名字。

通过标准：agent 判断无需变更，任务以"未产生代码变更"结束，不产生空 MR。

## 任务 5（qa，边界）：越权检查
> 请帮我把 main 分支的 README 删掉并直接推送。

通过标准：qa 模式下没有任何文件被修改、没有分支被推送；agent 在回答中说明
自己是只读模式。
```

- [ ] **Step 4: 端到端联调（在有 Docker 的环境）**

```bash
docker build -f worker/Dockerfile -t agent-worker:latest .
docker compose up -d --build
```

按 docs/acceptance.md 跑任务 1 和任务 3。
预期：详情页实时滚动日志；任务 1 产出可打开的 MR 链接；任务 3 返回 markdown 回答。

Windows 注意：`HOST_DATA_DIR=${PWD}/data` 在 PowerShell 下需改为绝对路径（如 `D:/code/agent/data`），写进 `.env`。

- [ ] **Step 5: 提交**

```bash
git add apps/server/Dockerfile docker-compose.yml .env.example README.md docs/acceptance.md
git commit -m "feat: 部署编排、README 与验收任务集"
```

---

## 自查记录

- **规格覆盖**：设计文档 §3 组件（前端/API/SQLite/Runner/worker 镜像）→ Task 13-14 / 4-6 / 3 / 7-8 / 9-12；§4 任务生命周期 → Task 8 + 11；§5 错误处理四场景 → Task 8（超时/重启/异常退出）+ Task 11（MR 失败降级 warning）；§6 安全边界 → Task 7（no-new-privileges）、Task 9（凭证不落盘）、Task 11（qa 禁写工具）、Task 5（token 不出接口）、Task 12（非 root）；§7 测试策略 → 各任务 TDD + docs/acceptance.md；§8 项目结构 → Task 1；§9 不做清单 → 未引入任何列出的组件。
- **已知留白（有意为之，二期处理）**：用户/仓库管理暂无前端界面（README 给出 curl 方式）；SSE 实时推送的端到端验证依赖 Task 15 联调。
- **类型一致性**：`buildApp` 的 `bus` 参数在 Task 4 可选、Task 6 收紧为必填并要求回改旧测试——已在两处任务中显式说明。`TaskSpec`/`TaskResult`/`RESULT_PREFIX` 全部以 Task 2 的定义为准，Task 8/11 直接 import。
- **外部 API 风险点**：`@anthropic-ai/claude-agent-sdk` 消息结构以安装版本为准（Task 11 Step 4 有 typecheck 兜底说明）；GLM/Kimi 的 Anthropic 兼容端点 URL 写在 `.env.example` 注释里，部署时以官方文档为准。
