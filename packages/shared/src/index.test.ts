import { describe, expect, it } from "vitest";
import { parseResultLine, RESULT_PREFIX, serializeResult, type TaskResult } from "./index.js";

describe("任务结果协议", () => {
  it("序列化后可解析回原值", () => {
    const r: TaskResult = { ok: true, mrUrl: "https://git.internal/mr/1", summary: "加了过滤" };
    const line = serializeResult(r);
    expect(line.startsWith(RESULT_PREFIX)).toBe(true);
    expect(line).not.toContain("\n");
    expect(parseResultLine(line)).toEqual(r);
  });

  it("普通日志行返回 null", () => {
    expect(parseResultLine("正在克隆仓库...")).toBeNull();
    expect(parseResultLine('{"ok":true}')).toBeNull();
  });

  it("前缀后 JSON 非法时返回 null", () => {
    expect(parseResultLine(`${RESULT_PREFIX}{oops`)).toBeNull();
  });
});
