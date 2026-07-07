import { makeId } from "./ids";
import { toCreatureMemoryVoice } from "./memory";
import { applyStateDelta } from "./state";
import { summarizeText } from "./text";
import type { CreatureProfile, EmergenceRecord, LongTermMemory, WakeEvent } from "./types";

const MINUTE = 60_000;

export function wakeCreature(profile: CreatureProfile, now = new Date().toISOString()): WakeEvent {
  const previousSeenAt = parseSeenAt(profile.lastSeenAt ?? profile.createdAt, now);
  const elapsedMinutes = Math.max(0, Math.floor((Date.parse(now) - previousSeenAt.getTime()) / MINUTE));
  const stateDelta = deltaForElapsedMinutes(elapsedMinutes);
  const stateChangeReason = reasonForElapsedMinutes(elapsedMinutes);

  if (Object.keys(stateDelta).length > 0) {
    applyStateDelta(profile, stateDelta, stateChangeReason, now);
  }

  const wakeId = makeId("wake");
  const memory = memoryForWake(profile, elapsedMinutes);
  const emergence = memory ? createWakeEmergence(profile, memory, wakeId, elapsedMinutes, now) : undefined;
  profile.lastSeenAt = now;
  const event: WakeEvent = {
    id: wakeId,
    at: now,
    elapsedMinutes,
    message: wakeMessage(elapsedMinutes, Object.keys(stateDelta).length > 0),
    innerThought: emergence?.message,
    relatedMemoryIds: emergence?.relatedMemoryIds ?? [],
    emergenceId: emergence?.id,
    stateChangeReason,
    stateDelta,
    ruleTrace: [
      `elapsed_minutes=${elapsedMinutes}`,
      Object.keys(stateDelta).length > 0 ? "state_delta=applied" : "state_delta=none",
      emergence ? `wake_emergence=${emergence.id}` : "wake_emergence=none"
    ]
  };
  profile.wakeHistory.unshift(event);
  profile.wakeHistory = profile.wakeHistory.slice(0, 20);
  return event;
}

function parseSeenAt(value: string | undefined, now: string) {
  const parsed = value ? new Date(value) : new Date(now);
  if (Number.isNaN(parsed.getTime())) return new Date(now);
  return parsed;
}

function deltaForElapsedMinutes(elapsedMinutes: number): WakeEvent["stateDelta"] {
  if (elapsedMinutes < 10) return {};
  if (elapsedMinutes < 60) {
    return {
      energy: Math.min(8, Math.floor(elapsedMinutes / 10) + 2),
      arousal: -3
    };
  }
  if (elapsedMinutes < 360) {
    return {
      energy: 14,
      arousal: -6,
      curiosity: 3,
      safety: 2
    };
  }
  return {
    energy: 18,
    arousal: -8,
    curiosity: 5,
    attachment: 2,
    safety: 3
  };
}

function reasonForElapsedMinutes(elapsedMinutes: number) {
  if (elapsedMinutes < 10) return "app_wake_short_gap";
  if (elapsedMinutes < 60) return "app_wake_brief_rest";
  if (elapsedMinutes < 360) return "app_wake_after_rest";
  return "app_wake_after_long_absence";
}

function wakeMessage(elapsedMinutes: number, changed: boolean) {
  if (elapsedMinutes < 1) return "我刚刚醒着，你一打开我就还在这里。";
  if (!changed) return "刚才只是隔了一小会儿。我还在这里，等你继续说。";
  if (elapsedMinutes < 60) return "我像浅浅趴了一会儿。你回来时，我的能量回来了些，心跳也放慢了一点。";
  if (elapsedMinutes < 360) return "我隔了一阵才又见到你，像从小睡里醒来。现在更有力气，也更想听你说说发生了什么。";
  return "你离开了比较久。我醒来时先安静下来，等你继续告诉我新的事。";
}

function memoryForWake(profile: CreatureProfile, elapsedMinutes: number): LongTermMemory | undefined {
  if (elapsedMinutes < 60) return undefined;
  const shared = [...profile.longTermMemories]
    .filter((memory) => memory.kind !== "creature_self_memory" && memory.weight > 0)
    .sort((a, b) => (a.lastReferencedAt ?? a.createdAt).localeCompare(b.lastReferencedAt ?? b.createdAt))[0];
  if (shared) return shared;
  return [...profile.longTermMemories]
    .filter((memory) => memory.kind === "creature_self_memory" && memory.tags.includes("被你养成") && memory.weight > 0)
    .sort((a, b) => (a.lastReferencedAt ?? a.createdAt).localeCompare(b.lastReferencedAt ?? b.createdAt))[0];
}

function createWakeEmergence(
  profile: CreatureProfile,
  memory: LongTermMemory,
  wakeId: string,
  elapsedMinutes: number,
  now: string
): EmergenceRecord {
  memory.lastReferencedAt = now;
  const record: EmergenceRecord = {
    id: makeId("emergence"),
    at: now,
    kind: "rhythm",
    whyNow: wakeWhyNow(memory, elapsedMinutes),
    relatedMemoryIds: [memory.id],
    driveSource: memory.kind === "creature_self_memory" ? "wake_self_memory" : "wake_rhythm",
    message: wakeEmergenceMessage(memory),
    ruleTrace: [`wake=${wakeId}`, `memory=${memory.id}`, `elapsed_minutes=${elapsedMinutes}`, "trigger=app_wake"]
  };
  profile.emergenceHistory.unshift(record);
  profile.emergenceHistory = profile.emergenceHistory.slice(0, 30);
  return record;
}

function wakeWhyNow(memory: LongTermMemory, elapsedMinutes: number) {
  if (memory.kind === "creature_self_memory") {
    return "我刚醒来时，想起你教过我的回应方式。";
  }
  return "我刚醒来时，想起以前记住的一件事。";
}

function wakeEmergenceMessage(memory: LongTermMemory) {
  if (memory.kind === "creature_self_memory") {
    return `我醒来时想起你教过我：${wakeMemoryText(memory.text)}。所以现在我会按这个习惯继续听你说。`;
  }
  return `我醒来时想起这件事：${wakeMemoryText(memory.text)}。如果今天又聊到相近内容，我会更容易想起来。`;
}

function wakeMemoryText(text: string) {
  return summarizeText(toCreatureMemoryVoice(text), 92).replace(/[。！？.!?]+$/, "");
}
