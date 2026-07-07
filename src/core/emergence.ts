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
    whyNow: "刚才的新片段碰到了我还抱着的一小段。",
    relatedMemoryIds: [memory.id],
    driveSource: "memory_resonance",
    message: `你刚递来的这一小段碰到了熟悉气味，我又想起了：${emergenceMemoryText(memory.text, 96)}。我没有急着把它当成新事，而是先把那段和现在放在一起听。`,
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
      whyNow: "我现在更在意边界，所以先碰到以前那段需要小心保存的小事。",
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
      whyNow: "我还有一点没想完，所以先摸到一段还没放下的小事。",
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
      whyNow: "我现在更想靠近你，所以先贴近一条我们一起留下的小事。",
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
    whyNow: "你来看我在想什么时，我安静了一会儿，先摸到一条很久没回来的小事。",
    driveSource: "rhythm",
    messagePrefix: "我刚才安静地摸到一小段以前的事"
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
      whyNow: `${input.whyNow} 但我还没有和你攒出足够稳定的共同小事，所以这次先把耳朵留给新的真实片段。`,
      relatedMemoryIds: [],
      driveSource: input.driveSource,
      message: `${input.messagePrefix}，但我还没有能自己回来的小事。我会先把耳朵留给下一段你递来的世界，等真的有一小段值得留下时，再把它从我里面轻轻带回来。`,
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
  if (driveSource === "safety") return "我现在更在意边界，所以先碰到你教过我的小心听法。";
  if (driveSource === "curiosity") return "我还有一点没想完，所以先碰到你教我形成的听法。";
  if (driveSource === "attachment") return "我现在更想靠近你，所以先摸到你养出来的那点习惯。";
  if (driveSource === "rhythm") return "我安静了一会儿，先碰到你教过我的听法。";
  return "我先碰到你教过我的听法。";
}

function selfMemoryBackMessage(driveSource: string, messagePrefix: string, memoryText: string) {
  if (driveSource === "safety") {
    return `我现在靠近得慢一点，先摸到你教过我的样子：${memoryText}。所以接下来我会先护住边界，再听你递来的这一小段。`;
  }
  if (driveSource === "curiosity") {
    return `我还没把这件事想完，先摸到你教过我的样子：${memoryText}。所以接下来我会带着这个习惯多听一会儿，等真正的生活片段靠近。`;
  }
  if (driveSource === "attachment") {
    return `我有点想靠近你，先摸到你养出来的样子：${memoryText}。所以我会带着这点习惯听你真正放不下的地方。`;
  }
  if (driveSource === "rhythm") {
    return `我安静了一会儿，先摸到你教过我的样子：${memoryText}。所以现在我会带着这个习惯听新的小片段，等它真的变成我们一起经历过的事。`;
  }
  return `${messagePrefix}，先摸到你教过我的样子：${memoryText}。我会带着这个习惯继续听你。`;
}

function memoryBackMessage(driveSource: string, messagePrefix: string, memoryText: string) {
  if (driveSource === "safety") {
    return `我现在靠近得慢一点，所以我想起了：${memoryText}。这件小事让我先把边界抱紧些，再听你接下来递来的片段。`;
  }
  if (driveSource === "curiosity") {
    return `我还没把这件事想完，所以我想起了：${memoryText}。如果你继续说，我会先听它和现在有什么关系。`;
  }
  if (driveSource === "attachment") {
    return `我有点想靠近我们以前这件小事，所以我想起了：${memoryText}。它让我听新片段时先找你真正放不下的地方。`;
  }
  if (driveSource === "rhythm") {
    return `我安静了一会儿，脑袋里先碰到这件小事，我想起了：${memoryText}。它像一小块旧气味，让我现在更容易注意相似的生活细节。`;
  }
  return `${messagePrefix}，所以我想起了：${memoryText}。我会把这段以前的小事贴近一点，再听你接下来递来的东西。`;
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
