import { EventEmitter } from "node:events";

export interface LogEvent {
  taskId: number;
  seq: number;
  line: string;
}

export interface DoneEvent {
  taskId: number;
  status: string;
}

export class LogBus {
  private ee = new EventEmitter().setMaxListeners(100);

  emitLine(e: LogEvent): void {
    this.ee.emit(`line:${e.taskId}`, e);
  }

  emitDone(e: DoneEvent): void {
    this.ee.emit(`done:${e.taskId}`, e);
  }

  onLine(taskId: number, fn: (e: LogEvent) => void): () => void {
    this.ee.on(`line:${taskId}`, fn);
    return () => this.ee.off(`line:${taskId}`, fn);
  }

  onDone(taskId: number, fn: (e: DoneEvent) => void): () => void {
    this.ee.on(`done:${taskId}`, fn);
    return () => this.ee.off(`done:${taskId}`, fn);
  }
}
