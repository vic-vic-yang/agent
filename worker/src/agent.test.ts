import { describe, expect, it } from "vitest";
import { disallowedToolsFor } from "./agent.js";

describe("disallowedToolsFor", () => {
  it("qa 模式禁用所有写与命令执行工具（含 Bash）", () => {
    const tools = disallowedToolsFor("qa");
    expect(tools).toContain("Write");
    expect(tools).toContain("Edit");
    expect(tools).toContain("NotebookEdit");
    expect(tools).toContain("Bash");
  });

  it("code 模式不禁用工具", () => {
    expect(disallowedToolsFor("code")).toEqual([]);
  });
});
