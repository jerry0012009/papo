import type { CreatureProfile, EmergenceRecord } from "./types";

const HALF_HOUR_MINUTES = 30;
const AFTER_FIRST_UNANSWERED_MINUTES = 60;
const AFTER_SECOND_UNANSWERED_MINUTES = 12 * 60;

export function isProactiveEmergenceDue(profile: CreatureProfile, now = new Date().toISOString()) {
  const state = ensureProactiveState(profile, now);
  if (state.paused) return { due: false, reason: state.pauseReason ?? "paused_after_three_unanswered" };
  const next = Date.parse(state.nextCheckAt ?? now);
  if (!Number.isFinite(next)) return { due: true, reason: "invalid_next_check" };
  return {
    due: Date.parse(now) >= next,
    reason: Date.parse(now) >= next ? "due" : "waiting"
  };
}

export function markProactiveUserResponse(profile: CreatureProfile, now = new Date().toISOString()) {
  const state = ensureProactiveState(profile, now);
  if (state.pendingCount <= 0 && !state.paused) return false;
  state.pendingCount = 0;
  state.paused = false;
  state.pauseReason = undefined;
  state.lastUserResponseAt = now;
  state.nextCheckAt = addMinutes(now, HALF_HOUR_MINUTES);
  return true;
}

export function settleProactiveEmergence(profile: CreatureProfile, emergence: EmergenceRecord & { text: string }, now = new Date().toISOString()) {
  const state = ensureProactiveState(profile, now);
  state.lastCheckedAt = now;
  if (!emergence.text.trim()) {
    state.lastQuietAt = now;
    state.nextCheckAt = addMinutes(now, HALF_HOUR_MINUTES);
    return;
  }

  state.pendingCount = Math.max(0, Math.min(3, state.pendingCount + 1));
  state.lastActiveAt = now;
  emergence.delivery = "proactive";
  emergence.pendingIndex = state.pendingCount;
  const storedEmergence = profile.emergenceHistory.find((item) => item.id === emergence.id);
  if (storedEmergence) {
    storedEmergence.delivery = "proactive";
    storedEmergence.pendingIndex = state.pendingCount;
  }

  if (state.pendingCount >= 3) {
    state.paused = true;
    state.pauseReason = "three_unanswered_proactive_messages";
    state.nextCheckAt = undefined;
    return;
  }

  state.nextCheckAt = addMinutes(
    now,
    state.pendingCount === 1 ? AFTER_FIRST_UNANSWERED_MINUTES : AFTER_SECOND_UNANSWERED_MINUTES
  );
}

export function deferProactiveEmergence(profile: CreatureProfile, now = new Date().toISOString(), minutes = HALF_HOUR_MINUTES) {
  const state = ensureProactiveState(profile, now);
  state.lastCheckedAt = now;
  state.nextCheckAt = addMinutes(now, minutes);
}

export function proactivePromptContext(profile: CreatureProfile) {
  const state = ensureProactiveState(profile);
  return {
    pendingUnansweredMessages: state.pendingCount,
    paused: state.paused,
    nextCheckAt: state.nextCheckAt,
    lastCheckedAt: state.lastCheckedAt,
    lastActiveAt: state.lastActiveAt,
    lastUserResponseAt: state.lastUserResponseAt,
    pauseReason: state.pauseReason,
    cadence: {
      normalDecisionEveryMinutes: HALF_HOUR_MINUTES,
      afterFirstUnansweredMinutes: AFTER_FIRST_UNANSWERED_MINUTES,
      afterSecondUnansweredMinutes: AFTER_SECOND_UNANSWERED_MINUTES,
      afterThirdUnanswered: "pause_until_user_responds"
    }
  };
}

function ensureProactiveState(profile: CreatureProfile, now = new Date().toISOString()) {
  profile.proactive ??= {
    pendingCount: 0,
    paused: false,
    nextCheckAt: addMinutes(now, HALF_HOUR_MINUTES)
  };
  profile.proactive.pendingCount = Math.max(0, Math.min(3, Math.round(profile.proactive.pendingCount ?? 0)));
  profile.proactive.paused = Boolean(profile.proactive.paused);
  if (!profile.proactive.nextCheckAt && !profile.proactive.paused) {
    profile.proactive.nextCheckAt = addMinutes(now, HALF_HOUR_MINUTES);
  }
  return profile.proactive;
}

function addMinutes(iso: string, minutes: number) {
  const base = Date.parse(iso);
  const at = Number.isFinite(base) ? base : Date.now();
  return new Date(at + minutes * 60_000).toISOString();
}
