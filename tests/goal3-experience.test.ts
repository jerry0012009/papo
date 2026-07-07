import { describe, expect, it } from "vitest";
import { handleButtonCapture, handleCuriousStream } from "../src/core/attention";
import { semanticDecideEmergence } from "../src/core/emergence";
import { applyFeedback, semanticReflectFeedback } from "../src/core/feedback";
import { createCreatureProfile } from "../src/core/profile";
import type { ModelProvider } from "../src/core/provider";

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

    expect(result.curiousSession?.creatureReport).toContain("我刚才听见了需要回应的事");
    expect(result.curiousSession?.creatureReport).toContain("需要回应");
    expect(result.curiousSession?.creatureReport).not.toContain("投资人");
    expect(result.curiousSession?.creatureReport).not.toMatch(/扫过|分段|批量|直接记住|状态|谨慎：|\\d+ 段/);
    expect(result.curiousSession?.selected.map((item) => item.whySelected).join(" ")).toMatch(/需要回应|以后可能还会回来|情绪/);
    expect(result.curiousSession?.selected.map((item) => item.whySelected).join(" ")).not.toMatch(/选中|总分|future_value|emotion|score|\+\d/);
    expect(result.curiousSession?.ignored.map((item) => item.whyIgnored).join(" ")).not.toMatch(/忽略|总分|阈值|redundancy|future_value|score|偷偷|长期|片段|我先放过/);
    expect(result.events.map((event) => event.noticed).join(" ")).not.toMatch(/未来价值|情绪强度/);
    expect(result.events[0].creatureExperience.earReason).not.toMatch(/竖起耳朵|情景记忆|后台分析|抱住|叼/);
  });

  it("LLM feedback reflection returns a visible learning note", async () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "我有点担心自己又把妈妈复查这件事拖到睡前。");

    const feedback = applyFeedback(profile, { kind: "continue", targetId: result.episodes[0].id });
    await semanticReflectFeedback(profile, feedback, feedbackProvider("continue"));

    expect(feedback.learningNote).toContain("我学到");
    expect(feedback.learningNote).toContain("不要浅浅带过");
    expect(profile.policyProfile.preferDepth).toBeGreaterThan(45);
  });

  it("LLM emergence reads like an inner resurfacing, not a template reminder", async () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "妈妈复查这件事对我很重要，我希望提前准备。");
    applyFeedback(profile, { kind: "remember", targetId: result.episodes[0].id });
    profile.state.curiosity = 85;
    const memoryId = profile.longTermMemories.find((memory) => memory.sourceEpisodeId === result.episodes[0].id)?.id;
    if (!memoryId) throw new Error("expected memory");

    const emergence = await semanticDecideEmergence(profile, emergenceProvider(memoryId));

    expect(emergence.message).toContain("妈妈复查");
    expect(emergence.message).not.toMatch(/不是提醒|内在倾向|下一次你给我信息流|我浮现的是/);
    expect(emergence.message).not.toContain("我浮现的是");
  });
});

function emergenceProvider(memoryId: string): ModelProvider {
  return {
    kind: "generic",
    name: "goal emergence model",
    available: true,
    usesRealModel: true,
    generate: async () => "",
    summarizeImage: async () => "",
    transcribeAudio: async () => "",
    generateJson: async <T,>(): Promise<T | undefined> =>
      ({
        shouldEmerge: true,
        memoryId,
        driveSource: "curiosity",
        whyNow: "我还惦记着你希望提前准备妈妈复查这件事。",
        message: "我刚才又想起妈妈复查这件事。你说它很重要、想提前准备，所以等你继续说时，我会接住和准备有关的线索。",
        proactiveLevel: "gentle"
      }) as T
  };
}

function feedbackProvider(kind: "continue" | "not_now"): ModelProvider {
  const continueFeedback = kind === "continue";
  return {
    kind: "generic",
    name: "goal feedback model",
    available: true,
    usesRealModel: true,
    generate: async () => "",
    summarizeImage: async () => "",
    transcribeAudio: async () => "",
    generateJson: async <T,>(): Promise<T | undefined> =>
      ({
        responseAction: continueFeedback ? "acknowledge" : "quiet",
        stateDeltas: continueFeedback ? { curiosity: 5, attachment: 2 } : { arousal: -4 },
        policyDeltas: continueFeedback ? { preferDepth: 7, recallTendency: 4 } : { quietTendency: 7, preferProactivity: -5 },
        memoryWeightDelta: continueFeedback ? 6 : -4,
        learningNote: continueFeedback ? "我学到：妈妈复查这件事不要浅浅带过，要多停一下。" : "我学到：这类时候先安静陪着，不急着追问。",
        effect: continueFeedback ? "你是在教我遇到相近担心时更认真一点。" : "你是在教我收住声音，先陪着。",
        creatureSelfMemory: {
          text: continueFeedback ? "你教我遇到妈妈复查这类担心时，不要浅浅带过。" : "你教我不是每次注意到都要插话。",
          tags: continueFeedback ? ["更愿意多想"] : ["更安静"]
        }
      }) as T
  };
}

function segment(id: string, label: string, content: string, kind: "text" | "image_summary" | "audio_transcript" = "text") {
  return { id, label, content, kind };
}
