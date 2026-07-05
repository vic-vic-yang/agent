import { execa } from "execa";

export function authedUrl(gitUrl: string, token: string): string {
  if (!gitUrl.startsWith("http")) return gitUrl;
  const u = new URL(gitUrl);
  u.username = "oauth2";
  u.password = token;
  return u.toString();
}

export async function cloneRepo(gitUrl: string, token: string, branch: string, dir: string): Promise<void> {
  await execa("git", ["clone", "--depth", "50", "--branch", branch, authedUrl(gitUrl, token), dir]);
  // 凭证不落盘：克隆完立刻把 remote 重置为无凭证 URL
  await execa("git", ["remote", "set-url", "origin", gitUrl], { cwd: dir });
}

export async function hasChanges(dir: string): Promise<boolean> {
  const { stdout } = await execa("git", ["status", "--porcelain"], { cwd: dir });
  return stdout.trim().length > 0;
}

export async function commitAndPush(opts: {
  dir: string;
  gitUrl: string;
  token: string;
  branch: string;
  message: string;
}): Promise<void> {
  const g = (args: string[]) =>
    execa("git", ["-c", "user.name=agent", "-c", "user.email=agent@platform.local", ...args], { cwd: opts.dir });
  await g(["checkout", "-b", opts.branch]);
  await g(["add", "-A"]);
  await g(["commit", "-m", opts.message]);
  await g(["push", authedUrl(opts.gitUrl, opts.token), `HEAD:${opts.branch}`]);
}
