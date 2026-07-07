import { describe, expect, it, vi } from "vitest";
import { handleButtonCapture, handleCuriousStream } from "../src/core/attention";
import { semanticDecideEmergence } from "../src/core/emergence";
import { applyFeedback, semanticReflectFeedback } from "../src/core/feedback";
import { runButtonHarness, runCuriousHarness } from "../src/core/harness";
import { memoryKeepReasonToCreatureVoice, promoteEpisode, toCreatureMemoryVoice } from "../src/core/memory";
import { modelConversationContext } from "../src/core/model-context";
import { enrichFeedbackNarration } from "../src/core/narration";
import { createCreatureProfile } from "../src/core/profile";
import { createModelProvider, type ModelProvider } from "../src/core/provider";
import { wakeCreature } from "../src/core/rhythm";
import { semanticDecideMemory } from "../src/core/semantic-memory";
import type { CreatureState } from "../src/core/types";

describe("creature core", () => {
  it("initializes state in range", () => {
    const profile = createCreatureProfile({ userId: "u1" });
    expect(profile.userId).toBe("u1");
    expect(inRange(profile.state)).toBe(true);
    expect(profile.longTermMemories).toHaveLength(0);
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

  it("rule candidate path creates ordinary shared moments without analysis-template wording", () => {
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

  it("rule candidate path keeps cognition out of visible dialogue", () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "我准备去游泳最近每天我都游泳游泳是一个消耗卡路里效率很高的运动我很喜欢但是我不喜欢游泳馆人太多");

    expect(result.response).toContain("我听见了");
    expect(result.response).toContain("喜欢的部分");
    expect(result.response).not.toMatch(/我先听你说完|我注意到这段|刚发生的对话|确认我有没有听对|情景记忆|长期记忆/);
    expect(result.episodes[0].creatureResponse).toBe(result.response);
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
          followUpText: "这类内容我先不直接留下。",
          effect: "你是在教我遇到这类内容要先收住，等你确认后再处理。"
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

  it("feedback reflection must provide visible learning output instead of keeping rule text", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "incomplete feedback model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(): Promise<T | undefined> =>
        ({
          responseAction: "acknowledge",
          stateDeltas: { curiosity: 2 }
        }) as T
    };
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "我最近总是把妈妈复查这件事拖到很晚。");
    const feedback = applyFeedback(profile, { kind: "continue", targetId: result.episodes[0].id, content: "这里请多想一点。" });

    await expect(semanticReflectFeedback(profile, feedback, provider)).rejects.toThrow(/usable learning note|usable effect/);
  });

  it("ignores malformed optional feedback self memory without losing model learning", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "short self-memory feedback model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(): Promise<T | undefined> =>
        ({
          responseAction: "acknowledge",
          learningNote: "我学到这件事你希望我多停一下。",
          effect: "你是在教我遇到相近内容时不要太快带过。",
          creatureSelfMemory: { text: "" }
        }) as T
    };
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "我最近总是把妈妈复查这件事拖到很晚。");
    const feedback = applyFeedback(profile, { kind: "continue", targetId: result.episodes[0].id, content: "这里请多想一点。" });

    await semanticReflectFeedback(profile, feedback, provider);

    expect(feedback.learningNote).toContain("我学到这件事");
    expect(profile.longTermMemories.some((memory) => memory.tags.includes("LLM理解反馈"))).toBe(false);
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

    await expect(enrichFeedbackNarration(profile, feedback, provider)).rejects.toThrow(/invalid feedback narration/);

    expect(promptSeen).not.toContain("secret token");
    expect(promptSeen).not.toContain("abc");
    expect(feedback.replyText).toBe(before);
    expect(feedback.replyText).not.toMatch(/secret|token|abc/i);
  });

  it("wake rhythm applies time-based state recovery without faking memory emergence", () => {
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
    expect(wake.message).not.toMatch(/刚才过去 \d+ 分钟|重新计算|当前状态/);
    expect(wake.innerThought).toBeUndefined();
    expect(wake.emergenceId).toBeUndefined();
    expect(wake.relatedMemoryIds).toEqual([]);
    expect(profile.emergenceHistory).toHaveLength(0);
    expect(profile.longTermMemories[0].lastReferencedAt).toBeUndefined();
  });

  it("short wake gaps sound like presence instead of a no-op system log", () => {
    const profile = createCreatureProfile({ now: "2026-07-06T07:55:00.000Z" });

    const wake = wakeCreature(profile, "2026-07-06T08:00:00.000Z");

    expect(wake.elapsedMinutes).toBe(5);
    expect(wake.message).toContain("我还在这里");
    expect(wake.message).not.toContain("没有把这当成新的经历");
    expect(wake.message).not.toContain("当前状态");
  });

  it("wake does not carry feedback-shaped self memory as visible cognition", () => {
    const profile = createCreatureProfile({ now: "2026-07-06T06:00:00.000Z" });
    const result = handleButtonCapture(profile, "我担心自己又把妈妈复查这件事拖到睡前。", "2026-07-06T06:01:00.000Z");
    applyFeedback(profile, { kind: "continue", targetId: result.episodes[0].id, now: "2026-07-06T06:02:00.000Z" });
    profile.lastSeenAt = "2026-07-06T06:02:00.000Z";

    const wake = wakeCreature(profile, "2026-07-06T08:02:00.000Z");

    expect(wake.innerThought).toBeUndefined();
    expect(wake.emergenceId).toBeUndefined();
    expect(wake.relatedMemoryIds).toEqual([]);
    expect(profile.emergenceHistory).toHaveLength(0);
    expect(profile.longTermMemories.some((memory) => memory.tags.includes("被你养成"))).toBe(true);
  });

  it("wake never resurfaces raw analysis text as creature speech", () => {
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

    expect(wake.innerThought).toBeUndefined();
    expect(wake.relatedMemoryIds).toEqual([]);
    expect(profile.emergenceHistory).toHaveLength(0);
  });

  it("model conversation context excludes wake rhythm messages", () => {
    const profile = createCreatureProfile({ now: "2026-07-06T07:55:00.000Z" });
    profile.conversation.unshift(
      { id: "msg_wake", at: "2026-07-06T08:00:00.000Z", role: "papo", channel: "wake", text: "我像浅浅趴了一会儿。", relatedMemoryIds: [] },
      { id: "msg_user", at: "2026-07-06T08:01:00.000Z", role: "user", channel: "button", text: "我准备去游泳。", relatedMemoryIds: [] }
    );

    expect(modelConversationContext(profile)).toEqual([
      expect.objectContaining({ role: "user", channel: "button", text: "我准备去游泳。" })
    ]);
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
    const result = handleButtonCapture(profile, "妈妈周五复查这件事需要我提前准备病历。");
    const memory = promoteEpisode(profile, result.episodes[0].id);
    if (!memory) throw new Error("expected promoted memory");
    const targetId = memory.id;

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

  it("LLM emergence can choose quiet without faking recall", async () => {
    const profile = createCreatureProfile();
    const provider: ModelProvider = {
      kind: "generic",
      name: "quiet emergence model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(): Promise<T | undefined> =>
        ({
          shouldEmerge: false,
          driveSource: "rhythm",
          whyNow: "现在没有需要主动带回来的旧事。",
          message: "我先安静陪着。等你继续说，我再认真接住新的事。",
          proactiveLevel: "quiet"
        }) as T
    };

    const emergence = await semanticDecideEmergence(profile, provider);

    expect(emergence.relatedMemoryIds).toEqual([]);
    expect(emergence.memoryId).toBeUndefined();
    expect(emergence.text).toContain("安静陪着");
    expect(emergence.ruleTrace).toContain("llm: chose quiet emergence");
    expect(profile.emergenceHistory[0].id).toBe(emergence.id);
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

    await expect(semanticDecideEmergence(profile, provider, "2026-07-07T07:05:00.000Z")).rejects.toThrow(/unavailable memory|unsafe message/);
  });

  it("LLM emergence cannot resurface a memory after forget downranks it to zero", async () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "妈妈周五复查这件事需要我提前准备病历。");
    const memory = promoteEpisode(profile, result.episodes[0].id);
    if (!memory) throw new Error("expected promoted memory");
    const forgottenId = memory.id;

    applyFeedback(profile, { kind: "forget", targetId: forgottenId });
    const provider: ModelProvider = {
      kind: "generic",
      name: "forgotten emergence model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(): Promise<T | undefined> =>
        ({
          shouldEmerge: true,
          memoryId: forgottenId,
          driveSource: "curiosity",
          whyNow: "我想起了这件已经被放下的事。",
          message: "我想起妈妈周五复查这件事。",
          proactiveLevel: "gentle"
        }) as T
    };

    await expect(semanticDecideEmergence(profile, provider)).rejects.toThrow(/unavailable memory|unsafe message/);
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

  it("complete LLM harness handles dialogue context, action, memory, and privacy redaction", async () => {
    const prompts: string[] = [];
    const provider = scenarioProvider(prompts);
    const profile = createCreatureProfile();
    profile.conversation.unshift(
      { id: "msg-private", at: "2026-07-07T10:00:00.000Z", role: "user", channel: "button", text: "我的 secret token 是 abc", relatedMemoryIds: [] },
      { id: "msg-papo", at: "2026-07-07T10:00:01.000Z", role: "papo", channel: "button", text: "我刚才在听你说游泳。", relatedMemoryIds: [] }
    );

    const result = await runButtonHarness(profile, "我最近每天游泳，但不喜欢游泳馆人太多。", provider);

    expect(result.events[0].semanticSource).toBe("llm");
    expect(result.events[0].actionDecision.action).toBe("respond");
    expect(result.response).toContain("游泳");
    expect(result.memoryCandidates?.[0].memoryKind).toBe("habit");
    expect(prompts.filter((prompt) => prompt.includes("recent_conversation_newest_first")).length).toBeGreaterThanOrEqual(3);
    expect(prompts.join("\n")).toContain("我刚才在听你说游泳");
    expect(prompts.join("\n")).toContain("contentHiddenForPrivacy");
    expect(prompts.join("\n")).not.toMatch(/secret token|abc/i);
  });

  it("related memory during dialogue does not create rule-written emergence history", async () => {
    const provider = scenarioProvider();
    const profile = createCreatureProfile();
    const first = handleButtonCapture(profile, "我最近每天游泳，但不喜欢游泳馆人太多。");
    const memory = promoteEpisode(profile, first.episodes[0].id);
    if (!memory) throw new Error("expected promoted memory");
    profile.emergenceHistory = [];

    const result = await runButtonHarness(profile, "我最近每天游泳，但还是不喜欢游泳馆人太多。", provider);

    expect(result.events[0].relatedMemoryIds).toContain(memory.id);
    expect(profile.emergenceHistory).toHaveLength(0);
  });

  it("bad visible LLM wording fails loudly instead of falling back to rule copy", async () => {
    const provider = scenarioProvider([], {
      actionReply: "我刚才说先回应你，是因为我先做回应流程。"
    });
    const profile = createCreatureProfile();

    await expect(runButtonHarness(profile, "为什么说“先回应你”，你还想后干啥？", provider)).rejects.toThrow(/visible text|process language/);
  });

  it("memory model must write kept candidate text instead of preserving rule draft", async () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "我最近每天游泳，但不喜欢游泳馆人太多。");
    const candidateId = result.memoryCandidates?.[0].id;
    if (!candidateId) throw new Error("expected memory candidate");
    const provider: ModelProvider = {
      kind: "generic",
      name: "incomplete memory model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      summarizeImage: async () => "",
      transcribeAudio: async () => "",
      generateJson: async <T,>(): Promise<T | undefined> =>
        ({
          candidates: [{
            candidateId,
            shouldKeepCandidate: true,
            memoryKind: "habit",
            confidence: 72,
            writePolicy: "wait_feedback",
            whyConsolidate: "这和最近稳定出现的运动习惯有关。",
            decayPolicy: "decay_without_feedback"
          }]
        }) as T
    };

    await expect(semanticDecideMemory(profile, result.memoryCandidates ?? [], provider)).rejects.toThrow(/usable memory text/);
  });

});

function scenarioProvider(prompts: string[] = [], options: { actionReply?: string } = {}): ModelProvider {
  return {
    kind: "generic",
    name: "scenario model",
    available: true,
    usesRealModel: true,
    generate: async () => "",
    summarizeImage: async () => "",
    transcribeAudio: async () => "",
    generateJson: async <T,>(prompt: string): Promise<T | undefined> => {
      prompts.push(prompt);
      const eventId = prompt.match(/"id":"(attention_[^"]+)"/)?.[1] ?? "";
      const candidateId = prompt.match(/"candidateId":"(candidate_[^"]+)"/)?.[1] ?? "";
      if (prompt.includes("行动选择脑")) {
        return {
          decisions: [{
            eventId,
            action: "respond",
            shouldReply: true,
            reply: options.actionReply ?? "游泳这件事你是喜欢的，只是人太多会让它没那么舒服。",
            visibleReaction: "我靠近一点听你说。"
          }]
        } as T;
      }
      if (prompt.includes("记忆决策脑")) {
        return {
          candidates: [{
            candidateId,
            shouldKeepCandidate: true,
            candidateText: "你最近每天游泳，喜欢运动后的轻一点，但不喜欢游泳馆人太多。",
            memoryKind: "habit",
            confidence: 82,
            writePolicy: "wait_feedback",
            whyConsolidate: "这和你最近稳定出现的运动习惯有关。",
            decayPolicy: "decay_without_feedback",
            tags: ["游泳", "运动习惯"]
          }]
        } as T;
      }
      return {
        response: "游泳这件事你是喜欢的，只是人太多会让它没那么舒服。",
        interaction: {
          shouldReply: true,
          suggestedAction: "respond",
          reply: "游泳这件事你是喜欢的，只是人太多会让它没那么舒服。",
          memoryCandidateText: "你最近每天游泳，喜欢运动后的轻一点，但不喜欢游泳馆人太多。",
          memoryTags: ["游泳", "运动习惯"]
        }
      } as T;
    }
  };
}

function inRange(state: CreatureState) {
  return [state.curiosity, state.attachment, state.energy, state.arousal, state.safety, state.confidence].every(
    (value) => value >= 0 && value <= 100
  );
}
