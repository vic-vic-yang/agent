import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { seedAdmin } from "./auth.js";
import { initDb, type DB } from "./db.js";
import { loadConfig } from "./config.js";
import { LogBus } from "./logbus.js";

let db: DB;
let app: FastifyInstance;

beforeEach(async () => {
  db = initDb(":memory:");
  seedAdmin(db, "admin123");
  app = buildApp({ db, config: loadConfig({}), bus: new LogBus() });
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
