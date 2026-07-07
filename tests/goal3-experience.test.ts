import { describe, expect, it } from "vitest";
import { handleButtonCapture, handleCuriousStream } from "../src/core/attention";
import { semanticDecideEmergence } from "../src/core/emergence";
import { applyFeedback, semanticReflectFeedback } from "../src/core/feedback";
import { createCreatureProfile } from "../src/core/profile";
import type { ModelProvider } from "../src/core/provider";
import { runCuriousHarness } from "../src/core/harness";

describe("goal 3 creature experience", () => {
  it("curious harness creates a model-written observation report from everyday material", async () => {
    const profile = createCreatureProfile();
    const result = await runCuriousHarness(profile, [
      segment("s1", "背景 1", "今天早餐吃了面包，路上有点堵。"),
      segment("s2", "日历截图", "周五 9:30 妈妈复查，备注写着提前准备病历和医保卡。", "image_summary"),
      segment("s3", "隐私片段", "短信里有验证码 4921 和缴费链接，这段不应该被长期保存。"),
      segment("s4", "语音 1", "我有点担心自己又把妈妈复查这件事拖到最后，明明很重要。", "audio_transcript"),
      segment("s5", "购物截图", "购物车里有洗衣液、纸巾和一个水杯。", "image_summary"),
      segment("s6", "朋友提醒", "朋友说我最近总是把重要家事压到睡前才处理，容易焦虑。"),
      segment("s7", "语音 2", "下周想提前一天提醒自己准备资料，不要又临时找东西。", "audio_transcript"),
      segment("s8", "重复背景", "妈妈复查这件事刚才已经说过一次，这里只是重复提醒。")
    ], curiousProvider());

    expect(result.curiousSession?.creatureReport).toContain("妈妈复查");
    expect(result.curiousSession?.creatureReport).toContain("有点担心");
    expect(result.curiousSession?.creatureReport).not.toContain("投资人");
    expect(result.curiousSession?.creatureReport).not.toMatch(/扫过|分段|批量|直接记住|状态|谨慎：|\\d+ 段/);
    expect(result.curiousSession?.selected.map((item) => item.whySelected).join(" ")).toMatch(/担心|复查/);
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

function curiousProvider(): ModelProvider {
  return {
    kind: "generic",
    name: "goal curious model",
    available: true,
    usesRealModel: true,
    generate: async () => "",
    summarizeImage: async () => "",
    transcribeAudio: async () => "",
    generateJson: async <T,>(prompt: string): Promise<T | undefined> => {
      if (prompt.includes("注意决策脑")) {
        return {
          shouldAttend: true,
          selected: [
            { segmentId: "s4", whySelected: "你说自己有点担心妈妈复查会拖到最后，这里最需要被听见。" },
            { segmentId: "s2", whySelected: "日历里的复查时间和资料准备，是这件事的具体线索。" }
          ],
          ignored: [
            { segmentId: "s3", whyIgnored: "这段有验证码和链接，我不直接碰细节。" }
          ],
          creatureReport: "我听见你有点担心妈妈复查又被拖到最后，也看见了复查时间和要准备的资料。",
          trace: ["selected family review concern"]
        } as T;
      }
      if (prompt.includes("行动选择脑")) {
        return { decisions: [{ eventId: firstAttentionId(prompt), action: "respond", shouldReply: true, reply: "这件事我听见了，妈妈复查和准备资料我会陪你放近一点。", visibleReaction: "Papo 抬头看着你" }] } as T;
      }
      if (prompt.includes("语义脑")) {
        return {
          response: "这件事我听见了，妈妈复查和准备资料我会陪你放近一点。",
          interaction: {
            userIntent: "你在说一件让你担心会拖延的家事。",
            emotionalTone: "担心",
            visibleReaction: "Papo 抬头看着你",
            shouldReply: true,
            suggestedAction: "respond",
            reply: "这件事我听见了，妈妈复查和准备资料我会陪你放近一点。",
            memoryCandidateText: "你担心妈妈复查又拖到最后，希望提前准备病历和医保卡。",
            memoryTags: ["妈妈复查", "提前准备"]
          },
          curiousSession: {
            creatureReport: "我听见你有点担心妈妈复查又被拖到最后，也看见了复查时间和要准备的资料。"
          }
        } as T;
      }
      if (prompt.includes("记忆决策脑")) {
        return {
          candidates: extractCandidateIds(prompt).map((candidateId) => ({
            candidateId,
            shouldKeepCandidate: true,
            candidateText: "你担心妈妈复查又拖到最后，希望提前准备病历和医保卡。",
            memoryKind: "future_review",
            confidence: 78,
            writePolicy: "wait_feedback",
            whyConsolidate: "这和你想提前准备妈妈复查有关。",
            decayPolicy: "decay_without_feedback",
            tags: ["妈妈复查", "提前准备"]
          }))
        } as T;
      }
      return undefined;
    }
  };
}

function firstAttentionId(prompt: string) {
  return [...prompt.matchAll(/attention_[A-Za-z0-9_-]{10}/g)].at(-1)?.[0] ?? "missing";
}

function extractCandidateIds(prompt: string) {
  return [...new Set([...prompt.matchAll(/candidate_[A-Za-z0-9_-]{10}/g)].map((match) => match[0]))];
}

function segment(id: string, label: string, content: string, kind: "text" | "image_summary" | "audio_transcript" = "text") {
  return { id, label, content, kind };
}
