import { copyFile } from "node:fs/promises";
import path from "node:path";
import { reconcileClientDocument, updateClientDocument } from "../src/core/client-document";
import { createModelProvider } from "../src/core/provider";
import { enrichMemoryExperience } from "../src/server/memory-enrichment";
import { JsonProfileStore } from "../src/server/store";

const userId = process.argv[2] ?? "papo";
const reconcileOnly = process.argv.includes("--reconcile-only");
if (userId !== "papo") throw new Error("This migration is intentionally restricted to userid=papo");

const storePath = path.join(process.cwd(), "data", "papo-store.json");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const backupPath = path.join(process.cwd(), "data", `papo-store.backup-before-memory-experience-${stamp}.json`);
await copyFile(storePath, backupPath);
console.log(`Backup: ${backupPath}`);

const store = new JsonProfileStore(storePath);
const provider = createModelProvider();
if (!provider.usesRealModel) throw new Error("A real model provider is required");
let profile = await store.getProfile(userId);
if (!profile) throw new Error(`Profile not found: ${userId}`);

const allMemories = profile.longTermMemories.filter((memory) => memory.weight > 0);
const memories = reconcileOnly ? [] : allMemories.filter((memory) => memory.visualStatus !== "ready");
for (const [index, snapshot] of memories.entries()) {
  profile = await store.getProfile(userId);
  if (!profile) throw new Error(`Profile disappeared: ${userId}`);
  const memory = profile.longTermMemories.find((item) => item.id === snapshot.id);
  if (!memory) continue;
  console.log(`[${index + 1}/${memories.length}] ${memory.id} ${memory.shortTitle ?? memory.text.slice(0, 24)}`);
  try {
    await enrichMemoryExperience(profile, memory, provider);
  } catch (error) {
    memory.visualStatus = "failed";
    memory.visualError = error instanceof Error ? error.message.slice(0, 300) : "Unknown migration error";
    console.error(`  failed: ${memory.visualError}`);
  }
  await store.saveProfile(profile);
}

profile = await store.getProfile(userId);
if (!profile) throw new Error(`Profile disappeared: ${userId}`);
for (let index = 0; !reconcileOnly && index < allMemories.length; index += 1) {
  const sourceIds = [allMemories[index].id];
  try {
    await updateClientDocument(profile, provider, sourceIds);
    await store.saveProfile(profile);
  } catch (error) {
    console.error(`Client.md skipped ${sourceIds[0]}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
await reconcileClientDocument(profile, provider);
await store.saveProfile(profile);
console.log(`Completed ${memories.length} memories; Client.md revision ${profile.clientDocument?.revision ?? 0}`);
