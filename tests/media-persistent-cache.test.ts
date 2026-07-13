import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createCreatureProfile } from "../src/core/profile";
import type { MediaAttachment } from "../src/core/types";
import { profileImageUrls } from "../src/web/media-cache-sources";

const at = "2026-07-13T12:00:00.000Z";

test("profile image cache collection covers every product surface and deduplicates content URLs", () => {
  const profile = createCreatureProfile({ userId: "media-cache-sources", creatureName: "Papo", now: at });
  const avatar = image("avatar", "/api/assets/img_aaaaaaaaaaaaaaaaaaaaaaaa.jpg");
  const cover = image("cover", "/api/assets/img_bbbbbbbbbbbbbbbbbbbbbbbb.jpg");
  const illustration = image("illustration", "/api/assets/img_cccccccccccccccccccccccc.png");
  const memory = image("memory", "/api/assets/img_dddddddddddddddddddddddd.webp");
  const candidate = image("candidate", "/api/assets/img_eeeeeeeeeeeeeeeeeeeeeeee.jpg");
  const episode = image("episode", "/api/assets/img_ffffffffffffffffffffffff.jpg");
  const conversation = image("conversation", "/api/assets/img_111111111111111111111111.jpg");
  profile.petProfile.avatarImage = avatar;
  profile.petProfile.referenceImage = image("inline", "data:image/png;base64,AAAA");
  profile.actionCards = [{
    id: "vid_card", createdAt: at, title: "动作", prompt: "动作", durationSeconds: 4,
    video: video("video", "/api/assets/vid_222222222222222222222222.mp4"), cover, sourceIds: []
  }];
  profile.illustrations = [{ id: "drawing", createdAt: at, title: "画", prompt: "画", attachment: illustration, sourceIds: [] }];
  profile.longTermMemories = [{ id: "memory", createdAt: at, kind: "habit", text: "记忆", weight: 80, tags: [], visual: memory, attachments: [conversation] }];
  profile.memoryCandidates = [{ id: "candidate", createdAt: at, candidateText: "候选", memoryKind: "habit", confidence: 80, whyConsolidate: "测试", writePolicy: "wait_feedback", decayPolicy: "stable", status: "candidate", tags: [], previewVisual: candidate, attachments: [avatar] }];
  profile.episodes = [{ id: "episode", createdAt: at, source: "curious_stream", sourceSegmentId: "segment", inputSummary: "事件", noticed: "事件", creatureResponse: "", weight: 50, tags: [], stateSnapshot: profile.state, attachments: [episode] }];
  profile.conversation = [{ id: "message", at, channel: "curious", role: "user", text: "照片", attachments: [conversation] }];

  assert.deepEqual(new Set(profileImageUrls(profile)), new Set([avatar.url, cover.url, illustration.url, memory.url, candidate.url, episode.url, conversation.url]));
});

test("service worker uses persistent cache-first media handling without intercepting range requests", async () => {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(source, /papo-persistent-media-v1/);
  assert.match(source, /cacheFirstMedia/);
  assert.match(source, /request\.headers\.has\("range"\)/);
  assert.match(source, /PAPO_CACHE_MEDIA/);
  assert.match(source, /slice\(index, index \+ 4\)/);
});

function image(id: string, url: string): MediaAttachment {
  return { id, kind: "image", label: id, mime: url.endsWith(".webp") ? "image/webp" : url.endsWith(".png") ? "image/png" : "image/jpeg", url, createdAt: at };
}

function video(id: string, url: string): MediaAttachment {
  return { id, kind: "video", label: id, mime: "video/mp4", url, createdAt: at };
}
