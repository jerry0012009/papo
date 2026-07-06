import { makeId } from "./ids";
import type { ConversationChannel, CreatureMessage, CreatureProfile } from "./types";

const MAX_CONVERSATION_MESSAGES = 80;

export function appendPapoMessage(
  profile: CreatureProfile,
  input: {
    channel: ConversationChannel;
    text?: string;
    sourceId?: string;
    relatedMemoryIds?: string[];
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
    relatedMemoryIds: input.relatedMemoryIds ?? []
  };
  profile.conversation.unshift(message);
  profile.conversation = profile.conversation.slice(0, MAX_CONVERSATION_MESSAGES);
  return message;
}
