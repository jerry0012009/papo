import { makeId } from "./ids";
import type { ConversationChannel, CreatureMessage, CreatureProfile, MessageCognitionTrace, SegmentKind, SensingTrace, StreamSegment } from "./types";

const MAX_CONVERSATION_MESSAGES = 80;

export function appendPapoMessage(
  profile: CreatureProfile,
  input: {
    channel: ConversationChannel;
    text?: string;
    sourceId?: string;
    relatedMemoryIds?: string[];
    attachments?: StreamSegment["attachments"];
    cognitionTrace?: MessageCognitionTrace;
    at?: string;
  }
): CreatureMessage | undefined {
  const text = input.text?.trim();
  if (!text) return undefined;
  profile.conversation ??= [];
  const duplicate = profile.conversation.find(
    (message) => message.role === "papo" && message.channel === input.channel && message.sourceId === input.sourceId && message.text === text
  );
  if (duplicate) return duplicate;

  const message: CreatureMessage = {
    id: makeId("msg"),
    at: input.at ?? new Date().toISOString(),
    role: "papo",
    channel: input.channel,
    text,
    sourceId: input.sourceId,
    relatedMemoryIds: input.relatedMemoryIds ?? [],
    attachments: input.attachments ?? [],
    cognitionTrace: input.cognitionTrace
  };
  profile.conversation.unshift(message);
  profile.conversation = profile.conversation.slice(0, MAX_CONVERSATION_MESSAGES);
  return message;
}

export function appendInputMessage(
  profile: CreatureProfile,
  input: {
    channel: ConversationChannel;
    role?: "user" | "world";
    text?: string;
    displayText?: string;
    auditOnly?: boolean;
    sourceId?: string;
    modality?: SegmentKind | "button";
    batchId?: string;
    observedAt?: string;
    location?: StreamSegment["location"];
    attachments?: StreamSegment["attachments"];
    relatedMemoryIds?: string[];
    sensingTrace?: SensingTrace;
    cognitionTrace?: MessageCognitionTrace;
    at?: string;
  }
): CreatureMessage | undefined {
  const text = input.text?.trim();
  if (!text) return undefined;
  profile.conversation ??= [];
  const duplicate = profile.conversation.find(
    (message) => message.role === (input.role ?? "world") && message.channel === input.channel && message.sourceId === input.sourceId && message.text === text
  );
  if (duplicate) return duplicate;

  const message: CreatureMessage = {
    id: makeId("msg"),
    at: input.at ?? input.observedAt ?? new Date().toISOString(),
    role: input.role ?? "world",
    channel: input.channel,
    text,
    displayText: input.displayText?.trim() || undefined,
    auditOnly: input.auditOnly,
    sourceId: input.sourceId,
    relatedMemoryIds: input.relatedMemoryIds ?? [],
    modality: input.modality,
    batchId: input.batchId,
    observedAt: input.observedAt,
    location: input.location,
    attachments: input.attachments ?? [],
    sensingTrace: input.sensingTrace,
    cognitionTrace: input.cognitionTrace
  };
  profile.conversation.unshift(message);
  profile.conversation = profile.conversation.slice(0, MAX_CONVERSATION_MESSAGES);
  return message;
}
