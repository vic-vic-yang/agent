import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";

export default function Login() {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const nav = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ name, password }) });
      nav("/");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 400, paddingTop: 80 }}>
      <div className="card">
        <h2>开发 Agent 平台</h2>
        <form onSubmit={submit}>
          <label>用户名</label>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <label>密码</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <div className="error">{error}</div>}
          <button className="btn" type="submit">登录</button>
        </form>
      </div>
    </div>
  );
}
