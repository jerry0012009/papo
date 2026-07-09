import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModelProvider } from "../src/core/provider";
import { createHermesBridge } from "../src/server/hermes";
import { MemoryProfileStore } from "../src/server/store";

const dir = await mkdtemp(path.join(os.tmpdir(), "papo-hermes-recovery-"));
const logPath = path.join(dir, "fake-hermes.log");
const cliPath = path.join(dir, "fake-hermes.sh");

await writeFile(
  cliPath,
  `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$PAPO_FAKE_HERMES_LOG"
if [ "$1" = "sessions" ]; then
  exit 0
fi
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
  echo "recovered result"
  exit 0
fi
echo "session_id: new-session" >&2
echo "new result"
`,
  "utf8"
);
await chmod(cliPath, 0o755);

const store = new MemoryProfileStore();
const resumable = await store.createProfile({ userId: "recover-user", creatureName: "Papo" });
resumable.hermes.sessionId = "session-recover-user";
resumable.hermes.sessionName = "papo-recover-user";
resumable.hermes.tasks.unshift({
  id: "hermes_task_resumable",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: "sent",
  task: "resume me",
  title: "recover",
  sessionId: "session-recover-user",
  sessionName: "papo-recover-user"
});
await store.saveProfile(resumable);

const unsafe = await store.createProfile({ userId: "unsafe-user", creatureName: "Papo" });
unsafe.hermes.tasks.unshift({
  id: "hermes_task_unsafe",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: "sent",
  task: "send an email once",
  title: "unsafe side effect"
});
await store.saveProfile(unsafe);

const provider: ModelProvider = {
  kind: "mimo",
  name: "Fake Hermes recovery provider",
  available: true,
  usesRealModel: true,
  diagnostics: { textModel: "fake-hermes-recovery" },
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
            userMeaning: "用户在等结果。",
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
            userIntent: "转述外部结果。",
            emotionalTone: "平静",
            reason: "任务完成。",
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

await bridge.recoverInterruptedTasks?.();

await waitFor(async () => {
  const current = await store.getProfile("recover-user");
  return current?.hermes.tasks[0]?.status === "completed";
});

const currentUnsafe = await store.getProfile("unsafe-user");
assert.equal(currentUnsafe?.hermes.tasks[0]?.status, "failed");
assert.match(currentUnsafe?.hermes.tasks[0]?.error ?? "", /restarted/);
assert.equal(currentUnsafe?.conversation.some((message) => message.sourceId === "hermes_task_unsafe" && /重启打断/.test(message.text)), true);

const log = await readFile(logPath, "utf8");
assert.match(log, /--resume session-recover-user/);
assert.equal(log.includes("send an email once"), false, log);

console.log(JSON.stringify({ ok: true }, null, 2));

async function waitFor(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for Hermes recovery");
}
