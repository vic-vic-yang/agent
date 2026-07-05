export interface Config {
  port: number;
  dataDir: string;
  hostDataDir: string;
  adminPassword: string;
  anthropicBaseUrl: string;
  anthropicApiKey: string;
  model: string;
  workerImage: string;
  concurrency: number;
  taskTimeoutMs: number;
  webDist: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.DATA_DIR ?? "./data";
  return {
    port: Number(env.PORT ?? 8787),
    dataDir,
    // Runner 给 worker 容器挂卷时用的是宿主机路径；server 自己在容器里跑时两者不同
    hostDataDir: env.HOST_DATA_DIR ?? dataDir,
    adminPassword: env.ADMIN_PASSWORD ?? "admin123",
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL ?? "",
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    model: env.MODEL ?? "",
    workerImage: env.WORKER_IMAGE ?? "agent-worker:latest",
    concurrency: Number(env.CONCURRENCY ?? 2),
    taskTimeoutMs: Number(env.TASK_TIMEOUT_MINUTES ?? 30) * 60 * 1000,
    webDist: env.WEB_DIST ?? null
  };
}
