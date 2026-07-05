import { mkdirSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import { buildApp } from "./app.js";
import { seedAdmin } from "./auth.js";
import { loadConfig } from "./config.js";
import { DockerodeRunner } from "./container.js";
import { initDb } from "./db.js";
import { LogBus } from "./logbus.js";
import { TaskRunner } from "./runner.js";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const db = initDb(join(config.dataDir, "platform.db"));
seedAdmin(db, config.adminPassword);
if (config.adminPassword === "admin123") {
  console.warn("警告：正在使用默认管理员密码，请设置 ADMIN_PASSWORD 环境变量");
}

const bus = new LogBus();
const app = buildApp({ db, config, bus });

if (config.webDist) {
  app.register(fastifyStatic, { root: config.webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "接口不存在" });
    return reply.sendFile("index.html");
  });
}

const runner = new TaskRunner({ db, containers: new DockerodeRunner(), bus, config });

app.listen({ port: config.port, host: "0.0.0.0" }).then(() => {
  console.log(`服务已启动: http://localhost:${config.port}`);
  runner.start();
});
