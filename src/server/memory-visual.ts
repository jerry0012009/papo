import { z } from "zod";
import { clientContextFor } from "../core/client-document";
import { memoryShortTitle } from "../core/memory";
import type { ImageReference, ModelProvider } from "../core/provider";
import type { CreatureProfile, LongTermMemory, MediaAttachment } from "../core/types";

const planSchema = z.object({
  shortTitle: z.string().trim().min(2).max(24).transform((title) => [...title].slice(0, 8).join("")),
  narrative: z.string().trim().min(8).max(500),
  visualMode: z.enum(["grounded_scene", "imaginative_illustration", "no_visual"]),
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
  if (plan.visualMode === "imaginative_illustration") validatePaintedMemoryPrompt(plan.imagePrompt ?? "");
  return plan;
}

function validatePaintedMemoryPrompt(prompt: string) {
  const paintedMedium = /hand[- ]painted|gouache|watercolou?r|colored[- ]pencil|sketchbook|oil[- ]paint|pastel|ink[- ]wash|蜡笔|水彩|水粉|彩铅|油画|手绘|速写/i;
  const abstractInfographic = /\b(vector|infographic|commercial app style|corporate illustration|interconnected nodes?|neural network|floating icons?|speech bubbles?|thought clouds?|flow arrows?)\b|互联节点|神经网络|漂浮图标|对话气泡|流程箭头|商业化移动应用|抽象舞台|发光线条|渐变背景/i;
  if (!paintedMedium.test(prompt)) throw new Error("imaginative_illustration must name a tactile painted medium");
  if (abstractInfographic.test(prompt)) throw new Error("memory image prompt uses forbidden infographic language");
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
  memory.visualPolicyVersion = 2;
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
  return `你是 ${profile.creatureName} 的共同回忆编辑和视觉导演，也是生活画面导演。先整理 narrative，再判断这段记忆是否有一个值得被看见的具体画面。图片必须像小动物亲眼看到的生活，或像小动物在画纸上想象的生活；禁止做通用 AI 信息图、商业封面或概念图。

写作要求：
- narrative 使用 ${profile.creatureName} 这个小动物观察者的第一人称视角，像它带着理解和感情在回想共同经历。
- 对使用者直接称呼“${name}”或“你”，禁止写“用户”“该用户”“说话者”等客观系统口吻。
- 温柔、具体、克制，不虚构未发生的动作、人物、地点、情绪或关系；事实以 target_memory 和来源附件为准。
- shortTitle 2-8 个中文字符，适合相册式缩略卡。

视觉要求：
- visualMode 只能选择 grounded_scene、imaginative_illustration、no_visual。
- grounded_scene 只用于有真实照片附件的记忆。以照片中的真实人物、物件、空间和光线为依据，不得补造照片外的现场细节。
- 没有真实照片时只能选择 imaginative_illustration 或 no_visual。imaginative_illustration 必须是有笔触、有材质、明确非摄影的绘画画面，并在 prompt 中直接写明 hand-painted、gouache、watercolor、colored-pencil 或 sketchbook 等具体绘画媒介。
- 画面必须有一个具体可观看的生活场景、视角和主体。讲座可以画成从听众后方望向讲者与投影幕的手绘现场，会议可以画成桌边交谈的绘画场景；人物只用无身份特征的背影、剪影或概括造型，不虚构真实长相和场地特征。
- 禁止用互联节点、神经网络、漂浮图标、对话气泡、灯泡、播放按钮、流程箭头、抽象舞台、发光线条、渐变背景等符号拼贴来代替生活画面。
- 禁止出现 vector、3D render、commercial app style、corporate illustration、infographic、UI、logo、文字或水印。
- 如果没有足够证据形成具体画面，选择 no_visual，不要退回抽象概念封面。
- 讲座、会议等知识型记忆通常使用 imaginative_illustration，papoPresence 通常 absent；画的是被听见和经历的现场，而不是知识概念本身。
- 日常陪伴、旅行、吃饭和关系型共同经历，只有当小动物确实是画面叙事的一部分时才用 papoPresence=required。
- no_visual 表示这条记忆不值得配图，此时不返回 imagePrompt，papoPresence 只能 optional 或 absent。
- papoPresence=required 表示明确让 ${profile.creatureName} 出现在画面，系统才会加入小动物参考图；optional/absent 不加入参考图。
- 非 no_visual 时生成无文字的正方形生活画面；画面先表达经历，不做封面排版或通用装饰图。
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
{"shortTitle":"路演现场","narrative":"我记得陪你听完那场路演。","visualMode":"imaginative_illustration","papoPresence":"absent","visualReason":"没有现场照片，用无身份特征的手绘观看视角保留这次经历","imagePrompt":"A hand-painted gouache memory scene viewed from the back row of a small talk, simplified anonymous audience backs facing a speaker silhouette and a softly lit blank projection screen, visible brush texture, clearly illustrated and non-photographic, no icons, no diagrams, no text, no logo","relatedMemoryIds":[],"needsClientReferences":false}`;
}
