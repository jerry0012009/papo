import assert from "node:assert/strict";
import test from "node:test";
import { handleCuriousStream, scoreSegment } from "../src/core/attention";
import { createCreatureProfile } from "../src/core/profile";
import type { StreamSegment } from "../src/core/types";

test("a user-initiated companion photo receives a durable attention bonus", () => {
  const profile = createCreatureProfile({ userId: "manual-capture-attention", creatureName: "Papo" });
  const base: StreamSegment = {
    id: "native-camera-image",
    kind: "image_summary",
    label: "后置摄像头看到的画面",
    content: "健身房里有一排紫色器械。",
    observedAt: "2026-07-13T07:37:03.606Z",
    batchId: "native-1783928209337-camera-002",
    companionSessionId: "native-1783928209337"
  };
  const scheduled = scoreSegment(profile, { ...base, captureIntent: "scheduled" });
  const manual = scoreSegment(profile, { ...base, captureIntent: "user_initiated" });

  assert.equal(scheduled.userIntentBonus, 0);
  assert.equal(manual.userIntentBonus, 28);
  assert.equal(manual.total - scheduled.total, 28);

  const result = handleCuriousStream(profile, [{ ...base, captureIntent: "user_initiated" }], "2026-07-13T07:37:04.000Z");
  assert.equal(result.attentionCandidates?.[0].segment.captureIntent, "user_initiated");
  assert.match(result.attentionCandidates?.[0].segment.content ?? "", /拍摄方式：用户主动从陪伴通知取景/);
});
