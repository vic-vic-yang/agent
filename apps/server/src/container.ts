import { Writable } from "node:stream";
import Docker from "dockerode";

export interface ContainerRunSpec {
  image: string;
  env: Record<string, string>;
  binds: string[];
  timeoutMs: number;
  onLine: (line: string) => void;
}

export interface ContainerRunner {
  run(spec: ContainerRunSpec): Promise<{ exitCode: number; timedOut: boolean }>;
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

  async run(spec: ContainerRunSpec): Promise<{ exitCode: number; timedOut: boolean }> {
    const container = await this.docker.createContainer({
      Image: spec.image,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
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
