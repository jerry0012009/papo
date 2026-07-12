import assert from "node:assert/strict";
import { createCreatureProfile } from "../src/core/profile";
import type { ModelProvider } from "../src/core/provider";
import { updateClientDocument } from "../src/core/client-document";
import { applyMemoryVisualPlan, planMemoryVisual } from "../src/server/memory-visual";

const profile = createCreatureProfile({ userId: "memory-experience", creatureName: "Papo", now: "2026-07-11T10:00:00.000Z" });
profile.longTermMemories.push({
  id: "ltm_walk",
  createdAt: "2026-07-11T10:01:00.000Z",
  kind: "habit",
  text: "Jerry 明确说以后希望被称作 Jerry，并且喜欢傍晚散步。",
  weight: 70,
  tags: ["称呼", "散步"]
});

const provider = {
  kind: "mimo", name: "test", available: true, usesRealModel: false,
  async generate() { return ""; },
  async generateJson(prompt: string) {
    if (prompt.includes("Client.md 维护脑")) return {
      preferredName: "Jerry",
      facts: [{ dimension: "leisure", text: "Jerry 喜欢傍晚散步", confidence: 95, sourceIds: ["ltm_walk"] }]
    };
    return {
      shortTitle: "傍晚散步",
      narrative: "我记得 Jerry 喜欢在傍晚出去走一走，这是一段值得我留在心里的日常。",
      imagePrompt: "Square hand-painted gouache memory scene of Papo accompanying Jerry on an evening walk, visible brush texture, no text.",
      visualMode: "imaginative_illustration", papoPresence: "required", visualReason: "这是共同经历，小动物参与画面",
      relatedMemoryIds: [], needsClientReferences: false
    };
  },
  async summarizeImage() { return ""; }, async observeAudio() { return ""; },
  async generateImage() { throw new Error("not used"); }
} satisfies ModelProvider;

await updateClientDocument(profile, provider, ["ltm_walk"]);
assert.equal(profile.clientDocument?.preferredName, "Jerry");
assert.match(profile.clientDocument?.markdown ?? "", /Jerry 喜欢傍晚散步/);

const memory = profile.longTermMemories[0];
const originalFact = memory.text;
const plan = await planMemoryVisual(profile, memory, provider);
applyMemoryVisualPlan(memory, plan);
assert.equal(memory.text, originalFact, "the presentation layer must not overwrite the canonical fact");
assert.match(memory.narrative ?? "", /^我记得 Jerry/);
assert.equal(memory.shortTitle, "傍晚散步");
