import assert from "node:assert/strict";
import { createModelProvider } from "../src/core/provider";

const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; method?: string; body?: Record<string, unknown> }> = [];

globalThis.fetch = (async (url, init) => {
  const href = String(url);
  calls.push({
    url: href,
    method: init?.method,
    body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
  });

  if (href === "https://openrouter.ai/api/v1/videos/models") {
    return new Response(JSON.stringify({
      data: [
        {
          id: "alibaba/happyhorse-1.1",
          supported_durations: [3, 5],
          supported_resolutions: ["720p"],
          supported_aspect_ratios: ["1:1", "16:9"]
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  if (href === "https://openrouter.ai/api/v1/videos" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    assert.equal(body.model, "alibaba/happyhorse-1.1");
    assert.equal(body.duration, 5);
    assert.equal(body.duration_seconds, 5);
    assert.equal(body.resolution, "720p");
    assert.equal(body.aspect_ratio, "1:1");
    assert.match(String(body.prompt), /small cat waves/);
    return new Response(JSON.stringify({ id: "job-1", status: "pending" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }

  if (href === "https://openrouter.ai/api/v1/videos/job-1") {
    return new Response(JSON.stringify({ id: "job-1", status: "completed" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }

  if (href === "https://openrouter.ai/api/v1/videos/job-1/content") {
    return new Response(Buffer.from("fake-mp4"), {
      status: 200,
      headers: { "content-type": "video/mp4" }
    });
  }

  throw new Error(`Unexpected fetch: ${href}`);
}) as typeof fetch;

try {
  const provider = createModelProvider({
    NODE_ENV: "test",
    PAPO_PROVIDER: "mimo",
    MIMO_ENDPOINT: "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
    MIMO_API_KEY: "mimo-test-key",
    MIMO_MODEL: "mimo-v2.5-pro",
    OPENROUTER_API_KEY: "openrouter-test-key",
    OPENROUTER_VIDEO_MODEL: "alibaba/happyhorse-1.1"
  } as NodeJS.ProcessEnv);

  assert.equal(provider.kind, "mimo");
  assert.equal(provider.diagnostics?.textProvider, "mimo");
  assert.equal(provider.diagnostics?.videoProvider, "openrouter");
  assert.equal(provider.diagnostics?.videoRoute, "openrouter_videos");
  const video = await provider.generateVideo?.("small cat waves to the user", { durationSeconds: 12 });
  assert.equal(video?.model, "alibaba/happyhorse-1.1");
  assert.equal(video?.mime, "video/mp4");
  assert.match(video?.dataUrl ?? "", /^data:video\/mp4;base64,/);
  assert.deepEqual(calls.map((call) => call.url), [
    "https://openrouter.ai/api/v1/videos/models",
    "https://openrouter.ai/api/v1/videos",
    "https://openrouter.ai/api/v1/videos/job-1",
    "https://openrouter.ai/api/v1/videos/job-1/content"
  ]);
  console.log(JSON.stringify({ ok: true, route: provider.diagnostics?.videoRoute, model: video?.model }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
}
