import assert from "node:assert/strict";
import test from "node:test";
import { enqueueCandidateVisualJobs, forgetMemory, promoteMemoryCandidate, upsertLongTermMemory } from "../src/core/memory";
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

test("candidate confirmation keeps occurrence time separate from confirmation time", () => {
  const occurredAt = "2026-06-18T08:15:00.000Z";
  const episodeCreatedAt = "2026-06-18T08:16:00.000Z";
  const confirmedAt = "2026-07-13T07:00:00.000Z";
  const profile = createCreatureProfile({ userId: "memory-occurrence", now: episodeCreatedAt });
  profile.episodes.push({
    id: "episode_occurrence", createdAt: episodeCreatedAt, sourceObservedAt: occurredAt, source: "button",
    inputSummary: "六月的一次散步", noticed: "用户六月散步", creatureResponse: "", memoryCandidateIds: ["candidate_occurrence"], weight: 70, tags: []
  });
  profile.memoryCandidates.push({
    id: "candidate_occurrence", createdAt: episodeCreatedAt, candidateText: "你六月在河边散过步", memoryKind: "long_theme",
    confidence: 82, sourceEpisodeId: "episode_occurrence", whyConsolidate: "用户确认值得记住", writePolicy: "wait_feedback",
    decayPolicy: "stable", status: "candidate", tags: ["散步"]
  });

  const promoted = promoteMemoryCandidate(profile, "candidate_occurrence", { now: confirmedAt });
  assert.equal(promoted?.createdAt, confirmedAt, "record creation remains the confirmation time for auditing");
  assert.equal(promoted?.occurredAt, occurredAt, "the memory timeline uses when the event happened");

  const legacy = memory("ltm_legacy_occurrence", "旧记忆也应显示发生时间");
  legacy.sourceEpisodeId = "episode_occurrence";
  profile.longTermMemories.push(legacy);
  normalizeCreatureProfile(profile);
  assert.equal(profile.longTermMemories.find((item) => item.id === legacy.id)?.occurredAt, occurredAt);
});

test("candidate visual jobs are budgeted, idempotent, and their preview is reused on promotion", () => {
  const profile = createCreatureProfile({ userId: "candidate-preview", creatureName: "Papo", now: "2026-07-12T10:00:00.000Z" });
  for (let index = 0; index < 3; index += 1) {
    const episodeId = `episode_candidate_${index}`;
    profile.episodes.push({
      id: episodeId, createdAt: "2026-07-12T10:00:00.000Z", source: "button", inputSummary: `候选生活 ${index}`,
      noticed: `候选生活 ${index}`, creatureResponse: "", memoryCandidateIds: [], weight: 70, tags: []
    });
    profile.memoryCandidates.push({
      id: `candidate_${index}`, createdAt: "2026-07-12T10:00:00.000Z", candidateText: `我记得候选生活 ${index}`,
      shortTitle: `候选${index}`, memoryKind: "long_theme", confidence: 80, sourceEpisodeId: episodeId,
      whyConsolidate: "值得稍后确认", writePolicy: "wait_feedback", decayPolicy: "stable", status: "candidate", tags: []
    });
  }
  const jobs = enqueueCandidateVisualJobs(profile);
  assert.equal(jobs.length, 2, "only two candidate previews may be active at once");
  assert.equal(enqueueCandidateVisualJobs(profile).length, 0, "normalization or retry cannot duplicate preview jobs");

  const candidate = profile.memoryCandidates[0];
  candidate.previewVisual = attachment("candidate_preview", "候选预览");
  candidate.previewStatus = "ready";
  candidate.previewPrompt = "A warm hand-drawn watercolor everyday scene, no animals, no text.";
  candidate.previewMode = "imaginative_illustration";
  candidate.previewPapoPresence = "absent";
  const promoted = promoteMemoryCandidate(profile, candidate.id);
  assert.equal(promoted?.visual?.id, "candidate_preview");
  assert.equal(promoted?.visualStatus, "ready");
  assert.equal(profile.jobs?.some((job) => job.type === "memory_enrichment" && job.memoryId === promoted?.id), false, "a ready candidate preview avoids a second paid image job");
});

test("candidate preview backfill is capped and dismissal drops the retained preview", () => {
  const profile = createCreatureProfile({ userId: "candidate-preview-budget", creatureName: "Papo" });
  for (let index = 0; index < 8; index += 1) profile.memoryCandidates.push({
    id: `candidate_budget_${index}`, createdAt: `2026-07-${String(12 - index).padStart(2, "0")}T10:00:00.000Z`, candidateText: `我记得预算候选 ${index}`,
    shortTitle: `预算${index}`, memoryKind: "long_theme", confidence: 80, sourceEpisodeId: `episode_budget_${index}`,
    whyConsolidate: "等待确认", writePolicy: "wait_feedback", decayPolicy: "stable", status: "candidate", tags: []
  });
  enqueueCandidateVisualJobs(profile);
  profile.jobs?.filter((job) => job.type === "candidate_visual").forEach((job) => { job.status = "completed"; });
  enqueueCandidateVisualJobs(profile);
  profile.jobs?.filter((job) => job.type === "candidate_visual" && job.status === "queued").forEach((job) => { job.status = "completed"; });
  enqueueCandidateVisualJobs(profile);
  assert.equal(profile.jobs?.filter((job) => job.type === "candidate_visual").length, 6, "historical backfill is limited to the six newest pending candidates");
  const first = profile.memoryCandidates[0];
  first.previewVisual = attachment("dismissed_preview", "待清理预览");
  first.previewStatus = "ready";
  forgetMemory(profile, first.id);
  assert.equal(first.status, "dismissed");
  assert.equal(first.previewVisual, undefined);
  assert.equal(first.previewStatus, "not_needed");
});

test("promoted candidate preview failure falls back to durable memory enrichment", async () => {
  const store = new MemoryProfileStore();
  const profile = await store.createProfile({ userId: "candidate-preview-fallback", creatureName: "Papo" });
  profile.episodes.push({ id: "episode_fallback", createdAt: "2026-07-12T10:00:00.000Z", source: "button", inputSummary: "一次候选经历", noticed: "一次候选经历", creatureResponse: "", memoryCandidateIds: ["candidate_fallback"], weight: 70, tags: [] });
  profile.memoryCandidates.push({ id: "candidate_fallback", createdAt: "2026-07-12T10:00:00.000Z", candidateText: "我记得一次候选经历", shortTitle: "候选经历", memoryKind: "long_theme", confidence: 80, sourceEpisodeId: "episode_fallback", whyConsolidate: "值得留下", writePolicy: "wait_feedback", decayPolicy: "stable", status: "candidate", tags: [] });
  enqueueCandidateVisualJobs(profile);
  const promoted = promoteMemoryCandidate(profile, "candidate_fallback");
  assert.ok(promoted);
  await store.saveProfile(profile);
  let imageAttempts = 0;
  const provider = providerWith(() => ({ shortTitle: "候选经历", narrative: "我记得这次经历。", visualMode: "imaginative_illustration", papoPresence: "absent", visualReason: "手绘生活场景", imagePrompt: "A warm hand-drawn watercolor everyday scene with natural simplified faces, visible paper texture, no animals, no text.", relatedMemoryIds: [], needsClientReferences: false }), async () => {
    imageAttempts += 1;
    if (imageAttempts <= 2) throw new Error("candidate preview fails twice");
    return { dataUrl: IMAGE, mime: "image/png" };
  });
  const app = createApp({ store, provider, proactive: { enabled: false }, turns: { autoStart: false }, nativeIngest: { autoStart: false } });
  const worker = app.locals.turnWorker as PersistentTurnWorker;
  await worker.start();
  await waitFor(async () => (await store.getProfile(profile.userId))?.longTermMemories.find((memory) => memory.id === promoted?.id)?.visualStatus === "ready");
  const saved = await store.getProfile(profile.userId);
  assert.equal(imageAttempts, 3);
  assert.equal(saved?.jobs?.find((job) => job.type === "candidate_visual")?.status, "failed");
  assert.equal(saved?.jobs?.find((job) => job.type === "memory_enrichment" && job.memoryId === promoted?.id)?.status, "completed");
  worker.stop();
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
    imagePrompt: "Square hand-drawn watercolor comic illustration of people sharing ideas in a small room, natural simplified faces and expressions, visible paper texture, no animals, no text.",
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

test("legacy long-term memories without artwork migrate once into durable low-cost enrichment", () => {
  const profile = createCreatureProfile({ userId: "memory-thumbnail-backfill", creatureName: "Papo" });
  profile.longTermMemories.push({
    ...memory("ltm_missing_thumbnail", "一次值得长期留下的共同经历"),
    visualMode: "no_visual",
    visualStatus: "not_needed",
    visualPolicyVersion: 5,
    contentRevision: 1,
    enrichedRevision: 1,
    enrichmentStatus: "completed"
  });

  normalizeCreatureProfile(profile);
  const migrated = profile.longTermMemories[0];
  assert.equal(migrated.contentRevision, 2);
  assert.equal(migrated.enrichmentStatus, "pending");
  assert.equal(profile.jobs?.filter((job) => job.memoryId === migrated.id && job.memoryRevision === 2).length, 1);

  normalizeCreatureProfile(profile);
  assert.equal(migrated.contentRevision, 2);
  assert.equal(profile.jobs?.filter((job) => job.memoryId === migrated.id && job.memoryRevision === 2).length, 1);
});

test("legacy Papo mascot covers also migrate into the shared hand-drawn album style", () => {
  const profile = createCreatureProfile({ userId: "memory-papo-style-migration", creatureName: "Papo" });
  profile.longTermMemories.push({
    ...memory("ltm_legacy_papo", "我和 Papo 一起完成了今天的工作"), visualMode: "imaginative_illustration", papoPresence: "required", visualPolicyVersion: 3,
    visual: attachment("old_3d_papo_cover", "旧 3D Papo 图"), visualStatus: "ready", contentRevision: 1, enrichedRevision: 1, enrichmentStatus: "completed"
  });
  normalizeCreatureProfile(profile);
  assert.equal(profile.longTermMemories[0].contentRevision, 2);
  assert.equal(profile.longTermMemories[0].visual?.id, "old_3d_papo_cover");
  assert.equal(profile.jobs?.some((job) => job.memoryId === "ltm_legacy_papo" && job.memoryRevision === 2), true);
});

test("policy 5 selectively redraws symbolic screen prompts without redrawing compliant policy 4 art", () => {
  const profile = createCreatureProfile({ userId: "memory-symbol-screen-migration", creatureName: "Papo" });
  profile.longTermMemories.push({
    ...memory("ltm_bad_screen", "一次技术分享"), visualMode: "imaginative_illustration", papoPresence: "absent", visualPolicyVersion: 4,
    visualPrompt: "A hand-drawn talk with AI-related icons on a projection screen, no text.", visual: attachment("bad_screen", "带概念图标的旧图"), visualStatus: "ready", contentRevision: 1, enrichedRevision: 1, enrichmentStatus: "completed"
  }, {
    ...memory("ltm_good_scene", "一次雨后散步"), visualMode: "imaginative_illustration", papoPresence: "absent", visualPolicyVersion: 4,
    visualPrompt: "A warm hand-drawn watercolor walk after rain, visible paper texture, no animals.", visual: attachment("good_scene", "合格手绘图"), visualStatus: "ready", contentRevision: 1, enrichedRevision: 1, enrichmentStatus: "completed"
  });
  normalizeCreatureProfile(profile);
  assert.equal(profile.longTermMemories.find((item) => item.id === "ltm_bad_screen")?.contentRevision, 2);
  assert.equal(profile.longTermMemories.find((item) => item.id === "ltm_good_scene")?.contentRevision, 1);
  assert.equal(profile.jobs?.some((job) => job.memoryId === "ltm_bad_screen"), true);
  assert.equal(profile.jobs?.some((job) => job.memoryId === "ltm_good_scene"), false);
});

test("negative no-icons and no-text guards remain valid visual prompts", async () => {
  const profile = createCreatureProfile({ userId: "memory-negative-visual-guard", creatureName: "Papo" });
  const provider = providerWith(() => ({
    shortTitle: "自然交流", narrative: "我记得大家自然地聊了起来。", visualMode: "imaginative_illustration", papoPresence: "absent", visualReason: "手绘具体生活场景",
    imagePrompt: "A warm hand-drawn watercolor scene with natural expressive faces, visible paper texture, no animals, no icons, no text, no logo.", relatedMemoryIds: [], needsClientReferences: false
  }));
  await assert.doesNotReject(() => planMemoryVisual(profile, memory("ltm_negative_guard", "一次自然交流"), provider));
});

test("positive icon requests are rejected even without infographic wording", async () => {
  const profile = createCreatureProfile({ userId: "memory-positive-icon-guard", creatureName: "Papo" });
  const provider = providerWith(() => ({
    shortTitle: "技术分享", narrative: "我记得这场分享。", visualMode: "imaginative_illustration", papoPresence: "absent", visualReason: "手绘活动现场",
    imagePrompt: "A warm hand-drawn watercolor event scene with friendly technology icons on the screen, visible paper texture, no animals.", relatedMemoryIds: [], needsClientReferences: false
  }));
  await assert.rejects(() => planMemoryVisual(profile, memory("ltm_positive_icons", "一次技术分享"), provider), /forbidden symbols/);
});

test("invalid long-term visual plans receive one model-authored repair before image generation", async () => {
  const profile = createCreatureProfile({ userId: "memory-plan-repair", creatureName: "Papo" });
  let planningCalls = 0;
  let imageCalls = 0;
  const provider = providerWith((prompt) => {
    planningCalls += 1;
    if (!prompt.includes("上一次返回未通过校验")) return {
      shortTitle: "讲座", narrative: "我记得这场讲座。", visualMode: "grounded_scene", papoPresence: "absent", visualReason: "错误地假设有照片",
      imagePrompt: "A warm hand-drawn watercolor lecture scene, visible paper texture, no animals, no text.", relatedMemoryIds: [], needsClientReferences: false
    };
    return {
      shortTitle: "讲座", narrative: "我记得这场讲座。", visualMode: "imaginative_illustration", papoPresence: "absent", visualReason: "没有照片，改为生活插画",
      imagePrompt: "A warm hand-drawn watercolor lecture scene with natural faces, visible paper texture, no animals, no text.", relatedMemoryIds: [], needsClientReferences: false
    };
  }, async () => { imageCalls += 1; return { dataUrl: IMAGE, mime: "image/png" }; });
  provider.generateJsonFallback = provider.generateJson;

  const plan = await planMemoryVisual(profile, memory("ltm_plan_repair", "一次没有照片的讲座"), provider, { requireVisual: true });
  assert.equal(plan.visualMode, "imaginative_illustration");
  assert.equal(planningCalls, 2);
  assert.equal(imageCalls, 0, "planning repair must not spend an image call");
});

test("device playback memory narratives preserve media provenance and repair unsupported user attribution", async () => {
  const profile = createCreatureProfile({ userId: "memory-device-playback", creatureName: "Papo" });
  profile.episodes.push({
    id: "episode_car_video", createdAt: "2026-07-13T01:00:00.000Z", source: "stream", audioSourceType: "device_playback",
    inputSummary: "用户手机播放的汽车节目中，媒体讲者介绍了可旋转座椅。", noticed: "这是媒体讲者的内容，不是用户发言。",
    possibleIntent: "用户在观看汽车节目", importanceReason: "持续的媒体内容", creatureResponse: "", memoryCandidateIds: [], weight: 70, tags: ["本机媒体播放"]
  });
  const target = memory("ltm_car_video", "用户播放的视频中，媒体讲者介绍了可旋转座椅和中央桌板。");
  target.sourceEpisodeId = "episode_car_video";
  let calls = 0;
  const provider = providerWith((prompt) => {
    calls += 1;
    assert.match(prompt, /source_provenance/);
    assert.match(prompt, /"audioSourceType":"device_playback"/);
    if (!prompt.includes("上一次返回未通过校验")) return {
      shortTitle: "汽车会客厅", narrative: "我趴在你旁边听着视频，觉得你对这些设计特别有共鸣。",
      visualMode: "imaginative_illustration", papoPresence: "absent", visualReason: "手绘媒体观看场景",
      imagePrompt: "A warm hand-drawn watercolor scene of a phone playing a car program, visible paper texture, no animals, no text.", relatedMemoryIds: [], needsClientReferences: false
    };
    assert.match(prompt, /cannot infer the user's opinion/);
    return {
      shortTitle: "汽车会客厅", narrative: "我记得你播放的视频里，媒体讲者介绍了可旋转座椅和中央桌板。",
      visualMode: "imaginative_illustration", papoPresence: "absent", visualReason: "以手绘场景保留媒体内容来源",
      imagePrompt: "A warm hand-drawn watercolor scene of a phone playing a car program, visible paper texture, no animals, no text.", relatedMemoryIds: [], needsClientReferences: false
    };
  });
  provider.generateJsonFallback = provider.generateJson;

  const plan = await planMemoryVisual(profile, target, provider, { requireVisual: true });
  assert.equal(calls, 2);
  assert.match(plan.narrative, /你播放的视频里，媒体讲者/);
  assert.doesNotMatch(plan.narrative, /共鸣|趴在你旁边/);
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

test("completed memory artwork is committed even when Client.md validation fails", async () => {
  const store = new MemoryProfileStore();
  const profile = await store.createProfile({ userId: "memory-client-isolation", creatureName: "Papo" });
  const created = upsertLongTermMemory(profile, memory("ltm_client_isolation", "一段值得配图的经历"));
  await store.saveProfile(profile);
  let imageCalls = 0;
  const provider = providerWith(() => ({
    shortTitle: "共同经历", narrative: "我记得这段值得留下的经历。",
    visualMode: "imaginative_illustration", papoPresence: "absent", visualReason: "具体的手绘生活场景",
    imagePrompt: "A warm hand-drawn watercolor everyday scene with natural faces, visible paper texture, no animals, no text.",
    relatedMemoryIds: [], needsClientReferences: false
  }), async () => { imageCalls += 1; return { dataUrl: IMAGE, mime: "image/png" }; });
  const originalGenerateJson = provider.generateJson.bind(provider);
  provider.generateJson = async (prompt) => prompt.includes("Client.md 维护脑")
    ? { facts: [{ dimension: "leisure", text: "x".repeat(181), confidence: 80, sourceIds: [created.memory.id] }] }
    : originalGenerateJson(prompt);
  const app = createApp({ store, provider, proactive: { enabled: false }, turns: { autoStart: false }, nativeIngest: { autoStart: false } });
  const worker = app.locals.turnWorker as PersistentTurnWorker;
  await worker.start();
  await waitFor(async () => (await store.getProfile(profile.userId))?.jobs?.find((job) => job.memoryId === created.memory.id)?.status === "completed");
  const saved = await store.getProfile(profile.userId);
  assert.equal(imageCalls, 1);
  assert.equal(saved?.longTermMemories.find((item) => item.id === created.memory.id)?.visualStatus, "ready");
  assert.equal(saved?.longTermMemories.find((item) => item.id === created.memory.id)?.enrichmentStatus, "completed");
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
