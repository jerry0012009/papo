import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AiBillingAccountView, AiRedemptionResult, AiUsageCategory, AiUsageEvent, AiUsageSummaryBucket } from "../core/ai-usage";
import { AI_PRICE_VERSION } from "./ai-pricing";

const DEFAULT_TRIAL_MICROS = 20_000_000;
const MAX_PUBLIC_EVENTS = 200;
const RESERVATION_RECOVERY_MS = 60 * 60_000;
const FILE_LOCK_RETRY_MS = 25;
const FILE_LOCK_TIMEOUT_MS = 10_000;
const FILE_LOCK_STALE_MS = 30_000;

interface BillingAccount {
  userId: string;
  balanceMicros: number;
  trialGrantedAt: string;
  updatedAt: string;
}

interface BillingTransaction {
  id: string;
  userId: string;
  at: string;
  kind: "trial" | "redemption" | "debit" | "reservation" | "refund" | "adjustment";
  amountMicros: number;
  callId?: string;
  codeId?: string;
  balanceAfterMicros: number;
}

interface BillingReservation {
  callId: string;
  userId: string;
  createdAt: string;
  estimatedMicros: number;
}

interface RedemptionCodeRecord {
  id: string;
  codeHash: string;
  amountMicros: number;
  createdAt: string;
  expiresAt?: string;
  maxUses: number;
  redemptions: Array<{ userId: string; at: string }>;
  disabled?: boolean;
}

interface BillingFile {
  version: 1;
  accounts: Record<string, BillingAccount>;
  events: AiUsageEvent[];
  transactions: BillingTransaction[];
  reservations: Record<string, BillingReservation>;
  codes: RedemptionCodeRecord[];
}

export interface AiUsageContext {
  userId: string;
  sourceId?: string;
  turnId?: string;
  jobId?: string;
  feature?: string;
}

export class InsufficientAiBalanceError extends Error {
  readonly code = "insufficient_balance";
  readonly retryable = false;

  constructor(readonly requiredMicros: number, readonly balanceMicros: number) {
    super("AI 余额不足，暂时不能生成图片或视频");
    this.name = "InsufficientAiBalanceError";
  }
}

export class AiRedemptionError extends Error {
  readonly code = "invalid_redemption_code";
  constructor(message: string) {
    super(message);
    this.name = "AiRedemptionError";
  }
}

export class JsonAiBillingService {
  private writeQueue: Promise<unknown> = Promise.resolve();
  private readonly contextStore = new AsyncLocalStorage<AiUsageContext>();

  constructor(
    private readonly filePath = path.join(process.cwd(), "data", "ai-billing.json"),
    private readonly trialMicros = DEFAULT_TRIAL_MICROS
  ) {}

  withContext<T>(context: AiUsageContext, run: () => T): T {
    return this.contextStore.run(context, run);
  }

  context() {
    return this.contextStore.getStore();
  }

  async account(userId: string, limit = MAX_PUBLIC_EVENTS): Promise<AiBillingAccountView> {
    return this.withWriteLock(async () => {
      const data = await this.read();
      const account = ensureAccount(data, userId, this.trialMicros);
      await this.write(data);
      return accountView(data, account, limit);
    });
  }

  async authorize(userId: string, callId: string, estimatedMicros: number) {
    return this.withWriteLock(async () => {
      const data = await this.read();
      const account = ensureAccount(data, userId, this.trialMicros);
      const existing = data.reservations[callId];
      if (existing) return existing;
      if (account.balanceMicros < estimatedMicros) throw new InsufficientAiBalanceError(estimatedMicros, account.balanceMicros);
      account.balanceMicros -= estimatedMicros;
      account.updatedAt = new Date().toISOString();
      const reservation = { callId, userId, createdAt: account.updatedAt, estimatedMicros };
      data.reservations[callId] = reservation;
      appendTransaction(data, account, "reservation", -estimatedMicros, { callId });
      await this.write(data);
      return reservation;
    });
  }

  async settle(input: Omit<AiUsageEvent, "id" | "at" | "balanceAfterMicros" | "priceVersion">) {
    return this.withWriteLock(async () => {
      const data = await this.read();
      const duplicate = data.events.find((event) => event.callId === input.callId);
      if (duplicate) return duplicate;
      const account = ensureAccount(data, input.userId, this.trialMicros);
      const reservation = data.reservations[input.callId];
      if (reservation) {
        const adjustment = reservation.estimatedMicros - input.costMicros;
        if (adjustment !== 0) {
          account.balanceMicros += adjustment;
          appendTransaction(data, account, adjustment > 0 ? "refund" : "adjustment", adjustment, { callId: input.callId });
        }
        delete data.reservations[input.callId];
      } else if (input.costMicros > 0) {
        account.balanceMicros -= input.costMicros;
        appendTransaction(data, account, "debit", -input.costMicros, { callId: input.callId });
      }
      account.updatedAt = new Date().toISOString();
      const event: AiUsageEvent = {
        ...input,
        id: `usage_${randomUUID()}`,
        at: account.updatedAt,
        priceVersion: AI_PRICE_VERSION,
        balanceAfterMicros: account.balanceMicros
      };
      data.events.unshift(event);
      data.events = data.events.slice(0, 20_000);
      data.transactions = data.transactions.slice(0, 40_000);
      await this.write(data);
      return event;
    });
  }

  async redeem(userId: string, code: string): Promise<AiRedemptionResult> {
    return this.withWriteLock(async () => {
      const data = await this.read();
      const account = ensureAccount(data, userId, this.trialMicros);
      const now = new Date().toISOString();
      const record = data.codes.find((item) => timingSafeCodeMatch(item.codeHash, code));
      if (!record || record.disabled || (record.expiresAt && Date.parse(record.expiresAt) <= Date.parse(now))) throw new AiRedemptionError("兑换码无效或已过期");
      if (record.redemptions.some((item) => item.userId === userId)) throw new AiRedemptionError("这个兑换码已经使用过");
      if (record.redemptions.length >= record.maxUses) throw new AiRedemptionError("这个兑换码已经用完");
      record.redemptions.push({ userId, at: now });
      account.balanceMicros += record.amountMicros;
      account.updatedAt = now;
      appendTransaction(data, account, "redemption", record.amountMicros, { codeId: record.id });
      await this.write(data);
      return { creditedMicros: record.amountMicros, balanceMicros: account.balanceMicros, redeemedAt: now };
    });
  }

  async createRedemptionCode(amountMicros: number, options: { maxUses?: number; expiresAt?: string } = {}) {
    if (!Number.isInteger(amountMicros) || amountMicros <= 0) throw new Error("amountMicros must be a positive integer");
    return this.withWriteLock(async () => {
      const data = await this.read();
      const code = `PAPO-${randomBytes(5).toString("hex").toUpperCase()}`;
      const record: RedemptionCodeRecord = {
        id: `code_${randomUUID()}`,
        codeHash: hashCode(code),
        amountMicros,
        createdAt: new Date().toISOString(),
        expiresAt: options.expiresAt,
        maxUses: Math.max(1, Math.round(options.maxUses ?? 1)),
        redemptions: []
      };
      data.codes.push(record);
      await this.write(data);
      return { code, id: record.id, amountMicros, maxUses: record.maxUses, expiresAt: record.expiresAt };
    });
  }

  private async read(): Promise<BillingFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<BillingFile>;
      const data: BillingFile = {
        version: 1,
        accounts: parsed.accounts ?? {},
        events: parsed.events ?? [],
        transactions: parsed.transactions ?? [],
        reservations: parsed.reservations ?? {},
        codes: parsed.codes ?? []
      };
      recoverStaleReservations(data);
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return emptyBillingFile();
    }
  }

  private async write(data: BillingFile) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    let releaseFileLock: (() => Promise<void>) | undefined;
    try {
      releaseFileLock = await this.acquireFileLock();
      return await operation();
    } finally {
      await releaseFileLock?.();
      release();
    }
  }

  private async acquireFileLock() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    const startedAt = Date.now();
    while (true) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n`);
        return async () => {
          await handle.close();
          await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const lockStat = await stat(lockPath).catch(() => undefined);
        if (lockStat && Date.now() - lockStat.mtimeMs > FILE_LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() - startedAt >= FILE_LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for AI billing lock: ${lockPath}`);
        await new Promise((resolve) => setTimeout(resolve, FILE_LOCK_RETRY_MS));
      }
    }
  }
}

function ensureAccount(data: BillingFile, userId: string, trialMicros: number) {
  const existing = data.accounts[userId];
  if (existing) return existing;
  const now = new Date().toISOString();
  const account: BillingAccount = { userId, balanceMicros: trialMicros, trialGrantedAt: now, updatedAt: now };
  data.accounts[userId] = account;
  appendTransaction(data, account, "trial", trialMicros);
  return account;
}

function appendTransaction(data: BillingFile, account: BillingAccount, kind: BillingTransaction["kind"], amountMicros: number, ids: { callId?: string; codeId?: string } = {}) {
  data.transactions.unshift({ id: `txn_${randomUUID()}`, userId: account.userId, at: new Date().toISOString(), kind, amountMicros, ...ids, balanceAfterMicros: account.balanceMicros });
}

function accountView(data: BillingFile, account: BillingAccount, limit: number): AiBillingAccountView {
  const events = data.events.filter((event) => event.userId === account.userId).slice(0, Math.max(1, Math.min(500, limit)));
  const summary = (["text", "audio", "image", "video"] as AiUsageCategory[]).map((category): AiUsageSummaryBucket => {
    const relevant = data.events.filter((event) => event.userId === account.userId && event.category === category);
    return {
      category,
      calls: relevant.length,
      completed: relevant.filter((event) => event.status === "completed").length,
      failed: relevant.filter((event) => event.status === "failed").length,
      blocked: relevant.filter((event) => event.status === "blocked").length,
      totalTokens: relevant.reduce((sum, event) => sum + (event.totalTokens ?? 0), 0),
      costMicros: relevant.reduce((sum, event) => sum + event.costMicros, 0)
    };
  });
  return { userId: account.userId, currency: "CNY", balanceMicros: account.balanceMicros, trialGrantedAt: account.trialGrantedAt, updatedAt: account.updatedAt, summary, events };
}

function emptyBillingFile(): BillingFile {
  return { version: 1, accounts: {}, events: [], transactions: [], reservations: {}, codes: [] };
}

function recoverStaleReservations(data: BillingFile, now = new Date()) {
  for (const reservation of Object.values(data.reservations)) {
    if (now.getTime() - Date.parse(reservation.createdAt) < RESERVATION_RECOVERY_MS) continue;
    const account = data.accounts[reservation.userId];
    if (account) {
      account.balanceMicros += reservation.estimatedMicros;
      account.updatedAt = now.toISOString();
      appendTransaction(data, account, "refund", reservation.estimatedMicros, { callId: reservation.callId });
    }
    delete data.reservations[reservation.callId];
  }
}

function hashCode(code: string) {
  return createHash("sha256").update(normalizeCode(code)).digest("hex");
}

function timingSafeCodeMatch(expected: string, code: string) {
  const actual = Buffer.from(hashCode(code), "hex");
  const stored = Buffer.from(expected, "hex");
  return actual.length === stored.length && timingSafeEqual(actual, stored);
}

function normalizeCode(code: string) {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}
