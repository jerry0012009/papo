import assert from "node:assert/strict";
import { createModelProvider } from "../src/core/provider";

const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; method?: string; headers?: Headers; body?: Record<string, unknown> }> = [];
let statusCalls = 0;

globalThis.fetch = (async (url, init) => {
  const href = String(url);
  calls.push({
    url: href,
    method: init?.method,
    headers: new Headers(init?.headers),
    body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
  });
  if (href === "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis") {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      input: { prompt: string; img_url: string };
      parameters: { resolution: string; duration: number; prompt_extend: boolean; watermark: boolean };
    };
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("X-DashScope-Async"), "enable");
    assert.equal(body.model, "wan2.2-i2v-flash");
    assert.match(body.input.prompt, /Papo waves/);
    assert.match(body.input.img_url, /^data:image\/png;base64,/);
    assert.deepEqual(body.parameters, { resolution: "480P", prompt_extend: true, duration: 5, watermark: false });
    return Response.json({ output: { task_id: "dash-task-1", task_status: "PENDING" }, request_id: "req-1" });
  }
  if (href === "https://dashscope.aliyuncs.com/api/v1/tasks/dash-task-1") {
    statusCalls += 1;
    return Response.json(statusCalls === 1
      ? { output: { task_id: "dash-task-1", task_status: "RUNNING" } }
      : { output: { task_id: "dash-task-1", task_status: "SUCCEEDED", video_url: "https://dashscope-result.example/papo.mp4" } });
  }
  if (href === "https://dashscope-result.example/papo.mp4") {
    return new Response(Buffer.from("fake-wan-mp4"), { headers: { "content-type": "video/mp4" } });
  }
  throw new Error(`Unexpected fetch: ${href}`);
}) as typeof fetch;

try {
  const provider = createModelProvider({
    NODE_ENV: "test",
    PAPO_PROVIDER: "mimo",
    MIMO_ENDPOINT: "https://mimo.example/v1/chat/completions",
    MIMO_API_KEY: "mimo-test",
    PAPO_VIDEO_PROVIDER: "dashscope",
    DASHSCOPE_API_KEY: "dash-test",
    DASHSCOPE_VIDEO_MODEL: "wan2.2-i2v-flash",
    DASHSCOPE_VIDEO_RESOLUTION: "480P",
    DASHSCOPE_VIDEO_POLL_MS: "1"
  } as NodeJS.ProcessEnv);
  assert.equal(provider.diagnostics?.videoProvider, "dashscope");
  assert.equal(provider.diagnostics?.videoRoute, "dashscope_video_synthesis");
  const video = await provider.generateVideo?.("Papo waves in a clean loop", {
    durationSeconds: 12,
    referenceImage: { dataUrl: "data:image/png;base64,AAAA", label: "approved cover" }
  });
  assert.equal(video?.model, "wan2.2-i2v-flash");
  assert.equal(video?.mime, "video/mp4");
  assert.match(video?.dataUrl ?? "", /^data:video\/mp4;base64,/);
  assert.equal(statusCalls, 2);
  console.log(JSON.stringify({ ok: true, provider: provider.diagnostics?.videoProvider, model: video?.model }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
}
