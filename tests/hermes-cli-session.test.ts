import assert from "node:assert/strict";
import { buildHermesCliChatArgs, parseHermesCliChatOutput } from "../src/server/hermes";
import { createCreatureProfile } from "../src/core/profile";
import type { HermesTaskRecord } from "../src/core/types";

const profile = createCreatureProfile({ userId: "user_cli_session" });
const otherProfile = createCreatureProfile({ userId: "another_user" });
const task: HermesTaskRecord = {
  id: "hermes_task_cli",
  createdAt: "2026-07-07T10:00:00.000Z",
  updatedAt: "2026-07-07T10:00:00.000Z",
  status: "sent",
  task: "请查资料",
  title: "查资料"
};

assert.deepEqual(buildHermesCliChatArgs(profile, task), ["chat", "-Q", "--source", "tool", "-q", "请查资料"]);

profile.hermes.sessionId = "20260707_120000_test";
assert.deepEqual(buildHermesCliChatArgs(profile, task), ["chat", "-Q", "--source", "tool", "--resume", "20260707_120000_test", "-q", "请查资料"]);

assert.deepEqual(parseHermesCliChatOutput("\nsession_id: 20260707_120000_test\n虾虾收到\n"), {
  sessionId: "20260707_120000_test",
  content: "虾虾收到"
});
assert.deepEqual(parseHermesCliChatOutput("虾虾收到\n", "\nsession_id: 20260707_120001_stderr\n"), {
  sessionId: "20260707_120001_stderr",
  content: "虾虾收到"
});
assert.notEqual(profile.hermes.sessionName, otherProfile.hermes.sessionName);

console.log(JSON.stringify({ ok: true }, null, 2));
