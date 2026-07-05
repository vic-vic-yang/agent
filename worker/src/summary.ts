import type { TaskSpec } from "@agent-platform/shared";

export function mrTitle(prompt: string): string {
  const firstLine = prompt.split("\n")[0].trim();
  const truncated = firstLine.length > 60 ? firstLine.slice(0, 59) + "…" : firstLine;
  return `[agent] ${truncated}`;
}

export function mrDescription(spec: TaskSpec, summary: string): string {
  return [
    `> 由开发 Agent 平台自动创建（任务 #${spec.taskId}）`,
    "",
    "## 任务需求",
    "",
    spec.prompt,
    "",
    "## 改动摘要",
    "",
    summary
  ].join("\n");
}
