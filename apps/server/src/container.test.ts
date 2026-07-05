import { describe, expect, it } from "vitest";
import { createLineSplitter } from "./container.js";

describe("createLineSplitter", () => {
  it("跨 chunk 的行会被正确拼接", async () => {
    const lines: string[] = [];
    const w = createLineSplitter((l) => lines.push(l));
    w.write(Buffer.from("正在克"));
    w.write(Buffer.from("隆仓库\n第二行\n第三"));
    w.end(Buffer.from("行"));
    await new Promise((r) => w.on("finish", r));
    expect(lines).toEqual(["正在克隆仓库", "第二行", "第三行"]);
  });

  it("忽略空行", async () => {
    const lines: string[] = [];
    const w = createLineSplitter((l) => lines.push(l));
    w.end(Buffer.from("a\n\n\nb\n"));
    await new Promise((r) => w.on("finish", r));
    expect(lines).toEqual(["a", "b"]);
  });
});
