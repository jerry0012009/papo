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
      });

    const button = await request(app)
      .post(`/api/profiles/${userId}/button`)
      .send({ text: "我希望小动物会注意、会记忆、会根据反馈改变。" })
      .expect(200);
    expect(button.body.events).toHaveLength(1);

    await request(app)
      .post(`/api/profiles/${userId}/curious`)
      .send({
        segments: [
          { id: "s1", kind: "text", label: "片段 1", content: "普通信息。" },
          { id: "s2", kind: "text", label: "片段 2", content: "投资人演示要看到反馈真的改变状态。" }
        ]
      })
      .expect(200)
      .expect((response) => {
        expect(response.body.events.length).toBeGreaterThan(0);
      });

    const episodeId = button.body.episodes[0].id;
    await request(app)
      .post(`/api/profiles/${userId}/feedback`)
      .send({ kind: "remember", targetId: episodeId })
      .expect(200)
      .expect((response) => {
        expect(response.body.profile.longTermMemories.length).toBeGreaterThan(1);
      });

    const profileResponse = await request(app).get(`/api/profiles/${userId}`).expect(200);
    const memoryId = profileResponse.body.profile.longTermMemories[0].id;
    await request(app)
      .patch(`/api/profiles/${userId}/memories/${memoryId}`)
      .send({ text: "用户希望小动物解释自己为什么注意到重点。" })
      .expect(200)
      .expect((response) => {
        expect(response.body.memory.text).toContain("为什么注意");
      });

    await request(app)
      .post(`/api/profiles/${userId}/emergence`)
      .expect(200)
      .expect((response) => {
        expect(response.body.emergence.whyNow ?? response.body.emergence.text).toBeTruthy();
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
        expect(response.body.semanticSource).toBe("fallback");
        expect(response.body.summary).toContain("图片");
      });

    await request(app)
      .post("/api/audio-transcript")
      .send({ dataUrl: `data:audio/webm;base64,${base64}`, label: "录音" })
      .expect(200)
      .expect((response) => {
        expect(response.body.semanticSource).toBe("fallback");
        expect(response.body.transcript).toContain("音频");
      });
  });
});
