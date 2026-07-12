import assert from "node:assert/strict";
import test from "node:test";
import { upsertLongTermMemory } from "../src/core/memory";
import { createCreatureProfile, normalizeCreatureProfile } from "../src/core/profile";
import type { ModelProvider } from "../src/core/provider";
import type { LongTermMemory, MediaAttachment } from "../src/core/types";
import { createApp } from "../src/server/app";
import { memoryVisualReferences, planMemoryVisual } from "../src/server/memory-visual";
import { MemoryProfileStore } from "../src/server/store";
import { PersistentTurnWorker } from "../src/server/turn-worker";

const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

test("memory upsert is idempotent and revisions retain the previous visual", () => {
  const profile = createCreatureProfile({ userId: "memory-upsert", creatureName: "Papo", now: "2026-07-12T10:00:00.000Z" });
  const first = upsertLongTermMemory(profile, memory("ltm_revision", "你喜欢傍晚散步"), { now: "2026-07-12T10:01:00.000Z" });
  const oldVisual = attachment("old_visual", "旧回忆图");
  first.memory.visual = oldVisual;
  first.memory.visualStatus = "ready";
  first.memory.enrichedRevision = 1;
  first.memory.enrichmentStatus = "completed";

  const duplicate = upsertLongTermMemory(profile, { ...first.memory }, { now: "2026-07-12T10:02:00.000Z" });
  assert.equal(duplicate.changed, false);
  assert.equal(profile.jobs?.filter((job) => job.memoryId === first.memory.id).length, 1);

  const revised = upsertLongTermMemory(profile, { ...first.memory, text: "你喜欢雨后傍晚散步" }, { now: "2026-07-12T10:03:00.000Z" });
  assert.equal(revised.revision, 2);
  assert.equal(revised.memory.visual?.id, oldVisual.id, "the current image remains visible while revision 2 is pending");
  assert.equal(revised.memory.enrichmentStatus, "pending");
  assert.deepEqual(profile.jobs?.filter((job) => job.memoryId === first.memory.id).map((job) => job.memoryRevision).sort(), [1, 2]);

  upsertLongTermMemory(profile, { ...revised.memory }, { now: "2026-07-12T10:04:00.000Z" });
  assert.equal(profile.jobs?.filter((job) => job.memoryId === first.memory.id && job.memoryRevision === 2).length, 1);
});

test("visual planning avoids fake grounding and only adds Papo when required", async () => {
  const profile = createCreatureProfile({ userId: "memory-visual-policy", creatureName: "Papo" });
  profile.petProfile.avatarImage = attachment("papo_reference", "Papo reference");
  const lecture = memory("ltm_lecture", "一场关于向量数据库检索架构的讲座");
  const daily = memory("ltm_daily", "我和你在雨后一起散步");
  let plan: Record<string, unknown> = {};
  const provider = providerWith(() => plan);
  const loader = async (item: MediaAttachment) => item.id === "papo_reference" ? IMAGE : undefined;

  plan = {
    shortTitle: "检索讲座", narrative: "我记得这场讲座梳理了向量检索的关键结构。",
    visualMode: "imaginative_illustration", papoPresence: "absent", visualReason: "从听众视角手绘这次讲座经历",
    imagePrompt: "Square hand-painted gouache memory scene from the back row of a small lecture, anonymous human audience backs facing a speaker silhouette and blank screen, visible brush texture, no animals, no text.",
    relatedMemoryIds: [], needsClientReferences: false
  };
  const lecturePlan = await planMemoryVisual(profile, lecture, provider);
  assert.equal((await memoryVisualReferences(profile, lecture, lecturePlan, loader)).length, 0);

  plan = {
    shortTitle: "雨后散步", narrative: "我记得雨后陪你一起慢慢散步。",
    visualMode: "imaginative_illustration", papoPresence: "required", visualReason: "这是 Papo 参与的共同日常",
    imagePrompt: "Square hand-painted watercolor shared memory of Papo accompanying a person after rain, visible paper texture, no realistic likeness, no text.",
    relatedMemoryIds: [], needsClientReferences: false
  };
  const dailyPlan = await planMemoryVisual(profile, daily, provider);
  assert.deepEqual((await memoryVisualReferences(profile, daily, dailyPlan, loader)).map((item) => item.label), ["Papo reference"]);

  plan = {
    shortTitle: "想象封面", narrative: "我记得这件事，但当时没有留下现场照片。",
    visualMode: "imaginative_illustration", papoPresence: "absent", visualReason: "没有照片，只作明确的想象插画",
    imagePrompt: "Square colored-pencil sketchbook memory scene, explicitly non-photographic, no identifiable person or location, visible paper texture, no animals, no text.",
    relatedMemoryIds: [], needsClientReferences: false
  };
  assert.equal((await planMemoryVisual(profile, memory("ltm_no_photo", "没有照片的经历"), provider)).visualMode, "imaginative_illustration");

  plan = {
    shortTitle: "错误封面", narrative: "这不是生活画面。",
    visualMode: "imaginative_illustration", papoPresence: "absent", visualReason: "错误地使用概念图",
    imagePrompt: "Clean vector infographic with interconnected nodes, floating icons and a gradient background.",
    relatedMemoryIds: [], needsClientReferences: false
  };
  await assert.rejects(() => planMemoryVisual(profile, memory("ltm_infographic", "不应生成信息图"), provider), /painted medium|infographic language/);
});

test("legacy symbolic covers migrate once while retaining their old image", () => {
  const profile = createCreatureProfile({ userId: "memory-visual-migration", creatureName: "Papo" });
  profile.longTermMemories.push({
    ...memory("ltm_legacy_cover", "一场路演"), visualMode: "symbolic_cover", visualPolicyVersion: 1,
    visual: attachment("old_symbolic_cover", "旧抽象图"), visualStatus: "ready", contentRevision: 1, enrichedRevision: 1, enrichmentStatus: "completed"
  });
  normalizeCreatureProfile(profile);
  const migrated = profile.longTermMemories[0];
  assert.equal(migrated.contentRevision, 2);
  assert.equal(migrated.visual?.id, "old_symbolic_cover");
  assert.equal(migrated.enrichmentStatus, "pending");
  assert.equal(profile.jobs?.filter((job) => job.memoryId === migrated.id && job.memoryRevision === 2).length, 1);
  normalizeCreatureProfile(profile);
  assert.equal(migrated.contentRevision, 2, "policy migration must not increment on every normalization");
});

test("persistent memory jobs retry failures and expose a terminal visual error without replacing the old image", async () => {
  const store = new MemoryProfileStore();
  const profile = await store.createProfile({ userId: "memory-retry", creatureName: "Papo" });
  const created = upsertLongTermMemory(profile, memory("ltm_retry", "这条记忆的配图总是失败"));
  created.memory.visual = attachment("stable_old_visual", "仍可查看的旧图");
  created.memory.visualStatus = "ready";
  await store.saveProfile(profile);
  let attempts = 0;
  const provider = providerWith(() => ({
    shortTitle: "失败测试", narrative: "我仍保留这条记忆，并会诚实显示配图失败。",
    visualMode: "imaginative_illustration", papoPresence: "absent", visualReason: "使用非写实插画",
    imagePrompt: "Square hand-painted gouache memory scene for an intentional retry failure test, visible brush texture, no animals, no text.",
    relatedMemoryIds: [], needsClientReferences: false
  }), async () => {
    attempts += 1;
    throw new Error("deterministic memory image failure");
  });
  const app = createApp({ store, provider, proactive: { enabled: false }, turns: { autoStart: false }, nativeIngest: { autoStart: false } });
  const worker = app.locals.turnWorker as PersistentTurnWorker;
  await worker.start();
  await waitFor(async () => (await store.getProfile(profile.userId))?.jobs?.find((job) => job.memoryId === created.memory.id)?.status === "failed");
  const saved = await store.getProfile(profile.userId);
  const failed = saved?.longTermMemories.find((item) => item.id === created.memory.id);
  const job = saved?.jobs?.find((item) => item.memoryId === created.memory.id);
  assert.equal(attempts, 3);
  assert.equal(job?.attempt, 3);
  assert.equal(failed?.visual?.id, "stable_old_visual");
  assert.equal(failed?.visualStatus, "failed");
  assert.match(failed?.visualError ?? "", /deterministic memory image failure/);
  worker.stop();
});

function memory(id: string, text: string): LongTermMemory {
  return { id, createdAt: "2026-07-12T10:00:00.000Z", kind: "long_theme", text, weight: 80, tags: [] };
}

function attachment(id: string, label: string): MediaAttachment {
  return { id, kind: "image", label, mime: "image/png", url: `/api/assets/${id}.png`, createdAt: "2026-07-12T10:00:00.000Z" };
}

function providerWith(
  visualPlan: (prompt: string) => Record<string, unknown>,
  generateImage: ModelProvider["generateImage"] = async () => ({ dataUrl: IMAGE, mime: "image/png" })
): ModelProvider {
  return {
    kind: "generic", name: "memory lifecycle fake", available: true, usesRealModel: false,
    async generate() { return ""; },
    async generateJson(prompt) {
      if (prompt.includes("共同回忆编辑和视觉导演")) return visualPlan(prompt);
      if (prompt.includes("Client.md 维护脑")) return { facts: [] };
      throw new Error(`unexpected prompt: ${prompt.slice(0, 60)}`);
    },
    async summarizeImage() { return ""; },
    async observeAudio() { return ""; },
    generateImage
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for memory lifecycle job");
}
