import { makeId } from "./ids";
import { toCreatureMemoryVoice } from "./memory";
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
    whyNow: "刚才的新内容关联到以前记住的一件事。",
    relatedMemoryIds: [memory.id],
    driveSource: "memory_resonance",
    message: `你刚说的内容让我想起了：${emergenceMemoryText(memory.text, 96)}。我会把以前那件事和现在一起考虑。`,
    ruleTrace: [`event=${event.id}`, `memory=${memory.id}`, "trigger=related_memory"]
  };
  profile.emergenceHistory.unshift(record);
  profile.emergenceHistory = profile.emergenceHistory.slice(0, 30);
  return record;
}

export function createDriveBasedEmergence(profile: CreatureProfile, now = new Date().toISOString()): EmergenceRecord {
  const safetyMemory = topMemory(profile, "safety_rule");
  const futureMemory = topMemory(profile, "future_review") ?? topMemory(profile, "open_question");
  const generalMemory = topMemory(profile);

  if (profile.state.safety > 72 || profile.policyProfile.privacySensitivity > 72) {
    return buildRecord({
      profile,
      now,
      kind: "drive_based",
      memory: safetyMemory ?? generalMemory,
      whyNow: "我现在更在意边界，所以想起以前那件需要谨慎处理的事。",
      driveSource: "safety",
      messagePrefix: "我现在比较谨慎"
    });
  }

  if (profile.state.curiosity > 72 || profile.policyProfile.preferDepth > 68) {
    return buildRecord({
      profile,
      now,
      kind: "drive_based",
      memory: futureMemory ?? generalMemory,
      whyNow: "我还有一点没想完，所以想起一件还需要继续看的事。",
      driveSource: "curiosity",
      messagePrefix: "我有点想继续想"
    });
  }

  if (profile.state.attachment > 62 || profile.policyProfile.recallTendency > 64) {
    return buildRecord({
      profile,
      now,
      kind: "drive_based",
      memory: generalMemory,
      whyNow: "我现在更想靠近你，所以想起我们以前一起经历过的事。",
      driveSource: "attachment",
      messagePrefix: "我想靠近我们之前反复提过的主题"
    });
  }

  return createRhythmEmergence(profile, now);
}

export function createRhythmEmergence(profile: CreatureProfile, now = new Date().toISOString()): EmergenceRecord {
  const memories = sharedMemories(profile);
  const stale =
    memories
      .filter((memory) => memory.kind !== "creature_self_memory")
      .sort((a, b) => (a.lastReferencedAt ?? a.createdAt).localeCompare(b.lastReferencedAt ?? b.createdAt))[0] ??
    memories.sort((a, b) => (a.lastReferencedAt ?? a.createdAt).localeCompare(b.lastReferencedAt ?? b.createdAt))[0];
  return buildRecord({
    profile,
    now,
    kind: "rhythm",
    memory: stale,
    whyNow: "你来看我在想什么时，我安静了一会儿，想起一件很久没提过的事。",
    driveSource: "rhythm",
    messagePrefix: "我刚才想起一件以前的事"
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
  if (!input.memory) {
    return {
      id: makeId("emergence"),
      at: input.now,
      kind: input.kind,
      whyNow: `${input.whyNow} 但我还没有和你经历过足够稳定的真实内容，所以这次先等你继续说。`,
      relatedMemoryIds: [],
      driveSource: input.driveSource,
      message: "我安静了一下，还没有足够稳定、真的和你一起经历过的事可以自己想起。我先等你继续说，等真的有值得记住的事，再在合适的时候想起来。",
      ruleTrace: [`kind=${input.kind}`, `drive=${input.driveSource}`, "memory=none", "shared_memory=none"]
    };
  }

  input.memory.lastReferencedAt = input.now;
  const memoryText = emergenceMemoryText(input.memory.text, 100);
  const feedbackSelfMemory = isFeedbackSelfMemory(input.memory);
  return {
    id: makeId("emergence"),
    at: input.now,
    kind: input.kind,
    whyNow: feedbackSelfMemory ? selfMemoryWhyNow(input.driveSource) : input.whyNow,
    relatedMemoryIds: input.memory ? [input.memory.id] : [],
    driveSource: input.driveSource,
    message: feedbackSelfMemory ? selfMemoryBackMessage(input.driveSource, input.messagePrefix, memoryText) : memoryBackMessage(input.driveSource, input.messagePrefix, memoryText),
    ruleTrace: [
      `kind=${input.kind}`,
      `drive=${input.driveSource}`,
      input.memory ? `memory=${input.memory.id}` : "memory=none",
      feedbackSelfMemory ? "memory_type=feedback_self_memory" : `memory_type=${input.memory.kind}`
    ]
  };
}

function selfMemoryWhyNow(driveSource: string) {
  if (driveSource === "safety") return "我现在更在意边界，所以想起你教过我的谨慎回应方式。";
  if (driveSource === "curiosity") return "我还有一点没想完，所以想起你教过我的回应方式。";
  if (driveSource === "attachment") return "我现在更想靠近你，所以想起你教过我的回应习惯。";
  if (driveSource === "rhythm") return "我安静了一会儿，想起你教过我的回应方式。";
  return "我想起你教过我的回应方式。";
}

function selfMemoryBackMessage(driveSource: string, messagePrefix: string, memoryText: string) {
  if (driveSource === "safety") {
    return `我现在会谨慎一点，因为你教过我：${memoryText}。接下来涉及隐私或保存时，我会先等你的意思。`;
  }
  if (driveSource === "curiosity") {
    return `我还没把这件事想完，也记得你教过我：${memoryText}。所以接下来我会多听一会儿，再回应你。`;
  }
  if (driveSource === "attachment") {
    return `我有点想靠近你，也记得你教过我：${memoryText}。所以我会更认真听你真正放不下的地方。`;
  }
  if (driveSource === "rhythm") {
    return `我安静了一会儿，想起你教过我：${memoryText}。所以现在我会按这个习惯继续听你说。`;
  }
  return `${messagePrefix}，也想起你教过我：${memoryText}。我会按这个习惯继续听你。`;
}

function memoryBackMessage(driveSource: string, messagePrefix: string, memoryText: string) {
  if (driveSource === "safety") {
    return `我现在会谨慎一点，所以想起了：${memoryText}。接下来如果聊到相关内容，我会先注意边界。`;
  }
  if (driveSource === "curiosity") {
    return `我还没把这件事想完，所以我想起了：${memoryText}。如果你继续说，我会先听它和现在有什么关系。`;
  }
  if (driveSource === "attachment") {
    return `我想起我们以前说过这件事：${memoryText}。如果你继续说，我会先听你真正放不下的地方。`;
  }
  if (driveSource === "rhythm") {
    return `我安静了一会儿，想起了：${memoryText}。如果现在出现相似的细节，我会更容易注意到。`;
  }
  return `${messagePrefix}，所以我想起了：${memoryText}。如果你继续说，我会把它和现在一起考虑。`;
}

function emergenceMemoryText(text: string, max: number) {
  return summarizeText(toCreatureMemoryVoice(text), max).replace(/[。！？.!?]+$/, "");
}

function topMemory(profile: CreatureProfile, kind?: LongTermMemory["kind"]) {
  return sharedMemories(profile)
    .filter((memory) => !kind || memory.kind === kind)
    .sort((a, b) => {
      if (!kind && a.kind !== b.kind) {
        if (a.kind === "creature_self_memory") return 1;
        if (b.kind === "creature_self_memory") return -1;
      }
      return b.weight - a.weight;
    })[0];
}

function availableMemories(profile: CreatureProfile) {
  return [...profile.longTermMemories].filter((memory) => memory.weight > 0);
}

function sharedMemories(profile: CreatureProfile) {
  return availableMemories(profile).filter((memory) => memory.kind !== "creature_self_memory" || Boolean(memory.sourceEpisodeId));
}

function isFeedbackSelfMemory(memory: LongTermMemory) {
  return memory.kind === "creature_self_memory" && memory.tags.includes("被你养成");
}
