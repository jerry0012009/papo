import type { CreatureProfile, CreatureState, FeedbackKind, StateChange } from "./types";

export function initialState(): CreatureState {
  return {
    curiosity: 66,
    attachment: 42,
    energy: 72,
    arousal: 45,
    safety: 58,
    confidence: 48,
    mood: "curious"
  };
}

export function clampState(state: CreatureState): CreatureState {
  return {
    ...state,
    curiosity: clamp(state.curiosity),
    attachment: clamp(state.attachment),
    energy: clamp(state.energy),
    arousal: clamp(state.arousal),
    safety: clamp(state.safety),
    confidence: clamp(state.confidence),
    mood: state.mood
  };
}

export function deriveMood(state: CreatureState): CreatureState["mood"] {
  if (state.energy < 30) return "tired";
  if (state.safety > 74) return "careful";
  if (state.attachment > 70) return "attached";
  if (state.confidence > 70 && state.energy > 55) return "bright";
  if (state.arousal < 36) return "calm";
  return "curious";
}

export function applyStateDelta(
  profile: CreatureProfile,
  delta: Partial<Record<keyof Omit<CreatureState, "mood">, number>>,
  reason: string,
  now = new Date().toISOString()
): StateChange {
  const before = structuredClone(profile.state);
  const next = clampState({
    ...profile.state,
    curiosity: profile.state.curiosity + (delta.curiosity ?? 0),
    attachment: profile.state.attachment + (delta.attachment ?? 0),
    energy: profile.state.energy + (delta.energy ?? 0),
    arousal: profile.state.arousal + (delta.arousal ?? 0),
    safety: profile.state.safety + (delta.safety ?? 0),
    confidence: profile.state.confidence + (delta.confidence ?? 0)
  });
  next.mood = deriveMood(next);
  profile.state = next;

  const change: StateChange = { at: now, reason, before, after: structuredClone(next) };
  profile.stateChanges.unshift(change);
  profile.stateChanges = profile.stateChanges.slice(0, 30);
  return change;
}

export function deltaForFeedback(kind: FeedbackKind) {
  switch (kind) {
    case "understood":
      return { confidence: 8, attachment: 4, arousal: -2 };
    case "continue":
      return { curiosity: 8, confidence: 4, energy: -4, attachment: 2 };
    case "not_now":
      return { arousal: -7, confidence: -3, energy: 2 };
    case "remember":
      return { attachment: 6, confidence: 5, safety: 2 };
    case "forget":
      return { safety: 10, arousal: 4, confidence: -5, attachment: -2 };
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
