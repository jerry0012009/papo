import assert from "node:assert/strict";
import { DOG_STATE_CATALOG } from "../src/core/dog-states";

const ids = new Set(DOG_STATE_CATALOG.map((state) => state.id));

assert.ok(DOG_STATE_CATALOG.length >= 100, "Papo should have at least 100 selectable external states");
assert.equal(ids.size, DOG_STATE_CATALOG.length, "Papo external state ids must be unique");
assert.ok(DOG_STATE_CATALOG.every((state) => state.actionText.trim().startsWith("Papo")), "Each state should have a visible Papo action line");

console.log(JSON.stringify({ ok: true, states: DOG_STATE_CATALOG.length }));
