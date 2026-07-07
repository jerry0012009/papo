import request from "supertest";
import { describe, expect, it } from "vitest";
import type { ModelProvider } from "../src/core/provider";
import { createApp } from "../src/server/app";
import { MemoryProfileStore } from "../src/server/store";

describe("api", () => {
  it("returns health and provider info", async () => {
    const app = createApp({ store: new MemoryProfileStore(), provider: testProvider() });

    await request(app).get("/api/health").expect(200).expect((response) => {
      expect(response.body.ok).toBe(true);
    });

    await request(app).get("/api/provider").expect(200).expect((response) => {
      expect(response.body.kind).toBe("generic");
      expect(response.body.usesRealModel).toBe(true);
    });
  });

  it("runs profile, button, curious, feedback, and emergence endpoints", async () => {
    const app = createApp({ store: new MemoryProfileStore(), provider: testProvider() });
    const created = await request(app).post("/api/profiles").send({ creatureName: "Demo" }).expect(201);
    const userId = created.body.profile.userId;

    await request(app)
      .post(`/api/profiles/${userId}/wake`)
      .expect(200)
      .expect((response) => {
        expect(response.body.wake.message).toBeTruthy();
        expect(response.body.profile.wakeHistory).toHaveLength(1);
        expect(response.body.profile.conversation[0].channel).toBe("wake");
      });

    const button = await request(app)
      .post(`/api/profiles/${userId}/button`)
      .send({ text: "我有点担心自己又把妈妈复查这件事拖到睡前，明明它很重要。" })
      .expect(200);
    expect(button.body.events).toHaveLength(1);
    expect(button.body.profile.conversation[0].channel).toBe("button");

    await request(app)
      .post(`/api/profiles/${userId}/curious`)
      .send({
        segments: [
          { id: "s1", kind: "text", label: "片段 1", content: "今天午饭还不错。", batchId: "manual-1", observedAt: "2026-07-06T10:00:00.000Z" },
          {
            id: "s2",
            kind: "image_summary",
            label: "照片 1",
            content: "妈妈复查的病历和医保卡还没有放进包里。",
            batchId: "manual-1",
            observedAt: "2026-07-06T10:00:15.000Z",
            location: { latitude: 52.52, longitude: 13.405, accuracy: 25, label: "上传时的位置" }
          }
        ]
      })
      .expect(200)
      .expect((response) => {
        expect(response.body.events.length).toBeGreaterThan(0);
        expect(response.body.episodes[0].sourceBatchId).toBe("manual-1");
        expect(response.body.episodes[0].sourceObservedAt).toBeTruthy();
        expect(response.body.profile.conversation[0].channel).toBe("curious");
        expect(response.body.profile.conversation.some((message: { role: string; modality?: string; batchId?: string }) => message.role === "world" && message.modality === "image_summary" && message.batchId === "manual-1")).toBe(true);
      });

    const episodeId = button.body.episodes[0].id;
    await request(app)
      .post(`/api/profiles/${userId}/feedback`)
      .send({ kind: "remember", targetId: episodeId, content: "语音里说：这件事确实要记住，下次可以主动提起。", modality: "audio_transcript" })
      .expect(200)
      .expect((response) => {
        expect(response.body.profile.longTermMemories.length).toBeGreaterThan(1);
        expect(response.body.feedback.inputText).toContain("确实要记住");
        expect(response.body.feedback.inputModality).toBe("audio_transcript");
        expect(response.body.feedback.responseAction).toBe("note_memory");
        expect(response.body.feedback.replyText).toContain("我学到这件事要记得更稳一点");
        expect(response.body.feedback.policyDeltas.length).toBeGreaterThan(0);
        expect(response.body.feedback.effect).toContain("你让我帮你把这件事记准一点");
        expect(response.body.feedback.effect).not.toMatch(/用户让我|用户说|策略改变/);
        expect(response.body.profile.conversation[0].channel).toBe("feedback");
        expect(response.body.profile.conversation[0].role).toBe("papo");
        expect(response.body.profile.conversation[0].text).toContain("我学到这件事要记得更稳一点");
        expect(response.body.profile.conversation[1].role).toBe("user");
        expect(response.body.profile.conversation[1].text).toContain("帮我记住");
        expect(response.body.profile.conversation[1].text).toContain("这件事确实要记住");
        expect(response.body.profile.conversation[1].modality).toBe("audio_transcript");
      });

    const profileResponse = await request(app).get(`/api/profiles/${userId}`).expect(200);
    const memoryId = profileResponse.body.profile.longTermMemories[0].id;
    await request(app)
      .patch(`/api/profiles/${userId}/memories/${memoryId}`)
      .send({ text: "用户希望小动物解释自己为什么注意到重点。" })
      .expect(200)
      .expect((response) => {
        expect(response.body.memory.text).toContain("为什么注意");
        expect(response.body.profile.conversation[0].role).toBe("papo");
        expect(response.body.profile.conversation[0].text).toContain("我记准了");
        expect(response.body.profile.conversation[0].text).toContain("你那时希望我解释自己为什么注意到重点");
        expect(response.body.profile.conversation[0].text).not.toMatch(/用户|小动物/);
        expect(response.body.profile.conversation[0].relatedMemoryIds).toContain(memoryId);
        expect(response.body.profile.conversation[1].role).toBe("user");
        expect(response.body.profile.conversation[1].text).toContain("帮我记准");
        expect(response.body.profile.conversation[1].text).toContain("你那时希望我解释自己为什么注意到重点");
        expect(response.body.profile.conversation[1].text).not.toMatch(/用户|小动物/);
        expect(response.body.profile.conversation[1].relatedMemoryIds).toContain(memoryId);
      });

    await request(app)
      .post(`/api/profiles/${userId}/feedback`)
      .send({ kind: "continue", targetId: memoryId, content: "这条记忆先多想一下，但不要主动吵我。", modality: "text" })
      .expect(200)
      .expect((response) => {
        expect(response.body.feedback.targetId).toBe(memoryId);
        expect(response.body.profile.conversation[0].role).toBe("papo");
        expect(response.body.profile.conversation[0].relatedMemoryIds).toContain(memoryId);
        expect(response.body.profile.conversation[1].role).toBe("user");
        expect(response.body.profile.conversation[1].text).toContain("这条记忆先多想一下");
        expect(response.body.profile.conversation[1].relatedMemoryIds).toContain(memoryId);
      });

    await request(app)
      .post(`/api/profiles/${userId}/emergence`)
      .expect(200)
      .expect((response) => {
        expect(response.body.emergence.whyNow ?? response.body.emergence.text).toBeTruthy();
        expect(response.body.profile.conversation[0].channel).toBe("emergence");
      });
  });

  it("keeps empty real-model audio transcripts out of life content", async () => {
    const provider = {
      ...testProvider(),
      kind: "generic" as const,
      name: "empty audio model",
      usesRealModel: true,
      diagnostics: { audioProvider: "generic" as const, audioRoute: "audio_transcriptions" as const, audioModel: "gpt-4o-mini-transcribe" },
      transcribeAudio: async () => ""
    };
    const app = createApp({ store: new MemoryProfileStore(), provider });

    await request(app)
      .post("/api/audio-transcript")
      .send({ dataUrl: `data:audio/wav;base64,${"A".repeat(80)}`, label: "空录音" })
      .expect(200)
      .expect((response) => {
        expect(response.body.provider).toBe("generic");
        expect(response.body.model).toBe("gpt-4o-mini-transcribe");
        expect(response.body.route).toBe("audio_transcriptions");
        expect(response.body.semanticSource).toBe("llm");
        expect(response.body.transcript).toBe("");
        expect(response.body.noSpeech).toBe(true);
      });
  });

  it("fails loudly when sensing provider errors", async () => {
    const provider = {
      ...testProvider(),
      kind: "generic" as const,
      name: "failing sensing model",
      usesRealModel: true,
      diagnostics: {
        visionProvider: "generic" as const,
        visionModel: "gpt-5.5",
        audioProvider: "generic" as const,
        audioRoute: "audio_transcriptions" as const,
        audioModel: "gpt-4o-mini-transcribe"
      },
      summarizeImage: async () => {
        throw new Error("Vision provider failed: 403 provider denied image");
      },
      transcribeAudio: async () => {
        throw new Error("Audio provider failed: 400 unsupported_format");
      }
    };
    const app = createApp({ store: new MemoryProfileStore(), provider });

    await request(app)
      .post("/api/image-summary")
      .send({ dataUrl: `data:image/png;base64,${"A".repeat(80)}`, label: "坏图" })
      .expect(500)
      .expect((response) => {
        expect(response.body.error).toContain("Vision provider failed");
      });

    await request(app)
      .post("/api/audio-transcript")
      .send({ dataUrl: `data:audio/wav;base64,${"A".repeat(80)}`, label: "坏录音" })
      .expect(500)
      .expect((response) => {
        expect(response.body.error).toContain("Audio provider failed");
      });
  });

  it("reports the actual modality provider when audio is routed away from the semantic brain", async () => {
    const provider = {
      ...testProvider(),
      kind: "openrouter" as const,
      name: "OpenRouter + Generic model API audio",
      usesRealModel: true,
      diagnostics: {
        textProvider: "openrouter" as const,
        audioProvider: "generic" as const,
        audioRoute: "audio_transcriptions" as const,
        audioModel: "gpt-4o-mini-transcribe"
      },
      transcribeAudio: async () => "这段声音里有人说周五复查。"
    };
    const app = createApp({ store: new MemoryProfileStore(), provider });

    await request(app)
      .post("/api/audio-transcript")
      .send({ dataUrl: `data:audio/wav;base64,${"A".repeat(80)}`, label: "混合路由录音" })
      .expect(200)
      .expect((response) => {
        expect(response.body.provider).toBe("generic");
        expect(response.body.provider).not.toBe("openrouter");
        expect(response.body.route).toBe("audio_transcriptions");
        expect(response.body.transcript).toContain("周五复查");
      });
  });
});

function testProvider(): ModelProvider {
  return {
    kind: "generic",
    name: "Test real-model harness",
    available: true,
    usesRealModel: true,
    diagnostics: {
      textProvider: "generic",
      visionProvider: "generic",
      audioProvider: "generic",
      textModel: "test-text",
      visionModel: "test-vision",
      audioModel: "test-audio",
      audioRoute: "audio_transcriptions"
    },
    generate: async () => "",
    summarizeImage: async () => "照片里是周五复查的日历备注，写着提前准备病历。",
    transcribeAudio: async () => "这段声音里有人说周五复查。",
    generateJson: async <T,>(prompt: string): Promise<T | undefined> => {
      const attentionId = prompt.match(/"id":"(attention_[^"]+)"/)?.[1] ?? "";
      const candidateId = prompt.match(/"candidateId":"(candidate_[^"]+)"/)?.[1] ?? "";
      const memoryId = prompt.match(/"id":"(ltm_[^"]+)"/)?.[1] ?? "";
      if (prompt.includes("行动选择脑")) {
        return { decisions: [{ eventId: attentionId, action: "respond", shouldReply: true, reply: "我听见了，会认真陪你把这件事接住。" }] } as T;
      }
      if (prompt.includes("语义脑")) {
        return {
          response: "我听见了，会认真陪你把这件事接住。",
          interaction: {
            shouldReply: true,
            suggestedAction: "respond",
            reply: "我听见了，会认真陪你把这件事接住。",
            memoryCandidateText: "你提到妈妈复查这件事让你有点担心，希望我认真听。",
            memoryTags: ["复查", "担心"]
          }
        } as T;
      }
      if (prompt.includes("注意决策脑")) {
        return {
          shouldAttend: true,
          selected: [{ segmentId: "s2", whySelected: "这张照片和复查准备有关，值得回应。" }],
          ignored: [{ segmentId: "s1", whyIgnored: "午饭只是背景。" }],
          creatureReport: "我把照片里的复查准备和你刚才的担心放在一起听。"
        } as T;
      }
      if (prompt.includes("记忆决策脑")) {
        return {
          candidates: [{
            candidateId,
            shouldKeepCandidate: true,
            candidateText: "你提到妈妈复查这件事让你担心，也补了照片里的准备线索。",
            memoryKind: "future_review",
            confidence: 78,
            writePolicy: "wait_feedback",
            whyConsolidate: "这件事之后还可能回来。",
            decayPolicy: "decay_without_feedback",
            tags: ["复查"]
          }]
        } as T;
      }
      if (prompt.includes("反馈反思脑")) {
        return {
          responseAction: "note_memory",
          stateDeltas: { attachment: 3 },
          policyDeltas: { recallTendency: 4 },
          memoryWeightDelta: 8,
          learningNote: "我学到这件事要记得更稳一点。",
          followUpText: "我会把你补的这点和原来的事放在一起。",
          effect: "你让我帮你把这件事记准一点。",
          creatureSelfMemory: {
            text: "你教我遇到妈妈复查这类准备线索时，要记得更稳一点，也要等你的反馈来校准。",
            tags: ["更愿意记稳", "复查"]
          }
        } as T;
      }
      if (prompt.includes("反馈学习结果")) {
        return { learningNote: "我学到这件事要记得更稳一点。", followUpText: "我会把你补的这点和原来的事放在一起。" } as T;
      }
      if (prompt.includes("改准了一条记忆")) {
        return { replyText: "我记准了：你那时希望我解释自己为什么注意到重点。之后想起这件事时，我会按这个版本接上。" } as T;
      }
      if (prompt.includes("主动浮现大脑")) {
        return {
          shouldEmerge: Boolean(memoryId),
          memoryId,
          driveSource: "attachment",
          whyNow: "我想起这件事是因为你刚才把它教得更重要了。",
          message: "我又想起妈妈复查这件事，记得你希望我把准备线索接住。",
          proactiveLevel: "gentle"
        } as T;
      }
      return { message: "我又想起妈妈复查这件事，记得你希望我把准备线索接住。" } as T;
    }
  };
}
