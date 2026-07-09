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

const firstArgs = buildHermesCliChatArgs(profile, task);
assert.deepEqual(firstArgs.slice(0, 7), ["chat", "-Q", "--source", "tool", "--accept-hooks", "--yolo", "--max-turns"]);
assert.equal(firstArgs[7], "12");
assert.equal(firstArgs[8], "-q");
assert.match(firstArgs[9], /不能向用户提问/);
assert.match(firstArgs[9], /请查资料/);

profile.hermes.sessionId = "20260707_120000_test";
const resumeArgs = buildHermesCliChatArgs(profile, task);
assert.deepEqual(resumeArgs.slice(0, 7), ["chat", "-Q", "--source", "tool", "--accept-hooks", "--yolo", "--max-turns"]);
assert.equal(resumeArgs[7], "12");
assert.equal(resumeArgs[8], "--resume");
assert.equal(resumeArgs[9], "20260707_120000_test");
assert.equal(resumeArgs[10], "-q");
assert.match(resumeArgs[11], /请查资料/);

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
