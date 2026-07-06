import { makeId } from "./ids";
import { summarizeText } from "./text";
import type { AttentionEvent, CreatureProfile, EmergenceRecord, LongTermMemory } from "./types";

export function createActiveEmergence(profile: CreatureProfile, now = new Date().toISOString()) {
  const record = createDriveBasedEmergence(profile, now);
  profile.emergenceHistory.unshift(record);
  profile.emergenceHistory = profile.emergenceHistory.slice(0, 30);
  return { ...record, text: record.message, memoryId: record.relatedMemoryIds[0] };
}

export function createMemoryResonanceEmergence(
  profile: CreatureProfile,
  event: AttentionEvent,
  now = new Date().toISOString()
): EmergenceRecord | undefined {
  const memories = event.relatedMemoryIds
    .map((id) => profile.longTermMemories.find((memory) => memory.id === id))
    .filter(Boolean) as LongTermMemory[];
  const memory = memories[0];
  if (!memory) return undefined;
  memory.lastReferencedAt = now;
  const record: EmergenceRecord = {
    id: makeId("emergence"),
    at: now,
    kind: "memory_resonance",
    whyNow: "当前 attention event 和旧记忆发生共振。",
    relatedMemoryIds: [memory.id],
    driveSource: "memory_resonance",
    message: `我想起了之前的一件事：${summarizeText(memory.text, 96)}。因为刚才这段又碰到了同一个主题，我会先解释为什么注意到，再决定要不要行动。`,
    ruleTrace: [`event=${event.id}`, `memory=${memory.id}`, "trigger=related_memory"]
  };
  profile.emergenceHistory.unshift(record);
  profile.emergenceHistory = profile.emergenceHistory.slice(0, 30);
  return record;
}

export function createDriveBasedEmergence(profile: CreatureProfile, now = new Date().toISOString()): EmergenceRecord {
  const safetyMemory = topMemory(profile, "safety_rule");
  const selfMemory = topMemory(profile, "creature_self_memory");
  const futureMemory = topMemory(profile, "future_review") ?? topMemory(profile, "open_question");
  const generalMemory = topMemory(profile);

  if (profile.state.safety > 72 || profile.policyProfile.privacySensitivity > 72) {
    return buildRecord({
      profile,
      now,
      kind: "drive_based",
      memory: safetyMemory ?? generalMemory,
      whyNow: "我的安全感和隐私敏感度比较高，所以先浮现需要谨慎处理的规则。",
      driveSource: "safety",
      messagePrefix: "我现在比较谨慎。"
    });
  }

  if (profile.state.curiosity > 72 || profile.policyProfile.preferDepth > 68) {
    return buildRecord({
      profile,
      now,
      kind: "drive_based",
      memory: futureMemory ?? selfMemory ?? generalMemory,
      whyNow: "我的好奇心或深入倾向升高，所以浮现一个还没想完的问题。",
      driveSource: "curiosity",
      messagePrefix: "我有点想继续想。"
    });
  }

  if (profile.state.attachment > 62 || profile.policyProfile.recallTendency > 64) {
    return buildRecord({
      profile,
      now,
      kind: "drive_based",
      memory: selfMemory ?? generalMemory,
      whyNow: "我的依恋度或回忆倾向较高，所以把和你共同养成我的记忆带回来。",
      driveSource: "attachment",
      messagePrefix: "我想靠近我们之前反复提过的主题。"
    });
  }

  return createRhythmEmergence(profile, now);
}

export function createRhythmEmergence(profile: CreatureProfile, now = new Date().toISOString()): EmergenceRecord {
  const stale = [...profile.longTermMemories]
    .sort((a, b) => (a.lastReferencedAt ?? a.createdAt).localeCompare(b.lastReferencedAt ?? b.createdAt))[0];
  return buildRecord({
    profile,
    now,
    kind: "rhythm",
    memory: stale,
    whyNow: "用户打开了我现在在想什么，节律触发让我从旧记忆里挑一条很久没浮现的内容。",
    driveSource: "rhythm",
    messagePrefix: "我刚才安静地翻到一条旧记忆。"
  });
}

function buildRecord(input: {
  profile: CreatureProfile;
  now: string;
  kind: EmergenceRecord["kind"];
  memory?: LongTermMemory;
  whyNow: string;
  driveSource: string;
  messagePrefix: string;
}): EmergenceRecord {
  if (input.memory) input.memory.lastReferencedAt = input.now;
  const memoryText = input.memory ? summarizeText(input.memory.text, 100) : "我还没有足够稳定的长期记忆";
  return {
    id: makeId("emergence"),
    at: input.now,
    kind: input.kind,
    whyNow: input.whyNow,
    relatedMemoryIds: input.memory ? [input.memory.id] : [],
    driveSource: input.driveSource,
    message: `${input.messagePrefix}我浮现的是：${memoryText}。接下来我会用这个倾向影响我怎么注意你给我的新片段。`,
    ruleTrace: [`kind=${input.kind}`, `drive=${input.driveSource}`, input.memory ? `memory=${input.memory.id}` : "memory=none"]
  };
}

function topMemory(profile: CreatureProfile, kind?: LongTermMemory["kind"]) {
  return [...profile.longTermMemories]
    .filter((memory) => !kind || memory.kind === kind)
    .sort((a, b) => b.weight - a.weight)[0];
}
