import assert from "node:assert/strict";
import { createApp } from "../src/server/app";
import { MemoryProfileStore } from "../src/server/store";
import { createModelProvider } from "../src/core/provider";

if (process.env.RUN_REAL_MODEL_SMOKE !== "1") {
  console.log(JSON.stringify({ skipped: true, reason: "set RUN_REAL_MODEL_SMOKE=1 to call the configured real provider" }, null, 2));
  process.exit(0);
}

const store = new MemoryProfileStore();
const provider = createModelProvider();
assert.equal(provider.usesRealModel, true, "real cognition smoke requires a real provider");

const app = createApp({ store, provider });
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind smoke server");

const base = `http://127.0.0.1:${address.port}/api`;

try {
  const created = await post<{ profile: { userId: string } }>("/profiles", { creatureName: "Papo Smoke" }, 201);
  const userId = created.profile.userId;
  const inputText = "请记住：我喜欢晚上去游泳，但是泳池人太多的时候我会有点烦。你可以自然地回应我一句。";
  const capture = await post<any>(`/profiles/${userId}/button`, { text: inputText });
  assert.equal(capture.provider, provider.kind);
  assert.ok(capture.events?.length >= 1, "attention model should select the explicit user message");
  assert.ok(capture.response?.trim(), "action model should produce a visible reply for this explicit dialogue");

  const profile = await store.getProfile(userId);
  assert.ok(profile, "profile should stay in the in-memory store");
  assert.equal(profile.conversation.some((message) => message.role === "papo" && message.text.trim()), true, "Papo reply should be persisted");

  const trace = profile.conversation.find((message) => message.role === "papo")?.cognitionTrace;
  assert.ok(trace, "Papo reply should carry cognition trace");
  assert.equal(trace.eventDecisions?.[0]?.semanticSource, "llm");
  assert.equal(trace.eventDecisions?.[0]?.sourceText.includes("请记住"), true);
  assert.equal(trace.modelRuns.some((run) => run.stage === "attention" && run.status === "applied"), true);
  assert.equal(trace.modelRuns.some((run) => run.stage === "action" && run.status === "applied"), true);
  assert.equal(trace.modelRuns.some((run) => run.stage === "harness" && run.status === "applied"), true);

  const recallCapture = await post<any>(`/profiles/${userId}/button`, { text: "上一句话我刚才说了什么？请直接回答。" });
  assert.ok(recallCapture.response?.trim(), "context follow-up should produce a visible reply");
  assert.match(recallCapture.response, /游泳|泳池|人太多|晚上/i, "context follow-up should use recent conversation instead of a fixed template");
  const afterRecall = await store.getProfile(userId);
  const recallTrace = afterRecall?.conversation.find((message) => message.role === "papo" && message.text === recallCapture.response)?.cognitionTrace;
  assert.ok(recallTrace, "context follow-up reply should carry cognition trace");
  assert.equal(recallTrace.modelRuns.some((run) => run.stage === "attention" && run.status === "applied"), true);
  assert.equal(recallTrace.modelRuns.some((run) => run.stage === "action" && run.status === "applied"), true);

  const keptEpisode = trace.episodeDecisions?.find((episode) => episode.kept);
  assert.ok(keptEpisode, "explicit remember request should keep an episode");
  const feedback = await post<any>(`/profiles/${userId}/feedback`, {
    kind: "remember",
    targetId: keptEpisode.episodeId,
    content: "对，这条很重要，记成我关于游泳的偏好。",
    modality: "text"
  });
  assert.equal(feedback.feedback.kind, "remember");

  const afterFeedback = await store.getProfile(userId);
  const feedbackTrace = afterFeedback?.conversation.find((message) => message.channel === "feedback" && message.cognitionTrace)?.cognitionTrace;
  assert.ok(feedbackTrace, "feedback should carry cognition trace");
  assert.equal(feedbackTrace.modelRuns.some((run) => run.stage === "feedback" && run.status === "applied"), true);

  const emergence = await post<any>(`/profiles/${userId}/emergence`, {});
  assert.ok(emergence.emergence.cognitionTrace, "emergence response should carry cognition trace even when quiet");
  assert.equal(emergence.emergence.cognitionTrace.modelRuns.some((run: { stage?: string; status: string }) => run.stage === "emergence" && run.status === "applied"), true);

  console.log(JSON.stringify({
    ok: true,
    provider: provider.kind,
    model: provider.diagnostics?.textModel,
    action: trace.eventDecisions?.[0]?.action,
    replyLength: capture.response.trim().length,
    feedbackAction: feedback.feedback.responseAction ?? "quiet",
    longTermMemories: afterFeedback?.longTermMemories.length ?? 0
  }, null, 2));
} finally {
  server.close();
}

async function post<T>(path: string, body: unknown, expectedStatus = 200): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(async () => ({ raw: await response.text() }));
  assert.equal(response.status, expectedStatus, JSON.stringify(payload));
  return payload as T;
}
