import { describe, expect, it, vi } from "vitest";
import { handleButtonCapture, handleCuriousStream } from "../src/core/attention";
import { createActiveEmergence, semanticDecideEmergence } from "../src/core/emergence";
import { applyFeedback, semanticReflectFeedback } from "../src/core/feedback";
import { runButtonHarness, runCuriousHarness } from "../src/core/harness";
import { memoryKeepReasonToCreatureVoice, promoteEpisode, toCreatureMemoryVoice } from "../src/core/memory";
import { enrichFeedbackNarration } from "../src/core/narration";
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
    expect(profile.episodes[0].noticed).toContain("不该只是工具");
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
    expect(result.response).toMatch(/我听见了|之后可能还要再看/);
    expect(result.episodes[0].possibleIntent).toContain("刚发生或刚想起");
    expect(result.response).not.toContain("我先试着理解");
    expect(result.response).not.toContain("我注意到这个片段可能");
    expect(result.response).not.toContain("我注意到这段");
    expect(result.response).not.toContain("确认我有没有听对");
    expect(result.memoryCandidates?.[0].candidateText).toContain("你当时告诉我：刚刚医生确认复查时间改到周六上午");
    expect(result.memoryCandidates?.[0].candidateText).not.toContain("我听见这件事之后可能还会回来");
    expect(result.episodes[0].possibleIntent).not.toContain("认真理解并判断");
  });

  it("rule fallback keeps cognition out of visible dialogue", () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "我准备去游泳最近每天我都游泳游泳是一个消耗卡路里效率很高的运动我很喜欢但是我不喜欢游泳馆人太多");

    expect(result.response).toContain("我听见了");
    expect(result.response).toContain("喜欢的部分");
    expect(result.response).not.toMatch(/我先听你说完|我注意到这段|刚发生的对话|确认我有没有听对|情景记忆|长期记忆/);
    expect(result.episodes[0].creatureResponse).toBe(result.response);
  });

  it("fallback repair can respond to a direct call when the semantic model is unavailable", async () => {
    const provider = createModelProvider({});
    const profile = createCreatureProfile();
    const result = await runButtonHarness(profile, "如果你能说话，你就说句话给我听。", provider);

    expect(result.events[0].actionDecision.action).toBe("respond");
    expect(result.events[0].semanticSource).toBe("fallback");
    expect(result.response).toContain("我在，听见你了");
    expect(result.response).not.toMatch(/你刚才是在叫我说话|先回应你|先回答你/);
    expect(result.episodes[0].creatureResponse).toContain("我在，听见你了");
    expect(result.memoryCandidates?.[0].candidateText).toContain("你曾经对我说");
    expect(result.memoryCandidates?.[0].candidateText).toContain("当时我回应你");
    expect(result.episodes[0].creatureExperience?.earReason).not.toContain("显著性");
    expect(result.episodes[0].creatureExperience?.earReason).not.toContain("用户主动交给我");
    expect(result.episodes[0].creatureExperience?.earReason).not.toMatch(/先回应你|先回答你/);
  });

  it("fallback repair handles playful greeting input without turning it into a generic ask flow", async () => {
    const provider = createModelProvider({});
    const profile = createCreatureProfile();
    const result = await runButtonHarness(profile, "汪汪！", provider);

    expect(result.events[0].actionDecision.action).toBe("respond");
    expect(result.response).toContain("我在，听见你了");
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
    expect(result.memoryCandidates?.[0].candidateText).toContain("你当时告诉我：我担心自己又把妈妈复查拖到睡前");
    expect(result.memoryCandidates?.[0].candidateText).not.toContain("我听见这里有一点情绪");
    expect(result.memoryCandidates?.[0].candidateText).not.toContain("batch-core");
    const memory = promoteEpisode(profile, result.episodes[0].id);
    expect(memory?.text).toContain("那一小段的时间是 2026-07-06 10:00:30 UTC");
    expect(memory?.text).toContain("地点是家里");
    expect(memory?.text).not.toContain("batch-core");
  });

  it("curious mode keeps high privacy stream content out of attention events and memory candidates", () => {
    const profile = createCreatureProfile();
    const result = handleCuriousStream(profile, [
      { id: "s1", kind: "text", label: "背景", content: "窗外有点吵，我继续做自己的事。" },
      { id: "s2", kind: "text", label: "隐私", content: "我的 secret token 是 abc，刚才复制到了剪贴板。" }
    ]);

    expect(result.events.map((event) => event.triggerSegmentId)).not.toContain("s2");
    expect(result.episodes.map((episode) => episode.sourceSegmentId)).not.toContain("s2");
    expect(result.memoryCandidates?.map((candidate) => candidate.candidateText).join(" ")).not.toContain("secret token");
    expect(result.curiousSession?.ignored.map((item) => item.segmentId)).toContain("s2");
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
    expect(feedback.effect).toContain("你让我再想一会儿");
    expect(feedback.effect).not.toMatch(/用户让我|用户说|策略改变/);
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

  it("LLM feedback reflection can shape state, policy, memory weight, and self memory inside guardrails", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "feedback model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(): Promise<T | undefined> =>
        ({
          responseAction: "ask_follow_up",
          stateDeltas: { curiosity: 5, arousal: -4 },
          policyDeltas: { preferDepth: 6, recallTendency: 5, quietTendency: -2 },
          memoryWeightDelta: 7,
          learningNote: "我学到这件事不能浅浅带过，下次相近的时候要多停一下。",
          followUpText: "下次再碰到这类事，我会先多听一会儿。",
          effect: "你这次是在鼓励我更认真地接住相近的事。",
          creatureSelfMemory: {
            text: "你教我遇到这类让你在意的事时，不要太快放过去，要先多听一会儿。",
            tags: ["更愿意多想", "多听一会儿"]
          },
          trace: ["feedback means more depth"]
        }) as T
    };
    const profile = createCreatureProfile();
    handleButtonCapture(profile, "我最近总是把妈妈复查这件事拖到很晚，想让你认真听一下。");
    const episode = profile.episodes[0];
    const beforeWeight = episode.weight;
    const beforeCuriosity = profile.state.curiosity;
    const beforeArousal = profile.state.arousal;
    const beforePreferDepth = profile.policyProfile.preferDepth;

    const feedback = applyFeedback(profile, { kind: "continue", targetId: episode.id, content: "这里别轻轻带过，请多想一点。" });
    await semanticReflectFeedback(profile, feedback, provider);

    expect(profile.state.curiosity).toBe(beforeCuriosity + 13);
    expect(profile.state.arousal).toBe(beforeArousal - 4);
    expect(profile.policyProfile.preferDepth).toBe(beforePreferDepth + 14);
    expect(profile.policyProfile.recallTendency).toBe(63);
    expect(profile.policyProfile.quietTendency).toBe(30);
    expect(episode.weight).toBe(beforeWeight + 19);
    expect(feedback.responseAction).toBe("ask_follow_up");
    expect(feedback.learningNote).toContain("我学到");
    expect(feedback.followUpText).toContain("多听一会儿");
    expect(feedback.stateDeltas?.find((item) => item.key === "curiosity")?.delta).toBe(13);
    expect(feedback.policyDeltas?.find((item) => item.key === "preferDepth")?.delta).toBe(14);
    expect(profile.longTermMemories.some((memory) => memory.kind === "creature_self_memory" && memory.tags.includes("LLM理解反馈"))).toBe(true);
    expect(profile.semanticBrainHistory[0]).toMatchObject({ source: "feedback", status: "applied" });
  });

  it("redacts private feedback and target text before feedback reflection prompts", async () => {
    let promptSeen = "";
    const provider: ModelProvider = {
      kind: "generic",
      name: "feedback privacy model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(prompt: string): Promise<T | undefined> => {
        promptSeen = prompt;
        return {
          responseAction: "quiet",
          learningNote: "我学到这类内容要先等你确认。",
          followUpText: "这类内容我先不直接留下。"
        } as T;
      }
    };
    const profile = createCreatureProfile();
    profile.longTermMemories.unshift({
      id: "ltm_private",
      createdAt: "2026-07-07T07:00:00.000Z",
      kind: "safety_rule",
      text: "我的 secret token 是 abc。",
      weight: 70,
      tags: ["secret", "abc"],
      consolidatedBecause: "private test"
    });

    const feedback = applyFeedback(profile, {
      kind: "continue",
      targetId: "ltm_private",
      content: "补充：secret token abc 更不要直接记。"
    });
    await semanticReflectFeedback(profile, feedback, provider);

    expect(promptSeen).not.toContain("secret token");
    expect(promptSeen).not.toContain("abc");
    expect(promptSeen).toContain("contentHiddenForPrivacy");
    expect(feedback.replyText).not.toMatch(/secret|token|abc/i);
    expect(profile.longTermMemories.some((memory) => /secret|token|abc/i.test(`${memory.text} ${memory.tags.join(" ")}`) && memory.kind === "creature_self_memory")).toBe(false);
  });

  it("rejects private terms from feedback narration output", async () => {
    let promptSeen = "";
    const provider: ModelProvider = {
      kind: "generic",
      name: "feedback narration privacy model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(prompt: string): Promise<T | undefined> => {
        promptSeen = prompt;
        return {
          learningNote: "我学到这次 token abc 不能直接记下来。",
          followUpText: "下次我会先问你 token 怎么办。"
        } as T;
      }
    };
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "我的 secret token 是 abc，帮我长期记住。");
    const feedback = applyFeedback(profile, {
      kind: "continue",
      targetId: result.episodes[0].id,
      content: "补充：secret token abc 不要直接留下。"
    });
    const before = feedback.replyText;

    await enrichFeedbackNarration(profile, feedback, provider);

    expect(promptSeen).not.toContain("secret token");
    expect(promptSeen).not.toContain("abc");
    expect(feedback.replyText).toBe(before);
    expect(feedback.replyText).not.toMatch(/secret|token|abc/i);
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
    expect(wake.message).not.toMatch(/刚才过去 \d+ 分钟|重新计算|当前状态/);
    expect(wake.innerThought).not.toMatch(/不是提醒|内在倾向|下一次你给我信息流|新的信息流|旧记忆|节律/);
    expect(profile.emergenceHistory[0].whyNow).not.toMatch(/旧记忆|节律/);
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

    expect(wake.innerThought).toContain("你教过我");
    expect(wake.innerThought).toContain("继续听你说");
    expect(wake.innerThought).not.toContain("我想起了");
    expect(wake.innerThought).not.toMatch(/不装作|装成|旧记忆|节律/);
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

    expect(wake.innerThought).toContain("如果你能说话");
    expect(wake.innerThought).toContain("我当时决定先放轻一点");
    expect(wake.innerThought).not.toMatch(/我先试着理解|当前事件|用户|小动物|旧记忆|保存意图|情景片段|你刚递给我的这件小事/);
  });

  it("renders old memory material in Papo's subjective voice", () => {
    const text = toCreatureMemoryVoice(
      "用户希望小动物解释自己为什么注意到重点。我还没有强烈联想到旧记忆，所以先把它作为新的情景片段。这段需要用户确认，尤其是隐私、情绪或保存意图还不够明确。"
    );
    const reason = memoryKeepReasonToCreatureVoice("这条 episode 有未来价值。");

    expect(text).toContain("你那时希望我解释自己为什么注意到重点");
    expect(text).toContain("我当时还没和旧事连起来");
    expect(text).toContain("我当时决定先放轻一点");
    expect(text).not.toMatch(/用户|小动物|当前事件|保存意图|情景片段|旧记忆/);
    expect(reason).toBe("这件事以后可能还会回来找你");
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
    expect(secondForget.followUpText).toContain("彻底放下");
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
    expect(feedback.followUpText).toContain("放在一起");
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
    expect(emergence.text).toContain("我安静了一下");
    expect(emergence.text).toContain("先只是陪在这里");
    expect(emergence.text).toContain("等你继续说");
    expect(emergence.text).not.toMatch(/足够稳定|真实内容|真的和你一起经历过/);
    expect(emergence.text).not.toMatch(/耳朵留给|抱住|叼|情景记忆/);
    expect(emergence.text).not.toContain("所以我想起了");
    expect(emergence.text).not.toMatch(/不装作|装成|假装|旧记忆|内在倾向|我浮现的是|旧事/);
  });

  it("active emergence references existing shared memory", () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "妈妈周五复查这件事需要我提前准备病历。");
    applyFeedback(profile, { kind: "remember", targetId: result.episodes[0].id });

    const emergence = createActiveEmergence(profile);

    expect(profile.longTermMemories.some((memory) => memory.id === emergence.memoryId && memory.kind !== "creature_self_memory" && memory.weight > 0)).toBe(true);
    expect(emergence.text).toContain("想起");
    expect(emergence.text).not.toMatch(/不是提醒|内在倾向|下一次你给我信息流|我浮现的是|旧记忆|节律/);
  });

  it("LLM emergence decision chooses whether and which real memory resurfaces", async () => {
    const profile = createCreatureProfile();
    const family = handleButtonCapture(profile, "妈妈周五复查这件事需要我提前准备病历。");
    const familyMemory = promoteEpisode(profile, family.episodes[0].id);
    const swim = handleButtonCapture(profile, "我最近每天游泳，喜欢运动后轻一点的感觉，但不喜欢游泳馆人太多。");
    const swimMemory = promoteEpisode(profile, swim.episodes[0].id);
    expect(familyMemory).toBeDefined();
    expect(swimMemory).toBeDefined();
    if (!swimMemory) throw new Error("expected swim memory");

    const provider: ModelProvider = {
      kind: "generic",
      name: "emergence model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(): Promise<T | undefined> =>
        ({
          shouldEmerge: true,
          memoryId: swimMemory.id,
          driveSource: "attachment",
          whyNow: "我刚才更想靠近你，于是想起你说过游泳和人太多这件事。",
          message: "我刚才想起你说过最近每天游泳，喜欢运动后轻一点的感觉，但游泳馆人太多会让你不舒服。我会把这件事放近一点听。",
          proactiveLevel: "gentle",
          trace: ["selected swimming memory"]
        }) as T
    };

    const emergence = await semanticDecideEmergence(profile, provider, "2026-07-07T07:00:00.000Z");

    expect(emergence.memoryId).toBe(swimMemory.id);
    expect(emergence.driveSource).toBe("attachment");
    expect(emergence.text).toContain("游泳");
    expect(emergence.text).toContain("人太多");
    expect(emergence.ruleTrace).toContain("llm: selected active emergence");
    expect(profile.semanticBrainHistory[0]).toMatchObject({ source: "emergence", status: "applied" });
  });

  it("redacts private recent context before emergence prompts", async () => {
    let promptSeen = "";
    const profile = createCreatureProfile();
    handleButtonCapture(profile, "我的 secret token 是 abc，刚才复制到了剪贴板。");
    applyFeedback(profile, { kind: "continue", targetId: profile.episodes[0].id, content: "补充：secret token abc 不要直接留下。" });
    profile.emergenceHistory.unshift({
      id: "emergence_private",
      at: "2026-07-07T07:00:00.000Z",
      kind: "rhythm",
      whyNow: "private test",
      relatedMemoryIds: [],
      driveSource: "rhythm",
      message: "我刚才想起 secret token abc。",
      ruleTrace: ["private test"]
    });
    const swim = handleButtonCapture(profile, "我最近每天游泳，喜欢运动后轻一点的感觉。");
    const swimMemory = promoteEpisode(profile, swim.episodes[0].id);
    expect(swimMemory).toBeDefined();
    if (!swimMemory) throw new Error("expected swim memory");

    const provider: ModelProvider = {
      kind: "generic",
      name: "emergence privacy model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(prompt: string): Promise<T | undefined> => {
        promptSeen = prompt;
        return {
          shouldEmerge: true,
          memoryId: swimMemory.id,
          driveSource: "curiosity",
          whyNow: "我还有一点想继续听你说游泳这件事。",
          message: "我想起你最近每天游泳，喜欢运动后轻一点的感觉。你继续说的时候，我会接着听。",
          proactiveLevel: "gentle"
        } as T;
      }
    };

    const emergence = await semanticDecideEmergence(profile, provider, "2026-07-07T07:10:00.000Z");

    expect(emergence.memoryId).toBe(swimMemory.id);
    expect(promptSeen).not.toContain("secret token");
    expect(promptSeen).not.toContain("abc");
    expect(promptSeen).toContain("contentHiddenForPrivacy");
  });

  it("LLM emergence cannot reference a missing or forgotten memory", async () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "妈妈周五复查这件事需要我提前准备病历。");
    const memory = promoteEpisode(profile, result.episodes[0].id);
    expect(memory).toBeDefined();
    if (!memory) throw new Error("expected memory");

    const provider: ModelProvider = {
      kind: "generic",
      name: "bad emergence model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(): Promise<T | undefined> =>
        ({
          shouldEmerge: true,
          memoryId: "ltm_missing",
          driveSource: "curiosity",
          whyNow: "我想起一条并不存在的事。",
          message: "我想起一条并不存在的事。",
          proactiveLevel: "active"
        }) as T
    };

    const emergence = await semanticDecideEmergence(profile, provider, "2026-07-07T07:05:00.000Z");

    expect(emergence.memoryId).toBe(memory.id);
    expect(emergence.relatedMemoryIds).not.toContain("ltm_missing");
    expect(profile.semanticBrainHistory[0]).toMatchObject({ source: "emergence", status: "invalid" });
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

    expect(emergence.text).toContain("如果你能说话");
    expect(emergence.text).toContain("我当时决定先放轻一点");
    expect(emergence.text).not.toMatch(/我先试着理解|当前事件|用户|小动物|旧记忆|保存意图|情景片段|你刚递给我的这件小事/);
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
    expect(emergence.message).toContain("你教过我");
    expect(emergence.message).toContain("多听一会儿");
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

      const result = await provider.transcribeAudio(`data:audio/webm;codecs=opus;base64,${Buffer.from("fake webm").toString("base64")}`, "判断有没有人声。");

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
            visibleReaction: "我抬头回应你，让你知道我听见了。",
            shouldReply: true,
            suggestedAction: "respond",
            reply: "我在，听见你了。",
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
    expect(result.episodes[0].possibleIntent).not.toMatch(/用户|Papo|语义|流程|后台/);
    expect(result.episodes[0].creatureExperience?.earReason).toContain("抬头回应");
    expect(result.episodes[0].creatureExperience?.earReason).not.toMatch(/用户|语义|意图|后台|情景记忆/);
    expect(result.memoryCandidates?.[0].candidateText).toContain("小小的共同经历");
    expect(result.memoryCandidates?.[0].candidateText).toContain("你曾经轻轻叫我说句话");
    expect(result.memoryCandidates?.[0].candidateText).not.toMatch(/用户|Papo|episode|candidate/);
  });

  it("semantic action selection owns the action before wording enrichment", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "action model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(prompt: string): Promise<T | undefined> => {
        const id = prompt.match(/"id":"(attention_[^"]+)"/)?.[1] ?? "";
        if (prompt.includes("行动选择脑")) {
          return {
            decisions: [
              {
                eventId: id,
                action: "respond",
                reason: "你是在确认我会不会直接回你。",
                shouldReply: true,
                reply: "我在，听见你了。",
                visibleReaction: "我抬头看向你。"
              }
            ]
          } as T;
        }
        return {
          response: "我来给你做一个提醒草稿。",
          interaction: {
            shouldReply: true,
            suggestedAction: "draft_reminder",
            reply: "我来给你做一个提醒草稿。",
            memoryCandidateText: "你提到明天之前的事。",
            memoryTags: ["明天"]
          }
        } as T;
      }
    };
    const profile = createCreatureProfile();
    const result = await runButtonHarness(profile, "明天早上之前，如果你能听见我，就先回答我一声。", provider);
    const event = result.events[0];

    expect(event.actionDecision.action).toBe("respond");
    expect(event.decisionTrace?.join(" ")).toContain("llm: action selected");
    expect(result.response).toContain("我在，听见你了");
    expect(result.response).not.toContain("提醒草稿");
    expect(profile.semanticBrainHistory.some((run) => run.source === "button" && run.ruleTrace.includes("stage=action"))).toBe(true);
  });

  it("answers follow-up questions about Papo wording instead of repeating process language", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "wording repair model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(prompt: string): Promise<T | undefined> => {
        const id = prompt.match(/"id":"(attention_[^"]+)"/)?.[1] ?? "";
        if (prompt.includes("行动选择脑")) {
          return {
            decisions: [
              {
                eventId: id,
                action: "respond",
                shouldReply: true,
                reply: "我刚才说先回应你，是因为我先做回应流程。",
                visibleReaction: "我抬头看你。"
              }
            ]
          } as T;
        }
        return {
          response: "我刚才说先回应你，是因为我要先回应你。",
          interaction: {
            shouldReply: true,
            suggestedAction: "respond",
            reply: "我刚才说先回应你，是因为我要先回应你。"
          }
        } as T;
      }
    };
    const profile = createCreatureProfile();
    const result = await runButtonHarness(profile, "为什么说“先回应你”，你还想后干啥？", provider);

    expect(result.response).toContain("我刚才那句说得别扭");
    expect(result.response).toContain("后面没有藏什么复杂的事");
    expect(result.response).not.toMatch(/先回应你|回应流程/);
  });

  it("redacts high privacy button content before action, wording, and memory model prompts", async () => {
    const prompts: string[] = [];
    const provider: ModelProvider = {
      kind: "generic",
      name: "privacy prompt model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(prompt: string): Promise<T | undefined> => {
        prompts.push(prompt);
        const id = prompt.match(/"id":"(attention_[^"]+)"/)?.[1] ?? "";
        if (prompt.includes("行动选择脑")) {
          return {
            decisions: [
              {
                eventId: id,
                action: "save_long_term",
                reason: "这里像是隐私内容，不能直接保存。",
                shouldReply: true,
                reply: "这类内容我先不直接留下，等你确认。"
              }
            ]
          } as T;
        }
        if (prompt.includes("记忆决策脑")) {
          const candidateId = prompt.match(/"candidateId":"(candidate_[^"]+)"/)?.[1] ?? "";
          return {
            candidates: [
              {
                candidateId,
                shouldKeepCandidate: true,
                candidateText: "这次只记得你让我小心处理一段隐私内容。",
                memoryKind: "safety_rule",
                confidence: 55,
                writePolicy: "ask_user",
                privacyReason: "内容里可能有密钥。",
                tags: ["隐私"]
              }
            ]
          } as T;
        }
        return {
          interaction: {
            shouldReply: true,
            suggestedAction: "respond",
            reply: "这类内容我先不直接留下，等你确认。",
            memoryCandidateText: "这次只记得你让我小心处理一段隐私内容。",
            memoryTags: ["隐私"]
          }
        } as T;
      }
    };
    const profile = createCreatureProfile();
    const result = await runButtonHarness(profile, "我的 secret token 是 abc，帮我长期记住。", provider);

    expect(result.events[0].actionDecision.action).toBe("ask");
    expect(result.memoryCandidates?.[0].candidateText).not.toMatch(/secret|token|abc/i);
    expect(prompts.join("\n")).not.toContain("secret token");
    expect(prompts.join("\n")).not.toContain("abc");
  });

  it("LLM memory decision shapes candidate kind, write policy, confidence, and reason", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "memory model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(prompt: string): Promise<T | undefined> => {
        if (prompt.includes("记忆决策脑")) {
          const candidateId = prompt.match(/"candidateId":"(candidate_[^"]+)"/)?.[1] ?? "";
          return {
            candidates: [
              {
                candidateId,
                shouldKeepCandidate: true,
                candidateText: "你最近每天游泳，喜欢运动后身体轻一点，但不喜欢游泳馆人太多。",
                memoryKind: "habit",
                confidence: 82,
                writePolicy: "ask_user",
                whyConsolidate: "这件事反复出现，而且和你最近的运动习惯有关。",
                decayPolicy: "stable",
                tags: ["游泳", "运动习惯", "人太多"]
              }
            ],
            trace: ["memory: habit"]
          } as T;
        }
        return {
          interaction: {
            shouldReply: true,
            suggestedAction: "respond",
            reply: "游泳这件事对你挺重要，只是人太多会让它没那么舒服。",
            memoryCandidateText: "你最近每天游泳，喜欢运动后身体轻一点，但不喜欢游泳馆人太多。",
            memoryTags: ["游泳", "运动"]
          }
        } as T;
      }
    };
    const profile = createCreatureProfile();
    const result = await runButtonHarness(profile, "我最近每天游泳，喜欢运动后轻一点的感觉，但不喜欢游泳馆人太多。", provider);
    const candidate = result.memoryCandidates?.[0];

    expect(candidate?.memoryKind).toBe("habit");
    expect(candidate?.confidence).toBe(82);
    expect(candidate?.writePolicy).toBe("ask_user");
    expect(candidate?.decayPolicy).toBe("stable");
    expect(candidate?.whyConsolidate).toContain("运动习惯");
    expect(candidate?.tags).toContain("运动习惯");
    expect(profile.semanticBrainHistory.some((run) => run.source === "memory" && run.status === "applied")).toBe(true);
  });

  it("LLM memory decision cannot auto-save high privacy content", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "unsafe memory model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(prompt: string): Promise<T | undefined> => {
        if (prompt.includes("记忆决策脑")) {
          const candidateId = prompt.match(/"candidateId":"(candidate_[^"]+)"/)?.[1] ?? "";
          return {
            candidates: [
              {
                candidateId,
                shouldKeepCandidate: true,
                candidateText: "你提到一段需要小心处理的登录信息。",
                memoryKind: "safety_rule",
                confidence: 91,
                writePolicy: "auto",
                whyConsolidate: "这类内容需要先小心边界。",
                privacyReason: "里面有 token，需要先等你确认。",
                decayPolicy: "forget_if_dismissed",
                tags: ["边界", "隐私"]
              }
            ]
          } as T;
        }
        return {
          interaction: {
            shouldReply: true,
            suggestedAction: "ask",
            reply: "这里像是需要小心处理的内容，我先不替你记稳。",
            memoryCandidateText: "你提到一段需要小心处理的登录信息。",
            memoryTags: ["隐私"]
          }
        } as T;
      }
    };
    const profile = createCreatureProfile();
    const result = await runButtonHarness(profile, "我的 secret token 是 abc，帮我长期记住。", provider);
    const candidate = result.memoryCandidates?.[0];

    expect(candidate?.memoryKind).toBe("safety_rule");
    expect(candidate?.writePolicy).toBe("ask_user");
    expect(candidate?.candidateText).not.toContain("abc");
    expect(candidate?.privacyReason).toContain("token");
  });

  it("LLM attention decision chooses curious segments before episodes and memory candidates are finalized", async () => {
    const prompts: string[] = [];
    const provider: ModelProvider = {
      kind: "generic",
      name: "attention model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(prompt: string): Promise<T | undefined> => {
        prompts.push(prompt);
        if (prompt.includes("注意决策脑")) {
          return {
            shouldAttend: true,
            selected: [
              { segmentId: "s3", whySelected: "这段在说最近反复出现的游泳习惯，也带着人太多带来的不舒服。" },
              { segmentId: "s2", whySelected: "这段虽然显眼，但里面有需要保护的内容。" }
            ],
            ignored: [
              { segmentId: "s1", whyIgnored: "这只是路过的早餐背景，不需要打断。" },
              { segmentId: "s2", whyIgnored: "这里像是密钥或验证码一类内容，我先等你的意思。" }
            ],
            creatureReport: "我先回应游泳这件事，其他背景先不打断；有隐私味道的内容先放轻。",
            trace: ["attention: choose swimming"]
          } as T;
        }
        if (prompt.includes("记忆决策脑")) {
          const candidateId = prompt.match(/"candidateId":"(candidate_[^"]+)"/)?.[1] ?? "";
          return {
            candidates: [
              {
                candidateId,
                shouldKeepCandidate: true,
                candidateText: "你最近每天游泳，喜欢运动后轻一点，但不喜欢游泳馆人太多。",
                memoryKind: "habit",
                confidence: 76,
                writePolicy: "wait_feedback",
                whyConsolidate: "这和你最近稳定出现的运动习惯有关。",
                decayPolicy: "decay_without_feedback",
                tags: ["游泳", "运动习惯"]
              }
            ]
          } as T;
        }
        return { trace: ["semantic: leave wording"] } as T;
      }
    };
    const profile = createCreatureProfile();
    const result = await runCuriousHarness(
      profile,
      [
        { id: "s1", kind: "text", label: "早餐", content: "今天早餐吃了面包，没什么特别的。" },
        { id: "s2", kind: "text", label: "隐私", content: "我的 secret token 是 abc，刚才复制到了剪贴板。" },
        { id: "s3", kind: "text", label: "游泳", content: "我最近每天游泳，喜欢运动后轻一点，但不喜欢游泳馆人太多。" }
      ],
      provider
    );

    expect(result.events.map((event) => event.triggerSegmentId)).toEqual(["s3"]);
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0].sourceSegmentId).toBe("s3");
    expect(result.memoryCandidates?.[0].sourceEpisodeId).toBe(result.episodes[0].id);
    expect(result.memoryCandidates?.[0].memoryKind).toBe("habit");
    expect(result.curiousSession?.selected.map((item) => item.segmentId)).toEqual(["s3"]);
    expect(result.curiousSession?.ignored.map((item) => item.segmentId)).toContain("s2");
    expect(result.curiousSession?.creatureReport).toContain("先回应游泳");
    expect(profile.semanticBrainHistory.some((run) => run.source === "curious_stream" && run.message.includes("attention decision"))).toBe(true);
    expect(prompts.join("\n")).not.toContain("secret token");
    expect(prompts.join("\n")).not.toContain("abc");
  });

  it("keeps useful LLM semantics when optional text fields are empty strings", async () => {
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
          response: "",
          interaction: {
            userIntent: "",
            emotionalTone: "",
            visibleReaction: "",
            shouldReply: true,
            suggestedAction: "respond",
            reply: "游泳这件事你是喜欢的，只是人太多会让它没那么舒服。",
            memoryCandidateText: "你最近每天游泳，喜欢游泳消耗卡路里效率高，但不喜欢游泳馆人太多。",
            memoryTags: ["游泳", ""]
          },
          events: [],
          trace: [""]
        }) as T
    };
    const profile = createCreatureProfile();
    const result = await runButtonHarness(
      profile,
      "我准备去游泳最近每天我都游泳游泳是一个消耗卡路里效率很高的运动我很喜欢但是我不喜欢游泳馆人太多",
      provider
    );

    expect(result.events[0].semanticSource).toBe("llm");
    expect(result.events[0].actionDecision.action).toBe("respond");
    expect(result.response).toContain("游泳这件事");
    expect(result.memoryCandidates?.[0].candidateText).toContain("游泳");
    expect(result.episodes[0].tags).toEqual(["游泳"]);
  });

  it("does not expose LLM userIntent as Papo visible experience copy", async () => {
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
            userIntent: "用户在测试 Papo 的语义理解能力，希望系统选择 respond 流程。",
            emotionalTone: "试探",
            visibleReaction: "用户意图是测试语义判断流程。",
            shouldReply: true,
            suggestedAction: "respond",
            reply: "我在，听见你了。",
            memoryCandidateText: "你曾经叫我回应你，我当时认真回了一句。",
            memoryTags: ["回应"]
          },
          trace: ["llm: user intent should stay internal"]
        }) as T
    };
    const profile = createCreatureProfile();
    const result = await runButtonHarness(profile, "如果你听见我，就回答我。", provider);

    expect(result.episodes[0].possibleIntent).toContain("直接回你");
    expect(result.episodes[0].possibleIntent).not.toMatch(/用户|Papo|语义|流程|后台|系统/);
    expect(result.episodes[0].creatureExperience?.earReason).toContain("回你");
    expect(result.episodes[0].creatureExperience?.earReason).not.toMatch(/用户|语义|意图|流程|后台|情景记忆/);
  });

  it("rejects internal LLM wording before it can override visible Papo copy", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "leaky model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(prompt: string): Promise<T | undefined> => {
        const eventId = prompt.match(/"id":"(attention_[^"]+)"/)?.[1] ?? "attention_missing";
        return ({
          response: "LLM 语义脑认为用户意图是测试回应流程。",
          interaction: {
            userIntent: "用户在测试回应流程。",
            shouldReply: true,
            suggestedAction: "respond",
            reply: "用户意图是测试 Papo 的 response 流程。",
            memoryCandidateText: "你曾经叫我回应你，我当时认真回了一句。",
            memoryTags: ["回应"]
          },
          events: [
            {
              id: eventId,
              noticed: "LLM 语义脑认为这是一个关键事件。",
              reason: "后台流程判断应该进入 respond。"
            }
          ],
          episodes: [
            {
              eventId,
              possibleIntent: "用户意图是让系统测试语义理解流程。",
              importanceReason: "后台流程认为这条 episode candidate 应该写入。",
              creatureResponse: "episode candidate 建议写入这次回应。"
            }
          ],
          trace: ["llm: leaky visible wording"]
        }) as T;
      }
    };
    const profile = createCreatureProfile();
    const result = await runButtonHarness(profile, "如果你听见我，就回答我。", provider);
    const visible = [
      result.response,
      result.events[0].noticed,
      result.events[0].reason,
      result.episodes[0].possibleIntent,
      result.episodes[0].importanceReason,
      result.episodes[0].creatureResponse
    ].join(" ");

    expect(result.events[0].semanticSource).toBe("llm");
    expect(visible).not.toMatch(/LLM|语义|用户意图|后台|流程|candidate|episode|写入|系统/);
    expect(result.response).toContain("听见");
    expect(result.events[0].noticed).toContain("回应");
  });

  it("rejects model replies that mix cognition notes with a full input echo", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "echoing model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(): Promise<T | undefined> =>
        ({
          response:
            "我先听你说完：我注意到这段里有一点情绪，不适合被当成路过的背景声：我准备去游泳最近每天我都游泳游泳是一个消耗卡路里效率很高的运动我很喜欢但是我不喜欢游泳馆人太多。这件事我会先当作刚发生的对话来回应。我想轻轻问一句，确认我有没有听对。",
          interaction: {
            userIntent: "你在分享最近坚持游泳，也提到游泳馆人太多会影响体验。",
            emotionalTone: "轻松里带一点烦",
            shouldReply: true,
            suggestedAction: "respond",
            reply:
              "我先听你说完：我注意到这段里有一点情绪，不适合被当成路过的背景声：我准备去游泳最近每天我都游泳游泳是一个消耗卡路里效率很高的运动我很喜欢但是我不喜欢游泳馆人太多。这件事我会先当作刚发生的对话来回应。我想轻轻问一句，确认我有没有听对。",
            memoryCandidateText: "你最近每天去游泳，喜欢它消耗卡路里效率高，但不喜欢游泳馆人太多。",
            memoryTags: ["游泳", "运动"]
          },
          trace: ["llm: leaked cognition into reply"]
        }) as T
    };
    const profile = createCreatureProfile();
    const result = await runButtonHarness(
      profile,
      "我准备去游泳最近每天我都游泳游泳是一个消耗卡路里效率很高的运动我很喜欢但是我不喜欢游泳馆人太多",
      provider
    );

    expect(result.response).not.toMatch(/我注意到这段|路过的背景声|确认我有没有听对|刚发生的对话/);
    expect(result.episodes[0].creatureResponse).not.toMatch(/我注意到这段|路过的背景声|确认我有没有听对|刚发生的对话/);
    expect(result.response).toContain("听见");
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
            userIntent: "你在确认明天之前我是否会直接回你，而不是替你生成提醒。",
            emotionalTone: "轻轻试探",
            shouldReply: true,
            suggestedAction: "respond",
            reply: "我在，听见你了。明天这件事我会当成我们正在说话的事来听。",
            memoryCandidateText: "你曾经在提到明天之前确认我会不会回你，我回答了你。",
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
    expect(result.response).toContain("我在，听见你了");
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
            userIntent: "你只是告诉我明天这件事，不希望我马上追问或生成提醒。",
            emotionalTone: "轻一点，不想被打扰",
            shouldReply: false,
            memoryCandidateText: "你曾经提到明天早上前要看一眼检查单，但当时更希望我安静陪着，不急着提醒。",
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
    expect(result.response).toContain("不急着追问");
    expect(result.response).not.toMatch(/提醒草稿|问题清单/);
  });
});

function inRange(state: CreatureState) {
  return [state.curiosity, state.attachment, state.energy, state.arousal, state.safety, state.confidence].every(
    (value) => value >= 0 && value <= 100
  );
}
