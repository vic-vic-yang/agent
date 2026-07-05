import { Writable } from "node:stream";
import Docker from "dockerode";

// 平台管理的所有 worker 容器都带此标签，便于重启后识别并清理孤儿容器
export const MANAGED_LABEL = "agent-platform.managed";

export interface ContainerRunSpec {
  image: string;
  env: Record<string, string>;
  binds: string[];
  timeoutMs: number;
  labels?: Record<string, string>;
  onLine: (line: string) => void;
}

export interface ContainerRunner {
  run(spec: ContainerRunSpec): Promise<{ exitCode: number; timedOut: boolean }>;
  // 清理上次进程遗留的孤儿容器（服务重启时调用）；测试用的假实现可省略
  cleanupOrphans?(): Promise<void>;
}

export function createLineSplitter(onLine: (line: string) => void): Writable {
  let buf = "";
  return new Writable({
    write(chunk: Buffer, _enc, cb) {
      buf += chunk.toString("utf8");
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const p of parts) if (p.trim()) onLine(p.trimEnd());
      cb();
    },
    final(cb) {
      if (buf.trim()) onLine(buf.trimEnd());
      cb();
    }
  });
}

export class DockerodeRunner implements ContainerRunner {
  constructor(private docker: Docker = new Docker()) {}

  async cleanupOrphans(): Promise<void> {
    const list = await this.docker
      .listContainers({ all: true, filters: { label: [`${MANAGED_LABEL}=1`] } })
      .catch(() => [] as { Id: string }[]);
    for (const c of list) {
      await this.docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
    }
  }

  async run(spec: ContainerRunSpec): Promise<{ exitCode: number; timedOut: boolean }> {
    const container = await this.docker.createContainer({
      Image: spec.image,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: { [MANAGED_LABEL]: "1", ...spec.labels },
      HostConfig: {
        Binds: spec.binds,
        SecurityOpt: ["no-new-privileges"],
        Memory: 4 * 1024 * 1024 * 1024
      },
      Tty: false
    });

    const stream = await container.attach({ stream: true, stdout: true, stderr: true });
    const splitter = createLineSplitter(spec.onLine);
    container.modem.demuxStream(stream, splitter, splitter);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      container.kill().catch(() => {});
    }, spec.timeoutMs);

    try {
      await container.start();
      const status = (await container.wait()) as { StatusCode: number };
      return { exitCode: status.StatusCode, timedOut };
    } finally {
      clearTimeout(timer);
      splitter.end();
      await container.remove({ force: true }).catch(() => {});
    }
  }
}
