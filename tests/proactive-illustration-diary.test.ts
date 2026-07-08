import assert from "node:assert/strict";
import { runProactiveEmergenceSweep } from "../src/server/app";
import type { ModelProvider } from "../src/core/provider";
import { MemoryProfileStore } from "../src/server/store";

const store = new MemoryProfileStore();
const profile = await store.createProfile({ userId: "diary-user", creatureName: "Papo" });
profile.longTermMemories.unshift({
  id: "ltm_pool",
  createdAt: "2026-07-08T08:00:00.000Z",
  kind: "habit",
  text: "用户今天去游泳，泳池里人很多，但还是觉得游泳很开心。",
  sourceEpisodeId: "episode_pool",
  weight: 84,
  tags: ["游泳", "今天"]
});
profile.episodes.unshift({
  id: "episode_pool",
  createdAt: "2026-07-08T12:00:00.000Z",
  source: "curious_stream",
  sourceSegmentId: "seg_pool",
  inputSummary: "用户说今天去游泳，泳池里人很多，但自己仍然很开心。",
  noticed: "这是当天真实发生的游泳片段。",
  possibleIntent: "分享今天的生活",
  importanceReason: "适合晚间回看。",
  relatedMemoryIds: ["ltm_pool"],
  stateSnapshot: profile.state,
  creatureResponse: "听起来今天泳池很热闹。",
  feedback: [],
  promotedToLongTerm: false,
  memoryCandidateIds: [],
  weight: 72,
  tags: ["游泳"]
});
profile.proactive.nextCheckAt = "2026-07-08T12:00:00.000Z";
await store.saveProfile(profile);

let imagePrompt = "";
let plannerPrompt = "";
const provider: ModelProvider = {
  kind: "generic",
  name: "Evening diary provider",
  available: true,
  usesRealModel: true,
  diagnostics: { textModel: "fake-emergence", imageModel: "fake-image" },
  async generate() {
    return "";
  },
  async generateJson(prompt) {
    if (prompt.includes("观察日记漫画规划脑")) {
      plannerPrompt = prompt;
      return {
        summary: "Papo 把今天泳池很热闹但用户仍然开心这件事画成一天里的小漫画。",
        elements: ["泳池", "很多人", "发亮的水面", "Papo 视角"],
        panels: [
          { title: "听见今天的事", scene: "Papo 在旁边听用户说起今天去游泳。", sourceIds: ["episode_pool"] },
          { title: "热闹的泳池", scene: "泳池里人很多，水面亮亮的。", sourceIds: ["episode_pool"] },
          { title: "晚上的回想", scene: "Papo 把这一天收进观察日记。", sourceIds: ["ltm_pool"] }
        ],
        realityMix: "泳池和开心来自真实片段，Papo 旁观和整理日记是温柔想象。",
        finalPrompt: "A 3-panel hand-drawn comic diary from Papo's point of view: the user tells Papo about swimming, the pool is crowded with shimmering water, and Papo remembers the day warmly at night. No text labels."
      };
    }
    assert.match(prompt, /evening_diary_context/);
    assert.match(prompt, /"eligible":true/);
    return {
      shouldEmerge: true,
      memoryId: "ltm_pool",
      driveSource: "rhythm",
      whyNow: "现在是晚上，今天有一段适合画下来的游泳小事。",
      message: "我把今天泳池里那件热闹的小事画成一张观察日记啦。",
      proactiveLevel: "gentle",
      illustrationDraft: {
        title: "今天的泳池观察日记",
        prompt: "一张 3-6 格手绘多格漫画观察日记：从 Papo 视角回想今天的泳池，人很多，水面亮亮的，旁边有可爱的 Papo 安静看着。",
        caption: "今天泳池很挤，但你还是游得开心。",
        style: "手绘多格漫画观察日记 / 3-6 格分镜",
        sourceIds: ["episode_pool", "ltm_pool"]
      },
      trace: ["evening diary selected"]
    };
  },
  async summarizeImage() {
    return "";
  },
  async observeAudio() {
    return "";
  },
  async generateImage(prompt) {
    imagePrompt = prompt;
    return {
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      mime: "image/png",
      model: "fake-image"
    };
  }
};

const result = await runProactiveEmergenceSweep(store, provider, "2026-07-08T12:00:00.000Z");
const current = await store.getProfile("diary-user");
assert.deepEqual(result, { checked: 1, active: 1, quiet: 0, deferred: 0 });
assert.match(plannerPrompt, /source_episodes/);
assert.match(imagePrompt, /观察日记/);
assert.match(imagePrompt, /multi-panel comic observation diary/);
assert.match(imagePrompt, /Papo's point of view/);
assert.match(imagePrompt, /Final image prompt from comic planner/);
assert.match(imagePrompt, /3-panel hand-drawn comic diary/);
assert.equal(current?.illustrations?.[0]?.kind, "evening_diary");
assert.equal(current?.illustrations?.[0]?.plan?.panels.length, 3);
assert.equal(current?.illustrations?.[0]?.attachment.generatedBy, "papo_illustration");
const message = current?.conversation.find((item) => item.channel === "emergence");
assert.ok(message?.attachments?.[0]?.url, "proactive diary message should carry illustration attachment");
assert.equal(message.cognitionTrace?.emergenceDecision?.actionResult?.kind, "illustration");
assert.equal(message.cognitionTrace?.emergenceDecision?.actionResult?.plan?.summary.includes("泳池"), true);

console.log(JSON.stringify({ ok: true, image: message.attachments[0].url }, null, 2));
