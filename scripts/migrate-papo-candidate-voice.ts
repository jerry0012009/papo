import { copyFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createModelProvider } from "../src/core/provider";
import { JsonProfileStore } from "../src/server/store";

const storePath = path.join(process.cwd(), "data", "papo-store.json");
const backupPath = path.join(process.cwd(), "data", `papo-store.backup-before-candidate-voice-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}.json`);
await copyFile(storePath, backupPath);
console.log(`Backup: ${backupPath}`);

const schema = z.object({ shortTitle: z.string().trim().min(2).max(24), candidateText: z.string().trim().min(8).max(500) });
const store = new JsonProfileStore(storePath);
const provider = createModelProvider();
const profile = await store.getProfile("papo");
if (!profile) throw new Error("Profile papo not found");
const candidates = profile.memoryCandidates.filter((candidate) => candidate.status === "candidate");
for (const [index, candidate] of candidates.entries()) {
  const episode = profile.episodes.find((item) => item.id === candidate.sourceEpisodeId);
  const raw = await provider.generateJson<unknown>(`你是 Papo 的候选记忆编辑。只重写展示口吻，不改变事实、重要程度或是否长期保存。

要求：
- 使用 Papo 小动物观察者的第一人称共同经历口吻，直接称呼“${profile.clientDocument?.preferredName ?? "你"}”或“你”。
- 禁止出现“用户”“该用户”“说话者”等系统称呼。
- 保留原文所有有证据的具体事实、时间、地点和未确定性，不补写不存在的内容。
- candidateText 80-300 字；shortTitle 2-8 个中文字符。
- 只返回 JSON。

原候选：${JSON.stringify({ id: candidate.id, text: candidate.candidateText, title: candidate.shortTitle, tags: candidate.tags })}
来源 episode：${JSON.stringify(episode ? { inputSummary: episode.inputSummary, noticed: episode.noticed, createdAt: episode.createdAt, observedAt: episode.sourceObservedAt, location: episode.sourceLocation, attachments: episode.attachments?.map((item) => ({ id: item.id, kind: item.kind, label: item.label })) } : null)}

返回：{"shortTitle":"傍晚散步","candidateText":"我记得 Jerry 那天……"}`);
  const parsed = schema.parse(raw);
  candidate.shortTitle = [...parsed.shortTitle].slice(0, 8).join("");
  candidate.candidateText = parsed.candidateText;
  await store.saveProfile(profile);
  console.log(`[${index + 1}/${candidates.length}] ${candidate.id} ${candidate.shortTitle}`);
}
