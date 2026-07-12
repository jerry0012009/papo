import assert from "node:assert/strict";
import { runButtonHarness } from "../src/core/harness";
import { createCreatureProfile } from "../src/core/profile";
import { createModelProvider } from "../src/core/provider";

if (process.env.RUN_REAL_MODEL_SMOKE !== "1") {
  console.log(JSON.stringify({ skipped: true, reason: "set RUN_REAL_MODEL_SMOKE=1 to call the configured real text provider" }, null, 2));
  process.exit(0);
}

const profile = createCreatureProfile({ userId: "real-revision-smoke", creatureName: "Papo", petKind: "shiba" });
profile.actionCards = [{
  id: "vid_real_smoke_old_football",
  createdAt: "2026-06-01T10:00:00.000Z",
  title: "和 Papo 一起踢足球",
  caption: "旧动作卡",
  prompt: "historical prompt",
  durationSeconds: 8,
  video: { id: "vid_real_smoke_old_football", kind: "video", mime: "video/mp4", label: "旧动作卡", url: "/old.mp4" },
  sourceIds: ["smoke"],
  providerKind: "generic",
  providerName: "smoke fixture"
}];

const provider = createModelProvider();
const result = await runButtonHarness(
  profile,
  "之前有一张和 Papo 一起踢足球的动作卡。我今年32岁，旧卡画风太低龄，人物看起来不到十岁，希望调整或者做一张新的。",
  provider
);
const mediaResults = result.events.flatMap((event) => [event.actionResult, ...(event.backgroundActions ?? []).map((action) => action.actionResult)]);
const revision = mediaResults.find((item) => item?.kind === "action_card_draft");
assert.equal(result.events.length, 1);
assert.ok(result.response.trim(), "the real action model should acknowledge the explicit request");
assert.ok(revision?.prompt?.trim(), "the real text model should author the media prompt");
assert.equal(revision?.replacesActionCardId, "vid_real_smoke_old_football");
assert.match(revision?.prompt ?? "", /32|adult|成年/i);

console.log(JSON.stringify({
  ok: true,
  provider: provider.kind,
  model: provider.diagnostics?.textModel,
  fallbackProvider: provider.diagnostics?.textFallbackProvider,
  action: result.events[0].actionDecision.action,
  backgroundActions: result.events[0].backgroundActions?.map((action) => action.action) ?? [],
  promptLength: revision?.prompt?.length ?? 0,
  replacementId: revision?.replacesActionCardId
}, null, 2));
