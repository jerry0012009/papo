import { describe, expect, it } from "vitest";
import { handleButtonCapture, handleCuriousStream } from "../src/core/attention";
import { createContrastSummary } from "../src/core/demo";
import { createActiveEmergence } from "../src/core/emergence";
import { applyFeedback } from "../src/core/feedback";
import { createCreatureProfile } from "../src/core/profile";
import { wakeCreature } from "../src/core/rhythm";
import type { StreamSegment } from "../src/core/types";

describe("goal 3 acceptance flow", () => {
  it("runs the minimum life loop: wake, notice, remember, learn, diverge, and resurface", () => {
    const main = createCreatureProfile({ userId: "goal3-main", now: "2026-07-06T06:00:00.000Z" });
    main.lastSeenAt = "2026-07-06T04:00:00.000Z";
    const wake = wakeCreature(main, "2026-07-06T06:00:00.000Z");
    expect(wake.message).toMatch(/醒|见到|世界|等你/);
    expect(wake.message).not.toContain("app_wake");

    main.state.energy = 44;
    const curious = handleCuriousStream(main, lifeSegments(), "2026-07-06T06:01:00.000Z");
    expect(curious.curiousSession?.totalSegments).toBe(8);
    expect(curious.events).toHaveLength(2);
    expect(curious.curiousSession?.creatureReport).toContain("我刚才陪你看了 8 段");
    expect(curious.curiousSession?.creatureReport).toContain("只认真盯住了 2 段");
    expect(curious.curiousSession?.selected.every((item) => item.whySelected)).toBe(true);
    expect(curious.curiousSession?.ignored.every((item) => item.whyIgnored)).toBe(true);

    const targetEpisode = curious.episodes[0];
    applyFeedback(main, { kind: "remember", targetId: targetEpisode.id, now: "2026-07-06T06:02:00.000Z" });
    const learned = applyFeedback(main, { kind: "continue", targetId: targetEpisode.id, now: "2026-07-06T06:03:00.000Z" });
    expect(learned.learningNote).toContain("我学到");
    expect(learned.learningNote).toContain("不要浅浅带过");
    expect(main.longTermMemories.some((memory) => memory.sourceEpisodeId === targetEpisode.id)).toBe(true);
    expect(main.memoryCandidates.some((candidate) => candidate.sourceEpisodeId === targetEpisode.id)).toBe(true);

    const input = "我有点担心自己又把妈妈复查这件事拖到睡前，明明它很重要。";
    const deep = conditionCreature("goal3-deep", input, "continue");
    const quiet = conditionCreature("goal3-quiet", input, "not_now");
    const deepNext = handleButtonCapture(deep, input, "2026-07-06T06:04:00.000Z");
    const quietNext = handleButtonCapture(quiet, input, "2026-07-06T06:04:00.000Z");
    const contrast = createContrastSummary({ deepProfile: deep, quietProfile: quiet, deepResult: deepNext, quietResult: quietNext });

    expect(deep.policyProfile.preferDepth).toBeGreaterThan(quiet.policyProfile.preferDepth);
    expect(deep.policyProfile.recallTendency).toBeGreaterThan(quiet.policyProfile.recallTendency);
    expect(quiet.policyProfile.quietTendency).toBeGreaterThan(deep.policyProfile.quietTendency);
    expect(deepNext.events[0].actionDecision.action).not.toBe(quietNext.events[0].actionDecision.action);
    expect(deepNext.response).toMatch(/不要浅浅带过|继续多想/);
    expect(deepNext.events[0].creatureExperience.actionFeeling).toMatch(/多停一下|不浅浅放过/);
    expect(quietNext.response).toMatch(/更安静|先轻轻记下|不急着打扰/);
    expect(quietNext.events[0].creatureExperience.actionFeeling).toMatch(/收住声音|不急着追问/);
    expect(contrast).toContain("养成差异");
    expect(contrast).toContain("它们的内在选择也不一样");

    const promoted = main.longTermMemories.find((memory) => memory.sourceEpisodeId === targetEpisode.id && !memory.tags.includes("被你养成"));
    expect(promoted).toBeTruthy();
    if (promoted) promoted.lastReferencedAt = "2026-07-01T00:00:00.000Z";
    for (const memory of main.longTermMemories.filter((memory) => memory.id !== promoted?.id)) {
      memory.lastReferencedAt = "2026-07-06T06:04:30.000Z";
    }
    main.state.curiosity = 50;
    main.state.attachment = 42;
    main.state.safety = 58;
    const emergence = createActiveEmergence(main, "2026-07-06T06:05:00.000Z");

    expect(emergence.relatedMemoryIds[0]).toBe(promoted?.id);
    expect(emergence.whyNow).toBeTruthy();
    expect(emergence.driveSource).toBeTruthy();
    expect(emergence.message).toContain("我想起了");
    expect(emergence.message).not.toContain("我浮现的是");
  });
});

function conditionCreature(userId: string, input: string, feedbackKind: "continue" | "not_now") {
  const profile = createCreatureProfile({ userId });
  const first = handleButtonCapture(profile, input, "2026-07-06T06:00:00.000Z");
  for (let index = 0; index < 3; index += 1) {
    applyFeedback(profile, { kind: feedbackKind, targetId: first.episodes[0].id, now: `2026-07-06T06:0${index + 1}:00.000Z` });
  }
  return profile;
}

function lifeSegments(): StreamSegment[] {
  return [
    { id: "s1", kind: "text", label: "早餐", content: "今天早餐吃了面包，路上有点堵。" },
    { id: "s2", kind: "image_summary", label: "日历截图", content: "周五 9:30 妈妈复查，备注写着提前准备病历、医保卡和上次检查单。" },
    { id: "s3", kind: "text", label: "隐私片段", content: "短信里有验证码 4921 和缴费链接，这段不应该被长期保存。" },
    { id: "s4", kind: "audio_transcript", label: "语音 1", content: "我有点担心自己又把妈妈复查这件事拖到最后，明明很重要。" },
    { id: "s5", kind: "image_summary", label: "购物截图", content: "购物车里有洗衣液、纸巾和一个水杯。" },
    { id: "s6", kind: "text", label: "朋友提醒", content: "朋友说我最近总是把重要家事压到睡前才处理，容易焦虑。" },
    { id: "s7", kind: "audio_transcript", label: "语音 2", content: "下周想提前一天提醒自己准备资料，不要又临时找东西。" },
    { id: "s8", kind: "text", label: "重复背景", content: "妈妈复查这件事刚才已经说过一次，这里只是重复提醒。" }
  ];
}
