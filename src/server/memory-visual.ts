import { z } from "zod";
import { clientContextFor } from "../core/client-document";
import { memoryShortTitle } from "../core/memory";
import type { ImageReference, ModelProvider } from "../core/provider";
import type { CreatureProfile, LongTermMemory, MediaAttachment } from "../core/types";

const planSchema = z.object({
  shortTitle: z.string().trim().min(2).max(24).transform((title) => [...title].slice(0, 8).join("")),
  narrative: z.string().trim().min(8).max(500),
  imagePrompt: z.string().trim().min(20).max(2200),
  relatedMemoryIds: z.array(z.string().min(1)).max(8).default([]),
  needsPapoReference: z.boolean().default(true),
  needsClientReferences: z.boolean().default(false)
});

export interface MemoryVisualPlan extends z.infer<typeof planSchema> {}

export async function planMemoryVisual(profile: CreatureProfile, memory: LongTermMemory, provider: ModelProvider) {
  const related = retrieveRelatedMemories(profile, memory);
  const client = clientContextFor(profile, `${memory.text} ${memory.tags.join(" ")}`);
  const raw = await provider.generateJson<unknown>(memoryVisualPlanPrompt(profile, memory, related, client));
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid memory visual plan (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
  const allowed = new Set(related.map((item) => item.id));
  return { ...parsed.data, relatedMemoryIds: parsed.data.relatedMemoryIds.filter((id) => allowed.has(id)) };
}

export async function memoryVisualReferences(
  profile: CreatureProfile,
  memory: LongTermMemory,
  plan: MemoryVisualPlan,
  attachmentDataUrl: (attachment: MediaAttachment) => Promise<string | undefined>
) {
  const references: ImageReference[] = [];
  const add = async (attachment: MediaAttachment | undefined) => {
    if (!attachment || references.some((item) => item.label === attachment.label)) return;
    const dataUrl = await attachmentDataUrl(attachment);
    if (dataUrl) references.push({ dataUrl, label: attachment.label });
  };

  for (const image of memory.attachments?.filter((item) => item.kind === "image") ?? []) await add(image);
  if (plan.needsPapoReference) await add(profile.petProfile.avatarImage ?? profile.petProfile.referenceImage);
  if (plan.needsClientReferences) {
    const related = profile.longTermMemories.filter((item) => plan.relatedMemoryIds.includes(item.id));
    for (const relatedMemory of related) {
      await add(relatedMemory.visual);
      for (const image of relatedMemory.attachments?.filter((item) => item.kind === "image") ?? []) await add(image);
    }
  }
  return references.slice(0, 6);
}

export function applyMemoryVisualPlan(memory: LongTermMemory, plan: MemoryVisualPlan) {
  memory.shortTitle = memoryShortTitle(plan.narrative, plan.shortTitle);
  memory.narrative = plan.narrative;
  memory.visualPrompt = plan.imagePrompt;
}

function retrieveRelatedMemories(profile: CreatureProfile, target: LongTermMemory) {
  const targetTerms = terms(`${target.text} ${target.tags.join(" ")}`);
  return profile.longTermMemories
    .filter((item) => item.id !== target.id && item.weight > 0)
    .map((item) => ({ item, score: overlap(targetTerms, terms(`${item.text} ${item.tags.join(" ")}`)) + (item.attachments?.some((a) => a.kind === "image") || item.visual ? 0.2 : 0) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ item }) => item);
}

function terms(text: string) {
  return new Set(text.toLowerCase().split(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】\[\]]+/).flatMap((part) => part.length > 4 ? [part, ...[...part].map((_, index, chars) => chars.slice(index, index + 2).join(""))] : [part]).filter((part) => part.length >= 2));
}

function overlap(left: Set<string>, right: Set<string>) {
  let matched = 0;
  for (const term of left) if (right.has(term)) matched += 1;
  return matched / Math.max(1, Math.min(left.size, right.size));
}

function memoryVisualPlanPrompt(profile: CreatureProfile, memory: LongTermMemory, related: LongTermMemory[], client: ReturnType<typeof clientContextFor>) {
  const name = profile.clientDocument?.preferredName?.trim() || "你";
  const feedback = profile.feedbackHistory
    .filter((item) => item.targetId === memory.id && item.inputText?.trim())
    .slice(0, 5)
    .map((item) => ({ id: item.id, inputText: item.inputText, effect: item.effect }));
  return `你是 ${profile.creatureName} 的共同回忆编辑和视觉导演。把一条已经确认的长期事实整理成 ${profile.creatureName} 口中的共同回忆，并规划一张回忆封面。

写作要求：
- narrative 使用 ${profile.creatureName} 这个小动物观察者的第一人称视角，像它带着理解和感情在回想共同经历。
- 对使用者直接称呼“${name}”或“你”，禁止写“用户”“该用户”“说话者”等客观系统口吻。
- 温柔、具体、克制，不虚构未发生的动作、人物、地点、情绪或关系；事实以 target_memory 和来源附件为准。
- shortTitle 2-8 个中文字符，适合相册式缩略卡。

视觉要求：
- 生成一张无文字的正方形共同回忆插画；画面先表达这条回忆，不做通用装饰图。
- 画风必须与 ${profile.creatureName} 当前 profile 的 visualStyle 一致。
- 如果画面出现 ${profile.creatureName}，needsPapoReference=true，并要求严格保持 profile 图片角色身份。
- 只有当回忆明确涉及使用者本人且 related memories 含自我相关照片时，needsClientReferences=true；不要为了凑参考图使用无关人像。
- relatedMemoryIds 只能从 related_memories 选择，且只选生成这张图真正需要的记忆。
- imagePrompt 必须说明哪些参考图对应 ${profile.creatureName}、使用者或现场，不得混淆身份。

pet_profile：${JSON.stringify({ name: profile.creatureName, ...profile.petProfile })}
client_context：${JSON.stringify(client)}
target_memory：${JSON.stringify({ id: memory.id, text: memory.text, shortTitle: memory.shortTitle, tags: memory.tags, createdAt: memory.createdAt, attachments: memory.attachments?.map((item) => ({ id: item.id, label: item.label, kind: item.kind })) })}
target_feedback：${JSON.stringify(feedback)}
related_memories：${JSON.stringify(related.map((item) => ({ id: item.id, text: item.text, shortTitle: item.shortTitle, tags: item.tags, hasImage: Boolean(item.visual || item.attachments?.some((a) => a.kind === "image")) })))}

返回严格 JSON：
{"shortTitle":"雨天散步","narrative":"我记得那天下着小雨，你走得不快，我就像平时一样陪在旁边。","imagePrompt":"...","relatedMemoryIds":[],"needsPapoReference":true,"needsClientReferences":false}`;
}
