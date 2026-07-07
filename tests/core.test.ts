import { describe, expect, it, vi } from "vitest";
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
    expect(result.response).not.toContain("我先试着理解");
    expect(result.response).not.toContain("当前工作区");
  });

  it("rule fallback responds to ordinary shared moments without analysis-template wording", () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "刚刚医生确认复查时间改到周六上午。");
    const event = result.events[0];

    expect(event).toBeDefined();
    if (!event) throw new Error("expected attention event");
    expect(event.scoreBreakdown).toBeDefined();
    if (!event.scoreBreakdown) throw new Error("expected score breakdown");
    expect(event.noticed).toContain("复查");
    expect(event.scoreBreakdown.futureValue).toBeGreaterThan(0);
    expect(result.response).toMatch(/共同经历|提醒草稿|复查/);
    expect(result.episodes[0].possibleIntent).toContain("我们刚一起经过的情景");
    expect(result.response).not.toContain("我先试着理解");
    expect(result.response).not.toContain("我注意到这个片段可能");
    expect(result.episodes[0].possibleIntent).not.toContain("认真理解并判断");
  });

  it("fallback repair can respond to a direct call when the semantic model is unavailable", async () => {
    const provider = createModelProvider({});
    const profile = createCreatureProfile();
    const result = await runButtonHarness(profile, "如果你能说话，你就说句话给我听。", provider);

    expect(result.events[0].actionDecision.action).toBe("respond");
    expect(result.events[0].semanticSource).toBe("fallback");
    expect(result.response).toContain("我在，听见了");
    expect(result.episodes[0].creatureResponse).toContain("我在，听见了");
    expect(result.memoryCandidates?.[0].candidateText).toContain("你曾经对我说");
    expect(result.memoryCandidates?.[0].candidateText).toContain("当时我回应你");
    expect(result.episodes[0].creatureExperience?.earReason).not.toContain("显著性");
    expect(result.episodes[0].creatureExperience?.earReason).not.toContain("用户主动交给我");
  });

  it("fallback repair handles playful greeting input without turning it into a generic ask flow", async () => {
    const provider = createModelProvider({});
    const profile = createCreatureProfile();
    const result = await runButtonHarness(profile, "汪汪！", provider);

    expect(result.events[0].actionDecision.action).toBe("respond");
    expect(result.response).toContain("我在，听见了");
  });

  it("curious mode selects salient stream events instead of summarizing everything", () => {
    const profile = createCreatureProfile();
    const result = handleCuriousStream(profile, [
      { id: "s1", kind: "text", label: "闲聊", content: "今天午饭还不错。" },
      {
        id: "s2",
        kind: "text",
        label: "核心",
        content: "我担心自己又把妈妈复查拖到睡前，所以想让 Papo 先注意到这件家事。",
        batchId: "batch-core",
        observedAt: "2026-07-06T10:00:30.000Z",
        location: { latitude: 52.52, longitude: 13.405, accuracy: 20, label: "家里" }
      },
      { id: "s3", kind: "text", label: "未来", content: "下次复查前一天要提醒自己把资料放进包里。" }
    ]);

    expect(result.events.length).toBeGreaterThanOrEqual(1);
    expect(result.events.length).toBeLessThanOrEqual(3);
    expect(result.events[0].triggerLabel).toBe("核心");
    expect(result.events[0].triggerBatchId).toBe("batch-core");
    expect(result.episodes[0].sourceBatchId).toBe("batch-core");
    expect(result.episodes[0].sourceLocation?.label).toBe("家里");
    expect(result.memoryCandidates?.[0].candidateText).toContain("那一小段的时间是 2026-07-06 10:00:30 UTC");
    expect(result.memoryCandidates?.[0].candidateText).toContain("地点是家里");
    expect(result.memoryCandidates?.[0].candidateText).not.toContain("batch-core");
    const memory = promoteEpisode(profile, result.episodes[0].id);
    expect(memory?.text).toContain("那一小段的时间是 2026-07-06 10:00:30 UTC");
    expect(memory?.text).toContain("地点是家里");
    expect(memory?.text).not.toContain("batch-core");
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
    expect(feedback.responseAction).toBe("ask_follow_up");
    expect(feedback.followUpText).toContain("下次再碰到");
    expect(feedback.followUpText).toMatch(/小动物|注意/);
    expect(feedback.replyText).toContain(feedback.followUpText);
    expect(feedback.memoryCandidateIds?.length).toBeGreaterThan(0);
    expect(profile.memoryCandidates[0].candidateText).toContain("你后来教我补上这一点");
    expect(profile.memoryCandidates[0].candidateText).not.toContain("用户反馈这段");
    expect(profile.longTermMemories[0].kind).toBe("creature_self_memory");
    expect(profile.longTermMemories[0].text).toContain("你教我不要浅浅带过");
    expect(profile.longTermMemories[0].text).toContain("你还用自己的话教我");
    expect(profile.longTermMemories[0].tags).toContain("更愿意多想");
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
    expect(wake.innerThought).not.toMatch(/不是提醒|内在倾向|下一次你给我信息流|新的信息流/);
    expect(wake.relatedMemoryIds).toEqual(["ltm_family_review"]);
    expect(profile.emergenceHistory[0].id).toBe(wake.emergenceId);
    expect(profile.emergenceHistory[0].relatedMemoryIds).toEqual(["ltm_family_review"]);
  });

  it("short wake gaps sound like presence instead of a no-op system log", () => {
    const profile = createCreatureProfile({ now: "2026-07-06T07:55:00.000Z" });

    const wake = wakeCreature(profile, "2026-07-06T08:00:00.000Z");

    expect(wake.elapsedMinutes).toBe(5);
    expect(wake.message).toContain("我还在这里");
    expect(wake.message).not.toContain("没有把这当成新的经历");
    expect(wake.message).not.toContain("当前状态");
  });

  it("wake can carry feedback-shaped self memory without faking a shared old event", () => {
    const profile = createCreatureProfile({ now: "2026-07-06T06:00:00.000Z" });
    const result = handleButtonCapture(profile, "我担心自己又把妈妈复查这件事拖到睡前。", "2026-07-06T06:01:00.000Z");
    applyFeedback(profile, { kind: "continue", targetId: result.episodes[0].id, now: "2026-07-06T06:02:00.000Z" });
    profile.lastSeenAt = "2026-07-06T06:02:00.000Z";

    const wake = wakeCreature(profile, "2026-07-06T08:02:00.000Z");

    expect(wake.innerThought).toContain("你教过我的样子");
    expect(wake.innerThought).toContain("等新的小事真的发生");
    expect(wake.innerThought).not.toContain("我想起了");
    expect(wake.innerThought).not.toMatch(/不装作|装成/);
    expect(wake.relatedMemoryIds).toEqual([expect.stringMatching(/^ltm_/)]);
    expect(profile.emergenceHistory[0].driveSource).toBe("wake_self_memory");
    expect(profile.longTermMemories.find((memory) => memory.id === wake.relatedMemoryIds[0])?.tags).toContain("被你养成");
  });

  it("wake resurfacing speaks normalized creature memory instead of raw analysis text", () => {
    const profile = createCreatureProfile({ now: "2026-07-06T06:00:00.000Z" });
    profile.lastSeenAt = "2026-07-06T06:00:00.000Z";
    profile.longTermMemories.unshift({
      id: "ltm_raw_llm_memory",
      createdAt: "2026-07-06T06:01:00.000Z",
      kind: "future_review",
      text: "我先试着理解：我注意到这个片段可能是你想让我认真理解的当前事件：如果你能说话 你就说句话给我听。我还没有强烈联想到旧记忆，所以先把它作为新的情景片段。这段需要用户确认，尤其是隐私、情绪或保存意图还不够明确。",
      weight: 80,
      tags: ["说话", "确认"]
    });

    const wake = wakeCreature(profile, "2026-07-06T08:00:00.000Z");

    expect(wake.innerThought).toContain("你刚递给我的这件小事");
    expect(wake.innerThought).toContain("这段我会先放轻一点");
    expect(wake.innerThought).not.toMatch(/我先试着理解|当前事件|用户|小动物|旧记忆|保存意图|情景片段/);
  });

  it("remember promotes an episode to long-term memory", () => {
    const profile = createCreatureProfile();
    handleButtonCapture(profile, "用户更喜欢我解释自己为什么注意到某件事。");

    const memory = promoteEpisode(profile, profile.episodes[0].id);

    expect(memory?.sourceEpisodeId).toBe(profile.episodes[0].id);
    expect(profile.episodes[0].promotedToLongTerm).toBe(true);
  });

  it("does not classify ordinary noticed life moments as Papo self memory", () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "妈妈周五复查这件事需要我提前准备病历。");
    const memory = promoteEpisode(profile, result.episodes[0].id);

    expect(memory?.kind).not.toBe("creature_self_memory");
    expect(["future_review", "long_theme"]).toContain(memory?.kind);
    expect(memory?.text).toContain("复查");
  });

  it("forget downranks memory to zero before purging on a second forget", () => {
    const profile = createCreatureProfile();
    const targetId = profile.longTermMemories[0].id;

    const firstForget = applyFeedback(profile, { kind: "forget", targetId });

    expect(profile.longTermMemories.find((memory) => memory.id === targetId)?.weight).toBe(0);
    expect(firstForget.followUpText).toContain("放轻到最低");
    const safetyMemory = profile.longTermMemories.find((memory) => memory.kind === "safety_rule");
    expect(safetyMemory?.text).toContain("你让我放下类似内容");
    expect(safetyMemory?.consolidatedBecause).toContain("小心边界");
    expect(safetyMemory?.consolidatedBecause).not.toContain("forget feedback");
    expect(profile.longTermMemories.some((memory) => memory.kind === "creature_self_memory" && memory.tags.includes("更小心边界"))).toBe(true);
    const secondForget = applyFeedback(profile, { kind: "forget", targetId });
    expect(profile.longTermMemories.find((memory) => memory.id === targetId)).toBeUndefined();
    expect(secondForget.followUpText).toContain("从一直记着的地方拿掉");
    expect(profile.state.safety).toBeGreaterThan(58);
  });

  it("remember feedback with teaching text updates the targeted long-term memory", () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "妈妈周五复查这件事需要我提前准备病历。");
    const memory = promoteEpisode(profile, result.episodes[0].id);
    expect(memory).toBeDefined();
    if (!memory) throw new Error("expected promoted memory");

    const feedback = applyFeedback(profile, {
      kind: "remember",
      targetId: memory.id,
      content: "还要提前把医保卡和上次检查报告放在包里。",
      now: "2026-07-06T09:00:00.000Z"
    });

    expect(feedback.responseAction).toBe("note_memory");
    expect(feedback.followUpText).toContain("贴到");
    expect(memory.text).toContain("医保卡");
    expect(memory.text).toContain("检查报告");
    expect(memory.tags.some((tag) => tag.includes("医保"))).toBe(true);
    expect(memory.tags.some((tag) => tag.includes("检查"))).toBe(true);
    expect(memory.lastReferencedAt).toBe("2026-07-06T09:00:00.000Z");
  });

  it("does not append private feedback text into a long-term memory", () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "妈妈周五复查这件事需要我提前准备病历。");
    const memory = promoteEpisode(profile, result.episodes[0].id);
    expect(memory).toBeDefined();
    if (!memory) throw new Error("expected promoted memory");
    const before = memory.text;

    applyFeedback(profile, {
      kind: "remember",
      targetId: memory.id,
      content: "医保验证码是 4921，token 是 secret-abc。",
      now: "2026-07-06T09:02:00.000Z"
    });

    expect(memory.text).toBe(before);
    expect(memory.text).not.toContain("4921");
    expect(memory.text).not.toContain("secret-abc");
  });

  it("active emergence waits instead of faking recall without shared memory", () => {
    const profile = createCreatureProfile();
    const emergence = createActiveEmergence(profile);

    expect(emergence.relatedMemoryIds).toEqual([]);
    expect(emergence.memoryId).toBeUndefined();
    expect(emergence.text).toContain("还没有能带回来的旧小事");
    expect(emergence.text).toContain("耳朵留给下一段");
    expect(emergence.text).not.toContain("所以我想起了");
    expect(emergence.text).not.toMatch(/不装作|装成/);
  });

  it("active emergence references existing shared memory", () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "妈妈周五复查这件事需要我提前准备病历。");
    applyFeedback(profile, { kind: "remember", targetId: result.episodes[0].id });

    const emergence = createActiveEmergence(profile);

    expect(profile.longTermMemories.some((memory) => memory.id === emergence.memoryId && memory.kind !== "creature_self_memory" && memory.weight > 0)).toBe(true);
    expect(emergence.text).toContain("我想起了");
    expect(emergence.text).not.toMatch(/不是提醒|内在倾向|下一次你给我信息流|我浮现的是/);
  });

  it("active emergence speaks normalized creature memory instead of raw analysis text", () => {
    const profile = createCreatureProfile();
    profile.state.curiosity = 86;
    profile.longTermMemories.unshift({
      id: "ltm_raw_active_memory",
      createdAt: "2026-07-06T06:01:00.000Z",
      kind: "future_review",
      text: "我先试着理解：我注意到这个片段可能是你想让我认真理解的当前事件：如果你能说话 你就说句话给我听。我还没有强烈联想到旧记忆，所以先把它作为新的情景片段。这段需要用户确认，尤其是隐私、情绪或保存意图还不够明确。",
      weight: 86,
      tags: ["说话", "确认"]
    });

    const emergence = createActiveEmergence(profile);

    expect(emergence.text).toContain("你刚递给我的这件小事");
    expect(emergence.text).toContain("这段我会先放轻一点");
    expect(emergence.text).not.toMatch(/我先试着理解|当前事件|用户|小动物|旧记忆|保存意图|情景片段/);
  });

  it("active emergence treats feedback-shaped self-memory as a raised habit, not an old event", () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "我担心自己又把妈妈复查拖到睡前。");
    applyFeedback(profile, { kind: "continue", targetId: result.episodes[0].id });
    profile.state.curiosity = 86;

    const emergence = createActiveEmergence(profile);
    const memory = profile.longTermMemories.find((item) => item.id === emergence.relatedMemoryIds[0]);

    expect(memory?.kind).toBe("creature_self_memory");
    expect(memory?.tags).toContain("被你养成");
    expect(emergence.message).toContain("你教过我的样子");
    expect(emergence.message).toContain("等真正的生活片段靠近");
    expect(emergence.ruleTrace).toContain("memory_type=feedback_self_memory");
    expect(emergence.message).not.toMatch(/我想起了|旧事|旧记忆|我浮现的是|下一次你给我信息流|不装作|装成/);
  });

  it("active emergence does not resurface a memory after forget downranks it to zero", () => {
    const profile = createCreatureProfile();
    const forgottenId = profile.longTermMemories[0].id;

    applyFeedback(profile, { kind: "forget", targetId: forgottenId });
    const emergence = createActiveEmergence(profile);

    expect(emergence.relatedMemoryIds).not.toContain(forgottenId);
    expect(emergence.memoryId).not.toBe(forgottenId);
  });

  it("fallback provider can run the whole harness", async () => {
    const provider = createModelProvider({});
    const profile = createCreatureProfile();

    const result = await runButtonHarness(profile, "小动物要记得自己如何被用户养成。", provider);

    expect(provider.kind).toBe("fallback");
    expect(result.events[0].semanticSource).toBe("rules");
    expect(result.harnessTrace?.join(" ")).toContain("fallback");
    expect(profile.semanticBrainHistory[0].status).toBe("skipped");
    expect(result.response).not.toContain("我先试着理解");
  });

  it("generic provider sends audio sensing through the transcription endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ text: "没有听到人声。" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    try {
      const provider = createModelProvider({
        PAPO_PROVIDER: "generic",
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "https://model.example.test/v1",
        OPENAI_MODEL: "gpt-5.5",
        OPENAI_AUDIO_MODEL: "gpt-5.5"
      });

      const result = await provider.transcribeAudio(`data:audio/wav;base64,${Buffer.from("fake wav").toString("base64")}`, "判断有没有人声。");

      expect(result).toBe("没有听到人声。");
      expect(provider.diagnostics?.audioRoute).toBe("audio_transcriptions");
      expect(provider.diagnostics?.audioModel).toBe("gpt-4o-mini-transcribe");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toBe("https://model.example.test/v1/audio/transcriptions");
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.body).toBeInstanceOf(FormData);
      expect((init.body as FormData).get("model")).toBe("gpt-4o-mini-transcribe");
      expect(JSON.stringify(init.headers ?? {})).not.toContain("Content-Type");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keeps OpenRouter as semantic brain while routing audio sensing through generic transcription", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ text: "这是一段真实转写。" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    try {
      const provider = createModelProvider({
        PAPO_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "openrouter-key",
        OPENROUTER_MODEL: "openai/gpt-5.5",
        OPENROUTER_AUDIO_MODEL: "google/gemini-3.1-flash-lite",
        OPENAI_API_KEY: "generic-key",
        OPENAI_BASE_URL: "https://model.example.test/v1"
      });

      const result = await provider.transcribeAudio(`data:audio/wav;base64,${Buffer.from("fake wav").toString("base64")}`, "转写这段声音。");

      expect(provider.kind).toBe("openrouter");
      expect(provider.diagnostics?.textProvider).toBe("openrouter");
      expect(provider.diagnostics?.audioProvider).toBe("generic");
      expect(provider.diagnostics?.audioRoute).toBe("audio_transcriptions");
      expect(provider.diagnostics?.audioModel).toBe("gpt-4o-mini-transcribe");
      expect(result).toBe("这是一段真实转写。");
      expect(fetchSpy.mock.calls[0][0]).toBe("https://model.example.test/v1/audio/transcriptions");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("can keep audio on the primary provider when explicitly requested", () => {
    const provider = createModelProvider({
      PAPO_PROVIDER: "openrouter",
      PAPO_AUDIO_PROVIDER: "primary",
      OPENROUTER_API_KEY: "openrouter-key",
      OPENROUTER_AUDIO_MODEL: "google/gemini-3.1-flash-lite",
      OPENAI_API_KEY: "generic-key"
    });

    expect(provider.kind).toBe("openrouter");
    expect(provider.diagnostics?.audioProvider).toBe("openrouter");
    expect(provider.diagnostics?.audioRoute).toBe("chat_completions");
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

  it("LLM interaction understanding drives reply, action, and memory candidate before persistence", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "interaction model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(): Promise<T | undefined> =>
        ({
          interaction: {
            userIntent: "用户在确认 Papo 是否能听见并主动回应。",
            emotionalTone: "轻轻试探，有一点期待",
            shouldReply: true,
            suggestedAction: "respond",
            reply: "我在，听见你了。我会把这次你叫我说话的小片段记下来。",
            memoryCandidateText: "用户曾经轻轻叫 Papo 说句话，Papo 回应并把这当成一次小小的共同经历。",
            memoryTags: ["回应", "共同经历"]
          },
          trace: ["llm: understood direct call"]
        }) as T
    };
    const profile = createCreatureProfile();
    const result = await runButtonHarness(profile, "如果你能说话，你就说句话给我听。", provider);

    expect(result.events[0].semanticSource).toBe("llm");
    expect(result.events[0].actionDecision.action).toBe("respond");
    expect(result.response).toContain("听见你了");
    expect(result.episodes[0].possibleIntent).toContain("主动回应");
    expect(result.episodes[0].creatureExperience?.earReason).toContain("主动回应");
    expect(result.memoryCandidates?.[0].candidateText).toContain("小小的共同经历");
    expect(result.memoryCandidates?.[0].candidateText).toContain("你曾经轻轻叫我说句话");
    expect(result.memoryCandidates?.[0].candidateText).not.toMatch(/用户|Papo|episode|candidate/);
  });

  it("does not let positive rule heuristics override the LLM interaction flow", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "interaction model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(): Promise<T | undefined> =>
        ({
          interaction: {
            userIntent: "你在确认明天之前我是否会先回应你，而不是替你生成提醒。",
            emotionalTone: "轻轻试探",
            shouldReply: true,
            suggestedAction: "respond",
            reply: "我在，先回应你。明天这件事我会先当成我们正在说话的小片段来听。",
            memoryCandidateText: "你曾经在提到明天之前先确认我会不会回应你，我先回答了你。",
            memoryTags: ["回应", "明天"]
          },
          trace: ["llm: direct response beats future heuristic"]
        }) as T
    };
    const profile = createCreatureProfile();
    const result = await runButtonHarness(profile, "明天早上之前，如果你能听见我，就先回答我一声。", provider);
    const event = result.events[0];

    expect(event).toBeDefined();
    if (!event) throw new Error("expected an attention event");
    expect(event.scoreBreakdown).toBeDefined();
    if (!event.scoreBreakdown) throw new Error("expected score breakdown");
    expect(event.scoreBreakdown.futureValue).toBeGreaterThanOrEqual(16);
    expect(event.actionDecision.action).toBe("respond");
    expect(event.actionDecision.ruleTrace).toContain("llm_suggested=respond");
    expect(event.actionDecision.ruleTrace).not.toContain("future_value_action");
    expect(result.response).toContain("我在，先回应你");
  });

  it("LLM shouldReply=false suppresses keyword reminder flow unless guardrails require otherwise", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "interaction model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(): Promise<T | undefined> =>
        ({
          interaction: {
            userIntent: "你只是把明天这件小事递给我注意，不希望我马上追问或生成提醒。",
            emotionalTone: "轻一点，不想被打扰",
            shouldReply: false,
            memoryCandidateText: "你曾经提到明天早上前要看一眼检查单，但当时更希望我安静抱住，不急着提醒。",
            memoryTags: ["明天", "检查单", "安静"]
          },
          trace: ["llm: quiet observation beats keyword reminder"]
        }) as T
    };
    const profile = createCreatureProfile();
    const result = await runButtonHarness(profile, "明天早上之前提醒我看一眼检查单，但这会儿先别打扰我。", provider);
    const event = result.events[0];

    expect(event.scoreBreakdown?.futureValue).toBeGreaterThanOrEqual(16);
    expect(event.semanticSource).toBe("llm");
    expect(event.actionDecision.action).toBe("observe");
    expect(event.actionDecision.ruleTrace).toContain("llm_suggested=observe");
    expect(event.actionDecision.ruleTrace).not.toContain("future_value_action");
    expect(event.decisionTrace?.join(" ")).toContain("llm_default_action=observe");
    expect(result.response).toContain("先轻轻抱住");
    expect(result.response).not.toMatch(/提醒草稿|问题清单/);
  });
});

function inRange(state: CreatureState) {
  return [state.curiosity, state.attachment, state.energy, state.arousal, state.safety, state.confidence].every(
    (value) => value >= 0 && value <= 100
  );
}
