import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import { registerAuth } from "./auth.js";
import type { LogBus } from "./logbus.js";

export interface AppDeps {
  db: DB;
  config: Config;
  bus?: LogBus;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(cookie);
  app.register(async (scoped) => {
    registerAuth(scoped, deps.db);
  });
  return app;
}
