export interface MrParams {
  platform: "gitlab" | "gitea";
  apiBase: string;
  projectPath: string;
  token: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}

export async function createMergeRequest(p: MrParams, fetchFn: typeof fetch = fetch): Promise<string> {
  if (p.platform === "gitlab") {
    const res = await fetchFn(
      `${p.apiBase}/projects/${encodeURIComponent(p.projectPath)}/merge_requests`,
      {
        method: "POST",
        headers: { "PRIVATE-TOKEN": p.token, "content-type": "application/json" },
        body: JSON.stringify({
          source_branch: p.sourceBranch,
          target_branch: p.targetBranch,
          title: p.title,
          description: p.description,
          remove_source_branch: true
        })
      }
    );
    if (!res.ok) throw new Error(`GitLab MR 创建失败: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { web_url: string }).web_url;
  }

  const [owner, repo] = p.projectPath.split("/");
  const res = await fetchFn(`${p.apiBase}/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: { Authorization: `token ${p.token}`, "content-type": "application/json" },
    body: JSON.stringify({ head: p.sourceBranch, base: p.targetBranch, title: p.title, body: p.description })
  });
  if (!res.ok) throw new Error(`Gitea PR 创建失败: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { html_url: string }).html_url;
}
