import request from "supertest";
import { describe, expect, it } from "vitest";
import { createModelProvider } from "../src/core/provider";
import { createApp } from "../src/server/app";
import { MemoryProfileStore } from "../src/server/store";

describe("api", () => {
  it("returns health and provider info", async () => {
    const app = createApp({ store: new MemoryProfileStore(), provider: createModelProvider({}) });

    await request(app).get("/api/health").expect(200).expect((response) => {
      expect(response.body.ok).toBe(true);
    });

    await request(app).get("/api/provider").expect(200).expect((response) => {
      expect(response.body.kind).toBe("fallback");
      expect(response.body.diagnostics.audioRoute).toBe("fallback");
    });
  });

  it("runs profile, button, curious, feedback, and emergence endpoints", async () => {
    const app = createApp({ store: new MemoryProfileStore(), provider: createModelProvider({}) });
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
        expect(response.body.feedback.replyText).toContain("我会把你刚补的这点和");
        expect(response.body.feedback.policyDeltas.length).toBeGreaterThan(0);
        expect(response.body.feedback.effect).toContain("你让我帮你记住");
        expect(response.body.feedback.effect).not.toMatch(/用户让我|用户说|策略改变/);
        expect(response.body.profile.conversation[0].channel).toBe("feedback");
        expect(response.body.profile.conversation[0].role).toBe("papo");
        expect(response.body.profile.conversation[0].text).toContain("我会把你刚补的这点和");
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
        expect(response.body.profile.conversation[0].text).toContain("我把这条记忆改准了");
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

  it("creates fallback visual and audio sensing material", async () => {
    const app = createApp({ store: new MemoryProfileStore(), provider: createModelProvider({}) });
    const base64 = "A".repeat(80);

    await request(app)
      .post("/api/image-summary")
      .send({ dataUrl: `data:image/png;base64,${base64}`, label: "截图" })
      .expect(200)
      .expect((response) => {
        expect(response.body.provider).toBe("fallback");
        expect(response.body.route).toBe("chat_completions");
        expect(response.body.semanticSource).toBe("fallback");
        expect(response.body.summary).toContain("图片");
      });

    await request(app)
      .post("/api/audio-transcript")
      .send({ dataUrl: `data:audio/webm;codecs=opus;base64,${base64}`, label: "录音" })
      .expect(200)
      .expect((response) => {
        expect(response.body.provider).toBe("fallback");
        expect(response.body.route).toBe("fallback");
        expect(response.body.semanticSource).toBe("fallback");
        expect(response.body.transcript).toContain("音频");
      });
  });

  it("turns empty real-model audio transcripts into an editable no-speech segment", async () => {
    const provider = {
      ...createModelProvider({}),
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
        expect(response.body.transcript).toContain("没有听到清楚的人声");
      });
  });

  it("keeps sensing provider errors out of user-editable fallback text", async () => {
    const provider = {
      ...createModelProvider({}),
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
      .expect(200)
      .expect((response) => {
        expect(response.body.semanticSource).toBe("fallback");
        expect(response.body.summary).toContain("你可以补一句");
        expect(response.body.summary).not.toMatch(/provider failed|403|denied/i);
        expect(response.body.error).toContain("Vision provider failed");
      });

    await request(app)
      .post("/api/audio-transcript")
      .send({ dataUrl: `data:audio/wav;base64,${"A".repeat(80)}`, label: "坏录音" })
      .expect(200)
      .expect((response) => {
        expect(response.body.semanticSource).toBe("fallback");
        expect(response.body.transcript).toContain("你可以补一句");
        expect(response.body.transcript).not.toMatch(/provider failed|unsupported_format|400/i);
        expect(response.body.error).toContain("Audio provider failed");
      });
  });

  it("reports the actual modality provider when audio is routed away from the semantic brain", async () => {
    const provider = {
      ...createModelProvider({}),
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
