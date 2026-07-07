import type { ActionDecision, ActionKind, AttentionEvent, CreatureProfile } from "./types";

export function structuralActionPlaceholder(): ActionDecision {
  return {
    action: "observe",
    confidence: 0,
    reason: "structural placeholder before model action selection.",
    blockedActions: [],
    safetyNotes: [],
    ruleTrace: ["structural_placeholder=awaiting_llm_action"]
  };
}

export function guardActionDecision(event: AttentionEvent, profile: CreatureProfile, llmSuggestedAction: ActionKind): ActionDecision {
  void event;
  void profile;
  return {
    action: llmSuggestedAction,
    confidence: 100,
    reason: "model selected this whitelisted action.",
    blockedActions: [],
    safetyNotes: [],
    llmSuggestedAction,
    ruleTrace: [`llm_selected=${llmSuggestedAction}`]
  };
}
