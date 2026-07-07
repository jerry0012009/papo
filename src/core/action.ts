import type { ActionDecision, ActionKind, AttentionEvent, CreatureProfile, SegmentScore } from "./types";

export interface ActionSelectionInput {
  profile: CreatureProfile;
  source: AttentionEvent["source"];
  text: string;
  attentionStrength: number;
  privacyRisk: number;
  relatedMemoryIds: string[];
  score?: SegmentScore;
  llmSuggestedAction?: ActionKind;
}

export function selectAction(input: ActionSelectionInput): ActionDecision {
  const action = input.llmSuggestedAction ?? "observe";
  let confidence = input.llmSuggestedAction ? 70 : 45;

  confidence += input.relatedMemoryIds.length * 4;
  confidence += input.attentionStrength > 75 ? 8 : 0;
  confidence = Math.max(30, Math.min(96, Math.round(confidence)));

  return {
    action,
    confidence,
    reason: explainAction(action, input),
    blockedActions: [],
    safetyNotes: [],
    llmSuggestedAction: input.llmSuggestedAction,
    ruleTrace: [
      input.llmSuggestedAction ? `llm_selected=${input.llmSuggestedAction}` : "structural_default=observe"
    ]
  };
}

export function guardActionDecision(event: AttentionEvent, profile: CreatureProfile, llmSuggestedAction?: ActionKind) {
  return selectAction({
    profile,
    source: event.source,
    text: event.triggerContent,
    attentionStrength: event.attentionStrength,
    privacyRisk: event.privacyRisk,
    relatedMemoryIds: event.relatedMemoryIds,
    score: event.scoreBreakdown,
    llmSuggestedAction
  });
}

function explainAction(action: ActionKind, input: ActionSelectionInput) {
  void input;
  switch (action) {
    case "respond":
      return "llm selected a visible response.";
    case "ask":
      return "llm selected a question.";
    case "save_episode":
      return "llm selected an episodic save.";
    case "save_long_term":
      return "llm selected a long-term save.";
    case "recall":
      return "llm selected recall.";
    case "review":
      return "llm selected review.";
    case "quiet":
      return "llm selected quiet.";
    case "draft_reminder":
      return "llm selected reminder drafting.";
    case "draft_question_list":
      return "llm selected question-list drafting.";
    default:
      return "structural default keeps the candidate observable until the model decides.";
  }
}
