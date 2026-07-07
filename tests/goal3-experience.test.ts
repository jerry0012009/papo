import { describe, expect, it } from "vitest";
import { handleButtonCapture, handleCuriousStream } from "../src/core/attention";
import { createActiveEmergence } from "../src/core/emergence";
import { applyFeedback } from "../src/core/feedback";
import { createCreatureProfile } from "../src/core/profile";

describe("goal 3 creature experience", () => {
  it("curious mode creates a creature-facing observation report from everyday material", () => {
    const profile = createCreatureProfile();
    const result = handleCuriousStream(profile, [
      segment("s1", "背景 1", "今天早餐吃了面包，路上有点堵。"),
      segment("s2", "日历截图", "周五 9:30 妈妈复查，备注写着提前准备病历和医保卡。", "image_summary"),
      segment("s3", "隐私片段", "短信里有验证码 4921 和缴费链接，这段不应该被长期保存。"),
      segment("s4", "语音 1", "我有点担心自己又把妈妈复查这件事拖到最后，明明很重要。", "audio_transcript"),
      segment("s5", "购物截图", "购物车里有洗衣液、纸巾和一个水杯。", "image_summary"),
      segment("s6", "朋友提醒", "朋友说我最近总是把重要家事压到睡前才处理，容易焦虑。"),
      segment("s7", "语音 2", "下周想提前一天提醒自己准备资料，不要又临时找东西。", "audio_transcript"),
      segment("s8", "重复背景", "妈妈复查这件事刚才已经说过一次，这里只是重复提醒。")
    ]);

    expect(result.curiousSession?.creatureReport).toContain("我刚才陪你看了 8 段");
    expect(result.curiousSession?.creatureReport).toContain("竖起耳朵");
    expect(result.curiousSession?.creatureReport).not.toContain("投资人");
    expect(result.curiousSession?.selected.map((item) => item.whySelected).join(" ")).toMatch(/竖起耳朵|以后可能还会回来|情绪/);
    expect(result.curiousSession?.selected.map((item) => item.whySelected).join(" ")).not.toMatch(/选中|总分|future_value|emotion|score|\+\d/);
    expect(result.curiousSession?.ignored.map((item) => item.whyIgnored).join(" ")).not.toMatch(/忽略|总分|阈值|redundancy|future_value|score/);
    expect(result.events.map((event) => event.noticed).join(" ")).not.toMatch(/未来价值|情绪强度/);
    expect(result.events[0].creatureExperience.earReason).toContain("竖起耳朵");
  });

  it("feedback returns a visible learning note", () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "我有点担心自己又把妈妈复查这件事拖到睡前。");

    const feedback = applyFeedback(profile, { kind: "continue", targetId: result.episodes[0].id });

    expect(feedback.learningNote).toContain("我学到");
    expect(feedback.learningNote).toContain("不要浅浅带过");
    expect(profile.policyProfile.preferDepth).toBeGreaterThan(45);
  });

  it("active emergence reads like an inner resurfacing, not a template reminder", () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "妈妈复查这件事对我很重要，我希望提前准备。");
    applyFeedback(profile, { kind: "remember", targetId: result.episodes[0].id });
    profile.state.curiosity = 85;

    const emergence = createActiveEmergence(profile);

    expect(emergence.message).toContain("我想起了");
    expect(emergence.message).not.toMatch(/不是提醒|内在倾向|下一次你给我信息流|我浮现的是/);
    expect(emergence.message).not.toContain("我浮现的是");
  });
});

function segment(id: string, label: string, content: string, kind: "text" | "image_summary" | "audio_transcript" = "text") {
  return { id, label, content, kind };
}
