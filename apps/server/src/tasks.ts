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
    const cleanup = () => {
      offLine();
      offDone();
    };
    // 补发订阅建立前的空窗期日志
    lastSeq = replay(lastSeq);

    req.raw.on("close", cleanup);
  });
}
