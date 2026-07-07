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

    const summary = createContrastSummary({
      deepProfile: a,
      quietProfile: b,
      deepResult: aNext,
      quietResult: bNext
    });
    expect(summary).toContain("被你鼓励多想的 Papo");
    expect(summary).toContain("被你教会轻声陪着的 Papo");
    expect(summary).not.toContain("深想型");
    expect(summary).not.toContain("安静型");
    expect(summary).toContain("更愿意停下来多想一点");
    expect(summary).toContain("更会收住声音");
    expect(summary).not.toContain(`深入倾向 ${a.policyProfile.preferDepth}`);
    expect(summary).not.toContain(`安静倾向 ${b.policyProfile.quietTendency}`);
    expect(summary).toContain("它们的内在选择也不一样");
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

  it("invalid LLM JSON falls back and is visible in diagnostics", async () => {
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

    const result = await runButtonHarness(profile, "小动物要记得自己如何被用户养成。", provider);

    expect(result.events).toHaveLength(1);
    expect(result.harnessTrace?.join(" ")).toContain("invalid model JSON");
    expect(result.events[0].semanticSource).toBe("rules");
    expect(profile.semanticBrainHistory[0].status).toBe("invalid");
    expect(profile.semanticBrainHistory[0].providerName).toBe("bad json model");
  });

  it("LLM can explain curious selection while rules still cap events to 1-3", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "semantic model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(prompt: string) => {
        const ids = [...prompt.matchAll(/"id":"(attention_[^"]+)"/g)].map((match) => match[1]);
        return {
          response: "我不是总结全部，而是挑出最像身份校准和未来行动的片段。",
          events: ids.map((id) => ({
            id,
            noticed: "LLM 语义脑认为这是一个关键转折点。",
            reason: "它同时包含情绪担心、未来准备和需要被反馈养成的线索。",
            suggestedAction: "recall"
          })),
          curiousSession: {
            creatureReport: "我陪你看完这一小段世界后，只把复查担心和未来准备这两处叼了出来，其他背景声先让它们过去。",
            selected: [
              { segmentId: "s2", whySelected: "这段不是普通抱怨，它在说妈妈复查这件事总被拖到睡前。" },
              { segmentId: "s3", whySelected: "这段关系到下次能不能真的提前把资料准备好。" }
            ],
            ignored: [
              { segmentId: "s1", whyIgnored: "它更像今天路过的背景声，没有拉起旧记忆，也不需要 Papo 插话。" },
              { segmentId: "s4", whyIgnored: "它和第一段普通记录一样轻，我先不把每个背景声都抓住。" }
            ]
          },
          trace: ["llm: semantic curious judgment"]
        } as T;
      }
    };
    const profile = createCreatureProfile();
    const result = await runCuriousHarness(
      profile,
      [
        segment("s1", "普通", "今天只是普通记录。"),
        segment("s2", "家事", "我担心妈妈复查这件事又被拖到睡前。"),
        segment("s3", "未来", "下次复查前需要提前一天把资料准备好。"),
        segment("s4", "普通2", "又一个普通记录。")
      ],
      provider
    );

    expect(result.events.length).toBeGreaterThanOrEqual(1);
    expect(result.events.length).toBeLessThanOrEqual(3);
    expect(result.events[0].semanticSource).toBe("llm");
    expect(result.curiousSession?.selected.some((item) => item.whySelected.includes("拖到睡前"))).toBe(true);
    expect(result.curiousSession?.ignored.some((item) => item.whyIgnored.includes("背景声"))).toBe(true);
    expect(result.curiousSession?.creatureReport).toContain("叼了出来");
    expect(result.curiousSession?.selected.map((item) => item.segmentId)).toContain("s2");
    expect(result.harnessTrace?.join(" ")).toContain("llm interpretation applied");
    expect(profile.semanticBrainHistory[0].status).toBe("applied");
  });

  it("LLM can promote a near-threshold curious segment while rules keep the attention budget", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "semantic model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>() =>
        ({
          response: "我先盯住你担心复查这件事，也把明天要带资料检查这点叼出来，因为它会影响这件家事能不能真的准备好。",
          curiousSession: {
            creatureReport: "我没有总结全部，只把担心复查和明天带资料检查这两点认真叼住。",
            selected: [
              { segmentId: "s2", whySelected: "这段说的是复查担心，情绪比较重。" },
              { segmentId: "s3", whySelected: "虽然规则分数接近阈值，但它补上了明天要带资料检查这个具体准备动作。" }
            ],
            ignored: [{ segmentId: "s1", whyIgnored: "这只是背景声，我先放过去。" }]
          },
          trace: ["llm: promoted near-threshold preparation segment"]
        }) as T
    };
    const profile = createCreatureProfile();
    const result = await runCuriousHarness(
      profile,
      [
        segment("s1", "背景", "今天只是普通记录。"),
        segment("s2", "担心", "我担心妈妈复查这件事又被拖到睡前。"),
        segment("s3", "准备", "明天带资料检查")
      ],
      provider
    );

    expect(result.curiousSession?.selected.map((item) => item.segmentId)).toContain("s3");
    expect(result.curiousSession?.ignored.map((item) => item.segmentId)).not.toContain("s3");
    expect(result.events.some((event) => event.triggerSegmentId === "s3")).toBe(true);
    const promoted = result.events.find((event) => event.triggerSegmentId === "s3");
    expect(promoted?.semanticSource).toBe("llm");
    expect(promoted?.decisionTrace?.join(" ")).toContain("promoted near-threshold");
    expect(result.events.length).toBeLessThanOrEqual(result.curiousSession?.attentionBudget ?? 3);
    expect(result.harnessTrace?.join(" ")).toContain("llm interpretation applied");
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

    const rejected = await enrichEmergenceNarration(profile, unsafe, unsafeProvider);

    expect(rejected.text).toBe(unsafeOriginal);
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
            "我先摸到被你养成的更愿意多想：妈妈复查这类担心不要浅浅带过。它现在冒出来，是因为我还想照着你教的方式多听一会儿。",
          trace: ["llm: self-memory emergence narration"]
        } as T;
      }
    };

    const enriched = await enrichEmergenceNarration(profile, emergence, provider);

    expect(promptSeen).toContain("被用户教出来的习惯");
    expect(promptSeen).toContain("不能写成普通旧事");
    expect(enriched.text).toContain("被你养成");
    expect(enriched.text).toContain("更愿意多想");
    expect(enriched.text).not.toMatch(/我想起了|旧事|我浮现的是|下一次你给我信息流/);
  });
});

function segment(id: string, label: string, content: string, kind: "text" | "image_summary" | "audio_transcript" = "text") {
  return { id, label, content, kind };
}
