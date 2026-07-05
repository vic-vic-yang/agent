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
            .catch((e: unknown) =>
              this.finish(task.id, "failed", { ok: false, error: String((e as Error)?.message ?? e) })
            )
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

    const finalResult = result as TaskResult | null;
    let status: string;
    let stored: TaskResult;
    if (timedOut) {
      status = "failed";
      stored = { ok: false, error: `任务超时（${config.taskTimeoutMs / 60000} 分钟），已强制终止` };
    } else if (finalResult?.ok) {
      status = finalResult.warning ? "done_with_warning" : "done";
      stored = finalResult;
    } else {
      status = "failed";
      stored = finalResult ?? { ok: false, error: `容器异常退出，退出码 ${exitCode}` };
    }
    this.finish(task.id, status, stored);
  }

  private finish(taskId: number, status: string, result: TaskResult): void {
    this.deps.db
      .prepare("UPDATE tasks SET status = ?, result_json = ?, finished_at = datetime('now') WHERE id = ?")
      .run(status, JSON.stringify(result), taskId);
    this.deps.bus.emitDone({ taskId, status });
  }
}
