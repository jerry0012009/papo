import { summarizeText } from "./text";
import type { CreatureProfile } from "./types";

export function createActiveEmergence(profile: CreatureProfile, now = new Date().toISOString()) {
  const memory = [...profile.longTermMemories].sort((a, b) => b.weight - a.weight)[0];
  const episode = [...profile.episodes].sort((a, b) => b.weight - a.weight)[0];

  if (memory) {
    memory.lastReferencedAt = now;
    const drive = profile.state.curiosity > profile.state.attachment ? "我今天更想探索" : "我今天更想靠近你";
    return {
      text: `${drive}。我刚才自己浮现出一条记忆：${summarizeText(memory.text, 96)}。它让我觉得，下一次注意到类似片段时，我应该先解释为什么注意到，再决定要不要行动。`,
      memoryId: memory.id
    };
  }

  if (episode) {
    return {
      text: `我现在想到我们刚经历过的一小段：${summarizeText(episode.noticed, 96)}。我还在学习把这种片段变成更稳定的记忆。`,
      memoryId: episode.id
    };
  }

  return {
    text: "我现在还没有太多旧记忆，所以先保持轻微好奇，等你给我第一个值得注意的片段。",
    memoryId: undefined
  };
}
