import type { CreatureProfile, MediaAttachment } from "../core/types";

export function profileImageUrls(profile: CreatureProfile) {
  const urls = new Set<string>();
  const add = (attachment?: MediaAttachment) => {
    if (attachment?.kind === "image" && attachment.url && !attachment.url.startsWith("data:")) urls.add(attachment.url);
  };
  add(profile.petProfile?.avatarImage);
  add(profile.petProfile?.referenceImage);
  for (const card of profile.actionCards ?? []) add(card.cover);
  for (const illustration of profile.illustrations ?? []) add(illustration.attachment);
  for (const memory of profile.longTermMemories ?? []) {
    add(memory.visual);
    for (const attachment of memory.attachments ?? []) add(attachment);
  }
  for (const candidate of profile.memoryCandidates ?? []) {
    add(candidate.previewVisual);
    for (const attachment of candidate.attachments ?? []) add(attachment);
  }
  for (const episode of profile.episodes ?? []) for (const attachment of episode.attachments ?? []) add(attachment);
  for (const message of profile.conversation ?? []) for (const attachment of message.attachments ?? []) add(attachment);
  return [...urls];
}
