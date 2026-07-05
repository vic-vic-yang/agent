import { describe, expect, it } from "vitest";
import type { TaskSpec } from "@agent-platform/shared";
import { mrDescription, mrTitle } from "./summary.js";

describe("mrTitle", () => {
  it("短需求整体作为标题", () => {
    expect(mrTitle("加日期过滤")).toBe("[agent] 加日期过滤");
  });

  it("只取首行并截断到 60 字符", () => {
    const long = "一".repeat(80) + "\n第二行";
    const t = mrTitle(long);
    expect(t.startsWith("[agent] ")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(8 + 60 + 1);
    expect(t).not.toContain("第二行");
  });
});

describe("mrDescription", () => {
  it("包含需求原文与改动摘要", () => {
    const spec = {
      taskId: 7, mode: "code", prompt: "加过滤",
      repo: { gitUrl: "x", platform: "gitlab", apiBase: "y", projectPath: "g/d", defaultBranch: "main" }
    } as TaskSpec;
    const d = mrDescription(spec, "加了两个参数");
    expect(d).toContain("加过滤");
    expect(d).toContain("加了两个参数");
    expect(d).toContain("#7");
  });
});
