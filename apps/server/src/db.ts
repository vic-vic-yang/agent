import Database from "better-sqlite3";

export type DB = Database.Database;

export interface UserRow {
  id: number;
  name: string;
  password_hash: string;
  is_admin: number;
}

export interface RepoRow {
  id: number;
  name: string;
  git_url: string;
  platform: "gitlab" | "gitea";
  api_base: string;
  project_path: string;
  access_token: string;
  default_branch: string;
}

export interface TaskRow {
  id: number;
  user_id: number;
  repo_id: number;
  mode: string;
  prompt: string;
  status: string;
  result_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export function initDb(file: string): DB {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      git_url TEXT NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('gitlab','gitea')),
      api_base TEXT NOT NULL,
      project_path TEXT NOT NULL,
      access_token TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main'
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      mode TEXT NOT NULL CHECK (mode IN ('code','qa')),
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      result_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      seq INTEGER NOT NULL,
      line TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id, seq);
  `);
  return db;
}
