import assert from "node:assert/strict";
import { createApp } from "../src/server/app";
import { MemoryProfileStore } from "../src/server/store";
import type { ModelProvider } from "../src/core/provider";

const imageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const videoDataUrl = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQ==";

const store = new MemoryProfileStore();
await store.createProfile({ userId: "pet-profile-user", creatureName: "吉祥", petKind: "british-shorthair" });

const provider: ModelProvider = {
  kind: "openrouter",
  name: "fake multimodal provider",
  available: true,
  usesRealModel: true,
  diagnostics: { textModel: "fake-text", imageModel: "fake-image", videoModel: "fake-video", imageProvider: "openrouter", videoProvider: "openrouter" },
  async generate() {
    return "";
  },
  async generateJson(prompt) {
    if (prompt.includes("动作卡导演")) {
      assert.match(prompt, /轻轻探头/);
      assert.match(prompt, /主目标/);
      assert.match(prompt, /动作内容优先来自用户/);
      return {
        card: {
          key: "curious",
          title: "吉祥探头",
          caption: "它轻轻探头看你。",
          prompt: "吉祥保持灰白英短形象，轻轻探头看向镜头。",
          style: "looping natural digital pet animation",
          durationSeconds: 8,
          stateId: "curious_peek",
          statusText: "吉祥轻轻探头看着你。"
        }
      };
    }
    return {
      displaySpecies: "圆脸灰白英短小猫",
      appearance: "圆脸灰白英短小猫，琥珀眼睛，小粉鼻，身体柔软微胖。",
      personality: "慢热、亲近、喜欢安静陪着用户。",
      habits: "喜欢蹲在用户旁边看用户工作。",
      visualStyle: "温暖米白背景里的高质感 3D 毛绒手机宠物。",
      imagePrompt: "round-faced gray and white British Shorthair kitten mascot, amber eyes, tiny pink nose, plush 3D mobile companion",
      motionStyle: "短循环，全身居中，动作轻，结尾回到起始姿势。",
      userGuidance: "更像圆脸灰白英短"
    };
  },
  async summarizeImage() {
    return "一只圆脸灰白小猫。";
  },
  async observeAudio() {
    return "";
  },
  async generateImage(prompt) {
    assert.match(prompt, /British Shorthair|英短|灰白/);
    assert.match(prompt, /stuffed animal|plush toy/i);
    if (prompt.includes("action video")) assert.match(prompt, /user's requested action|用户/);
    return { dataUrl: imageDataUrl, mime: "image/png", model: "fake-image" };
  },
  async generateVideo(prompt) {
    assert.match(prompt, /圆脸灰白英短|British Shorthair/);
    assert.match(prompt, /first frame and final frame should match/i);
    assert.match(prompt, /not a plush toy or figurine/i);
    assert.match(prompt, /Do not replace a user-requested action/);
    return { dataUrl: videoDataUrl, mime: "video/mp4", model: "fake-video" };
  }
};

const app = createApp({ store, provider });
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind test server");
const base = `http://127.0.0.1:${address.port}`;

try {
  const profileResponse = await fetch(`${base}/api/profiles/pet-profile-user/pet-profile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ guidance: "更像圆脸灰白英短，慢一点，喜欢蹲在我旁边。" })
  });
  const profilePayload = await profileResponse.json();
  assert.equal(profileResponse.status, 200, JSON.stringify(profilePayload));
  assert.equal(profilePayload.profile.petProfile.displaySpecies, "圆脸灰白英短小猫");
  assert.equal(profilePayload.profile.petProfile.avatarImage.generatedBy, "papo_profile");

  const motionResponse = await fetch(`${base}/api/profiles/pet-profile-user/pet-profile/initial-action-cards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ guidance: "轻轻探头看我" })
  });
  const motionPayload = await motionResponse.json();
  assert.equal(motionResponse.status, 200, JSON.stringify(motionPayload));
  assert.equal(motionPayload.profile.petProfile.initialMotion.status, "pending");

  const current = await waitForInitialMotions();
  assert.equal(current.petProfile.initialMotion?.status, "ready");
  assert.equal(current.actionCards?.length, 1);
  assert.equal(current.actionCards?.[0].cover?.generatedBy, "papo_action_card");
  assert.equal(current.actionCards?.[0].video.generatedBy, "papo_action_card");
  console.log(JSON.stringify({ ok: true, avatar: current.petProfile.avatarImage?.url, actionCards: current.actionCards?.length }, null, 2));
} finally {
  server.close();
}

async function waitForInitialMotions() {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const profile = await store.getProfile("pet-profile-user");
    if (profile?.petProfile.initialMotion?.status === "ready" && (profile.actionCards?.length ?? 0) >= 1) return profile;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("initial pet motions were not generated asynchronously");
}
