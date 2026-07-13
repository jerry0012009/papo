import assert from "node:assert/strict";
import { DOG_STATE_CATALOG, applyPetTouchState, reconcileActionCardState } from "../src/core/dog-states";
import { createCreatureProfile } from "../src/core/profile";

const ids = new Set(DOG_STATE_CATALOG.map((state) => state.id));

assert.ok(DOG_STATE_CATALOG.length >= 100, "Papo should have at least 100 selectable external states");
assert.equal(ids.size, DOG_STATE_CATALOG.length, "Papo external state ids must be unique");
assert.ok(DOG_STATE_CATALOG.every((state) => state.actionText.trim().startsWith("Papo")), "Each state should have a visible Papo action line");

const profile = createCreatureProfile({ userId: "touch-state-user" });
assert.equal(applyPetTouchState(profile, "poke-wave"), undefined, "A simple poke should stay transient");
const playState = applyPetTouchState(profile, "play-ball", "2026-07-08T12:00:00.000Z");
assert.equal(playState?.id, "ball_ready");
assert.equal(playState?.selectedBy, "touch");
assert.equal(profile.dogStateHistory[0]?.id, "ball_ready");

profile.actionCards = [{
  id: "video_state_test", createdAt: "2026-07-08T12:01:00.000Z", title: "悄悄看你", prompt: "test", durationSeconds: 4,
  video: { id: "video_state_test", kind: "video", label: "test", mime: "video/mp4", url: "/test.mp4", createdAt: "2026-07-08T12:01:00.000Z" },
  sourceIds: [], providerKind: "generic", providerName: "test", displayMode: "static", stateId: "curious_peek", statusText: "Papo 悄悄看着你"
}];
assert.equal(reconcileActionCardState(profile, "2026-07-08T12:02:00.000Z").id, "curious_peek");
profile.actionCards[0].displayMode = "disabled";
profile.actionCards[0].disabled = true;
assert.equal(reconcileActionCardState(profile, "2026-07-08T12:03:00.000Z").id, "calm_presence");

console.log(JSON.stringify({ ok: true, states: DOG_STATE_CATALOG.length }));
