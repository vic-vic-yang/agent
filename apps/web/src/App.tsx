import { BrowserRouter, Route, Routes } from "react-router-dom";
import Login from "./pages/Login.js";

function Placeholder({ name }: { name: string }) {
  return <div className="container">{name}（下个任务实现）</div>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<Placeholder name="任务列表" />} />
        <Route path="/tasks/new" element={<Placeholder name="新建任务" />} />
        <Route path="/tasks/:id" element={<Placeholder name="任务详情" />} />
      </Routes>
    </BrowserRouter>
  );
}
