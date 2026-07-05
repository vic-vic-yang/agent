export type TaskMode = "code" | "qa";
export type TaskStatus = "queued" | "running" | "done" | "failed" | "done_with_warning";

export interface RepoInfo {
  gitUrl: string;
  platform: "gitlab" | "gitea";
  apiBase: string;
  projectPath: string;
  defaultBranch: string;
}

export interface TaskSpec {
  taskId: number;
  mode: TaskMode;
  prompt: string;
  repo: RepoInfo;
}

export type TaskResult =
  | { ok: true; mrUrl?: string; summary: string; warning?: string }
  | { ok: false; error: string };

export const RESULT_PREFIX = "@@RESULT@@";

export function serializeResult(r: TaskResult): string {
  return RESULT_PREFIX + JSON.stringify(r);
}

export function parseResultLine(line: string): TaskResult | null {
  if (!line.startsWith(RESULT_PREFIX)) return null;
  try {
    return JSON.parse(line.slice(RESULT_PREFIX.length)) as TaskResult;
  } catch {
    return null;
  }
}
