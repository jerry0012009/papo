import assert from "node:assert/strict";
import { DOG_STATE_CATALOG, applyPetTouchState } from "../src/core/dog-states";
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

console.log(JSON.stringify({ ok: true, states: DOG_STATE_CATALOG.length }));
