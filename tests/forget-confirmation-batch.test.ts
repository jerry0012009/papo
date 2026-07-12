import assert from "node:assert/strict";
import { applyFeedback, recordExplicitForgetConfirmation } from "../src/core/feedback";
import { createCreatureProfile } from "../src/core/profile";

const profile = createCreatureProfile({ userId: "forget-batch-user", creatureName: "Papo" });
profile.memoryCandidates = ["one", "two", "three"].map((id, index) => ({
  id: `candidate_${id}`,
  sourceEpisodeId: `episode_${id}`,
  createdAt: `2026-07-12T10:00:0${index}.000Z`,
  candidateText: `候选内容 ${id}`,
  memoryKind: "habit" as const,
  confidence: 70,
  whyConsolidate: "测试候选",
  writePolicy: "ask_user" as const,
  decayPolicy: "forget_if_dismissed" as const,
  status: "candidate" as const,
  tags: []
}));

for (const [index, targetId] of ["candidate_one", "candidate_two"].entries()) {
  const at = `2026-07-12T10:00:${String(index * 20).padStart(2, "0")}.000Z`;
  const feedback = applyFeedback(profile, { kind: "forget", targetId, modality: "button", now: at });
  recordExplicitForgetConfirmation(profile, feedback, at);
}

let confirmations = profile.conversation.filter((message) => message.sourceId?.startsWith("forget_batch:"));
assert.equal(confirmations.length, 1, "forget clicks inside 60 seconds should reuse one durable message");
assert.equal(confirmations[0].text, "已忘记 2 条内容 ✓");
assert.equal(profile.feedbackHistory[0].forgetBatchId, profile.feedbackHistory[1].forgetBatchId);
assert.equal(profile.conversation.some((message) => message.role === "user"), false);

const nextAt = "2026-07-12T10:01:01.000Z";
const next = applyFeedback(profile, { kind: "forget", targetId: "candidate_three", modality: "button", now: nextAt });
recordExplicitForgetConfirmation(profile, next, nextAt);
confirmations = profile.conversation.filter((message) => message.sourceId?.startsWith("forget_batch:"));
assert.equal(confirmations.length, 2, "a forget after the cooldown should begin a new batch");
assert.equal(confirmations.find((message) => message.at === nextAt)?.text, "已忘记 1 条内容 ✓");

console.log(JSON.stringify({ ok: true }, null, 2));
