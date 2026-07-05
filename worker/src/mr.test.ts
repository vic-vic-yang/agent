import { describe, expect, it, vi } from "vitest";
import { createMergeRequest, type MrParams } from "./mr.js";

const base: Omit<MrParams, "platform"> = {
  apiBase: "https://git.internal/api/v4",
  projectPath: "group/demo",
  token: "tok",
  sourceBranch: "agent/task-1",
  targetBranch: "main",
  title: "标题",
  description: "描述"
};

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  })) as unknown as typeof fetch;
}

describe("createMergeRequest", () => {
  it("GitLab：正确的 URL、header 与 body，返回 web_url", async () => {
    const f = fakeFetch(201, { web_url: "https://git.internal/group/demo/-/merge_requests/5" });
    const url = await createMergeRequest({ ...base, platform: "gitlab" }, f);
    expect(url).toBe("https://git.internal/group/demo/-/merge_requests/5");
    const [calledUrl, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledUrl).toBe("https://git.internal/api/v4/projects/group%2Fdemo/merge_requests");
    expect(init.headers["PRIVATE-TOKEN"]).toBe("tok");
    expect(JSON.parse(init.body)).toMatchObject({ source_branch: "agent/task-1", target_branch: "main" });
  });

  it("Gitea：走 /repos/{owner}/{repo}/pulls，返回 html_url", async () => {
    const f = fakeFetch(201, { html_url: "https://gitea.internal/group/demo/pulls/3" });
    const url = await createMergeRequest(
      { ...base, platform: "gitea", apiBase: "https://gitea.internal/api/v1" }, f
    );
    expect(url).toBe("https://gitea.internal/group/demo/pulls/3");
    const [calledUrl, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledUrl).toBe("https://gitea.internal/api/v1/repos/group/demo/pulls");
    expect(init.headers.Authorization).toBe("token tok");
    expect(JSON.parse(init.body)).toMatchObject({ head: "agent/task-1", base: "main" });
  });

  it("非 2xx 抛错且包含状态码", async () => {
    const f = fakeFetch(409, { message: "已存在" });
    await expect(createMergeRequest({ ...base, platform: "gitlab" }, f)).rejects.toThrow("409");
  });
});
