import { describe, expect, it } from "vitest";
import { LogBus } from "./logbus.js";

describe("LogBus", () => {
  it("按 taskId 分发，退订后不再收到", () => {
    const bus = new LogBus();
    const got: string[] = [];
    const off = bus.onLine(1, (e) => got.push(e.line));
    bus.onLine(2, (e) => got.push("其他任务:" + e.line));

    bus.emitLine({ taskId: 1, seq: 1, line: "a" });
    bus.emitLine({ taskId: 2, seq: 1, line: "b" });
    off();
    bus.emitLine({ taskId: 1, seq: 2, line: "c" });

    expect(got).toEqual(["a", "其他任务:b"]);
  });

  it("done 事件同样按 taskId 分发", () => {
    const bus = new LogBus();
    const got: string[] = [];
    bus.onDone(5, (e) => got.push(e.status));
    bus.emitDone({ taskId: 5, status: "done" });
    bus.emitDone({ taskId: 6, status: "failed" });
    expect(got).toEqual(["done"]);
  });
});
