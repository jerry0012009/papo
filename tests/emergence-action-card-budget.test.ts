import assert from "node:assert/strict";
import test from "node:test";
import { semanticDecideEmergence } from "../src/core/emergence";
import { createCreatureProfile } from "../src/core/profile";
import type { ModelProvider } from "../src/core/provider";

test("emergence creates at most one action card per local day and resets next day", async () => {
  const profile = createCreatureProfile({ userId: "emergence-card-budget", creatureName: "Papo", now: "2026-07-13T08:00:00.000Z" });
  profile.longTermMemories.unshift({
    id: "ltm_walk",
    createdAt: "2026-07-13T08:00:00.000Z",
    kind: "habit",
    text: "用户喜欢傍晚散步。",
    weight: 80,
    tags: ["散步"]
  });
  const provider: ModelProvider = {
    kind: "generic", name: "emergence budget fake", available: true, usesRealModel: true,
    async generate() { return ""; },
    async generateJson() {
      return {
        shouldEmerge: true,
        memoryId: "ltm_walk",
        driveSource: "memory_resonance",
        whyNow: "现在适合轻轻想起散步。",
        message: "我想起你喜欢傍晚散步。",
        proactiveLevel: "gentle",
        actionCardDraft: {
          title: "一起散步",
          prompt: "Papo 在傍晚的小路上轻轻迈步",
          stateId: "desk_companion",
          statusText: "Papo 正陪你慢慢走。",
          durationSeconds: 4
        }
      };
    },
    async summarizeImage() { return ""; }, async observeAudio() { return ""; },
    async generateImage() { throw new Error("not used"); }
  };

  const first = await semanticDecideEmergence(profile, provider, "2026-07-13T10:00:00.000Z", { delivery: "proactive" });
  assert.equal(first.actionResult?.kind, "action_card_draft");

  const sameDay = await semanticDecideEmergence(profile, provider, "2026-07-13T10:11:00.000Z", { delivery: "proactive" });
  assert.equal(sameDay.actionResult, undefined);
  assert.ok(sameDay.ruleTrace.includes("guardrail: daily emergence action-card budget exhausted"));

  const nextDay = await semanticDecideEmergence(profile, provider, "2026-07-14T10:00:00.000Z", { delivery: "proactive" });
  assert.equal(nextDay.actionResult?.kind, "action_card_draft");
});
