import type { ConversationJobRecord, CreatureProfile } from "../core/types";
import type { ProfileStore } from "./store";

export interface TurnJobResult {
  messageId?: string;
  attachmentIds?: string[];
  episodeIds?: string[];
  memoryIds?: string[];
  memorySourceIds?: string[];
  memoryDecision?: "created" | "skipped_no_new_fact" | "skipped_duplicate";
  memoryReason?: string;
}

export class PersistentTurnWorker {
  private timer?: NodeJS.Timeout;
  private tickPromise?: Promise<void>;
  private readonly inFlight = new Set<string>();

  constructor(private readonly input: {
    store: ProfileStore;
    handle: (userId: string, job: ConversationJobRecord) => Promise<TurnJobResult | void>;
    concurrency?: number;
    intervalMs?: number;
  }) {}

  async start() {
    await this.recoverInterruptedJobs();
    this.timer = setInterval(() => void this.tick(), this.input.intervalMs ?? 250);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  wake() {
    void this.tick();
  }

  async drainOnce() {
    await this.tick();
    while (this.inFlight.size) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  private async tick() {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.schedule().finally(() => { this.tickPromise = undefined; });
    return this.tickPromise;
  }

  private async schedule() {
    const capacity = Math.max(1, this.input.concurrency ?? 3) - this.inFlight.size;
    if (capacity <= 0) return;
    const summaries = await this.input.store.listProfiles();
    const candidates: Array<{ userId: string; job: ConversationJobRecord }> = [];
    for (const summary of summaries) {
      const profile = await this.input.store.getProfile(summary.userId);
      if (!profile) continue;
      for (const job of profile.jobs ?? []) {
        if (job.status !== "queued" || this.inFlight.has(job.id)) continue;
        const dependencies = (job.dependsOn ?? []).map((id) => profile.jobs?.find((item) => item.id === id));
        if (dependencies.some((dependency) => !dependency || (dependency.status !== "completed" && dependency.status !== "failed"))) continue;
        if (job.type === "cognition" && (profile.jobs ?? []).some((other) => other.id !== job.id && other.type === "cognition" && other.status === "running")) continue;
        candidates.push({ userId: summary.userId, job });
      }
    }
    candidates.sort((left, right) => Date.parse(left.job.createdAt) - Date.parse(right.job.createdAt));
    const selected: typeof candidates = [];
    const cognitionUsers = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.job.type === "cognition" && cognitionUsers.has(candidate.userId)) continue;
      selected.push(candidate);
      if (candidate.job.type === "cognition") cognitionUsers.add(candidate.userId);
      if (selected.length >= capacity) break;
    }
    for (const candidate of selected) void this.run(candidate.userId, candidate.job.id);
  }

  private async run(userId: string, jobId: string) {
    this.inFlight.add(jobId);
    try {
      let claimed: ConversationJobRecord | undefined;
      await this.input.store.updateProfile(userId, (profile) => {
        const job = profile.jobs?.find((item) => item.id === jobId);
        if (!job || job.status !== "queued") return;
        if (job.type === "cognition" && (profile.jobs ?? []).some((other) =>
          other.id !== job.id
          && other.type === "cognition"
          && (other.status === "running" || (other.status === "queued" && compareJobs(other, job) < 0))
        )) return;
        const now = new Date().toISOString();
        job.status = "running";
        job.attempt += 1;
        job.startedAt = now;
        job.updatedAt = now;
        const turn = profile.turns?.find((item) => item.id === job.turnId);
        if (turn && turn.status === "queued") {
          turn.status = "running";
          turn.updatedAt = now;
        }
        claimed = structuredClone(job);
      });
      if (!claimed) return;
      const result = await this.input.handle(userId, claimed);
      await this.input.store.updateProfile(userId, (profile) => {
        const job = profile.jobs?.find((item) => item.id === jobId);
        if (!job || job.status === "completed") return;
        const now = new Date().toISOString();
        job.status = "completed";
        job.completedAt = now;
        job.updatedAt = now;
        job.error = undefined;
        if (result) job.result = { ...job.result, ...result };
        settleTurn(profile, job.turnId, now);
      });
    } catch (error) {
      await this.input.store.updateProfile(userId, (profile) => {
        const job = profile.jobs?.find((item) => item.id === jobId);
        if (!job || job.status === "completed") return;
        const now = new Date().toISOString();
        const retry = job.retryable && job.attempt < job.maxAttempts;
        job.status = retry ? "queued" : "failed";
        job.updatedAt = now;
        job.error = error instanceof Error ? error.message.slice(0, 500) : "Unknown background job error";
        settleTurn(profile, job.turnId, now);
      });
    } finally {
      this.inFlight.delete(jobId);
      this.wake();
    }
  }

  private async recoverInterruptedJobs() {
    for (const summary of await this.input.store.listProfiles()) {
      await this.input.store.updateProfile(summary.userId, (profile) => {
        const now = new Date().toISOString();
        for (const job of profile.jobs ?? []) {
          if (job.status !== "running") continue;
          if (job.retryable && job.attempt < job.maxAttempts) {
            job.status = "queued";
          } else {
            job.status = "failed";
            job.error = job.error ?? "Server restarted while this job was running";
          }
          job.updatedAt = now;
        }
        for (const turn of profile.turns ?? []) settleTurn(profile, turn.id, now);
      });
    }
  }
}

function compareJobs(left: ConversationJobRecord, right: ConversationJobRecord) {
  const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return byTime || left.id.localeCompare(right.id);
}

function settleTurn(profile: CreatureProfile, turnId: string, now: string) {
  const turn = profile.turns?.find((item) => item.id === turnId);
  if (!turn) return;
  const jobs = (profile.jobs ?? []).filter((job) => job.turnId === turnId);
  const active = jobs.some((job) => job.status === "queued" || job.status === "running");
  if (active) {
    turn.status = jobs.some((job) => job.status === "running") ? "running" : "queued";
  } else {
    turn.status = jobs.some((job) => job.status === "failed") ? "failed" : "completed";
    turn.completedAt = now;
    turn.error = jobs.find((job) => job.status === "failed")?.error;
  }
  turn.updatedAt = now;
}
