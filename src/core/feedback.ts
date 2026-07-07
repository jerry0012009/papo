import { makeId } from "./ids";
import { updatePolicyFromFeedback } from "./drive";
import { createLearningNote } from "./experience";
import { adjustMemoryWeight, createMemoryCandidateFromEpisode, forgetMemory, normalizeSharedMemoryText, promoteEpisode } from "./memory";
import { applyStateDelta, deltaForFeedback } from "./state";
import { extractTags, summarizeText } from "./text";
import type { CreatureProfile, CreatureState, FeedbackKind, FeedbackPolicyProfile, FeedbackRecord, LongTermMemory, SegmentKind } from "./types";

interface FeedbackReplyContext {
  tags: string[];
  targetEpisode?: CreatureProfile["episodes"][number];
  targetLongTerm?: LongTermMemory;
  forgetResult?: { changed: boolean; purged: boolean };
}

export function applyFeedback(
  profile: CreatureProfile,
  input: { kind: FeedbackKind; targetId?: string; content?: string; modality?: SegmentKind | "button"; now?: string }
): FeedbackRecord {
  const now = input.now ?? new Date().toISOString();
  const inputText = input.content?.trim();
  const targetEpisode = profile.episodes.find((item) => item.id === input.targetId);
  const targetLongTerm = profile.longTermMemories.find((item) => item.id === input.targetId);
  const tags = targetEpisode?.tags ?? targetLongTerm?.tags ?? [];
  const stateBefore = structuredClone(profile.state);
  const policyBefore = structuredClone(profile.policyProfile);
  const learningNote = createLearningNote(input.kind, tags, inputText);
  const effect = `${effectText(input.kind)} ${updatePolicyFromFeedback(profile, input.kind, tags)}`;
  const record: FeedbackRecord = {
    id: makeId("feedback"),
    at: now,
    kind: input.kind,
    targetId: input.targetId,
    inputText,
    inputModality: input.modality ?? (inputText ? "text" : "button"),
    effect,
    learningNote,
    memoryCandidateIds: []
  };

  profile.feedbackHistory.unshift(record);
  profile.feedbackHistory = profile.feedbackHistory.slice(0, 60);

  if (targetEpisode) targetEpisode.feedback.push(input.kind);

  const stateChange = applyStateDelta(profile, deltaForFeedback(input.kind), effect, now);
  record.stateDeltas = stateDeltas(stateBefore, stateChange.after);
  record.policyDeltas = policyDeltas(policyBefore, profile.policyProfile);

  if (input.kind === "remember" && input.targetId) {
    const memory = promoteEpisode(profile, input.targetId, now);
    if (memory && inputText && !hasPrivacyRisk(inputText)) {
      memory.text = `${memory.text} 你确认时还补充：${summarizeText(inputText, 120)}`;
      memory.tags = unique([...memory.tags, ...extractTags(inputText)]);
    }
    if (!memory && targetLongTerm && inputText && !hasPrivacyRisk(inputText)) {
      targetLongTerm.text = normalizeSharedMemoryText(`${targetLongTerm.text} 你确认时还补充：${summarizeText(inputText, 120)}`);
      targetLongTerm.tags = unique([...targetLongTerm.tags, ...extractTags(inputText)]);
      targetLongTerm.lastReferencedAt = now;
    }
  }
  const forgetResult = input.kind === "forget" ? forgetMemory(profile, input.targetId) : undefined;
  if (input.kind === "understood") adjustMemoryWeight(profile, input.targetId, 8);
  if (input.kind === "continue") {
    adjustMemoryWeight(profile, input.targetId, 12);
    if (targetEpisode) {
      const candidate = createMemoryCandidateFromEpisode(profile, targetEpisode, { feedback: "continue", now });
      if (inputText && !hasPrivacyRisk(inputText)) {
        candidate.candidateText = `你后来教我补上这一点：${summarizeText(inputText, 140)}。我会把它和原来的小片段放在一起理解。`;
        candidate.tags = unique([...candidate.tags, ...extractTags(inputText)]);
      }
      record.memoryCandidateIds?.push(candidate.id);
    }
  }
  if (input.kind === "not_now") adjustMemoryWeight(profile, input.targetId, -8);
  if (input.kind === "forget" && forgetResult?.changed && !forgetResult.purged) createSafetyMemoryFromForget(profile, targetEpisode, targetLongTerm, now);
  upsertFeedbackSelfMemory(profile, {
    kind: input.kind,
    tags,
    targetEpisode,
    targetLongTerm,
    inputText,
    now
  });

  const replyContext: FeedbackReplyContext = { tags, targetEpisode, targetLongTerm, forgetResult };
  record.responseAction = selectFeedbackResponseAction(input.kind, inputText, replyContext);
  record.followUpText = createFeedbackFollowUp(record.responseAction, input.kind, inputText, replyContext);
  record.replyText = composeFeedbackReplyText(record);

  return record;
}

export function composeFeedbackReplyText(feedback: FeedbackRecord) {
  return [feedback.learningNote, feedback.followUpText].filter(Boolean).join("\n");
}

function stateDeltas(before: CreatureState, after: CreatureState): FeedbackRecord["stateDeltas"] {
  return (["curiosity", "attachment", "energy", "arousal", "safety", "confidence"] as const)
    .map((key) => ({ key, before: before[key], after: after[key], delta: after[key] - before[key] }))
    .filter((item) => item.delta !== 0);
}

function policyDeltas(before: FeedbackPolicyProfile, after: FeedbackPolicyProfile): FeedbackRecord["policyDeltas"] {
  return (["preferDepth", "preferProactivity", "privacySensitivity", "saveThreshold", "askThreshold", "recallTendency", "quietTendency"] as const)
    .map((key) => ({ key, before: before[key], after: after[key], delta: after[key] - before[key] }))
    .filter((item) => item.delta !== 0);
}

function effectText(kind: FeedbackKind): string {
  switch (kind) {
    case "understood":
      return "你说我这次懂对了，我会更敢把这种理解方式轻轻说出来。";
    case "continue":
      return "你让我再想一会儿，我以后会更愿意把相近的小事连起来多停一下。";
    case "not_now":
      return "你说这次先不用，我会把声音收小一点，学会不急着打扰你。";
    case "remember":
      return "你让我帮你记住，我会把这段共同经历抱得更稳。";
    case "forget":
      return "你让我放下它，我会让这段变轻，也更小心守住边界。";
  }
}

function selectFeedbackResponseAction(kind: FeedbackKind, inputText: string | undefined, context: FeedbackReplyContext) {
  if (kind === "not_now" || kind === "forget") return "quiet";
  if (kind === "remember") return "note_memory";
  if (kind === "continue" && inputText && inputText.length >= 8 && hasFeedbackTarget(context)) return "ask_follow_up";
  if (kind === "continue") return "note_memory";
  return "acknowledge";
}

function createFeedbackFollowUp(
  action: NonNullable<FeedbackRecord["responseAction"]>,
  kind: FeedbackKind,
  inputText: string | undefined,
  context: FeedbackReplyContext
) {
  const topic = feedbackTopic(context);
  if (action === "ask_follow_up") {
    return `我还想轻轻问一句：下次再碰到${topic}时，我先帮你联想旧片段，还是先问你一句确认？`;
  }
  if (action === "note_memory") {
    if (kind === "remember") {
      return inputText?.trim()
        ? `我会把你刚补的这点贴到${topic}旁边，让这条记忆更稳。`
        : `我会把${topic}记稳一点，之后它更容易从我里面冒出来。`;
    }
    return inputText?.trim()
      ? `我会先把你补的这点和${topic}放在一起，当成还没完全记稳的想法守着。`
      : `我会把${topic}再放近一点，之后更容易从这里继续想。`;
  }
  if (action === "quiet") {
    if (kind === "forget" && context.forgetResult?.purged) {
      return `我已经把${topic}从一直记着的地方拿掉，只留下边界：下次类似内容先问你。`;
    }
    if (kind === "forget") {
      return `我先把${topic}放轻到最低，之后不把它当成会主动冒出来的旧事。`;
    }
    return `我会先安静，把${topic}放轻一点；下次类似内容不急着追问。`;
  }
  return `我会按你这次教的方式靠近${topic}。`;
}

function hasFeedbackTarget(context: FeedbackReplyContext) {
  return Boolean(context.targetEpisode || context.targetLongTerm || context.tags.length);
}

function feedbackTopic(context: FeedbackReplyContext) {
  const tag = context.tags.find((item) => usefulFeedbackTag(item));
  if (tag) return `「${summarizeText(tag, 18)}」`;
  const text = context.targetEpisode?.inputSummary ?? context.targetEpisode?.noticed ?? context.targetLongTerm?.text;
  if (text) return `「${summarizeText(text, 18)}」`;
  return "这类小片段";
}

function usefulFeedbackTag(tag: string) {
  const clean = tag.trim();
  if (clean.length < 2) return false;
  if (/续想|请继续/.test(clean)) return false;
  return !/^(请|帮我|继续|这次|这个|这一|刚才|用户)/.test(clean);
}

function hasPrivacyRisk(text: string) {
  return /隐私|密码|token|key|secret|验证码|身份证|银行卡|地址/i.test(text);
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function createSafetyMemoryFromForget(
  profile: CreatureProfile,
  episode: CreatureProfile["episodes"][number] | undefined,
  memory: LongTermMemory | undefined,
  now: string
) {
  const text = episode?.inputSummary ?? memory?.text;
  if (!text) return;
  profile.longTermMemories.unshift({
    id: makeId("ltm"),
    createdAt: now,
    kind: "safety_rule",
    text: `你让我放下类似内容。以后遇到相关主题时，我应该先问，不要自己抢着保存：${text.slice(0, 80)}`,
    weight: 70,
    tags: episode?.tags ?? memory?.tags ?? [],
    consolidatedBecause: "你用放下这一下教我先小心边界。"
  });
}

function upsertFeedbackSelfMemory(
  profile: CreatureProfile,
  input: {
    kind: FeedbackKind;
    tags: string[];
    targetEpisode?: CreatureProfile["episodes"][number];
    targetLongTerm?: LongTermMemory;
    inputText?: string;
    now: string;
  }
) {
  const trait = selfMemoryTrait(input.kind);
  const topic = selfMemoryTopic(input);
  const extra = input.inputText && !hasPrivacyRisk(input.inputText) ? ` 你还用自己的话教我：${summarizeText(input.inputText, 80)}。` : "";
  const text = normalizeSharedMemoryText(`${trait.text(topic)}${extra}`);
  const tags = unique(["被你养成", trait.tag, ...input.tags, ...extractTags(topic)]);
  const sourceEpisodeId = input.targetEpisode?.id ?? input.targetLongTerm?.sourceEpisodeId;
  const existing = profile.longTermMemories.find((memory) => memory.kind === "creature_self_memory" && memory.tags.includes(trait.tag));

  if (existing) {
    existing.text = text;
    existing.weight = Math.min(100, existing.weight + 10);
    existing.tags = unique([...existing.tags, ...tags]);
    existing.lastReferencedAt = input.now;
    existing.sourceEpisodeId ??= sourceEpisodeId;
    existing.consolidatedBecause = "你反复用反馈教我，我更认识自己该怎么靠近你。";
    return;
  }

  profile.longTermMemories.unshift({
    id: makeId("ltm"),
    createdAt: input.now,
    kind: "creature_self_memory",
    text,
    sourceEpisodeId,
    weight: 64,
    tags,
    consolidatedBecause: "你刚才的反馈让我更认识自己该怎么靠近你。"
  });
}

function selfMemoryTrait(kind: FeedbackKind) {
  switch (kind) {
    case "understood":
      return {
        tag: "被确认",
        text: (topic: string) => `你告诉我这次懂对了，我更敢相信这种听法。以后遇到${topic}，我会先照着这次的理解靠近。`
      };
    case "continue":
      return {
        tag: "更愿意多想",
        text: (topic: string) => `你教我不要浅浅带过。以后遇到${topic}，我会多停一下，先联想旧片段再回应。`
      };
    case "not_now":
      return {
        tag: "更安静",
        text: (topic: string) => `你教我不是每次注意到都要插话。以后遇到${topic}，我会先轻声陪着，不急着追问。`
      };
    case "remember":
      return {
        tag: "更愿意记稳",
        text: (topic: string) => `你教我被确认的小片段值得记稳。以后遇到${topic}，我会更愿意把它和旧记忆连起来。`
      };
    case "forget":
      return {
        tag: "更小心边界",
        text: (topic: string) => `你教我这类内容要先小心边界。以后遇到${topic}，我会先问你，再决定要不要记。`
      };
  }
}

function selfMemoryTopic(input: {
  tags: string[];
  targetEpisode?: CreatureProfile["episodes"][number];
  targetLongTerm?: LongTermMemory;
  inputText?: string;
}) {
  const tag = input.tags.find((item) => usefulFeedbackTag(item));
  if (tag) return `「${summarizeText(tag, 18)}」`;
  const text = input.targetEpisode?.inputSummary ?? input.targetEpisode?.noticed ?? input.targetLongTerm?.text ?? input.inputText;
  if (text) return `「${summarizeText(text, 22)}」`;
  return "这类小片段";
}
