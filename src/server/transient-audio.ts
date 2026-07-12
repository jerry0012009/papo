import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

export interface RetainedAudioAsset {
  id: string;
  mime: string;
  sizeBytes: number;
  retainedUntil: string;
}

export class TransientAudioStore {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly directory = path.join(process.cwd(), "data", "transient-audio"),
    private readonly retentionMs = DAY_MS,
    private readonly cleanupIntervalMs = HOUR_MS
  ) {}

  start() {
    if (this.timer) return;
    void this.cleanup().catch((error) => console.error("Transient audio cleanup failed", error));
    this.timer = setInterval(() => void this.cleanup().catch((error) => console.error("Transient audio cleanup failed", error)), this.cleanupIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async save(userId: string, batchId: string, dataUrl: string, now = new Date()): Promise<RetainedAudioAsset> {
    const parsed = parseAudioDataUrl(dataUrl);
    const id = `tmpaud_${createHash("sha256").update(`${userId}\u0000${batchId}\u0000`).update(parsed.buffer).digest("hex").slice(0, 24)}`;
    const userDirectory = path.join(this.directory, safeName(userId));
    await mkdir(userDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(userDirectory, `${id}.${parsed.extension}`), parsed.buffer, { mode: 0o600 });
    void this.cleanup(now).catch((error) => console.error("Transient audio cleanup failed", error));
    return {
      id,
      mime: parsed.mime,
      sizeBytes: parsed.buffer.byteLength,
      retainedUntil: new Date(now.getTime() + this.retentionMs).toISOString()
    };
  }

  async cleanup(now = new Date()) {
    let userDirectories: string[];
    try {
      userDirectories = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let removed = 0;
    for (const userDirectoryName of userDirectories) {
      const userDirectory = path.join(this.directory, userDirectoryName);
      let names: string[];
      try {
        names = await readdir(userDirectory);
      } catch {
        continue;
      }
      for (const name of names) {
        const filePath = path.join(userDirectory, name);
        try {
          const info = await stat(filePath);
          if (!info.isFile() || now.getTime() - info.mtimeMs < this.retentionMs) continue;
          await rm(filePath, { force: true });
          removed += 1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      try {
        if (!(await readdir(userDirectory)).length) await rm(userDirectory, { recursive: true, force: true });
      } catch {
        // A concurrent save may recreate or populate the directory.
      }
    }
    return removed;
  }
}

function parseAudioDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:(audio\/(?:webm|wav|wave|x-wav|mpeg|mp3|mp4|m4a|x-m4a|ogg|aac))(?:;[^,]+)?;base64,([a-zA-Z0-9+/=]+)$/);
  if (!match) throw new Error("Invalid transient audio data URL");
  const mime = canonicalMime(match[1]);
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) throw new Error("Transient audio is empty");
  return { mime, buffer, extension: extensionFor(mime) };
}

function canonicalMime(mime: string) {
  if (["audio/wav", "audio/wave", "audio/x-wav"].includes(mime)) return "audio/wav";
  if (["audio/mpeg", "audio/mp3"].includes(mime)) return "audio/mpeg";
  if (["audio/mp4", "audio/m4a", "audio/x-m4a"].includes(mime)) return "audio/mp4";
  return mime;
}

function extensionFor(mime: string) {
  if (mime === "audio/webm") return "webm";
  if (mime === "audio/wav") return "wav";
  if (mime === "audio/mpeg") return "mp3";
  if (mime === "audio/ogg") return "ogg";
  if (mime === "audio/aac") return "aac";
  return "m4a";
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "unknown";
}
