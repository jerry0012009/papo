import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCreatureProfile, normalizeCreatureProfile } from "../core/profile";
import type { CreatureProfile, EpisodeMemory, HermesTaskRecord, LongTermMemory, MemoryCandidate, StateChange } from "../core/types";

export interface ProfileStore {
  listProfiles(): Promise<Array<{ userId: string; creatureName: string; createdAt: string }>>;
  listProfileSnapshots(): Promise<CreatureProfile[]>;
  getProfile(userId: string): Promise<CreatureProfile | undefined>;
  saveProfile(profile: CreatureProfile): Promise<void>;
  updateProfile(userId: string, update: (profile: CreatureProfile) => void | CreatureProfile | Promise<void | CreatureProfile>): Promise<CreatureProfile | undefined>;
  createProfile(input: { userId?: string; creatureName?: string; petKind?: string }): Promise<CreatureProfile>;
}

interface StoreFile {
  profiles: Record<string, CreatureProfile>;
}

export class JsonProfileStore implements ProfileStore {
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath = path.join(process.cwd(), "data", "papo-store.json")) {}

  async listProfiles() {
    const data = await this.read();
    return Object.values(data.profiles).map((profile) => normalizeCreatureProfile(profile)).map((profile) => ({
      userId: profile.userId,
      creatureName: profile.creatureName,
      createdAt: profile.createdAt
    }));
  }

  async listProfileSnapshots() {
    const data = await this.read();
    return Object.values(data.profiles).map((profile) => normalizeCreatureProfile(profile));
  }

  async getProfile(userId: string) {
    const data = await this.read();
    const profile = data.profiles[userId];
    return profile ? normalizeCreatureProfile(profile) : undefined;
  }

  async saveProfile(profile: CreatureProfile) {
    await this.withWriteLock(async () => {
      const data = await this.read();
      const incoming = normalizeCreatureProfile(profile);
      const current = data.profiles[incoming.userId] ? normalizeCreatureProfile(data.profiles[incoming.userId]) : undefined;
      data.profiles[incoming.userId] = current ? mergeCreatureProfiles(current, incoming) : incoming;
      await this.write(data);
    });
  }

  async updateProfile(userId: string, update: (profile: CreatureProfile) => void | CreatureProfile | Promise<void | CreatureProfile>) {
    return this.withWriteLock(async () => {
      const data = await this.read();
      const stored = data.profiles[userId];
      if (!stored) return undefined;
      const profile = normalizeCreatureProfile(stored);
      const replacement = await update(profile);
      const next = normalizeCreatureProfile(replacement ?? profile);
      data.profiles[userId] = next;
      await this.write(data);
      return next;
    });
  }

  async createProfile(input: { userId?: string; creatureName?: string; petKind?: string }) {
    return this.withWriteLock(async () => {
      const data = await this.read();
      const profile = createCreatureProfile(input);
      data.profiles[profile.userId] = profile;
      await this.write(data);
      return profile;
    });
  }

  private async read(): Promise<StoreFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as StoreFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { profiles: {} };
    }
  }

  private async write(data: StoreFile) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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

function mergeCreatureProfiles(current: CreatureProfile, incoming: CreatureProfile): CreatureProfile {
  const purged = new Set([...purgedTargets(current), ...purgedTargets(incoming)]);
  const merged = normalizeCreatureProfile({
    ...current,
    ...incoming,
    lastUserActivityAt: timestamp(incoming.lastUserActivityAt) >= timestamp(current.lastUserActivityAt) ? incoming.lastUserActivityAt : current.lastUserActivityAt,
    petKind: incoming.petKind ?? current.petKind,
    petProfile: chooseLatestPetProfile(current, incoming),
    state: chooseLatestState(current, incoming),
    policyProfile: chooseLatestStateOwner(current, incoming).policyProfile,
    episodes: mergeById(current.episodes, incoming.episodes, "createdAt", mergeEpisode).filter((item) => !purged.has(item.id)).slice(0, 80),
    longTermMemories: mergeById(current.longTermMemories, incoming.longTermMemories, "createdAt", mergeLongTermMemory).filter((item) => !purged.has(item.id)).slice(0, 80),
    feedbackHistory: mergeById(current.feedbackHistory, incoming.feedbackHistory, "at").slice(0, 80),
    stateChanges: mergeByCompositeId(current.stateChanges, incoming.stateChanges, stateChangeKey, "at").slice(0, 80),
    memoryCandidates: mergeById(current.memoryCandidates, incoming.memoryCandidates, "createdAt", mergeMemoryCandidate).filter((item) => !purged.has(item.id)).slice(0, 80),
    emergenceHistory: mergeById(current.emergenceHistory, incoming.emergenceHistory, "at").slice(0, 80),
    wakeHistory: mergeById(current.wakeHistory, incoming.wakeHistory, "at").slice(0, 30),
    dreamHistory: mergeById(current.dreamHistory, incoming.dreamHistory, "at").slice(0, 30),
    semanticBrainHistory: mergeById(current.semanticBrainHistory, incoming.semanticBrainHistory, "at").slice(0, 30),
    conversation: mergeById(current.conversation, incoming.conversation, "at").slice(0, 80),
    turns: mergeById(current.turns ?? [], incoming.turns ?? [], "updatedAt", mergeTurn).slice(0, 80),
    jobs: mergeById(current.jobs ?? [], incoming.jobs ?? [], "updatedAt", mergeJob).slice(0, 240),
    companionSessions: mergeById(current.companionSessions ?? [], incoming.companionSessions ?? [], "updatedAt", mergeCompanionSession).slice(0, 40),
    illustrations: mergeById(current.illustrations ?? [], incoming.illustrations ?? [], "createdAt").slice(0, 30),
    actionCards: mergeById(current.actionCards ?? [], incoming.actionCards ?? [], "createdAt").slice(0, 30),
    clientDocument: chooseLatestClientDocument(current, incoming),
    proactive: chooseLatestProactive(current, incoming),
    readState: chooseLatestReadState(current, incoming),
    dogState: chooseLatestDogState(current, incoming),
    dogStateHistory: mergeByCompositeId(current.dogStateHistory, incoming.dogStateHistory, dogStateKey, "selectedAt").slice(0, 40),
    hermes: {
      channelId: incoming.hermes.channelId ?? current.hermes.channelId,
      channelName: incoming.hermes.channelName ?? current.hermes.channelName,
      sessionId: incoming.hermes.sessionId ?? current.hermes.sessionId,
      sessionName: incoming.hermes.sessionName ?? current.hermes.sessionName,
      tasks: mergeById(current.hermes.tasks, incoming.hermes.tasks, "updatedAt", mergeHermesTask).slice(0, 30)
    }
  });
  return merged;
}

function mergeCompanionSession(left: NonNullable<CreatureProfile["companionSessions"]>[number], right: NonNullable<CreatureProfile["companionSessions"]>[number]) {
  const chosen = timestamp(right.updatedAt) >= timestamp(left.updatedAt) ? right : left;
  return {
    ...left,
    ...chosen,
    sourceTurnIds: unique([...(left.sourceTurnIds ?? []), ...(right.sourceTurnIds ?? [])]),
    sourceSegmentIds: unique([...(left.sourceSegmentIds ?? []), ...(right.sourceSegmentIds ?? [])]),
    observations: mergeSessionObservations(left.observations ?? [], right.observations ?? []),
    events: mergeById(left.events ?? [], right.events ?? [], "updatedAt", mergeCompanionEvent)
  };
}

function mergeCompanionEvent(
  left: NonNullable<NonNullable<CreatureProfile["companionSessions"]>[number]["events"]>[number],
  right: NonNullable<NonNullable<CreatureProfile["companionSessions"]>[number]["events"]>[number]
) {
  const chosen = timestamp(right.updatedAt) >= timestamp(left.updatedAt) ? right : left;
  return {
    ...left,
    ...chosen,
    sourceTurnIds: unique([...(left.sourceTurnIds ?? []), ...(right.sourceTurnIds ?? [])]),
    sourceSegmentIds: unique([...(left.sourceSegmentIds ?? []), ...(right.sourceSegmentIds ?? [])]),
    importantContent: unique([...(left.importantContent ?? []), ...(right.importantContent ?? [])]).slice(-24),
    transcript: mergeTranscriptSegments(left.transcript ?? [], right.transcript ?? []),
    speakers: mergeSpeakerEvidence(left.speakers ?? [], right.speakers ?? [])
  };
}

function mergeTranscriptSegments(
  left: NonNullable<NonNullable<CreatureProfile["companionSessions"]>[number]["events"]>[number]["transcript"],
  right: NonNullable<NonNullable<CreatureProfile["companionSessions"]>[number]["events"]>[number]["transcript"]
) {
  const byId = new Map(left.map((segment) => [segment.segmentId, segment]));
  for (const segment of right) byId.set(segment.segmentId, segment);
  return [...byId.values()].sort((a, b) => timestamp(a.observedAt) - timestamp(b.observedAt));
}

function mergeSpeakerEvidence(
  left: NonNullable<NonNullable<CreatureProfile["companionSessions"]>[number]["events"]>[number]["speakers"],
  right: NonNullable<NonNullable<CreatureProfile["companionSessions"]>[number]["events"]>[number]["speakers"]
) {
  const byId = new Map(left.map((speaker) => [speaker.speakerId, speaker]));
  for (const speaker of right) {
    const existing = byId.get(speaker.speakerId);
    const chosen = !existing || speaker.confidence >= existing.confidence ? speaker : existing;
    byId.set(speaker.speakerId, {
      ...existing,
      ...chosen,
      sourceSegmentIds: unique([...(existing?.sourceSegmentIds ?? []), ...speaker.sourceSegmentIds])
    });
  }
  return [...byId.values()];
}

function mergeSessionObservations(
  left: NonNullable<CreatureProfile["companionSessions"]>[number]["observations"],
  right: NonNullable<CreatureProfile["companionSessions"]>[number]["observations"]
) {
  const byId = new Map(left.map((item) => [item.segmentId, item]));
  for (const item of right) {
    const existing = byId.get(item.segmentId);
    if (!existing || timestamp(item.processedAt ?? item.observedAt) >= timestamp(existing.processedAt ?? existing.observedAt)) {
      byId.set(item.segmentId, { ...existing, ...item });
    }
  }
  return [...byId.values()].sort((a, b) => timestamp(a.observedAt) - timestamp(b.observedAt));
}

function mergeTurn(left: NonNullable<CreatureProfile["turns"]>[number], right: NonNullable<CreatureProfile["turns"]>[number]) {
  const chosen = timestamp(right.updatedAt) >= timestamp(left.updatedAt) ? right : left;
  return {
    ...left,
    ...chosen,
    inputMessageIds: unique([...(left.inputMessageIds ?? []), ...(right.inputMessageIds ?? [])]),
    jobIds: unique([...(left.jobIds ?? []), ...(right.jobIds ?? [])]),
    segments: mergeById(left.segments ?? [], right.segments ?? [], "observedAt")
  };
}

function mergeJob(left: NonNullable<CreatureProfile["jobs"]>[number], right: NonNullable<CreatureProfile["jobs"]>[number]) {
  return timestamp(right.updatedAt) >= timestamp(left.updatedAt) ? { ...left, ...right } : { ...right, ...left };
}

function chooseLatestClientDocument(current: CreatureProfile, incoming: CreatureProfile) {
  const left = current.clientDocument;
  const right = incoming.clientDocument;
  if (!left) return right;
  if (!right) return left;
  if (right.revision !== left.revision) return right.revision > left.revision ? right : left;
  return timestamp(right.updatedAt) >= timestamp(left.updatedAt) ? right : left;
}

function mergeById<T extends { id: string }>(left: T[], right: T[], timeKey: keyof T, mergeSame?: (left: T, right: T) => T) {
  const byId = new Map<string, T>();
  for (const item of left) byId.set(item.id, item);
  for (const item of right) {
    const existing = byId.get(item.id);
    byId.set(item.id, existing && mergeSame ? mergeSame(existing, item) : item);
  }
  return [...byId.values()].sort((a, b) => timestamp(b[timeKey]) - timestamp(a[timeKey]));
}

function mergeByCompositeId<T>(left: T[], right: T[], keyOf: (item: T) => string, timeKey: keyof T) {
  const byId = new Map<string, T>();
  for (const item of left) byId.set(keyOf(item), item);
  for (const item of right) byId.set(keyOf(item), item);
  return [...byId.values()].sort((a, b) => timestamp(b[timeKey]) - timestamp(a[timeKey]));
}

function mergeHermesTask(left: HermesTaskRecord, right: HermesTaskRecord): HermesTaskRecord {
  const leftRank = hermesStatusRank(left.status);
  const rightRank = hermesStatusRank(right.status);
  if (leftRank > rightRank) return { ...right, ...left };
  if (rightRank > leftRank) return { ...left, ...right };
  return timestamp(right.updatedAt) >= timestamp(left.updatedAt) ? { ...left, ...right } : { ...right, ...left };
}

function hermesStatusRank(status: HermesTaskRecord["status"]) {
  if (status === "pending") return 0;
  if (status === "sent") return 1;
  return 2;
}

function mergeEpisode(left: EpisodeMemory, right: EpisodeMemory): EpisodeMemory {
  return {
    ...left,
    ...right,
    feedback: unique([...(left.feedback ?? []), ...(right.feedback ?? [])]),
    memoryCandidateIds: unique([...(left.memoryCandidateIds ?? []), ...(right.memoryCandidateIds ?? [])]),
    attachments: mergeAttachments(left.attachments, right.attachments)
  };
}

function mergeLongTermMemory(left: LongTermMemory, right: LongTermMemory): LongTermMemory {
  const leftRevision = left.contentRevision ?? 1;
  const rightRevision = right.contentRevision ?? 1;
  const chosen = left.weight <= 0 && right.weight > 0
    ? left
    : leftRevision !== rightRevision
      ? leftRevision > rightRevision ? left : right
      : memoryEnrichmentRank(left) > memoryEnrichmentRank(right) ? left : right;
  return {
    ...left,
    ...chosen,
    tags: unique([...(left.tags ?? []), ...(right.tags ?? [])]),
    attachments: mergeAttachments(left.attachments, right.attachments)
  };
}

function memoryEnrichmentRank(memory: LongTermMemory) {
  const revision = memory.enrichedRevision ?? 0;
  const status = memory.enrichmentStatus === "completed" ? 3 : memory.enrichmentStatus === "failed" ? 2 : 1;
  return revision * 10 + status;
}

function mergeMemoryCandidate(left: MemoryCandidate, right: MemoryCandidate): MemoryCandidate {
  const chosen = memoryCandidateStatusRank(left.status) > memoryCandidateStatusRank(right.status) ? left : right;
  return {
    ...left,
    ...chosen,
    tags: unique([...(left.tags ?? []), ...(right.tags ?? [])]),
    attachments: mergeAttachments(left.attachments, right.attachments)
  };
}

function memoryCandidateStatusRank(status: MemoryCandidate["status"]) {
  return status === "candidate" ? 0 : 1;
}

function mergeAttachments<T extends { id: string }>(left: T[] | undefined, right: T[] | undefined): T[] {
  const byId = new Map<string, T>();
  for (const attachment of [...(left ?? []), ...(right ?? [])]) byId.set(attachment.id, attachment);
  return [...byId.values()];
}

function chooseLatestState(current: CreatureProfile, incoming: CreatureProfile) {
  return chooseLatestStateOwner(current, incoming).state;
}

function chooseLatestStateOwner(current: CreatureProfile, incoming: CreatureProfile) {
  return timestamp(incoming.stateChanges[0]?.at) >= timestamp(current.stateChanges[0]?.at) ? incoming : current;
}

function chooseLatestReadState(current: CreatureProfile, incoming: CreatureProfile) {
  return timestamp(incoming.readState.lastReadAt) >= timestamp(current.readState.lastReadAt) ? incoming.readState : current.readState;
}

function chooseLatestProactive(current: CreatureProfile, incoming: CreatureProfile) {
  const currentAt = Math.max(timestamp(current.proactive.lastCheckedAt), timestamp(current.proactive.lastActiveAt), timestamp(current.proactive.lastUserResponseAt), timestamp(current.proactive.lastQuietAt));
  const incomingAt = Math.max(timestamp(incoming.proactive.lastCheckedAt), timestamp(incoming.proactive.lastActiveAt), timestamp(incoming.proactive.lastUserResponseAt), timestamp(incoming.proactive.lastQuietAt));
  return incomingAt >= currentAt ? incoming.proactive : current.proactive;
}

function chooseLatestDogState(current: CreatureProfile, incoming: CreatureProfile) {
  return timestamp(incoming.dogState?.selectedAt) >= timestamp(current.dogState?.selectedAt) ? incoming.dogState : current.dogState;
}

function chooseLatestPetProfile(current: CreatureProfile, incoming: CreatureProfile) {
  return timestamp(incoming.petProfile?.updatedAt) >= timestamp(current.petProfile?.updatedAt) ? incoming.petProfile : current.petProfile;
}

function purgedTargets(profile: CreatureProfile) {
  const ids = new Set<string>();
  for (const feedback of profile.feedbackHistory ?? []) {
    if (feedback.storagePurged && feedback.targetId) ids.add(feedback.targetId);
  }
  for (const message of profile.conversation ?? []) {
    for (const change of message.cognitionTrace?.feedbackDecision?.memoryChanges ?? []) {
      if (change.operation === "purged") ids.add(change.targetId);
    }
  }
  return ids;
}

function stateChangeKey(change: StateChange) {
  return `${change.at}:${change.reason}`;
}

function dogStateKey(state: CreatureProfile["dogState"]) {
  return `${state.selectedAt}:${state.id}:${state.selectedBy}`;
}

function timestamp(value: unknown) {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function unique<T>(values: T[]) {
  return [...new Set(values.filter(Boolean))];
}

export class MemoryProfileStore implements ProfileStore {
  private profiles = new Map<string, CreatureProfile>();
  private writeQueue: Promise<unknown> = Promise.resolve();

  async listProfiles() {
    return [...this.profiles.values()].map((profile) => ({
      userId: profile.userId,
      creatureName: profile.creatureName,
      createdAt: profile.createdAt
    }));
  }

  async listProfileSnapshots() {
    return [...this.profiles.values()].map((profile) => normalizeCreatureProfile(structuredClone(profile)));
  }

  async getProfile(userId: string) {
    const profile = this.profiles.get(userId);
    return profile ? normalizeCreatureProfile(profile) : undefined;
  }

  async saveProfile(profile: CreatureProfile) {
    await this.withWriteLock(async () => {
      const current = this.profiles.get(profile.userId);
      this.profiles.set(profile.userId, current ? mergeCreatureProfiles(normalizeCreatureProfile(current), normalizeCreatureProfile(profile)) : normalizeCreatureProfile(profile));
    });
  }

  async updateProfile(userId: string, update: (profile: CreatureProfile) => void | CreatureProfile | Promise<void | CreatureProfile>) {
    return this.withWriteLock(async () => {
      const stored = this.profiles.get(userId);
      if (!stored) return undefined;
      const profile = normalizeCreatureProfile(stored);
      const replacement = await update(profile);
      const next = normalizeCreatureProfile(replacement ?? profile);
      this.profiles.set(userId, next);
      return next;
    });
  }

  async createProfile(input: { userId?: string; creatureName?: string; petKind?: string }) {
    const profile = createCreatureProfile(input);
    this.profiles.set(profile.userId, profile);
    return profile;
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
