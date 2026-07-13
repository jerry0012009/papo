import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import test from "node:test";
import type { ModelProvider } from "../src/core/provider";
import { createCreatureProfile } from "../src/core/profile";
import { createApp } from "../src/server/app";
import { enrichMemoryExperience } from "../src/server/memory-enrichment";
import { MemoryProfileStore } from "../src/server/store";

test("content-addressed image and video assets keep durable HTTP cache semantics", async () => {
  const provider: ModelProvider = {
    kind: "generic", name: "media cache fake", available: true, usesRealModel: true,
    async generate() { return ""; },
    async generateJson() { return {}; },
    async summarizeImage() { return "缓存测试图片"; },
    async observeAudio() { return ""; },
    async generateImage() { throw new Error("not used"); }
  };
  const store = new MemoryProfileStore();
  await store.createProfile({ userId: "media-cache", creatureName: "Papo" });
  const app = createApp({
    store, provider,
    proactive: { enabled: false }, turns: { autoStart: false }, nativeIngest: { autoStart: false }, hermes: { enabled: false }
  });
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind media cache test server");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const imageBytes = Buffer.from("papo-media-cache-image-fixture-v1");
  const imageDataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;
  const imageFilename = `img_${createHash("sha256").update(imageBytes).digest("hex").slice(0, 24)}.png`;
  const videoBytes = Buffer.from("papo-media-cache-video-fixture-v1");
  const videoFilename = `vid_${createHash("sha256").update(videoBytes).digest("hex").slice(0, 24)}.mp4`;
  const assetDir = path.join(process.cwd(), "data", "assets", "images");
  const memoryBytes = Buffer.from("papo-memory-cache-image-fixture-v1");
  const memoryFilename = `img_${createHash("sha256").update(memoryBytes).digest("hex").slice(0, 24)}.png`;

  try {
    const createImage = () => fetch(`${baseUrl}/api/profiles/media-cache/image-summary`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dataUrl: imageDataUrl, label: "缓存测试" })
    });
    const firstAsset = await (await createImage()).json() as { asset: { url: string } };
    assert.equal(firstAsset.asset.url, `/api/assets/${imageFilename}`);
    const firstHead = await fetch(`${baseUrl}${firstAsset.asset.url}`, { method: "HEAD" });
    const firstEtag = firstHead.headers.get("etag");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondAsset = await (await createImage()).json() as { asset: { url: string } };
    assert.equal(secondAsset.asset.url, firstAsset.asset.url, "identical media bytes must reuse one stable URL");
    const secondHead = await fetch(`${baseUrl}${secondAsset.asset.url}`, { method: "HEAD" });
    assert.equal(secondHead.headers.get("etag"), firstEtag, "saving identical content again must not rewrite the immutable file");

    const image = await fetch(`${baseUrl}${firstAsset.asset.url}`);
    assert.equal(image.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const etag = image.headers.get("etag");
    assert.ok(etag);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), imageBytes);
    const notModifiedStatus = await requestStatus(`${baseUrl}${firstAsset.asset.url}`, { "If-None-Match": etag! });
    assert.equal(notModifiedStatus, 304, "an evicted client cache can revalidate without downloading the body again");

    await mkdir(assetDir, { recursive: true });
    await writeFile(path.join(assetDir, videoFilename), videoBytes);
    const video = await fetch(`${baseUrl}/api/assets/${videoFilename}`, { headers: { range: "bytes=0-3" } });
    assert.equal(video.status, 206);
    assert.equal(video.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(video.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(Buffer.from(await video.arrayBuffer()), videoBytes.subarray(0, 4));

    const memoryProvider: ModelProvider = {
      ...provider,
      async generateJson() {
        return {
          shortTitle: "缓存回忆", narrative: "我记得这次缓存验证。", visualMode: "imaginative_illustration", papoPresence: "absent",
          visualReason: "用手绘生活场景验证稳定资源", imagePrompt: "A warm hand-drawn watercolor everyday scene with visible paper texture, no animals, no text.",
          relatedMemoryIds: [], needsClientReferences: false
        };
      },
      async generateEconomyImage() { return { dataUrl: `data:image/png;base64,${memoryBytes.toString("base64")}`, mime: "image/png" }; }
    };
    const memoryProfile = createCreatureProfile({ userId: "memory-cache", creatureName: "Papo" });
    const makeMemory = () => ({ id: "ltm_cache", createdAt: "2026-07-13T12:00:00.000Z", kind: "long_theme" as const, text: "验证记忆图片缓存", weight: 80, tags: ["缓存"] });
    await enrichMemoryExperience(memoryProfile, makeMemory(), memoryProvider);
    const firstMemoryStat = await stat(path.join(assetDir, memoryFilename));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await enrichMemoryExperience(memoryProfile, makeMemory(), memoryProvider);
    const secondMemoryStat = await stat(path.join(assetDir, memoryFilename));
    assert.equal(secondMemoryStat.mtimeMs, firstMemoryStat.mtimeMs, "identical generated memory art must not rewrite its content-addressed asset");
  } finally {
    app.locals.turnWorker.stop();
    app.locals.transientAudioStore.stop();
    server.close();
    await rm(path.join(assetDir, imageFilename), { force: true });
    await rm(path.join(assetDir, videoFilename), { force: true });
    await rm(path.join(assetDir, memoryFilename), { force: true });
  }
});

function requestStatus(url: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end();
  });
}
