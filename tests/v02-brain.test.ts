import { describe, expect, it } from "vitest";
import { handleButtonCapture, handleCuriousStream } from "../src/core/attention";
import { createContrastSummary } from "../src/core/demo";
import { createActiveEmergence } from "../src/core/emergence";
import { applyFeedback } from "../src/core/feedback";
import { runButtonHarness, runCuriousHarness } from "../src/core/harness";
import { enrichEmergenceNarration, enrichFeedbackNarration } from "../src/core/narration";
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

  it("feedback policy changes later attention and action style for different users", () => {
    const a = createCreatureProfile({ userId: "a" });
    const b = createCreatureProfile({ userId: "b" });

    const aFirst = handleButtonCapture(a, "我担心这个小动物会变成工具，而不是活物。");
    const bFirst = handleButtonCapture(b, "我担心这个小动物会变成工具，而不是活物。");
    for (let i = 0; i < 3; i++) applyFeedback(a, { kind: "continue", targetId: aFirst.episodes[0].id });
    for (let i = 0; i < 3; i++) applyFeedback(b, { kind: "not_now", targetId: bFirst.episodes[0].id });

    const aNext = handleButtonCapture(a, "我担心这个小动物会变成工具，而不是活物。");
    const bNext = handleButtonCapture(b, "我担心这个小动物会变成工具，而不是活物。");

    expect(a.policyProfile.recallTendency).toBeGreaterThan(b.policyProfile.recallTendency);
    expect(a.policyProfile.quietTendency).toBeLessThan(b.policyProfile.quietTendency);
    expect(a.longTermMemories.some((memory) => memory.kind === "creature_self_memory" && memory.tags.includes("更愿意多想"))).toBe(true);
    expect(b.longTermMemories.some((memory) => memory.kind === "creature_self_memory" && memory.tags.includes("更安静"))).toBe(true);
    expect(a.longTermMemories.find((memory) => memory.tags.includes("更愿意多想"))?.text).toContain("多停一下");
    expect(b.longTermMemories.find((memory) => memory.tags.includes("更安静"))?.text).toContain("不急着追问");
    expect(aNext.events[0].actionDecision.action).not.toBe("quiet");
    expect(["observe", "quiet", "ask"]).toContain(bNext.events[0].actionDecision.action);
    expect(aNext.response).toMatch(/不要浅浅带过|继续多想/);
    expect(aNext.events[0].creatureExperience.actionFeeling).toMatch(/多停一下|不浅浅放过/);
    expect(bNext.response).toMatch(/更安静|先轻轻记下|不急着打扰/);
    expect(bNext.events[0].creatureExperience.actionFeeling).toMatch(/收住声音|不急着追问/);

    const summary = createContrastSummary({
      deepProfile: a,
      quietProfile: b,
      deepResult: aNext,
      quietResult: bNext
    });
    expect(summary).toContain("同一句担心，两只 Papo 的接法已经分开了");
    expect(summary).toContain("被你鼓励多想后");
    expect(summary).toContain("被你教着轻声陪后");
    expect(summary).not.toContain("深想型");
    expect(summary).not.toContain("安静型");
    expect(summary).toContain("更愿意停下来多想一点");
    expect(summary).toContain("更会收住声音");
    expect(summary).not.toContain(`深入倾向 ${a.policyProfile.preferDepth}`);
    expect(summary).not.toContain(`安静倾向 ${b.policyProfile.quietTendency}`);
    expect(summary).toContain("说出口的第一反应也不一样");
    expect(summary).not.toContain("内在选择");
    expect(summary).not.toMatch(/追问确认|保存本次经历|长期记忆/);
  });

  it("memory consolidation creates candidates before long-term promotion", () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "用户更重视我解释为什么注意，而不是只总结。");

    expect(result.memoryCandidates?.[0].status).toBe("candidate");
    expect(result.memoryCandidates?.[0].candidateText).toContain("当时我回应你");
    expect(result.memoryCandidates?.[0].whyConsolidate).not.toContain("episode");
    expect(profile.longTermMemories.some((memory) => memory.sourceEpisodeId === result.episodes[0].id)).toBe(false);

    applyFeedback(profile, { kind: "remember", targetId: result.episodes[0].id });

    const promoted = profile.longTermMemories.find((memory) => memory.sourceEpisodeId === result.episodes[0].id && memory.text.includes("当时我回应你"));
    expect(promoted).toBeTruthy();
    expect(promoted?.text).toContain("当时我回应你");
    expect(promoted?.consolidatedBecause).not.toContain("episode");
  });

  it("continue creates open question or future-review candidates", () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "这个问题还没想完：怎样让它真的像一个有小脑袋的活物？");

    applyFeedback(profile, { kind: "continue", targetId: result.episodes[0].id });

    expect(profile.memoryCandidates.some((candidate) => ["open_question", "future_review", "creature_self_memory"].includes(candidate.memoryKind))).toBe(true);
  });

  it("emergence follows different drives and stays user-isolated", () => {
    const a = createCreatureProfile({ userId: "a" });
    const b = createCreatureProfile({ userId: "b" });
    handleButtonCapture(a, "用户 A 的长期主题是小动物不能像工具。");
    applyFeedback(a, { kind: "remember", targetId: a.episodes[0].id });
    b.state.safety = 88;

    const aEmergence = createActiveEmergence(a);
    const bEmergence = createActiveEmergence(b);

    expect(aEmergence.relatedMemoryIds.every((id) => a.longTermMemories.some((memory) => memory.id === id))).toBe(true);
    expect(bEmergence.relatedMemoryIds.every((id) => b.longTermMemories.some((memory) => memory.id === id))).toBe(true);
    expect(bEmergence.driveSource).toBe("safety");
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
          followUpText: "我还想轻轻问一句：下次我先帮你盯住准备资料，还是先陪你把担心说完？",
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
    expect(feedback.followUpText).toContain("准备资料");
    expect(feedback.replyText).toContain("准备资料");
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
    expect(feedback.replyText).toContain(ruleFollowUp);
  });

  it("LLM emergence narration must stay anchored to an existing memory", async () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "妈妈复查这件事对我很重要，我希望提前准备。");
    applyFeedback(profile, { kind: "remember", targetId: result.episodes[0].id });
    profile.state.curiosity = 86;
    const emergence = createActiveEmergence(profile);
    const provider: ModelProvider = {
      kind: "generic",
      name: "anchored narration model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>() =>
        ({
          message: "我刚才自己又想起妈妈复查这件事。它现在冒出来，是因为我的好奇心还在轻轻推我：下次你给我新的片段时，我会先找哪些东西能帮你提前准备。",
          trace: ["llm: emergence narration"]
        }) as T
    };

    const enriched = await enrichEmergenceNarration(profile, emergence, provider);

    expect(enriched.text).toContain("妈妈复查");
    expect(profile.emergenceHistory[0].message).toContain("妈妈复查");

    const unsafe = createActiveEmergence(profile);
    const unsafeOriginal = unsafe.message;
    const unsafeProvider: ModelProvider = {
      ...provider,
      generateJson: async <T,>() =>
        ({
          message: "我刚才想起一件不存在的旅行计划，所以准备提醒你订票。",
          trace: ["llm: unanchored hallucination"]
        }) as T
    };

    await expect(enrichEmergenceNarration(profile, unsafe, unsafeProvider)).rejects.toThrow(/reference selected memory|invalid emergence narration/);
    expect(unsafe.message).toBe(unsafeOriginal);
  });

  it("keeps useful emergence narration when optional trace is empty", async () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "妈妈复查这件事对我很重要，我希望提前准备。");
    applyFeedback(profile, { kind: "remember", targetId: result.episodes[0].id });
    profile.state.curiosity = 86;
    const emergence = createActiveEmergence(profile);
    const provider: ModelProvider = {
      kind: "generic",
      name: "sparse emergence narration model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>() =>
        ({
          message: "我刚才又想起妈妈复查这件事，因为我还惦记着你想提前准备。等你继续说时，我会先接住和准备有关的线索。",
          trace: [""]
        }) as T
    };

    const enriched = await enrichEmergenceNarration(profile, emergence, provider);

    expect(enriched.text).toContain("妈妈复查");
    expect(enriched.text).toContain("提前准备");
    expect(profile.emergenceHistory[0].ruleTrace).toContain("llm: emergence narration enriched");
  });

  it("LLM emergence narration treats feedback self-memory as a raised habit", async () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "我担心自己又把妈妈复查拖到睡前。");
    applyFeedback(profile, { kind: "continue", targetId: result.episodes[0].id });
    profile.state.curiosity = 86;
    const emergence = createActiveEmergence(profile);
    let promptSeen = "";
    const provider: ModelProvider = {
      kind: "generic",
      name: "self-memory narration model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(prompt?: string) => {
        promptSeen = prompt ?? "";
        return {
          message:
            "我想起你教过我的回应方式：妈妈复查这类担心不要浅浅带过。它现在出现，是因为我还想照着你教的方式多听一会儿。",
          trace: ["llm: self-memory emergence narration"]
        } as T;
      }
    };

    const enriched = await enrichEmergenceNarration(profile, emergence, provider);

    expect(promptSeen).toContain("被你教出来的习惯");
    expect(promptSeen).toContain("不能写成普通旧事");
    expect(enriched.text).toContain("你教过");
    expect(enriched.text).toContain("多听一会儿");
    expect(enriched.text).not.toMatch(/我想起了|旧事|我浮现的是|下一次你给我信息流/);
  });

  it("rejects internal LLM wording in emergence narration", async () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "妈妈复查这件事对我很重要，我希望提前准备。");
    applyFeedback(profile, { kind: "remember", targetId: result.episodes[0].id });
    profile.state.curiosity = 86;
    const emergence = createActiveEmergence(profile);
    const original = emergence.text;
    const provider: ModelProvider = {
      kind: "generic",
      name: "leaky emergence narration model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>() =>
        ({
          message: "用户的妈妈复查 episode 触发了语义流程，所以系统准备写入长期记忆。",
          trace: ["llm: leaky emergence narration"]
        }) as T
    };

    await expect(enrichEmergenceNarration(profile, emergence, provider)).rejects.toThrow(/invalid emergence narration/);
    expect(emergence.text).toBe(original);
  });
});

function segment(id: string, label: string, content: string, kind: "text" | "image_summary" | "audio_transcript" = "text") {
  return { id, label, content, kind };
}
