import assert from "node:assert/strict";
import { createModelProvider } from "../src/core/provider";

const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

globalThis.fetch = (async (url, init) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  calls.push({ url: String(url), body });
  assert.equal(String(url), "https://openrouter.ai/api/v1/images");
  assert.equal(init?.method, "POST");
  assert.ok(["google/gemini-3.1-flash-lite-image", "black-forest-labs/flux.2-klein-4b"].includes(String(body.model)));
  assert.equal(body.n, 1);
  if (body.model === "google/gemini-3.1-flash-lite-image") assert.equal(body.resolution, "1K");
  if (body.model === "black-forest-labs/flux.2-klein-4b") assert.equal(body.size, "1024x1024");
  assert.equal(body.aspect_ratio, "1:1");
  assert.match(String(body.prompt), /hand-drawn/);
  return new Response(JSON.stringify({
    data: [
      {
        b64_json: "/9j/4AAQSkZJRgABAQAAAQABAAD/2w==",
        media_type: "image/jpeg"
      }
    ]
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}) as typeof fetch;

try {
  const provider = createModelProvider({
    NODE_ENV: "test",
    PAPO_PROVIDER: "mimo",
    MIMO_ENDPOINT: "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
    MIMO_API_KEY: "mimo-test-key",
    MIMO_MODEL: "mimo-v2.5-pro",
    PAPO_IMAGE_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "openrouter-test-key",
    OPENROUTER_IMAGE_MODEL: "google/gemini-3.1-flash-lite-image",
    OPENROUTER_ECONOMY_IMAGE_MODEL: "black-forest-labs/flux.2-klein-4b"
  } as NodeJS.ProcessEnv);

  assert.equal(provider.diagnostics?.imageProvider, "openrouter");
  assert.equal(provider.diagnostics?.imageRoute, "openrouter_images");
  const image = await provider.generateImage("warm hand-drawn Papo postcard", { size: "1K", style: "comic" });
  assert.equal(calls.length, 1);
  assert.equal(image.model, "google/gemini-3.1-flash-lite-image");
  assert.equal(image.mime, "image/jpeg");
  assert.match(image.dataUrl, /^data:image\/jpeg;base64,/);
  const economy = await provider.generateEconomyImage?.("hand-drawn memory preview", { size: "1024x1024", style: "comic" });
  assert.equal(economy?.model, "black-forest-labs/flux.2-klein-4b");
  assert.equal(calls[0].body.model, "google/gemini-3.1-flash-lite-image");
  assert.equal(calls[1].body.model, "black-forest-labs/flux.2-klein-4b");
  console.log(JSON.stringify({ ok: true, route: provider.diagnostics?.imageRoute, mime: image.mime }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
}
