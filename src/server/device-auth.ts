import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEVICE_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

interface DeviceSessionRecord {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
}

interface DeviceSessionFile {
  sessions: DeviceSessionRecord[];
}

export interface DeviceAuthService {
  create(userId: string): Promise<{ token: string; expiresAt: string }>;
  verify(userId: string, token: string): Promise<boolean>;
  revokeAll(userId: string): Promise<void>;
}

export class JsonDeviceAuthService implements DeviceAuthService {
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath = path.join(process.cwd(), "data", "device-sessions.json")) {}

  async create(userId: string) {
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + DEVICE_SESSION_TTL_MS).toISOString();
    await this.withWriteLock(async () => {
      const data = await this.read();
      const active = data.sessions
        .filter((session) => session.userId !== userId && Date.parse(session.expiresAt) > now.getTime())
        .concat(data.sessions.filter((session) => session.userId === userId && Date.parse(session.expiresAt) > now.getTime()).slice(-9));
      active.push({ tokenHash: hashToken(token), userId, createdAt: now.toISOString(), expiresAt });
      await this.write({ sessions: active });
    });
    return { token, expiresAt };
  }

  async verify(userId: string, token: string) {
    if (!token || token.length > 256) return false;
    const hash = hashToken(token);
    return this.withWriteLock(async () => {
      const data = await this.read();
      const now = new Date();
      const session = data.sessions.find((item) => item.userId === userId && item.tokenHash === hash);
      const valid = Boolean(session && Date.parse(session.expiresAt) > now.getTime());
      data.sessions = data.sessions.filter((item) => Date.parse(item.expiresAt) > now.getTime());
      if (valid && session) session.lastUsedAt = now.toISOString();
      await this.write(data);
      return valid;
    });
  }

  async revokeAll(userId: string) {
    await this.withWriteLock(async () => {
      const data = await this.read();
      data.sessions = data.sessions.filter((session) => session.userId !== userId);
      await this.write(data);
    });
  }

  private async read(): Promise<DeviceSessionFile> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as DeviceSessionFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { sessions: [] };
    }
  }

  private async write(data: DeviceSessionFile) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
