import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeCreatureProfile } from "../src/core/profile";
import { createModelProvider } from "../src/core/provider";
import type { CreatureProfile } from "../src/core/types";
import { runCompanionSessionSweep } from "../src/server/companion-session";
import { MemoryProfileStore } from "../src/server/store";

if (process.env.RUN_REAL_MODEL_SMOKE !== "1") {
  console.log("Set RUN_REAL_MODEL_SMOKE=1 to run the real companion-session smoke.");
  process.exit(0);
}

const raw = JSON.parse(await readFile("data/papo-store.json", "utf8")) as { profiles: Record<string, CreatureProfile> };
const source = raw.profiles.papo;
assert.ok(source, "papo profile is missing");
const clone = normalizeCreatureProfile(structuredClone(source));
clone.userId = "papo-session-smoke";
clone.password = undefined;
clone.companionSessions = [];

const store = new MemoryProfileStore();
const target = await store.createProfile({ userId: clone.userId, creatureName: clone.creatureName });
Object.assign(target, clone);
await store.saveProfile(target);

const provider = createModelProvider();
assert.equal(provider.usesRealModel, true, "real model provider is not configured");
const result = await runCompanionSessionSweep(store, provider, new Date(Date.now() + 10 * 60_000).toISOString());
const completed = await store.getProfile(clone.userId);
const lectureSession = completed?.companionSessions?.find((session) => session.id === "native-1783841575079");
assert.equal(lectureSession?.status, "completed", JSON.stringify({ result, sessions: completed?.companionSessions }));
assert.ok(lectureSession.memoryId, "the real lecture should create one integrated memory");
const memory = completed?.longTermMemories.find((item) => item.id === lectureSession.memoryId);
assert.ok(memory?.text.trim());
console.log(JSON.stringify({ result, session: { title: lectureSession.title, kind: lectureSession.kind, summary: lectureSession.summary }, memory: memory.text }, null, 2));
