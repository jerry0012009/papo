import { toCreatureMemoryVoice } from "./memory";
import { petKindLabel, normalizePetKind } from "./pet-kinds";
import { hasHighPrivacyText, tagsForModel, textForModel } from "./privacy";
import { modelTimeContext } from "./time";
import type { CreatureProfile, FeedbackRecord, LongTermMemory } from "./types";
import { projectInputForModel } from "./model-safety";

export function modelPetContext(profile: CreatureProfile, now = new Date().toISOString()) {
  return {
    creatureName: profile.creatureName,
    petKind: normalizePetKind(profile.petKind),
    petLabel: petKindLabel(profile.petKind),
    petProfile: {
      displaySpecies: profile.petProfile?.displaySpecies,
      appearance: profile.petProfile?.appearance,
      personality: profile.petProfile?.personality,
      habits: profile.petProfile?.habits,
      visualStyle: profile.petProfile?.visualStyle,
      motionStyle: profile.petProfile?.motionStyle,
      updatedAt: profile.petProfile?.updatedAt
    },
    time: modelTimeContext(now)
  };
}

export function modelConversationContext(profile: CreatureProfile, limit = 10) {
  return (profile.conversation ?? []).filter((message) => message.channel !== "wake").slice(0, limit).map((message) => {
    const privacyHigh = hasHighPrivacyText(message.text);
    const time = modelTimeContext(message.at);
    return {
      id: message.id,
      role: message.role,
      channel: message.channel,
      text: privacyHigh ? textForModel(message.text, true) : projectInputForModel(message.text).text,
      contentHiddenForPrivacy: privacyHigh,
      at: message.at,
      localAt: time.localDateTime,
      timeZone: time.timeZone,
      modality: message.modality,
      sourceId: message.sourceId,
      batchId: message.batchId,
      observedAt: message.observedAt,
      location: message.location ? modelLocation(message.location) : undefined,
      relatedMemoryIds: message.relatedMemoryIds
    };
  });
}

export function modelMemoryContext(memories: LongTermMemory[], options: { limit?: number; creatureVoice?: boolean } = {}) {
  return memories.slice(0, options.limit ?? 8).map((memory) => modelMemoryItem(memory, options.creatureVoice ?? false));
}

export function modelFeedbackContext(feedback: FeedbackRecord[], limit = 6) {
  return feedback.slice(0, limit).map(modelFeedbackItem);
}

export function modelMemoryItem(memory: LongTermMemory, creatureVoice = false) {
  const sourceText = creatureVoice ? toCreatureMemoryVoice(memory.text) : memory.text;
  const privacyHigh = hasHighPrivacyText(`${sourceText} ${memory.tags.join(" ")}`);
  return {
    id: memory.id,
    kind: memory.kind,
    text: textForModel(sourceText, privacyHigh),
    contentHiddenForPrivacy: privacyHigh,
    weight: memory.weight,
    tags: tagsForModel(memory.tags, privacyHigh),
    lastReferencedAt: memory.lastReferencedAt,
    sourceEpisodeId: memory.sourceEpisodeId
  };
}

export function modelFeedbackItem(item: FeedbackRecord) {
  const privacyHigh = hasHighPrivacyText(`${item.inputText ?? ""} ${item.learningNote} ${item.effect ?? ""} ${item.followUpText ?? ""} ${item.replyText ?? ""}`);
  return {
    kind: item.kind,
    inputText: textForModel(item.inputText, privacyHigh),
    learningNote: textForModel(item.learningNote, privacyHigh),
    effect: textForModel(item.effect, privacyHigh),
    followUpText: textForModel(item.followUpText, privacyHigh),
    replyText: textForModel(item.replyText, privacyHigh),
    targetId: item.targetId,
    contentHiddenForPrivacy: privacyHigh
  };
}

function modelLocation(location: NonNullable<CreatureProfile["conversation"][number]["location"]>) {
  return {
    latitude: Number(location.latitude.toFixed(5)),
    longitude: Number(location.longitude.toFixed(5)),
    accuracy: location.accuracy === undefined ? undefined : Math.round(location.accuracy),
    label: location.label
  };
}
