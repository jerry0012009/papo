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
  const blockedActions: ActionDecision["blockedActions"] = [];
  const safetyNotes: string[] = [];
  const trace: string[] = [];
  let action = baselineAction(input);
  let confidence = 58;

  trace.push(`baseline=${action}`);

  if (input.llmSuggestedAction) {
    trace.push(`llm_suggested=${input.llmSuggestedAction}`);
    action = input.llmSuggestedAction;
    confidence += 5;
  }

  if (input.profile.state.energy < 28 && action !== "quiet") {
    blockedActions.push({ action, reason: "energy guardrail limits expansive action" });
    action = action === "respond" && input.attentionStrength > 55 ? "respond" : input.attentionStrength > 70 ? "observe" : "quiet";
    safetyNotes.push("energy guardrail kept the action small.");
  }

  confidence += input.relatedMemoryIds.length * 4;
  confidence += input.attentionStrength > 75 ? 8 : 0;
  confidence -= blockedActions.length * 5;
  confidence = Math.max(30, Math.min(96, Math.round(confidence)));

  return {
    action,
    confidence,
    reason: explainAction(action, input),
    blockedActions,
    safetyNotes,
    llmSuggestedAction: input.llmSuggestedAction,
    ruleTrace: trace
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

function baselineAction(input: ActionSelectionInput): ActionKind {
  if (input.profile.state.energy < 25) return "quiet";
  if (input.attentionStrength >= input.profile.policyProfile.saveThreshold) return "observe";
  return "observe";
}

function explainAction(action: ActionKind, input: ActionSelectionInput) {
  void input;
  switch (action) {
    case "respond":
      return "llm selected a visible response within guardrails.";
    case "ask":
      return "guardrails require confirmation before expanding.";
    case "save_episode":
      return "llm selected an episodic save within guardrails.";
    case "save_long_term":
      return "llm selected a long-term save within guardrails.";
    case "recall":
      return "llm selected recall within guardrails.";
    case "review":
      return "llm selected review within guardrails.";
    case "quiet":
      return "guardrails kept the action quiet.";
    case "draft_reminder":
      return "llm selected reminder drafting within guardrails.";
    case "draft_question_list":
      return "llm selected question-list drafting within guardrails.";
    default:
      return "structural baseline keeps the candidate observable until the model decides.";
  }
}
