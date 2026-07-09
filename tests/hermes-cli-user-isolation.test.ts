import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHermesBridge } from "../src/server/hermes";
import { MemoryProfileStore } from "../src/server/store";
import { initialState } from "../src/core/state";
import type { ModelProvider } from "../src/core/provider";
import type { CaptureResult, CreatureProfile } from "../src/core/types";

const dir = await mkdtemp(path.join(os.tmpdir(), "papo-hermes-cli-"));
const logPath = path.join(dir, "fake-hermes.log");
const cliPath = path.join(dir, "fake-hermes.sh");

await writeFile(
  cliPath,
  `#!/usr/bin/env bash
set -euo pipefail
python3 - "$PAPO_FAKE_HERMES_LOG" "$@" <<'PY'
import json, sys
with open(sys.argv[1], "a", encoding="utf-8") as f:
    f.write(json.dumps(sys.argv[2:], ensure_ascii=False) + "\\n")
PY
if [ "$1" = "sessions" ]; then
  exit 0
fi
task="\${@: -1}"
resume=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "--resume" ]; then
    resume="$arg"
  fi
  previous="$arg"
done
if [ -n "$resume" ]; then
  echo "session_id: $resume" >&2
  echo "resumed $task"
  exit 0
fi
if [[ "$task" == *"user-a-first"* ]]; then
  sleep 0.25
  echo "session_id: session-user-a" >&2
  echo "new a"
  exit 0
fi
if [[ "$task" == *"user-b-first"* ]]; then
  echo "session_id: session-user-b" >&2
  echo "new b"
  exit 0
fi
echo "session_id: session-unknown" >&2
echo "new unknown"
`,
  "utf8"
);
await chmod(cliPath, 0o755);

const store = new MemoryProfileStore();
const profileA = await store.createProfile({ userId: "user-a", creatureName: "Papo A" });
const profileB = await store.createProfile({ userId: "user-b", creatureName: "Papo B" });

const provider: ModelProvider = {
  kind: "mimo",
  name: "Fake Hermes callback provider",
  available: true,
  usesRealModel: true,
  diagnostics: { textModel: "fake-hermes-callback" },
  async generate() {
    return "";
  },
  async generateJson(prompt) {
    if (prompt.includes("注意决策脑")) {
      const segmentId = [...prompt.matchAll(/"segmentId":"([^"]+)"/g)].at(-1)?.[1];
      assert.ok(segmentId);
      return {
        selected: [
          {
            segmentId,
            noticed: "虾虾返回了结果。",
            whySelected: "这是外部任务回流。",
            userMeaning: "用户在等待外部任务结果。",
            relatedMemoryIds: [],
            tags: ["虾虾"]
          }
        ],
        ignored: []
      };
    }
    if (prompt.includes("行动选择脑")) {
      const eventId = [...prompt.matchAll(/"id":"([^"]+)"/g)].at(-1)?.[1];
      assert.ok(eventId);
      return {
        decisions: [
          {
            eventId,
            action: "respond",
            noticed: "虾虾返回了结果。",
            userIntent: "把外部结果转述回来。",
            emotionalTone: "平静",
            reason: "外部任务已经完成。",
            stateDeltas: { confidence: 1 },
            shouldCreateEpisode: false,
            shouldConsiderMemory: false,
            shouldReply: true,
            reply: "虾虾回来了。"
          }
        ]
      };
    }
    throw new Error("unexpected prompt");
  },
  async summarizeImage() {
    return "";
  },
  async observeAudio() {
    return "";
  },
  async generateImage() {
    return {
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      mime: "image/png",
      model: "fake-image"
    };
  }
};

const bridge = createHermesBridge({
  store,
  provider,
  env: {
    PAPO_HERMES_DISPATCH: "cli",
    PAPO_HERMES_CLI_PATH: cliPath,
    PAPO_FAKE_HERMES_LOG: logPath
  }
});

await bridge.enqueueTasks(profileA, capture(profileA, "user-a-first"));
const staleA = await store.getProfile("user-a");
assert.ok(staleA);
await bridge.enqueueTasks(staleA, capture(staleA, "user-a-second"));
await bridge.enqueueTasks(profileB, capture(profileB, "user-b-first"));

await waitFor(async () => {
  const a = await store.getProfile("user-a");
  const b = await store.getProfile("user-b");
  return a?.hermes.tasks.filter((task) => task.status === "completed").length === 2 && b?.hermes.tasks[0]?.status === "completed";
});

const log = await readFile(logPath, "utf8");
const calls = log.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as string[]);
const chatCalls = calls.filter((call) => call[0] === "chat");
const aChatCalls = chatCalls.filter((call) => call.join("\n").includes("user-a-"));
const bChatCall = chatCalls.find((call) => call.join("\n").includes("user-b-first"));

assert.equal(aChatCalls.length, 2, log);
assert.equal(aChatCalls[0].includes("--resume"), false, log);
assert.equal(aChatCalls[0].join("\n").includes("user-a-first"), true, log);
assert.equal(aChatCalls[1].includes("--resume"), true, log);
assert.equal(aChatCalls[1].includes("session-user-a"), true, log);
assert.equal(aChatCalls[1].join("\n").includes("user-a-second"), true, log);
assert.ok(bChatCall, log);
assert.equal(bChatCall.includes("session-user-a"), false, log);
assert.equal(bChatCall.includes("--resume"), false, log);

const currentA = await store.getProfile("user-a");
const currentB = await store.getProfile("user-b");
assert.equal(currentA?.hermes.sessionId, "session-user-a");
assert.equal(currentB?.hermes.sessionId, "session-user-b");
assert.notEqual(currentA?.hermes.sessionName, currentB?.hermes.sessionName);
assert.equal(currentA?.hermes.tasks.every((task) => task.sessionId === "session-user-a"), true);
assert.equal(currentB?.hermes.tasks.every((task) => task.sessionId === "session-user-b"), true);

console.log(JSON.stringify({ ok: true }, null, 2));

function capture(profile: CreatureProfile, taskText: string): CaptureResult {
  const now = new Date().toISOString();
  return {
    profile,
    events: [
      {
        id: `event-${taskText}`,
        source: "button",
        triggerSegmentId: `segment-${taskText}`,
        triggerLabel: "用户说",
        triggerContent: taskText,
        noticed: "用户需要外部任务。",
        reason: "应交给 Hermes。",
        relatedMemoryIds: [],
        stateSnapshot: initialState(profile.userId),
        attentionStrength: 90,
        privacyRisk: 0,
        suggestedAction: "use_hermes",
        actionDecision: {
          action: "use_hermes",
          confidence: 100,
          reason: "model selected Hermes",
          blockedActions: [],
          safetyNotes: [],
          llmSuggestedAction: "use_hermes",
          ruleTrace: []
        },
        actionResult: {
          kind: "hermes_task",
          title: taskText,
          text: taskText
        },
        creatureExperience: { earReason: "", actionFeeling: "", saveFeeling: "" },
        tags: ["hermes"],
        semanticSource: "llm",
        createdAt: now
      }
    ],
    episodes: [],
    response: ""
  };
}

async function waitFor(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for Hermes tasks");
}
