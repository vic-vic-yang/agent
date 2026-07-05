import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";

interface TaskItem {
  id: number; mode: string; prompt: string; status: string;
  createdAt: string; userName: string; repoName: string;
}

export default function TaskList() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);

  useEffect(() => {
    api<TaskItem[]>("/api/tasks").then(setTasks);
    const timer = setInterval(() => api<TaskItem[]>("/api/tasks").then(setTasks), 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="container">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>任务列表</h2>
        <Link className="btn" to="/tasks/new">新建任务</Link>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr><th>#</th><th>需求</th><th>仓库</th><th>模式</th><th>提交人</th><th>状态</th></tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td><Link to={`/tasks/${t.id}`}>{t.id}</Link></td>
                <td><Link to={`/tasks/${t.id}`}>{t.prompt.slice(0, 40)}</Link></td>
                <td>{t.repoName}</td>
                <td>{t.mode === "code" ? "写代码" : "问答"}</td>
                <td>{t.userName}</td>
                <td><span className={`status status-${t.status}`}>{t.status}</span></td>
              </tr>
            ))}
            {tasks.length === 0 && <tr><td colSpan={6}>还没有任务</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
