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
