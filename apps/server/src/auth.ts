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
