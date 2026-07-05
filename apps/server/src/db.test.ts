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
