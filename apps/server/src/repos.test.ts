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
