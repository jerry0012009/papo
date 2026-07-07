import { makeId } from "./ids";
import { applyStateDelta } from "./state";
import type { CreatureProfile, WakeEvent } from "./types";

const MINUTE = 60_000;

export function wakeCreature(profile: CreatureProfile, now = new Date().toISOString()): WakeEvent {
  const previousSeenAt = parseSeenAt(profile.lastSeenAt ?? profile.createdAt, now);
  const elapsedMinutes = Math.max(0, Math.floor((Date.parse(now) - previousSeenAt.getTime()) / MINUTE));
  const stateDelta = deltaForElapsedMinutes(elapsedMinutes);
  const stateChangeReason = reasonForElapsedMinutes(elapsedMinutes);

  if (Object.keys(stateDelta).length > 0) {
    applyStateDelta(profile, stateDelta, stateChangeReason, now);
  }

  const wakeId = makeId("wake");
  profile.lastSeenAt = now;
  const event: WakeEvent = {
    id: wakeId,
    at: now,
    elapsedMinutes,
    message: "",
    relatedMemoryIds: [],
    stateChangeReason,
    stateDelta,
    ruleTrace: [
      `elapsed_minutes=${elapsedMinutes}`,
      Object.keys(stateDelta).length > 0 ? "state_delta=applied" : "state_delta=none"
    ]
  };
  profile.wakeHistory.unshift(event);
  profile.wakeHistory = profile.wakeHistory.slice(0, 20);
  return event;
}

function parseSeenAt(value: string | undefined, now: string) {
  const parsed = value ? new Date(value) : new Date(now);
  if (Number.isNaN(parsed.getTime())) return new Date(now);
  return parsed;
}

function deltaForElapsedMinutes(elapsedMinutes: number): WakeEvent["stateDelta"] {
  if (elapsedMinutes < 10) return {};
  if (elapsedMinutes < 60) {
    return {
      energy: Math.min(8, Math.floor(elapsedMinutes / 10) + 2),
      arousal: -3
    };
  }
  if (elapsedMinutes < 360) {
    return {
      energy: 14,
      arousal: -6,
      curiosity: 3,
      safety: 2
    };
  }
  return {
    energy: 18,
    arousal: -8,
    curiosity: 5,
    attachment: 2,
    safety: 3
  };
}

function reasonForElapsedMinutes(elapsedMinutes: number) {
  if (elapsedMinutes < 10) return "app_wake_short_gap";
  if (elapsedMinutes < 60) return "app_wake_brief_rest";
  if (elapsedMinutes < 360) return "app_wake_after_rest";
  return "app_wake_after_long_absence";
}
