import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const actionSource = readFileSync(new URL("../src/core/action.ts", import.meta.url), "utf8");
const semanticActionSource = readFileSync(new URL("../src/core/semantic-action.ts", import.meta.url), "utf8");

assert.equal(actionSource.includes("llmSuggestedAction ??"), false, "action guard must not invent a semantic default action");
assert.equal(actionSource.includes("structural_default=observe"), false, "structural placeholders must not be exposed as rule-selected actions");
assert.equal(semanticActionSource.includes("currentGuardedAction"), false, "action prompt must not bias the model with a rule-selected action");
assert.equal(semanticActionSource.includes("blockedActions: event.actionDecision.blockedActions"), false, "action prompt should not expose placeholder guard fields as semantic context");

console.log(JSON.stringify({ ok: true }, null, 2));
