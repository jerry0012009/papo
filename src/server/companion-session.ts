import { createHash } from "node:crypto";
import { z } from "zod";
import type { ModelProvider } from "../core/provider";
import type { CompanionSessionRecord, CreatureMessage, CreatureProfile, EpisodeMemory, LongTermMemory, SemanticBrainRecord, StreamSegment } from "../core/types";
import type { ProfileStore } from "./store";

const INACTIVITY_MS = 4 * 60_000;
const GUARANTEED_LONG_FORM_MS = 10 * 60_000;

const consolidationSchema = z.object({
  kind: z.enum(["lecture", "meeting", "conversation", "ambient"]),
  title: z.string().trim().min(2).max(24),
  summary: z.string().trim().min(1).max(1600),
  shouldRemember: z.boolean(),
  memoryText: z.string().trim().max(900).optional(),
  importanceReason: z.string().trim().min(1).max(360),
  tags: z.array(z.string().trim().min(1).max(40)).max(12)
});

export function collectCompanionTurn(profile: CreatureProfile, turnId: string, segments: StreamSegment[]) {
  for (const segment of segments) {
    if (!segment.batchId) continue;
    const sessionId = companionSessionId(segment.batchId);
    if (!sessionId) continue;
    const observedAt = segment.observedAt ?? new Date().toISOString();
    let session = profile.companionSessions?.find((item) => item.id === sessionId);
    if (!session) {
      session = {
        id: sessionId,
        startedAt: observedAt,
        lastObservedAt: observedAt,
        updatedAt: observedAt,
        status: "active",
        sourceTurnIds: [],
        sourceSegmentIds: [],
        observations: []
      };
      profile.companionSessions = [session, ...(profile.companionSessions ?? [])].slice(0, 40);
    }
    const isNewSegment = !session.sourceSegmentIds.includes(segment.id);
    session.startedAt = minIso(session.startedAt, observedAt);
    session.lastObservedAt = maxIso(session.lastObservedAt, observedAt);
    session.updatedAt = maxIso(session.updatedAt, observedAt);
    if (isNewSegment) {
      session.status = "active";
      session.error = undefined;
    }
    session.sourceTurnIds = unique([...session.sourceTurnIds, turnId]);
    session.sourceSegmentIds = unique([...session.sourceSegmentIds, segment.id]);
    const status = segment.sensingTrace?.status ?? (segment.auditOnly ? "empty" : "content");
    const observation = {
      segmentId: segment.id,
      observedAt,
      modality: segment.kind,
      status,
      content: status === "content" ? segment.content.trim().slice(0, 1600) : ""
    };
    session.observations = [observation, ...session.observations.filter((item) => item.segmentId !== segment.id)]
      .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
      .slice(-120);
  }
}

export async function runCompanionSessionSweep(store: ProfileStore, provider: ModelProvider, now = new Date().toISOString()) {
  let checked = 0;
  let completed = 0;
  let failed = 0;
  for (const summary of await store.listProfiles()) {
    const profile = await store.getProfile(summary.userId);
    if (!profile) continue;
    const backfilled = backfillCompanionSessions(profile);
    if (backfilled) await store.saveProfile(profile);
    for (const session of profile.companionSessions ?? []) {
      if (!isDue(session, now)) continue;
      checked += 1;
      const claimed = await store.updateProfile(profile.userId, (latest) => {
        const target = latest.companionSessions?.find((item) => item.id === session.id);
        if (!target || !isDue(target, now)) return;
        target.status = "consolidating";
        target.updatedAt = now;
        target.error = undefined;
      });
      const snapshot = claimed?.companionSessions?.find((item) => item.id === session.id);
      if (!claimed || !snapshot || snapshot.status !== "consolidating") continue;
      try {
        const content = snapshot.observations.filter((item) => item.status === "content" && item.content.trim());
        if (!content.length) {
          await settleEmptySession(store, claimed.userId, snapshot.id, snapshot.lastObservedAt, now);
          completed += 1;
          continue;
        }
        const raw = await provider.generateJson<unknown>(buildConsolidationPrompt(claimed, snapshot));
        const parsed = consolidationSchema.safeParse(raw);
        if (!parsed.success) throw new Error(`invalid companion session consolidation (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 240)})`);
        const durationMs = Math.max(0, Date.parse(snapshot.lastObservedAt) - Date.parse(snapshot.startedAt));
        const longForm = durationMs >= GUARANTEED_LONG_FORM_MS && content.length >= 3 && (parsed.data.kind === "lecture" || parsed.data.kind === "meeting");
        if (longForm && (!parsed.data.shouldRemember || !parsed.data.memoryText?.trim())) {
          throw new Error("long-form lecture or meeting consolidation must create one integrated memory");
        }
        const records = sessionRecords(claimed, snapshot, parsed.data, provider, now);
        const saved = await store.updateProfile(claimed.userId, (latest) => {
          const target = latest.companionSessions?.find((item) => item.id === snapshot.id);
          if (!target) return;
          if (Date.parse(target.lastObservedAt) > Date.parse(snapshot.lastObservedAt)) {
            target.status = "active";
            target.updatedAt = target.lastObservedAt;
            return;
          }
          latest.episodes = mergeById(latest.episodes, [records.episode]).slice(0, 80);
          if (records.memory) latest.longTermMemories = mergeById(latest.longTermMemories, [records.memory]).slice(0, 80);
          if (records.message) latest.conversation = mergeById(latest.conversation, [records.message]).slice(0, 80);
          latest.semanticBrainHistory = mergeById(latest.semanticBrainHistory, [records.semanticRun]).slice(0, 30);
          target.status = "completed";
          target.updatedAt = now;
          target.consolidatedAt = now;
          target.episodeId = records.episode.id;
          target.memoryId = records.memory?.id;
          target.messageId = records.message?.id;
          target.title = parsed.data.title;
          target.summary = parsed.data.summary;
          target.kind = parsed.data.kind;
          target.error = undefined;
        });
        if (saved) completed += 1;
      } catch (error) {
        failed += 1;
        await store.updateProfile(profile.userId, (latest) => {
          const target = latest.companionSessions?.find((item) => item.id === session.id);
          if (!target) return;
          target.status = "failed";
          target.updatedAt = now;
          target.error = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
        });
      }
    }
  }
  return { checked, completed, failed };
}

function sessionRecords(profile: CreatureProfile, session: CompanionSessionRecord, decision: z.infer<typeof consolidationSchema>, provider: ModelProvider, now: string) {
  const suffix = createHash("sha256").update(`${profile.userId}\u0000${session.id}`).digest("hex").slice(0, 20);
  const episodeId = `episode_session_${suffix}`;
  const memoryId = `ltm_session_${suffix}`;
  const shouldRemember = decision.shouldRemember && Boolean(decision.memoryText?.trim());
  const episode: EpisodeMemory = {
    id: episodeId,
    createdAt: session.startedAt,
    source: "curious_stream",
    cognitionSource: "ambient",
    sourceBatchId: session.id,
    sourceObservedAt: session.lastObservedAt,
    inputSummary: decision.summary,
    noticed: `Papo 完整陪伴了这段${decision.kind === "lecture" ? "讲座" : decision.kind === "meeting" ? "会议" : "连续现场"}。`,
    possibleIntent: "整合连续陪伴内容，保留前后文核心信息",
    importanceReason: decision.importanceReason,
    relatedMemoryIds: shouldRemember ? [memoryId] : [],
    stateSnapshot: structuredClone(profile.state),
    creatureResponse: "",
    feedback: [],
    promotedToLongTerm: shouldRemember,
    memoryCandidateIds: [],
    actionDecision: {
      action: "listen_silently",
      confidence: 100,
      reason: "companion session consolidation keeps one coherent record without interrupting each slice",
      blockedActions: [],
      safetyNotes: [],
      llmSuggestedAction: "listen_silently",
      ruleTrace: ["source=companion_session", "reply=quiet", `memory=${shouldRemember}`]
    },
    actionResult: { kind: "memory_intent", title: decision.title, text: decision.importanceReason, sourceIds: session.sourceSegmentIds },
    creatureExperience: { earReason: "我把前后片段连起来听完了。", actionFeeling: "安静陪听后整理", saveFeeling: shouldRemember ? "把完整内容收成一条记忆" : "只留下这次经历" },
    weight: shouldRemember ? 82 : 55,
    tags: unique(["陪伴会话", decision.kind, ...decision.tags]),
    decisionTrace: ["session: all sensed content considered independent of per-slice attention", `segments=${session.observations.length}`, `content_segments=${session.observations.filter((item) => item.status === "content").length}`]
  };
  const memory: LongTermMemory | undefined = shouldRemember ? {
    id: memoryId,
    createdAt: now,
    kind: "long_theme",
    text: decision.memoryText!.trim(),
    shortTitle: [...decision.title.replace(/\s+/g, "")].slice(0, 8).join(""),
    sourceEpisodeId: episodeId,
    consolidatedBecause: decision.importanceReason,
    weight: 88,
    tags: unique(["陪伴会话", decision.kind, ...decision.tags]),
    lastReferencedAt: now
  } : undefined;
  const message: CreatureMessage | undefined = memory ? {
    id: `msg_session_${suffix}`,
    at: now,
    role: "papo",
    channel: "curious",
    text: `我把这场${decision.kind === "lecture" ? "讲座" : "会议"}从头到尾整理好了。${decision.summary}`,
    sourceId: session.id,
    relatedMemoryIds: [memory.id],
    attachments: []
  } : undefined;
  const semanticRun: SemanticBrainRecord = {
    id: `semantic_session_${suffix}`,
    at: now,
    source: "companion_session",
    stage: "memory",
    providerKind: provider.kind,
    providerName: provider.name,
    model: provider.diagnostics?.textModel,
    status: "applied",
    message: `consolidated ${session.observations.length} companion observations into one episode${memory ? " and one memory" : ""}`,
    ruleTrace: [`session=${session.id}`, `kind=${decision.kind}`, `memory=${Boolean(memory)}`]
  };
  return { episode, memory, message, semanticRun };
}

function buildConsolidationPrompt(profile: CreatureProfile, session: CompanionSessionRecord) {
  return `请作为 Papo 的连续陪伴会话整理与记忆决策脑，把同一场连续现场的前言后语整合起来。

这不是逐片 Attention。所有 sensing 成功的片段都应参与总结，即使中间某片没有触发注意或 Papo 一直安静。
判断这是 lecture、meeting、conversation 还是 ambient。总结核心主题、关键论点、事实、结论和待办，不要逐片复述，不要编造。
如果是持续 10 分钟以上且至少 3 个有效片段的讲座或会议，shouldRemember 必须 true，并给出一条自足、整合前后文的 memoryText。
普通短暂背景或无长期价值环境可以 shouldRemember=false。
只返回 JSON：
{"kind":"lecture","title":"...","summary":"...","shouldRemember":true,"memoryText":"...","importanceReason":"...","tags":["..."]}

session:
${JSON.stringify({ id: session.id, startedAt: session.startedAt, lastObservedAt: session.lastObservedAt, observations: session.observations })}

recent_direct_context:
${JSON.stringify(profile.conversation.filter((message) => message.role === "user").slice(0, 8).map((message) => ({ at: message.at, text: message.text })))}
`;
}

function backfillCompanionSessions(profile: CreatureProfile) {
  const before = JSON.stringify((profile.companionSessions ?? []).map((session) => [session.id, session.sourceSegmentIds.length, session.lastObservedAt]));
  for (const turn of profile.turns ?? []) collectCompanionTurn(profile, turn.id, turn.segments ?? []);
  const after = JSON.stringify((profile.companionSessions ?? []).map((session) => [session.id, session.sourceSegmentIds.length, session.lastObservedAt]));
  return before !== after;
}

function companionSessionId(batchId: string) {
  if (!batchId.startsWith("native-") && !batchId.startsWith("live-")) return undefined;
  return batchId.replace(/-\d{1,4}$/, "");
}

function isDue(session: CompanionSessionRecord, now: string) {
  if (session.status === "completed" || session.status === "consolidating") return false;
  if (session.status === "failed" && Date.parse(now) - Date.parse(session.updatedAt) < INACTIVITY_MS) return false;
  return Date.parse(now) - Date.parse(session.lastObservedAt) >= INACTIVITY_MS;
}

async function settleEmptySession(store: ProfileStore, userId: string, sessionId: string, lastObservedAt: string, now: string) {
  await store.updateProfile(userId, (profile) => {
    const session = profile.companionSessions?.find((item) => item.id === sessionId);
    if (!session || Date.parse(session.lastObservedAt) > Date.parse(lastObservedAt)) return;
    session.status = "completed";
    session.updatedAt = now;
    session.consolidatedAt = now;
    session.summary = "这次陪伴没有形成可用的连续内容。";
  });
}

function mergeById<T extends { id: string }>(current: T[], owned: T[]) {
  const ids = new Set(owned.map((item) => item.id));
  return [...owned, ...current.filter((item) => !ids.has(item.id))];
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function minIso(left: string, right: string) {
  return Date.parse(right) < Date.parse(left) ? right : left;
}

function maxIso(left: string, right: string) {
  return Date.parse(right) > Date.parse(left) ? right : left;
}
