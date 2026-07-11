import assert from "node:assert/strict";
import { createCreatureProfile, normalizeCreatureProfile } from "../src/core/profile";
import { memoryShortTitle } from "../src/core/memory";

assert.equal(memoryShortTitle("用户今天去泳池游泳，人很多但还是很开心。", "泳池下午"), "泳池下午");
assert.equal(memoryShortTitle("你喜欢旺旺仙贝。"), "旺旺仙贝");
assert.equal(memoryShortTitle("用户提到 Jojo 会保护不属于自己的食物。", "Jojo 护食时刻"), "Jojo护食时刻");

const profile = createCreatureProfile({ userId: "short-title-user" });
profile.longTermMemories.push({
  id: "memory-old",
  createdAt: new Date().toISOString(),
  kind: "user_preference",
  text: "你喜欢在下午喝一杯可乐。",
  weight: 70,
  tags: [],
  attachments: []
});
normalizeCreatureProfile(profile);
assert.ok(profile.longTermMemories[0].shortTitle);
assert.ok([...profile.longTermMemories[0].shortTitle!].length >= 2);
assert.ok([...profile.longTermMemories[0].shortTitle!].length <= 8);

console.log(JSON.stringify({ ok: true, shortTitle: profile.longTermMemories[0].shortTitle }));
