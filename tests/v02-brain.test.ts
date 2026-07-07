import { describe, expect, it } from "vitest";
import { handleButtonCapture, handleCuriousStream } from "../src/core/attention";
import { semanticDecideEmergence } from "../src/core/emergence";
import { applyFeedback, semanticReflectFeedback } from "../src/core/feedback";
import { runButtonHarness, runCuriousHarness } from "../src/core/harness";
import { enrichFeedbackNarration } from "../src/core/narration";
import { createCreatureProfile } from "../src/core/profile";
import type { ModelProvider } from "../src/core/provider";

describe("creature brain v0.2", () => {
  it("curious session selects salient segments from an 8-part stream and audits ignored segments", () => {
    const profile = createCreatureProfile();
    handleButtonCapture(profile, "我不希望小动物像工具，它应该先学会注意和反馈。");

    const result = handleCuriousStream(profile, [
      segment("s1", "早餐", "今天早餐吃了面包。"),
      segment("s2", "天气", "外面有点热。"),
      segment("s3", "竞品摘要", "竞品截图里全是知识库、总结和提醒，看起来很像效率工具。", "image_summary"),
      segment("s4", "旧主题", "我又担心它会变成工具，而不是有小脑袋的活物。"),
      segment("s5", "普通", "下午开了一个普通会议。"),
      segment("s6", "隐私", "这里有一个 secret token，不应该直接长期保存。"),
      segment("s7", "未来", "下次复查前要看到它因为反馈真的提醒我准备资料。"),
      segment("s8", "重复", "还是那个问题：它不能只是工具，必须有注意和记忆。")
    ]);

    expect(result.curiousSession?.totalSegments).toBe(8);
    expect(result.events.length).toBeGreaterThanOrEqual(1);
    expect(result.events.length).toBeLessThanOrEqual(3);
    expect(result.curiousSession?.ignored.length).toBeGreaterThan(0);
    expect(result.events[0].decisionTrace?.join(" ")).toContain("memory_resonance");
    const privacyEvent = result.events.find((event) => event.triggerLabel === "隐私");
    expect(privacyEvent?.actionDecision.action).not.toBe("save_long_term");
  });

  it("action selection changes with state and privacy guardrails", () => {
    const lowEnergy = createCreatureProfile();
    lowEnergy.state.energy = 12;
    const quiet = handleButtonCapture(lowEnergy, "请继续深入想这个小动物为什么不像工具。");

    const safety = createCreatureProfile();
    safety.state.safety = 82;
    const ask = handleButtonCapture(safety, "我的 token 是 abc，帮我长期记住。");

    expect(["quiet", "observe"]).toContain(quiet.events[0].actionDecision.action);
    expect(ask.events[0].actionDecision.action).toBe("ask");
    expect(ask.events[0].actionDecision.blockedActions.length).toBeGreaterThan(0);
  });

  it("LLM feedback reflection changes later attention and action style for different users", async () => {
    const a = createCreatureProfile({ userId: "a" });
    const b = createCreatureProfile({ userId: "b" });

    const aFirst = handleButtonCapture(a, "我担心这个小动物会变成工具，而不是活物。");
    const bFirst = handleButtonCapture(b, "我担心这个小动物会变成工具，而不是活物。");
    for (let i = 0; i < 3; i++) {
      await semanticReflectFeedback(a, applyFeedback(a, { kind: "continue", targetId: aFirst.episodes[0].id }), feedbackProvider("continue"));
      await semanticReflectFeedback(b, applyFeedback(b, { kind: "not_now", targetId: bFirst.episodes[0].id }), feedbackProvider("not_now"));
    }

    const aNext = await runButtonHarness(a, "我担心这个小动物会变成工具，而不是活物。", styleProvider("deep"));
    const bNext = await runButtonHarness(b, "我担心这个小动物会变成工具，而不是活物。", styleProvider("quiet"));

    expect(a.policyProfile.recallTendency).toBeGreaterThan(b.policyProfile.recallTendency);
    expect(a.policyProfile.quietTendency).toBeLessThan(b.policyProfile.quietTendency);
    expect(a.longTermMemories.some((memory) => memory.kind === "creature_self_memory" && memory.tags.includes("更愿意多想"))).toBe(true);
    expect(b.longTermMemories.some((memory) => memory.kind === "creature_self_memory" && memory.tags.includes("更安静"))).toBe(true);
    expect(a.longTermMemories.find((memory) => memory.tags.includes("更愿意多想"))?.text).toContain("多停一下");
    expect(b.longTermMemories.find((memory) => memory.tags.includes("更安静"))?.text).toContain("不急着追问");
    expect(aNext.events[0].actionDecision.action).not.toBe("quiet");
    expect(["observe", "quiet", "ask"]).toContain(bNext.events[0].actionDecision.action);
    expect(aNext.response).toMatch(/不要浅浅带过|继续多想/);
    expect(aNext.events[0].creatureExperience.earReason).toContain("靠近");
    expect(bNext.response).toBe("");
    expect(bNext.events[0].creatureExperience.earReason).toContain("安静");
  });

  it("memory consolidation creates candidates before long-term promotion", () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "用户更重视我解释为什么注意，而不是只总结。");

    expect(result.memoryCandidates?.[0].status).toBe("candidate");
    expect(result.memoryCandidates?.[0].candidateText).toContain("你当时告诉我");
    expect(result.memoryCandidates?.[0].candidateText).not.toContain("当时我回应你");
    expect(result.memoryCandidates?.[0].whyConsolidate).toBe("");
    expect(profile.longTermMemories.some((memory) => memory.sourceEpisodeId === result.episodes[0].id)).toBe(false);

    applyFeedback(profile, { kind: "remember", targetId: result.episodes[0].id });

    const promoted = profile.longTermMemories.find((memory) => memory.sourceEpisodeId === result.episodes[0].id && memory.text.includes("你当时告诉我"));
    expect(promoted).toBeTruthy();
    expect(promoted?.text).toContain("你当时告诉我");
    expect(promoted?.consolidatedBecause).toBe("");
  });

  it("continue feedback no longer reclassifies memory without the memory model", () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "这个问题还没想完：怎样让它真的像一个有小脑袋的活物？");

    applyFeedback(profile, { kind: "continue", targetId: result.episodes[0].id });

    expect(profile.memoryCandidates.every((candidate) => candidate.memoryKind === "long_theme")).toBe(true);
    expect(profile.memoryCandidates.every((candidate) => candidate.whyConsolidate === "")).toBe(true);
  });

  it("LLM emergence follows selected memory and stays user-isolated", async () => {
    const a = createCreatureProfile({ userId: "a" });
    const b = createCreatureProfile({ userId: "b" });
    handleButtonCapture(a, "用户 A 的长期主题是小动物不能像工具。");
    applyFeedback(a, { kind: "remember", targetId: a.episodes[0].id });
    b.state.safety = 88;
    const memoryId = a.longTermMemories.find((memory) => memory.sourceEpisodeId === a.episodes[0].id)?.id;
    if (!memoryId) throw new Error("expected memory");

    const aEmergence = await semanticDecideEmergence(a, emergenceProvider({
      memoryId,
      message: "我想起你说过 Papo 不能只是工具，要更像有小脑袋的活物。你继续说时，我会按这个方向听。"
    }));

    expect(aEmergence.relatedMemoryIds.every((id) => a.longTermMemories.some((memory) => memory.id === id))).toBe(true);
    await expect(semanticDecideEmergence(b, emergenceProvider({
      memoryId,
      message: "我想起你说过 Papo 不能只是工具，要更像有小脑袋的活物。"
    }))).rejects.toThrow(/unavailable memory|unsafe message/);
  });

  it("invalid LLM JSON fails loudly instead of falling back", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "bad json model",
      available: true,
      usesRealModel: true,
      generate: async () => "not-json",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>() => ({ nope: true }) as T
    };
    const profile = createCreatureProfile();

    await expect(runButtonHarness(profile, "小动物要记得自己如何被用户养成。", provider)).rejects.toThrow(/invalid action JSON/);
  });

  it("LLM can narrate feedback learning without mutating rule-owned state", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "narration model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>() =>
        ({
          learningNote: "我学到：妈妈复查这件事你希望我多停一下，之后遇到相似担心时，我会先陪你把它放稳。",
          trace: ["llm: feedback narration"]
        }) as T
    };
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "我有点担心自己又把妈妈复查这件事拖到睡前。");
    const feedback = applyFeedback(profile, { kind: "continue", targetId: result.episodes[0].id, content: "我主要是怕又拖到最后。" });
    const stateAfterRules = structuredClone(profile.state);
    const actionAfterRules = feedback.responseAction;

    await enrichFeedbackNarration(profile, feedback, provider);

    expect(feedback.learningNote).toContain("妈妈复查");
    expect(feedback.followUpText).toBeUndefined();
    expect(feedback.replyText).toContain("妈妈复查");
    expect(feedback.responseAction).toBe(actionAfterRules);
    expect(profile.state).toEqual(stateAfterRules);
  });

  it("rejects internal LLM wording in feedback narration", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "leaky feedback narration model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>() =>
        ({
          learningNote: "我学到：用户希望系统进入继续想流程，后续写入长期记忆。",
          followUpText: "后台流程要不要继续？",
          trace: ["llm: leaky feedback narration"]
        }) as T
    };
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "我有点担心自己又把妈妈复查这件事拖到睡前。");
    const feedback = applyFeedback(profile, { kind: "continue", targetId: result.episodes[0].id });
    const ruleLearning = feedback.learningNote;
    const ruleFollowUp = feedback.followUpText;

    await expect(enrichFeedbackNarration(profile, feedback, provider)).rejects.toThrow(/invalid feedback narration/);
    expect(feedback.learningNote).toBe(ruleLearning);
    expect(feedback.followUpText).toBe(ruleFollowUp);
  });

  it("keeps useful feedback narration when optional fields are empty strings", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "sparse feedback narration model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>() =>
        ({
          learningNote: "我学到：妈妈复查这件事你希望我多停一下，之后我会更认真接住。",
          followUpText: "",
          trace: [""]
        }) as T
    };
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "我有点担心自己又把妈妈复查这件事拖到睡前。");
    const feedback = applyFeedback(profile, { kind: "continue", targetId: result.episodes[0].id });
    const ruleFollowUp = feedback.followUpText;

    await enrichFeedbackNarration(profile, feedback, provider);

    expect(feedback.learningNote).toContain("妈妈复查");
    expect(feedback.followUpText).toBe(ruleFollowUp);
    expect(feedback.replyText).toBe(feedback.learningNote);
  });

});

function emergenceProvider(input: { memoryId: string; message: string }): ModelProvider {
  return {
    kind: "generic",
    name: "v02 emergence model",
    available: true,
    usesRealModel: true,
    generate: async () => "",
    summarizeImage: async () => "",
    transcribeAudio: async () => "",
    generateJson: async <T,>(): Promise<T | undefined> =>
      ({
        shouldEmerge: true,
        memoryId: input.memoryId,
        driveSource: "attachment",
        whyNow: "我想把这条真实记住的事带回当前对话里。",
        message: input.message,
        proactiveLevel: "gentle"
      }) as T
  };
}

function feedbackProvider(kind: "continue" | "not_now"): ModelProvider {
  const deep = kind === "continue";
  return {
    kind: "generic",
    name: "v02 feedback model",
    available: true,
    usesRealModel: true,
    generate: async () => "",
    summarizeImage: async () => "",
    transcribeAudio: async () => "",
    generateJson: async <T,>(): Promise<T | undefined> =>
      ({
        responseAction: deep ? "acknowledge" : "quiet",
        stateDeltas: deep ? { curiosity: 4, attachment: 2 } : { arousal: -4 },
        policyDeltas: deep ? { preferDepth: 7, recallTendency: 6, quietTendency: -2 } : { quietTendency: 8, preferProactivity: -5, askThreshold: 3 },
        memoryWeightDelta: deep ? 6 : -4,
        learningNote: deep ? "我学到：这类担心不要浅浅带过，要多停一下。" : "我学到：这类担心先安静陪着，不急着追问。",
        effect: deep ? "你是在教我更认真接住相近担心。" : "你是在教我先收住声音，别急着打扰。",
        creatureSelfMemory: {
          text: deep ? "你教我遇到这类担心时，不要浅浅带过，要多停一下。" : "你教我遇到这类担心时，先轻声陪着，不急着追问。",
          tags: deep ? ["更愿意多想"] : ["更安静"]
        }
      }) as T
  };
}

function styleProvider(style: "deep" | "quiet"): ModelProvider {
  const deep = style === "deep";
  return {
    kind: "generic",
    name: `${style} v02 style model`,
    available: true,
    usesRealModel: true,
    generate: async () => "",
    summarizeImage: async () => "",
    transcribeAudio: async () => "",
    generateJson: async <T,>(prompt: string): Promise<T | undefined> => {
      const eventId = firstAttentionId(prompt);
      if (prompt.includes("行动选择脑")) {
        return {
          decisions: [{
            eventId,
            action: deep ? "respond" : "quiet",
            shouldReply: deep,
            reply: deep ? "这件担心我不会浅浅带过，会继续多想一会儿。" : undefined,
            visibleReaction: deep ? "Papo 靠近一点看着你" : "Papo 安静趴在你旁边"
          }]
        } as T;
      }
      if (prompt.includes("语义脑")) {
        return {
          response: deep ? "这件担心我不会浅浅带过，会继续多想一会儿。" : undefined,
          interaction: {
            userIntent: "你在说担心 Papo 变成工具，而不是活物。",
            emotionalTone: "担心",
            visibleReaction: deep ? "Papo 靠近一点看着你" : "Papo 安静趴在你旁边",
            shouldReply: deep,
            suggestedAction: deep ? "respond" : "quiet",
            reply: deep ? "这件担心我不会浅浅带过，会继续多想一会儿。" : undefined,
            memoryCandidateText: "你担心 Papo 变成工具，而不是更像活物。",
            memoryTags: ["活物", "工具感"]
          }
        } as T;
      }
      if (prompt.includes("记忆决策脑")) {
        return {
          candidates: extractCandidateIds(prompt).map((candidateId) => ({
            candidateId,
            shouldKeepCandidate: true,
            candidateText: "你担心 Papo 变成工具，而不是更像活物。",
            memoryKind: "creature_self_memory",
            confidence: 78,
            writePolicy: "wait_feedback",
            whyConsolidate: "这和你希望 Papo 更像活物有关。",
            decayPolicy: "decay_without_feedback",
            tags: ["活物", "工具感"]
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
