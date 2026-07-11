import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import webpush, { type PushSubscription } from "web-push";
import { summarizeText } from "../core/text";
import type { CreatureMessage, CreatureProfile } from "../core/types";
import { loadServerEnv } from "./env";
import type { ProfileStore } from "./store";

export interface BrowserPushSubscription extends PushSubscription {
  appUrl: string;
}

interface StoredPushSubscription extends BrowserPushSubscription {
  createdAt: string;
}

interface PushSubscriptionFile {
  subscriptions: Record<string, StoredPushSubscription[]>;
}

export interface WebPushService {
  readonly enabled: boolean;
  readonly publicKey?: string;
  subscribe(userId: string, subscription: BrowserPushSubscription): Promise<void>;
  unsubscribe(userId: string, endpoint: string): Promise<void>;
  sendMessages(profile: CreatureProfile, messages: CreatureMessage[]): Promise<void>;
}

export class JsonPushSubscriptionStore {
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath = path.join(process.cwd(), "data", "push-subscriptions.json")) {}

  async list(userId: string) {
    const data = await this.read();
    return data.subscriptions[userId] ?? [];
  }

  async upsert(userId: string, subscription: BrowserPushSubscription) {
    await this.withWriteLock(async () => {
      const data = await this.read();
      const current = data.subscriptions[userId] ?? [];
      data.subscriptions[userId] = [
        { ...subscription, createdAt: new Date().toISOString() },
        ...current.filter((item) => item.endpoint !== subscription.endpoint)
      ].slice(0, 10);
      await this.write(data);
    });
  }

  async remove(userId: string, endpoint: string) {
    await this.withWriteLock(async () => {
      const data = await this.read();
      const current = data.subscriptions[userId] ?? [];
      const next = current.filter((item) => item.endpoint !== endpoint);
      if (next.length) data.subscriptions[userId] = next;
      else delete data.subscriptions[userId];
      await this.write(data);
    });
  }

  private async read(): Promise<PushSubscriptionFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as PushSubscriptionFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { subscriptions: {} };
    }
  }

  private async write(data: PushSubscriptionFile) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.filePath);
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

export function createWebPushService(input: {
  env?: NodeJS.ProcessEnv;
  store?: JsonPushSubscriptionStore;
} = {}): WebPushService {
  const env = loadServerEnv(input.env);
  const publicKey = env.PAPO_WEB_PUSH_PUBLIC_KEY?.trim();
  const privateKey = env.PAPO_WEB_PUSH_PRIVATE_KEY?.trim();
  const enabled = Boolean(publicKey && privateKey);
  const store = input.store ?? new JsonPushSubscriptionStore();

  if (enabled) {
    webpush.setVapidDetails(
      env.PAPO_WEB_PUSH_SUBJECT?.trim() || "mailto:papo@localhost",
      publicKey!,
      privateKey!
    );
  }

  return {
    enabled,
    publicKey: enabled ? publicKey : undefined,
    async subscribe(userId, subscription) {
      if (!enabled) throw new Error("Web Push is not configured");
      await store.upsert(userId, subscription);
    },
    async unsubscribe(userId, endpoint) {
      await store.remove(userId, endpoint);
    },
    async sendMessages(profile, messages) {
      if (!enabled || !messages.length) return;
      const subscriptions = await store.list(profile.userId);
      await Promise.all(subscriptions.map(async (subscription) => {
        for (const message of [...messages].reverse()) {
          try {
            await webpush.sendNotification(subscription, JSON.stringify({
              title: profile.creatureName,
              body: summarizeText(message.text, 160),
              url: notificationUrl(subscription.appUrl),
              userId: profile.userId,
              messageId: message.id
            }), {
              TTL: 60 * 60 * 24,
              urgency: message.channel === "emergence" ? "normal" : "high"
            });
          } catch (error) {
            const statusCode = pushErrorStatus(error);
            if (statusCode === 404 || statusCode === 410) {
              await store.remove(profile.userId, subscription.endpoint);
              break;
            }
            console.error(`Web Push failed for ${profile.userId}`, error);
          }
        }
      }));
    }
  };
}

export class PushNotifyingProfileStore implements ProfileStore {
  private userQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly inner: ProfileStore,
    private readonly push: WebPushService
  ) {}

  listProfiles() {
    return this.inner.listProfiles();
  }

  async getProfile(userId: string) {
    const profile = await this.inner.getProfile(userId);
    return profile ? structuredClone(profile) : undefined;
  }

  async createProfile(input: { userId?: string; creatureName?: string; petKind?: string }) {
    return structuredClone(await this.inner.createProfile(input));
  }

  async saveProfile(profile: CreatureProfile) {
    const previous = this.userQueues.get(profile.userId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.userQueues.set(profile.userId, current);
    await previous.catch(() => undefined);
    try {
      const before = await this.inner.getProfile(profile.userId);
      const previousMessageIds = new Set(before?.conversation.map((message) => message.id) ?? []);
      await this.inner.saveProfile(structuredClone(profile));
      const saved = await this.inner.getProfile(profile.userId);
      const newMessages = saved?.conversation.filter((message) =>
        message.role === "papo" && message.channel !== "wake" && !previousMessageIds.has(message.id)
      ) ?? [];
      if (saved && newMessages.length) void this.push.sendMessages(saved, newMessages);
    } finally {
      release();
      if (this.userQueues.get(profile.userId) === current) this.userQueues.delete(profile.userId);
    }
  }
}

function notificationUrl(appUrl: string) {
  const url = new URL(appUrl);
  url.searchParams.set("open", "chat");
  return url.toString();
}

function pushErrorStatus(error: unknown) {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return undefined;
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}
