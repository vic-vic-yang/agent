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

main().catch((e: unknown) => {
  emit({ ok: false, error: String((e as Error)?.message ?? e) });
  process.exit(1);
});
