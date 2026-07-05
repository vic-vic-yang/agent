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

  it("容器执行时带上可识别任务的标签", async () => {
    let seen: ContainerRunSpec | undefined;
    const runner = makeRunner(
      fakeRunner(async (spec) => {
        seen = spec;
        spec.onLine(serializeResult({ ok: true, summary: "ok" }));
        return { exitCode: 0, timedOut: false };
      })
    );
    await runner.tick();
    expect(seen?.labels?.["agent-platform.task"]).toBe("1");
  });
});
