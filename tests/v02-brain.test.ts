import { describe, expect, it } from "vitest";
import { handleButtonCapture, handleCuriousStream } from "../src/core/attention";
import { createActiveEmergence } from "../src/core/emergence";
import { applyFeedback } from "../src/core/feedback";
import { runButtonHarness, runCuriousHarness } from "../src/core/harness";
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
      segment("s7", "未来", "下次投资人演示要看到它因为反馈真的改变。"),
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
    expect(aNext.events[0].actionDecision.action).not.toBe("quiet");
    expect(["observe", "quiet", "ask"]).toContain(bNext.events[0].actionDecision.action);
  });

  it("memory consolidation creates candidates before long-term promotion", () => {
    const profile = createCreatureProfile();
    const result = handleButtonCapture(profile, "用户更重视我解释为什么注意，而不是只总结。");

    expect(result.memoryCandidates?.[0].status).toBe("candidate");
    expect(profile.longTermMemories.some((memory) => memory.sourceEpisodeId === result.episodes[0].id)).toBe(false);

    applyFeedback(profile, { kind: "remember", targetId: result.episodes[0].id });

    expect(profile.longTermMemories.some((memory) => memory.sourceEpisodeId === result.episodes[0].id)).toBe(true);
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

  it("invalid LLM JSON falls back without breaking the life loop", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "bad json model",
      available: true,
      usesRealModel: true,
      generate: async () => "not-json",
      generateJson: async <T,>() => ({ nope: true }) as T
    };
    const profile = createCreatureProfile();

    const result = await runButtonHarness(profile, "小动物要记得自己如何被用户养成。", provider);

    expect(result.events).toHaveLength(1);
    expect(result.harnessTrace?.join(" ")).toContain("empty model result");
    expect(result.events[0].semanticSource).toBe("rules");
  });

  it("LLM can explain curious selection while rules still cap events to 1-3", async () => {
    const provider: ModelProvider = {
      kind: "generic",
      name: "semantic model",
      available: true,
      usesRealModel: true,
      generate: async () => "",
      generateJson: async <T,>(prompt: string) => {
        const ids = [...prompt.matchAll(/"id":"(attention_[^"]+)"/g)].map((match) => match[1]);
        return {
          response: "我不是总结全部，而是挑出最像身份校准和未来行动的片段。",
          events: ids.map((id) => ({
            id,
            noticed: "LLM 语义脑认为这是一个关键转折点。",
            reason: "它同时包含产品身份、情绪担心和未来演示价值。",
            suggestedAction: "recall"
          })),
          trace: ["llm: semantic curious judgment"]
        } as T;
      }
    };
    const profile = createCreatureProfile();
    const result = await runCuriousHarness(
      profile,
      [
        segment("s1", "普通", "今天只是普通记录。"),
        segment("s2", "身份", "我担心小动物变成工具，而不是活物。"),
        segment("s3", "未来", "下次投资人演示需要看到反馈改变。"),
        segment("s4", "普通2", "又一个普通记录。")
      ],
      provider
    );

    expect(result.events.length).toBeGreaterThanOrEqual(1);
    expect(result.events.length).toBeLessThanOrEqual(3);
    expect(result.events[0].semanticSource).toBe("llm");
    expect(result.harnessTrace?.join(" ")).toContain("llm interpretation applied");
  });
});

function segment(id: string, label: string, content: string, kind: "text" | "image_summary" | "audio_transcript" = "text") {
  return { id, label, content, kind };
}
