import { z } from "zod";
import { clientContextFor } from "../core/client-document";
import { memoryShortTitle } from "../core/memory";
import type { ImageReference, ModelProvider } from "../core/provider";
import type { CreatureProfile, LongTermMemory, MediaAttachment } from "../core/types";

const planSchema = z.object({
  shortTitle: z.string().trim().min(2).max(24).transform((title) => [...title].slice(0, 8).join("")),
  narrative: z.string().trim().min(8).max(500),
  visualMode: z.enum(["grounded_scene", "imaginative_illustration", "symbolic_cover", "no_visual"]),
  papoPresence: z.enum(["required", "optional", "absent"]),
  visualReason: z.string().trim().min(4).max(360),
  imagePrompt: z.preprocess((value) => value === null || value === "" ? undefined : value, z.string().trim().min(20).max(2200).optional()),
  relatedMemoryIds: z.array(z.string().min(1)).max(8).default([]),
  needsClientReferences: z.boolean().default(false)
}).superRefine((plan, context) => {
  if (plan.visualMode !== "no_visual" && !plan.imagePrompt) context.addIssue({ code: "custom", message: "visual plan requires imagePrompt" });
  if (plan.visualMode === "no_visual" && plan.papoPresence === "required") context.addIssue({ code: "custom", message: "no_visual cannot require Papo" });
});

export interface MemoryVisualPlan extends z.infer<typeof planSchema> {}

export async function planMemoryVisual(profile: CreatureProfile, memory: LongTermMemory, provider: ModelProvider) {
  const related = retrieveRelatedMemories(profile, memory);
  const client = clientContextFor(profile, `${memory.text} ${memory.tags.join(" ")}`);
  const raw = await provider.generateJson<unknown>(memoryVisualPlanPrompt(profile, memory, related, client));
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid memory visual plan (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
  const allowed = new Set(related.map((item) => item.id));
  const plan = { ...parsed.data, relatedMemoryIds: parsed.data.relatedMemoryIds.filter((id) => allowed.has(id)) };
  const hasGrounding = Boolean(memory.attachments?.some((item) => item.kind === "image"));
  if (plan.visualMode === "grounded_scene" && !hasGrounding) throw new Error("grounded_scene requires a real image attachment");
  return plan;
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
  if (plan.papoPresence === "required") await add(profile.petProfile.avatarImage ?? profile.petProfile.referenceImage);
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
  memory.visualMode = plan.visualMode;
  memory.papoPresence = plan.papoPresence;
  memory.visualPlanReason = plan.visualReason;
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
  return `你是 ${profile.creatureName} 的共同回忆编辑和视觉导演。先整理 narrative，再独立判断这条记忆是否值得生成图片；不要为了统一版式机械生成图片或机械加入小动物。

写作要求：
- narrative 使用 ${profile.creatureName} 这个小动物观察者的第一人称视角，像它带着理解和感情在回想共同经历。
- 对使用者直接称呼“${name}”或“你”，禁止写“用户”“该用户”“说话者”等客观系统口吻。
- 温柔、具体、克制，不虚构未发生的动作、人物、地点、情绪或关系；事实以 target_memory 和来源附件为准。
- shortTitle 2-8 个中文字符，适合相册式缩略卡。

视觉要求：
- visualMode 必须选择 grounded_scene、imaginative_illustration、symbolic_cover、no_visual。
- 有真实照片附件且能表达记忆核心时优先 grounded_scene，并优先使用真实素材；不得伪造照片里没有的人物、地点和现场细节。
- 没有真实照片时可以 imaginative_illustration 或 symbolic_cover，但必须明确是插画/象征表达，不伪造具体人物长相、真实地点或现场细节，不包装成真实照片。
- 讲座、会议等知识型记忆默认优先 symbolic_cover 或 imaginative_illustration，papoPresence 通常 optional 或 absent。
- 日常陪伴、旅行、吃饭和关系型共同经历，只有当小动物确实是画面叙事的一部分时才用 papoPresence=required。
- no_visual 表示这条记忆不值得配图，此时不返回 imagePrompt，papoPresence 只能 optional 或 absent。
- papoPresence=required 表示明确让 ${profile.creatureName} 出现在画面，系统才会加入小动物参考图；optional/absent 不加入参考图。
- 非 no_visual 时生成无文字的正方形插画或封面，画面先表达记忆核心，不做通用装饰图。
- 画风必须与 ${profile.creatureName} 当前 profile 的 visualStyle 一致。
- 只有当回忆明确涉及使用者本人且 related memories 含自我相关照片时，needsClientReferences=true；不要为了凑参考图使用无关人像。
- relatedMemoryIds 只能从 related_memories 选择，且只选生成这张图真正需要的记忆。
- imagePrompt 必须说明哪些参考图对应 ${profile.creatureName}、使用者或现场，不得混淆身份。

pet_profile：${JSON.stringify({ name: profile.creatureName, ...profile.petProfile })}
client_context：${JSON.stringify(client)}
target_memory：${JSON.stringify({ id: memory.id, text: memory.text, shortTitle: memory.shortTitle, tags: memory.tags, createdAt: memory.createdAt, attachments: memory.attachments?.map((item) => ({ id: item.id, label: item.label, kind: item.kind })) })}
target_feedback：${JSON.stringify(feedback)}
related_memories：${JSON.stringify(related.map((item) => ({ id: item.id, text: item.text, shortTitle: item.shortTitle, tags: item.tags, hasImage: Boolean(item.visual || item.attachments?.some((a) => a.kind === "image")) })))}

返回严格 JSON：
{"shortTitle":"雨天散步","narrative":"我记得那天下着小雨，你走得不快。","visualMode":"grounded_scene","papoPresence":"absent","visualReason":"真实照片足以表达这段经历","imagePrompt":"...","relatedMemoryIds":[],"needsClientReferences":false}`;
}
