import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../src/web/App.tsx", import.meta.url), "utf8");

const forbiddenVisibleTemplates = [
  "刚陪你听了一会儿",
  "刚学会一点你的意思",
  "收到了你刚给的事",
  "Papo 刚回了你一句",
  "文字、照片或声音会留在同一次对话里",
  "我还没有真正记下一件和你有关的事"
];

for (const phrase of forbiddenVisibleTemplates) {
  assert.equal(appSource.includes(phrase), false, `rule-written visible copy returned: ${phrase}`);
}

assert.equal(appSource.includes("hasActiveHermesTask || pendingActionCards > 0 || pendingPetMotions ? 3_000 : 60_000"), true, "active Hermes tasks, pending action cards, and pet motion jobs should poll quickly so async results surface without a stale waiting notice");
assert.equal(appSource.includes("props.emergence?.text || props.emergence?.cognitionTrace"), false, "quiet emergence traces should not render on the home page");
assert.equal(appSource.includes("emergence-audit"), false, "quiet emergence should not expose developer audit as a visible home card");

console.log(JSON.stringify({ ok: true, checked: forbiddenVisibleTemplates.length + 3 }, null, 2));
