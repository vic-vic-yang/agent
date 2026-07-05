import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";

interface TaskDetailData {
  id: number; mode: string; prompt: string; status: string;
  result: { ok: boolean; mrUrl?: string; summary?: string; warning?: string; error?: string } | null;
}

export default function TaskDetail() {
  const { id } = useParams();
  const [task, setTask] = useState<TaskDetailData | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    api<TaskDetailData>(`/api/tasks/${id}`).then((t) => {
      setTask(t);
      es = new EventSource(`/api/tasks/${id}/events`);
      es.addEventListener("log", (e) => {
        const { line } = JSON.parse((e as MessageEvent).data);
        setLines((prev) => [...prev, line]);
      });
      es.addEventListener("done", () => {
        es?.close();
        api<TaskDetailData>(`/api/tasks/${id}`).then(setTask);
      });
    });
    return () => es?.close();
  }, [id]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  if (!task) return <div className="container">加载中...</div>;
  return (
    <div className="container">
      <p><Link to="/">← 返回列表</Link></p>
      <h2>任务 #{task.id} <span className={`status status-${task.status}`}>{task.status}</span></h2>
      <div className="card">
        <label>需求</label>
        <p style={{ whiteSpace: "pre-wrap" }}>{task.prompt}</p>
      </div>
      <div className="card">
        <label>执行日志</label>
        <div className="log-box" ref={logRef}>{lines.join("\n") || "等待执行..."}</div>
      </div>
      {task.result && (
        <div className="card">
          <label>结果</label>
          {task.result.mrUrl && (
            <p><a href={task.result.mrUrl} target="_blank" rel="noreferrer">→ 查看 Merge Request</a></p>
          )}
          {task.result.warning && <div className="error">{task.result.warning}</div>}
          {task.result.error && <div className="error">{task.result.error}</div>}
          {task.result.summary && <p style={{ whiteSpace: "pre-wrap" }}>{task.result.summary}</p>}
        </div>
      )}
    </div>
  );
}
