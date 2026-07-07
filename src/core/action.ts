import type { ActionDecision, ActionKind, AttentionEvent, CreatureProfile } from "./types";

export interface ActionSelectionInput {
  profile: CreatureProfile;
  source: AttentionEvent["source"];
  text: string;
  attentionStrength: number;
  privacyRisk: number;
  relatedMemoryIds: string[];
  llmSuggestedAction?: ActionKind;
}

export function selectAction(input: ActionSelectionInput): ActionDecision {
  const action = input.llmSuggestedAction ?? "observe";
  const confidence = input.llmSuggestedAction ? 100 : 0;

  return {
    action,
    confidence,
    reason: input.llmSuggestedAction ? "model selected this whitelisted action." : "structural placeholder before model action selection.",
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
    llmSuggestedAction
  });
}
