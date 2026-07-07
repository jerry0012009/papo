import { summarizeText } from "./text";
import type {
  ActionKind,
  AttentionEvent,
  CreatureExperience,
  CreatureProfile,
  CuriousSessionAudit,
  EpisodeMemory,
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
    return "你在叫我，我抬头回你一声。";
  }
  if (input.relatedMemories.length) {
    return "这件事让我想起以前相关的内容。";
  }
  if (input.privacyRisk > 65) {
    return "这里可能有隐私内容，所以我会谨慎处理。";
  }
  if (strongest?.key === "emotional_charge") {
    return "这里有情绪，我不会把它当成普通背景音。";
  }
  if (strongest?.key === "future_value") {
    return "这件事之后可能还要再看。";
  }
  if (strongest?.key === "identity_relevance") {
    return "这会影响我以后怎么回应你。";
  }
  if (input.action === "respond") {
    return "我会直接回你一声。";
  }
  return "你主动告诉我这件事，所以我会认真听。";
}

export function createEpisodeExperience(episode: EpisodeMemory, profile: CreatureProfile): CreatureExperience {
  return episode.creatureExperience ?? {
    earReason: `我刚才注意到：${episode.noticed}`,
    rememberedScene: episode.relatedMemoryIds.length ? "这和我以前记住的一段经历有关。" : undefined,
    actionFeeling: episode.actionDecision ? actionFeeling(episode.actionDecision.action, profile) : "我会回你一声。",
    saveFeeling: episode.promotedToLongTerm
      ? "你已经让我记住它。"
      : "要不要一直记着它，我会看你的反馈。"
  };
}

export function createCuriousCreatureReport(session: CuriousSessionAudit): string {
  const selectedCount = session.selected.length;
  const privacyIgnored = session.ignored.find((item) => item.score.privacyRisk > 0);
  const repeatedIgnored = session.ignored.find((item) => item.score.redundancyPenalty > 0);
  const parts = [
    selectedCount > 0 ? "我刚才听见了需要回应的事。" : "我刚才先安静陪着，没有打断你。",
    session.selected[0] ? `${session.selected[0].label} 更需要回应：${session.selected[0].whySelected}` : undefined,
    privacyIgnored ? `${privacyIgnored.label} 里可能有隐私内容，我会等你的意思。` : undefined,
    repeatedIgnored ? `${repeatedIgnored.label} 和前面太像，我先不重复回应。` : undefined
  ].filter(Boolean);
  return parts.join(" ");
}

function actionFeeling(action: ActionKind, profile: CreatureProfile) {
  const base = baseActionFeeling(action, profile);
  const raised = raisedActionFeeling(action, profile);
  return raised ? `${base}${raised}` : base;
}

function baseActionFeeling(action: ActionKind, profile: CreatureProfile) {
  switch (action) {
    case "respond":
      return "我想先回你一句，让你知道我听见了。";
    case "ask":
      return profile.state.confidence < 55
        ? "我更想先轻轻问你一句，确认我有没有理解错。"
        : "我想先问你一句，因为直接保存或展开还不够稳。";
    case "recall":
      return "我会把以前相关的事一起考虑。";
    case "review":
      return "我想把它整理成一次小复盘，帮你看清这件事为什么重要。";
    case "quiet":
      return "我会短一点回应，先安静陪着，不急着打扰你。";
    case "draft_reminder":
      return "我感觉这件事之后可能还要再看。";
    case "draft_question_list":
      return "我感觉它还没想完，所以我先把里面几处没弄清的小结轻轻分开。";
    case "save_long_term":
      return "我觉得它可能值得一直记着，但还要看你的意思。";
    case "save_episode":
      return "我会记住这次发生了什么，等你之后再纠正我。";
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
    return "你把我教得愿意多停一下，所以我会把相关的旧事也一起考虑。";
  }
  return "";
}

function saveFeeling(action: ActionKind, privacyRisk: number) {
  if (privacyRisk > 65) return "这里可能有隐私边界，我会先等你的意思。";
  if (action === "save_long_term") return "它像是值得记稳的事，但我会等你点头。";
  if (action === "save_episode" || action === "recall" || action === "respond") return "我会记住这次发生了什么，但不会自己把它放得太重。";
  return "这次我先不急着记得太重。";
}
