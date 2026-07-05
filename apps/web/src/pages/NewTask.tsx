import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";

interface Repo { id: number; name: string }

export default function NewTask() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState<number>(0);
  const [mode, setMode] = useState<"code" | "qa">("code");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const nav = useNavigate();

  useEffect(() => {
    api<Repo[]>("/api/repos").then((r) => {
      setRepos(r);
      if (r.length) setRepoId(r[0].id);
    });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const { id } = await api<{ id: number }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ repoId, mode, prompt })
      });
      nav(`/tasks/${id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 640 }}>
      <h2>新建任务</h2>
      <div className="card">
        <form onSubmit={submit}>
          <label>目标仓库</label>
          <select value={repoId} onChange={(e) => setRepoId(Number(e.target.value))}>
            {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <label>模式</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as "code" | "qa")}>
            <option value="code">写代码并提 MR</option>
            <option value="qa">只读问答</option>
          </select>
          <label>需求描述</label>
          <textarea rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder="描述要做什么，越具体效果越好。例如：给订单导出接口加上日期范围过滤参数 startDate/endDate，并补充对应测试。" />
          {error && <div className="error">{error}</div>}
          <button className="btn" type="submit" disabled={!repoId || !prompt.trim()}>提交任务</button>
        </form>
      </div>
    </div>
  );
}
