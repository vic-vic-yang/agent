import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("无环境变量时给出默认值", () => {
    const c = loadConfig({});
    expect(c.port).toBe(8787);
    expect(c.concurrency).toBe(2);
    expect(c.taskTimeoutMs).toBe(30 * 60 * 1000);
    expect(c.workerImage).toBe("agent-worker:latest");
    expect(c.hostDataDir).toBe(c.dataDir);
  });

  it("从环境变量读取覆盖值", () => {
    const c = loadConfig({
      PORT: "9000",
      DATA_DIR: "/data",
      HOST_DATA_DIR: "/srv/agent/data",
      CONCURRENCY: "3",
      TASK_TIMEOUT_MINUTES: "10",
      ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
      ANTHROPIC_API_KEY: "sk-x",
      MODEL: "glm-4.6"
    });
    expect(c.port).toBe(9000);
    expect(c.hostDataDir).toBe("/srv/agent/data");
    expect(c.taskTimeoutMs).toBe(600000);
    expect(c.model).toBe("glm-4.6");
  });
});
