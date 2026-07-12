import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface NativeIngestPayload {
  batchId: string;
  observedAt: string;
  cameraFacing?: "front" | "back";
  audioDataUrl?: string;
  imageDataUrl?: string;
}

interface NativeIngestJob {
  id: string;
  userId: string;
  payload: NativeIngestPayload;
  queuedAt: string;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
}

export class NativeIngestQueue {
  private running = false;
  private timer?: NodeJS.Timeout;
  private enqueueChain: Promise<unknown> = Promise.resolve();
  private lastProcessAt = 0;

  constructor(
    private readonly processJob: (userId: string, payload: NativeIngestPayload) => Promise<void>,
    private readonly directory = path.join(process.cwd(), "data", "native-ingest"),
    private readonly intervalMs = 90_000,
    private readonly retentionMs = 24 * 60 * 60_000
  ) {}

  async enqueue(userId: string, payload: NativeIngestPayload) {
    const operation = this.enqueueChain.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const id = jobId(userId, payload.batchId);
      const filePath = this.jobPath(id);
      try {
        await readFile(filePath);
        return { queued: true, duplicate: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const now = new Date().toISOString();
      const job: NativeIngestJob = { id, userId, payload, queuedAt: now, attempts: 0, nextAttemptAt: now };
      await writeJsonAtomically(filePath, job);
      return { queued: true, duplicate: false };
    });
    this.enqueueChain = operation.catch(() => undefined);
    const result = await operation;
    void this.tick();
    return result;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick() {
    if (this.running) return;
    if (Date.now() - this.lastProcessAt < this.intervalMs) return;
    this.running = true;
    try {
      await mkdir(this.directory, { recursive: true });
      let names: string[];
      try {
        names = (await readdir(this.directory)).filter((name) => name.endsWith(".json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const now = Date.now();
      const jobs: Array<{ filePath: string; job: NativeIngestJob }> = [];
      for (const name of names) {
        const filePath = path.join(this.directory, name);
        try {
          const job = JSON.parse(await readFile(filePath, "utf8")) as NativeIngestJob;
          if (now - Date.parse(job.queuedAt) >= this.retentionMs) {
            await rm(filePath, { force: true });
            continue;
          }
          jobs.push({ filePath, job });
        } catch {
          await rm(filePath, { force: true });
        }
      }
      jobs.sort((left, right) => Date.parse(left.job.queuedAt) - Date.parse(right.job.queuedAt));
      for (const { filePath, job } of jobs) {
        if (Date.parse(job.nextAttemptAt) > now) continue;
        this.lastProcessAt = Date.now();
        try {
          await this.processJob(job.userId, job.payload);
          await rm(filePath, { force: true });
        } catch (error) {
          job.attempts += 1;
          job.lastError = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
          job.nextAttemptAt = new Date(Date.now() + retryDelayMs(job.attempts, job.lastError)).toISOString();
          await writeJsonAtomically(filePath, job);
        }
        return;
      }
    } finally {
      this.running = false;
    }
  }

  private jobPath(id: string) {
    return path.join(this.directory, `${id}.json`);
  }
}

function jobId(userId: string, batchId: string) {
  return `${safeName(userId)}--${safeName(batchId)}`;
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
}

function retryDelayMs(attempts: number, message: string) {
  const base = /code.?441|high-frequency|rate.?limit/i.test(message) ? 120_000 : 15_000;
  return Math.min(15 * 60_000, base * 2 ** Math.min(4, Math.max(0, attempts - 1)));
}

async function writeJsonAtomically(filePath: string, value: unknown) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}
