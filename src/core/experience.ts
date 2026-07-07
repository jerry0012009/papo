import { summarizeText } from "./text";
import type {
  ActionKind,
  AttentionEvent,
  CreatureExperience,
  CreatureProfile,
  CuriousSessionAudit,
  EpisodeMemory,
  FeedbackKind,
  LongTermMemory,
  SegmentScore
} from "./types";

export function createAttentionExperience(input: {
  profile: CreatureProfile;
  triggerContent: string;
  relatedMemories: LongTermMemory[];
  score: SegmentScore;
  action: ActionKind;
  privacyRisk: number;
}): CreatureExperience {
  const strongest = [...input.score.contributions]
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value)[0];
  const rememberedScene = input.relatedMemories[0]
    ? `我想起之前那段：${summarizeText(input.relatedMemories[0].text, 82)}`
    : undefined;
  return {
    earReason: earReason(input, strongest),
    rememberedScene,
    actionFeeling: actionFeeling(input.action, input.profile),
    saveFeeling: saveFeeling(input.action, input.privacyRisk),
    learnedHint: "如果你反馈我，我会把这次经历变成以后注意你的方式。"
  };
}

function earReason(
  input: {
    triggerContent: string;
    relatedMemories: LongTermMemory[];
    action: ActionKind;
    privacyRisk: number;
  },
  strongest?: SegmentScore["contributions"][number]
) {
  if (/说句话|说话|回复|回答|你在吗|你好|hello|汪|打招呼|听见|听到|回应|叫你/i.test(input.triggerContent)) {
    return "我刚才竖起耳朵，是因为你在对我发出一个需要回应的小信号。";
  }
  if (input.relatedMemories.length) {
    return "我刚才竖起耳朵，是因为这段碰到了我们以前留下的一点记忆。";
  }
  if (input.privacyRisk > 65) {
    return "我刚才竖起耳朵，是因为这里可能有需要保护的隐私。";
  }
  if (strongest?.key === "emotional_charge") {
    return "我刚才竖起耳朵，是因为这段里有情绪，不适合被当成普通背景音。";
  }
  if (strongest?.key === "future_value") {
    return "我刚才竖起耳朵，是因为这段以后可能还会回来找你。";
  }
  if (strongest?.key === "identity_relevance") {
    return "我刚才竖起耳朵，是因为这段在影响我应该长成什么样。";
  }
  if (input.action === "respond") {
    return "我刚才竖起耳朵，是因为最自然的下一步是先回应你。";
  }
  return "我刚才竖起耳朵，是因为你把这一小段直接递给了我，我需要认真听懂。";
}

export function createEpisodeExperience(episode: EpisodeMemory, profile: CreatureProfile): CreatureExperience {
  return episode.creatureExperience ?? {
    earReason: `我刚才注意到：${episode.noticed}`,
    rememberedScene: episode.relatedMemoryIds.length ? "这和我以前记住的一段经历有关。" : undefined,
    actionFeeling: episode.actionDecision ? actionFeeling(episode.actionDecision.action, profile) : "我先把它轻轻放进情景记忆。",
    saveFeeling: episode.promotedToLongTerm
      ? "它已经被你允许长成长期记忆。"
      : "它现在先是一条情景记忆，是否长期保存要看你的反馈。"
  };
}

export function createCuriousCreatureReport(session: CuriousSessionAudit): string {
  const selectedCount = session.selected.length;
  const privacyIgnored = session.ignored.find((item) => item.score.privacyRisk > 0);
  const repeatedIgnored = session.ignored.find((item) => item.score.redundancyPenalty > 0);
  const parts = [
    `我刚才陪你看了 ${session.totalSegments} 段，只认真盯住了 ${selectedCount} 段。`,
    session.selected[0] ? `${session.selected[0].label} 让我竖起耳朵：${session.selected[0].whySelected}` : "这组信息都很轻，我没有强行记住全部。",
    privacyIgnored ? `${privacyIgnored.label} 有隐私味道，我没有直接长期保存。` : undefined,
    repeatedIgnored ? `${repeatedIgnored.label} 和前面太像，我把它当作重复声音放低了。` : undefined,
    `当时我的状态影响了选择：${session.stateInfluence}`
  ].filter(Boolean);
  return parts.join(" ");
}

export function createLearningNote(kind: FeedbackKind, tags: string[] = [], feedbackText?: string): string {
  const topic = tags.length ? "这个主题" : "这类内容";
  const userLine = feedbackText?.trim() ? ` 你还补充说：${summarizeText(feedbackText, 72)}。` : "";
  switch (kind) {
    case "understood":
      return `我学到：这次理解方向是对的。以后遇到${topic}，我会更相信这种注意方式。${userLine}`;
    case "continue":
      return `我学到：${topic}你希望我不要浅浅带过。以后我会更愿意联想旧记忆，并展开一点。${userLine}`;
    case "not_now":
      return `我学到：不是每次注意到东西都要打扰你。以后遇到${topic}，我会更安静。${userLine}`;
    case "remember":
      return `我学到：${topic}值得成为我们之间更稳定的长期记忆。${userLine}`;
    case "forget":
      return `我学到：${topic}要更谨慎。以后我会先问你，不会直接长期保存。${userLine}`;
  }
}

function actionFeeling(action: ActionKind, profile: CreatureProfile) {
  const base = baseActionFeeling(action, profile);
  const raised = raisedActionFeeling(action, profile);
  return raised ? `${base}${raised}` : base;
}

function baseActionFeeling(action: ActionKind, profile: CreatureProfile) {
  switch (action) {
    case "respond":
      return "我想先回你一句，让你知道我听见了，而不是躲在后台只做分析。";
    case "ask":
      return profile.state.confidence < 55
        ? "我更想先轻轻问你一句，确认我有没有理解错。"
        : "我想先问你一句，因为直接保存或展开还不够稳。";
    case "recall":
      return "我更想把旧片段拉回来一起看，而不是把它当成孤立的新消息。";
    case "review":
      return "我想把它整理成一次小复盘，帮你看清这件事为什么重要。";
    case "quiet":
      return "我会短一点回应，先安静陪着，不急着打扰你。";
    case "draft_reminder":
      return "我感觉它可能以后还会回来，所以更像一张提醒草稿。";
    case "draft_question_list":
      return "我感觉它像一个还没想完的问题，可以拆成几个小问题。";
    case "save_long_term":
      return "我觉得它可能值得变成长期记忆，但仍需要规则和你的反馈确认。";
    case "save_episode":
      return "我想先把它写成我们共同经历过的一小段。";
    default:
      return "我先观察它，不急着行动。";
  }
}

function raisedActionFeeling(action: ActionKind, profile: CreatureProfile) {
  const policy = profile.policyProfile;
  if (policy.quietTendency >= 58 && ["ask", "quiet", "observe", "draft_reminder", "draft_question_list"].includes(action)) {
    return "你把我养得更会收住声音，所以我会把话放轻，不急着追问你。";
  }
  if ((policy.preferDepth >= 65 || policy.recallTendency >= 65) && ["ask", "recall", "review", "save_episode", "observe", "respond", "draft_reminder", "draft_question_list"].includes(action)) {
    return "你把我养得愿意多停一下，所以我会把这段和旧片段贴近一点，不浅浅放过。";
  }
  return "";
}

function saveFeeling(action: ActionKind, privacyRisk: number) {
  if (privacyRisk > 65) return "这里有隐私风险，我不会直接长期保存。";
  if (action === "save_long_term") return "它像是可以长期记住的东西，但我会等确认。";
  if (action === "save_episode" || action === "recall" || action === "respond") return "我会先形成情景记忆，不把它无脑塞进长期记忆。";
  return "这次我先不急着保存成长期记忆。";
}
