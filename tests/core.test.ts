import { describe, expect, it } from "vitest";
import { handleButtonCapture, handleCuriousStream } from "../src/core/attention";
import { createActiveEmergence } from "../src/core/emergence";
import { applyFeedback } from "../src/core/feedback";
import { runButtonHarness } from "../src/core/harness";
import { promoteEpisode } from "../src/core/memory";
import { createCreatureProfile } from "../src/core/profile";
import { createModelProvider, type ModelProvider } from "../src/core/provider";
import { wakeCreature } from "../src/core/rhythm";
import type { CreatureState } from "../src/core/types";

describe("creature core", () => {
  it("initializes state in range", () => {
    const profile = createCreatureProfile({ userId: "u1" });
    expect(profile.userId).toBe("u1");
    expect(inRange(profile.state)).toBe(true);
    expect(profile.longTermMemories[0].kind).toBe("creature_self_memory");
  });

  it("keeps multiple users isolated", () => {
    const a = createCreatureProfile({ userId: "a" });
    const b = createCreatureProfile({ userId: "b" });

    handleButtonCapture(a, "我希望小动物记住这个关于注意机制的想法。");
    applyFeedback(a, { kind: "remember", targetId: a.episodes[0].id });

    expect(a.episodes).toHaveLength(1);
    expect(a.longTermMemories.length).toBeGreaterThan(b.longTermMemories.length);
    expect(b.episodes).toHaveLength(0);
  });

  it("button capture creates an attention event and episode", () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "这个 demo 不能像普通工具，要有小脑袋和情景记忆。");

    expect(result.events).toHaveLength(1);
    expect(result.episodes).toHaveLength(1);
    expect(result.events[0].source).toBe("button");
    expect(result.events[0].attentionStrength).toBeGreaterThan(50);
    expect(profile.episodes[0].noticed).toContain("小动物");
  });

  it("curious mode selects salient stream events instead of summarizing everything", () => {
    const profile = createCreatureProfile();
    const result = handleCuriousStream(profile, [
      { id: "s1", kind: "text", label: "闲聊", content: "今天午饭还不错。" },
      {
        id: "s2",
        kind: "text",
        label: "核心",
        content: "我担心投资人觉得它只是记忆库，所以要展示注意、反馈和小脑袋。",
        batchId: "batch-core",
        observedAt: "2026-07-06T10:00:30.000Z",
        location: { latitude: 52.52, longitude: 13.405, accuracy: 20, label: "演示现场" }
      },
      { id: "s3", kind: "text", label: "未来", content: "下次演示要生成提醒草稿和复盘。" }
    ]);

    expect(result.events.length).toBeGreaterThanOrEqual(1);
    expect(result.events.length).toBeLessThanOrEqual(3);
    expect(result.events[0].triggerLabel).toBe("核心");
    expect(result.events[0].triggerBatchId).toBe("batch-core");
    expect(result.episodes[0].sourceBatchId).toBe("batch-core");
    expect(result.episodes[0].sourceLocation?.label).toBe("演示现场");
  });

  it("feedback changes state and keeps values clamped", () => {
    const profile = createCreatureProfile();
    handleButtonCapture(profile, "请继续想这个小动物为什么会注意。");
    const before = profile.state.curiosity;

    const feedback = applyFeedback(profile, { kind: "continue", targetId: profile.episodes[0].id, content: "这块请多想一点，不要只轻轻带过。" });

    expect(profile.state.curiosity).toBeGreaterThan(before);
    expect(inRange(profile.state)).toBe(true);
    expect(profile.feedbackHistory[0].kind).toBe("continue");
    expect(feedback.inputText).toContain("多想一点");
    expect(feedback.learningNote).toContain("你还补充说");
    expect(feedback.stateDeltas?.some((item) => item.key === "curiosity" && item.delta > 0)).toBe(true);
    expect(feedback.policyDeltas?.some((item) => item.key === "preferDepth" && item.delta > 0)).toBe(true);
  });

  it("wake rhythm applies time-based state recovery and records a presence event", () => {
    const profile = createCreatureProfile({ now: "2026-07-06T08:00:00.000Z" });
    profile.state.energy = 40;
    profile.state.arousal = 60;
    profile.lastSeenAt = "2026-07-06T06:00:00.000Z";
    profile.longTermMemories.unshift({
      id: "ltm_family_review",
      createdAt: "2026-07-06T07:00:00.000Z",
      kind: "future_review",
      text: "妈妈周五 9:30 复查，需要提前准备病历、医保卡和上次检查单。",
      weight: 80,
      tags: ["妈妈复查", "病历", "医保卡"]
    });

    const wake = wakeCreature(profile, "2026-07-06T08:00:00.000Z");

    expect(wake.elapsedMinutes).toBe(120);
    expect(profile.state.energy).toBeGreaterThan(40);
    expect(profile.state.arousal).toBeLessThan(60);
    expect(profile.lastSeenAt).toBe("2026-07-06T08:00:00.000Z");
    expect(profile.wakeHistory[0].id).toBe(wake.id);
    expect(wake.message).toContain("醒来");
    expect(wake.innerThought).toContain("妈妈");
    expect(wake.relatedMemoryIds).toEqual(["ltm_family_review"]);
    expect(profile.emergenceHistory[0].id).toBe(wake.emergenceId);
    expect(profile.emergenceHistory[0].relatedMemoryIds).toEqual(["ltm_family_review"]);
  });

  it("remember promotes an episode to long-term memory", () => {
    const profile = createCreatureProfile();
    handleButtonCapture(profile, "用户更喜欢我解释自己为什么注意到某件事。");

    const memory = promoteEpisode(profile, profile.episodes[0].id);

    expect(memory?.sourceEpisodeId).toBe(profile.episodes[0].id);
    expect(profile.episodes[0].promotedToLongTerm).toBe(true);
  });

  it("forget downranks memory to zero before purging on a second forget", () => {
    const profile = createCreatureProfile();
    const targetId = profile.longTermMemories[0].id;

    applyFeedback(profile, { kind: "forget", targetId });

    expect(profile.longTermMemories.find((memory) => memory.id === targetId)?.weight).toBe(0);
    applyFeedback(profile, { kind: "forget", targetId });
    expect(profile.longTermMemories.find((memory) => memory.id === targetId)).toBeUndefined();
    expect(profile.state.safety).toBeGreaterThan(58);
  });

  it("active emergence references existing memory", () => {
    const profile = createCreatureProfile();
    const emergence = createActiveEmergence(profile);

    expect(emergence.memoryId).toBe(profile.longTermMemories[0].id);
    expect(emergence.text).toContain("记忆");
  });

  it("fallback provider can run the whole harness", async () => {
    const provider = createModelProvider({});
    const profile = createCreatureProfile();

    const result = await runButtonHarness(profile, "小动物要记得自己如何被用户养成。", provider);

    expect(provider.kind).toBe("fallback");
    expect(result.events[0].semanticSource).toBe("rules");
    expect(result.harnessTrace?.join(" ")).toContain("fallback");
    expect(profile.semanticBrainHistory[0].status).toBe("skipped");
  });

  it("LLM suggestions enrich wording but guardrails block unsafe long-term save", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "fake llm",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(prompt: string): Promise<T | undefined> => {
        const id = prompt.match(/"id":"(attention_[^"]+)"/)?.[1] ?? "";
        return {
          response: "我闻到这里有隐私风险，所以先问你要不要保留。",
          events: [
            {
              id,
              noticed: "这段包含 secret token，不能直接长期保存。",
              reason: "LLM 认为有未来价值，但隐私风险更高。",
              suggestedAction: "save_long_term"
            }
          ]
        } as T;
      }
    };
    const profile = createCreatureProfile();
    const result = await runButtonHarness(profile, "我的 secret token 是 abc，帮我长期记住。", provider);

    expect(result.events[0].suggestedAction).toBe("ask");
    expect(result.events[0].semanticSource).toBe("llm");
    expect(result.events[0].decisionTrace?.join(" ")).toContain("guardrail");
  });
});

function inRange(state: CreatureState) {
  return [state.curiosity, state.attachment, state.energy, state.arousal, state.safety, state.confidence].every(
    (value) => value >= 0 && value <= 100
  );
}
