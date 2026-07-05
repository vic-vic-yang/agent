import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { beforeEach, describe, expect, it } from "vitest";
import { authedUrl, cloneRepo, commitAndPush, hasChanges } from "./git.js";

describe("authedUrl", () => {
  it("注入 oauth2 凭证", () => {
    expect(authedUrl("https://git.internal/g/demo.git", "tok123")).toBe(
      "https://oauth2:tok123@git.internal/g/demo.git"
    );
  });

  it("非 http URL 原样返回", () => {
    expect(authedUrl("file:///tmp/x.git", "tok")).toBe("file:///tmp/x.git");
  });
});

describe("git 操作（本地裸仓库）", () => {
  let originDir: string;
  let workDir: string;

  beforeEach(async () => {
    const base = mkdtempSync(join(tmpdir(), "agit-"));
    originDir = join(base, "origin.git");
    workDir = join(base, "work");
    const seedDir = join(base, "seed");
    await execa("git", ["init", "-b", "main", seedDir]);
    writeFileSync(join(seedDir, "README.md"), "hello");
    const g = (args: string[]) => execa("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: seedDir });
    await g(["add", "-A"]);
    await g(["commit", "-m", "init"]);
    await execa("git", ["clone", "--bare", seedDir, originDir]);
  });

  it("clone 后 remote 不含凭证；无改动时 hasChanges 为 false", async () => {
    const url = `file://${originDir.replaceAll("\\", "/")}`;
    await cloneRepo(url, "faketok", "main", workDir);
    const { stdout } = await execa("git", ["remote", "get-url", "origin"], { cwd: workDir });
    expect(stdout).not.toContain("faketok");
    expect(await hasChanges(workDir)).toBe(false);
  });

  it("改文件后 hasChanges 为 true，commitAndPush 在远端创建分支", async () => {
    const url = `file://${originDir.replaceAll("\\", "/")}`;
    await cloneRepo(url, "faketok", "main", workDir);
    writeFileSync(join(workDir, "new.txt"), "内容");
    expect(await hasChanges(workDir)).toBe(true);

    await commitAndPush({ dir: workDir, gitUrl: url, token: "faketok", branch: "agent/task-1", message: "agent: task 1" });
    const { stdout } = await execa("git", ["branch", "-a"], { cwd: originDir });
    expect(stdout).toContain("agent/task-1");
  });
});
