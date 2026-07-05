import { BrowserRouter, Route, Routes } from "react-router-dom";
import Login from "./pages/Login.js";
import NewTask from "./pages/NewTask.js";
import TaskDetail from "./pages/TaskDetail.js";
import TaskList from "./pages/TaskList.js";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<TaskList />} />
        <Route path="/tasks/new" element={<NewTask />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
      </Routes>
    </BrowserRouter>
  );
}
