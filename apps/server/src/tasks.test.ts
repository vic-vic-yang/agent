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
