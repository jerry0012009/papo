import { z } from "zod";
import { clientContextFor } from "../core/client-document";
import { MEMORY_VISUAL_POLICY_VERSION, memoryShortTitle, memoryVisualPromptHasForbiddenContent } from "../core/memory";
import type { ImageReference, ModelProvider } from "../core/provider";
import type { CreatureProfile, EpisodeMemory, LongTermMemory, MediaAttachment } from "../core/types";

const planSchema = z.object({
  shortTitle: z.string().trim().min(2).max(24).transform((title) => [...title].slice(0, 8).join("")),
  narrative: z.string().trim().min(8).max(500),
  visualMode: z.enum(["grounded_scene", "imaginative_illustration", "no_visual"]),
  papoPresence: z.enum(["required", "optional", "absent"]),
  visualReason: z.string().trim().min(4).max(360),
  imagePrompt: z.preprocess((value) => value === null || value === "" ? undefined : value, z.string().trim().min(20).max(2200).optional()),
  relatedMemoryIds: z.array(z.string().min(1)).max(8).default([]),
  needsClientReferences: z.boolean().default(false),
  provenance: z.object({
    sourceType: z.enum(["live_environment", "device_playback", "mixed", "unknown"]),
    userStance: z.enum(["explicit", "not_present", "inferred"]),
    userStanceEvidence: z.preprocess((value) => value === null || value === "" ? undefined : value, z.string().trim().min(1).max(360).optional()),
    sharedScene: z.enum(["explicit", "not_present", "inferred"]),
    sharedSceneEvidence: z.preprocess((value) => value === null || value === "" ? undefined : value, z.string().trim().min(1).max(360).optional())
  }).optional()
}).superRefine((plan, context) => {
  if (plan.visualMode !== "no_visual" && !plan.imagePrompt) context.addIssue({ code: "custom", message: "visual plan requires imagePrompt" });
  if (plan.visualMode === "no_visual" && plan.papoPresence === "required") context.addIssue({ code: "custom", message: "no_visual cannot require Papo" });
});

export interface MemoryVisualPlan extends z.infer<typeof planSchema> {}

export async function planMemoryVisual(profile: CreatureProfile, memory: LongTermMemory, provider: ModelProvider, options: { requireVisual?: boolean } = {}) {
  const related = retrieveRelatedMemories(profile, memory);
  const client = clientContextFor(profile, `${memory.text} ${memory.tags.join(" ")}`);
  const sourceEpisode = memory.sourceEpisodeId ? profile.episodes.find((episode) => episode.id === memory.sourceEpisodeId) : undefined;
  const prompt = memoryVisualPlanPrompt(profile, memory, related, client, sourceEpisode, options);
  let raw: unknown;
  try {
    raw = await provider.generateJson<unknown>(prompt);
    return validateMemoryVisualPlan(raw, related, memory, sourceEpisode, options);
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 500) : "unknown validation error";
    raw = await (provider.generateJsonFallback ?? provider.generateJson)(`${prompt}\n\n上一次返回未通过校验：${reason}\n请修正上述具体错误，只返回一份完整、严格合法的 JSON。`);
    return validateMemoryVisualPlan(raw, related, memory, sourceEpisode, options);
  }
}

function validateMemoryVisualPlan(raw: unknown, related: LongTermMemory[], memory: LongTermMemory, sourceEpisode: EpisodeMemory | undefined, options: { requireVisual?: boolean }) {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid memory visual plan (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
  const allowed = new Set(related.map((item) => item.id));
  const plan = { ...parsed.data, relatedMemoryIds: parsed.data.relatedMemoryIds.filter((id) => allowed.has(id)) };
  if (options.requireVisual && plan.visualMode === "no_visual") throw new Error("long-term memory requires a concrete album illustration");
  const hasGrounding = Boolean(memory.attachments?.some((item) => item.kind === "image"));
  if (plan.visualMode === "grounded_scene" && !hasGrounding) throw new Error("grounded_scene requires a real image attachment");
  if (plan.visualMode !== "no_visual") validatePaintedMemoryPrompt(plan.imagePrompt ?? "");
  if (plan.visualMode !== "no_visual" && plan.papoPresence !== "required" && !/no (?:pets?|animals?|anthropomorphic characters?)/i.test(plan.imagePrompt ?? "")) {
    throw new Error("non-Papo memory image prompt must explicitly exclude animals");
  }
  validateNarrativeProvenance(plan, sourceEpisode);
  return plan;
}

function validateNarrativeProvenance(plan: MemoryVisualPlan, sourceEpisode: EpisodeMemory | undefined) {
  if (sourceEpisode?.audioSourceType !== "device_playback") return;
  if (!plan.provenance || plan.provenance.sourceType !== "device_playback") throw new Error("visual narrative provenance must match the source episode");
  if (plan.provenance.userStance === "inferred") throw new Error("device_playback narrative cannot infer a user stance from media speech");
  if (plan.provenance.sharedScene === "inferred") throw new Error("device_playback narrative cannot infer a shared physical scene");
  if (plan.provenance.userStance === "explicit" && !plan.provenance.userStanceEvidence) throw new Error("explicit user stance requires source evidence");
  if (plan.provenance.sharedScene === "explicit" && !plan.provenance.sharedSceneEvidence) throw new Error("explicit shared scene requires source evidence");
}

function validatePaintedMemoryPrompt(prompt: string) {
  const paintedMedium = /hand[- ]drawn|hand[- ]painted|gouache|watercolou?r|colored[- ]pencil|sketchbook|pastel|ink[- ]wash|comic|illustration|蜡笔|水彩|水粉|彩铅|手绘|漫画|插画|速写/i;
  const abstractInfographic = /\b(vector|infographic|commercial app style|corporate illustration|interconnected nodes?|neural network|speech bubbles?|thought clouds?|flow arrows?|AI[- ]related)\b|互联节点|神经网络|对话气泡|流程箭头|商业化移动应用|抽象舞台|发光线条|渐变背景/i;
  const incompatibleMedium = /\b(oil[- ]paint(?:ing|ed)?|photorealistic|photo[- ]realistic|3d render(?:ing)?)\b|油画|厚涂|摄影写实|照片级|3D渲染/i;
  if (!paintedMedium.test(prompt)) throw new Error("imaginative_illustration must name a tactile painted medium");
  if (abstractInfographic.test(prompt)) throw new Error("memory image prompt uses forbidden infographic language");
  if (memoryVisualPromptHasForbiddenContent(prompt)) throw new Error("memory image prompt requests forbidden symbols or readable content");
  if (incompatibleMedium.test(prompt)) throw new Error("memory image prompt uses an incompatible album medium");
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
  memory.visualPolicyVersion = MEMORY_VISUAL_POLICY_VERSION;
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

function memoryVisualPlanPrompt(profile: CreatureProfile, memory: LongTermMemory, related: LongTermMemory[], client: ReturnType<typeof clientContextFor>, sourceEpisode: EpisodeMemory | undefined, options: { requireVisual?: boolean }) {
  const name = profile.clientDocument?.preferredName?.trim() || "你";
  const feedback = profile.feedbackHistory
    .filter((item) => item.targetId === memory.id && item.inputText?.trim())
    .slice(0, 5)
    .map((item) => ({ id: item.id, inputText: item.inputText, effect: item.effect }));
  return `你是 ${profile.creatureName} 的共同回忆编辑和视觉导演，也是生活画面导演。先整理 narrative，再判断这段记忆是否有一个值得被看见的具体画面。图片必须像小动物亲眼看到的生活，或像小动物在画纸上想象的生活；禁止做通用 AI 信息图、商业封面或概念图。
${options.requireVisual ? "- 这是已经正式留下的长期记忆，相册需要缩略图；必须选择 grounded_scene 或 imaginative_illustration，并生成一个克制、具体、不虚构事实的生活画面，不能选择 no_visual。" : "- 这是尚未确认的候选内容；若内容不适合花费预算生成预览，可以选择 no_visual。"}

写作要求：
- narrative 使用 ${profile.creatureName} 这个小动物观察者的第一人称视角，像它带着理解和感情在回想共同经历。
- 对使用者直接称呼“${name}”或“你”，禁止写“用户”“该用户”“说话者”等客观系统口吻。
- 温柔、具体、克制，不虚构未发生的动作、人物、地点、情绪或关系；事实以 target_memory 和来源附件为准。
- source_provenance 是事实归属边界。audioSourceType=device_playback 表示内容来自使用者手机播放的视频、播客或其他媒体：必须明确写成“你播放/收听的媒体中，讲者提到……”，不得改写成使用者本人说过、认同、喜欢、有共鸣或持有该观点，也不得虚构 ${profile.creatureName} 当时趴在旁边、共同观看等物理场景。audioSourceType=mixed 时必须保留来源不确定性。
- provenance 是对 narrative 的结构化事实审计：sourceType 必须与 source_provenance 一致；userStance/sharedScene 只能为 explicit、not_present 或 inferred。只有来源材料直接支持时才可填 explicit，并给出对应 evidence；模型补出的推测必须诚实标为 inferred。device_playback 不允许 inferred 的用户立场或共同物理场景。
- shortTitle 2-8 个中文字符，适合相册式缩略卡。

视觉要求：
- visualMode 只能选择 grounded_scene、imaginative_illustration、no_visual。
- 整个记忆相册使用统一的温暖手绘、漫画或生活插画语言：自然线条、纸张或颜料质感、克制但有生活气的颜色。不要使用油画厚涂、摄影写实、3D 渲染或企业宣传插画。
- grounded_scene 只用于有真实照片附件的记忆。以照片中的真实人物、物件、空间、构图和光线为事实依据，再转译成手绘生活插画；不得补造照片外的现场细节，也不要直接复制成写实照片。
- 没有真实照片时只能选择 imaginative_illustration 或 no_visual。imaginative_illustration 必须是有笔触、有材质、明确非摄影的手绘画面，并在 prompt 中直接写明 hand-drawn comic illustration、gouache、watercolor、colored-pencil 或 sketchbook 等具体媒介。
- 画面必须有一个具体可观看的生活场景、视角和主体，根据这条记忆本身选择构图，不要把某一类历史事件当成模板反复套用。
- 人物可以自然地呈现插画化的面部、表情、姿态和交流，不要刻意糊脸、抹去五官或把所有人强制画成背影和剪影。没有本人参考图时，只需避免声称画中人精确还原某个真实身份；概括的插画人物不构成身份还原。
- 禁止用互联节点、神经网络、漂浮图标、对话气泡、灯泡、播放按钮、流程箭头、抽象舞台、发光线条、渐变背景等符号拼贴来代替生活画面。
- 画面里的屏幕、白板、海报和手机只能作为生活场景中的普通物件，保持空白或只有不可辨认的色块；禁止出现任何图标、概念符号、可读文字、字母、数字、标题或品牌标识。
- 禁止出现 vector、3D render、commercial app style、corporate illustration、infographic、UI、logo、文字或水印。
- 如果没有足够证据形成具体画面，选择 no_visual，不要退回抽象概念封面。
- 知识、工作、日常、旅行和关系记忆都使用同一判断：画实际经历或合理想象出的生活瞬间，不画概念本身，也不预设固定会场构图。
- 当 papoPresence=optional 或 absent 时，imagePrompt 必须明确写 no pets、no animals、no anthropomorphic characters；不能因为产品角色是小动物，就把人类讲者或听众画成动物。
- 只有当小动物确实是画面叙事的一部分时才用 papoPresence=required。
- no_visual 表示这条记忆不值得配图，此时不返回 imagePrompt，papoPresence 只能 optional 或 absent。
- papoPresence=required 表示明确让 ${profile.creatureName} 出现在画面，系统才会加入小动物参考图；optional/absent 不加入参考图。
- 非 no_visual 时生成无文字的正方形生活画面；画面先表达经历，不做封面排版或通用装饰图。
- 当 ${profile.creatureName} 出现时，角色身份、毛色和外形必须与 profile 一致，但渲染媒介仍服从记忆相册统一的手绘/漫画/插画语言。动作卡承担实时角色动画，可以保持自身更严格的角色画风，不要把动作卡的 3D 或摄影语言带入记忆相册。
- 只有当回忆明确涉及使用者本人且 related memories 含自我相关照片时，needsClientReferences=true；不要为了凑参考图使用无关人像。
- relatedMemoryIds 只能从 related_memories 选择，且只选生成这张图真正需要的记忆。
- imagePrompt 必须说明哪些参考图对应 ${profile.creatureName}、使用者或现场，不得混淆身份。

pet_profile：${JSON.stringify({ name: profile.creatureName, ...profile.petProfile })}
client_context：${JSON.stringify(client)}
target_memory：${JSON.stringify({ id: memory.id, text: memory.text, shortTitle: memory.shortTitle, tags: memory.tags, occurredAt: memory.occurredAt ?? memory.createdAt, sourceEpisodeId: memory.sourceEpisodeId, attachments: memory.attachments?.map((item) => ({ id: item.id, label: item.label, kind: item.kind })) })}
source_provenance：${JSON.stringify(sourceEpisode ? { episodeId: sourceEpisode.id, audioSourceType: sourceEpisode.audioSourceType ?? "unknown", cognitionSource: sourceEpisode.cognitionSource, inputSummary: sourceEpisode.inputSummary, noticed: sourceEpisode.noticed, possibleIntent: sourceEpisode.possibleIntent, importanceReason: sourceEpisode.importanceReason, sourceObservedAt: sourceEpisode.sourceObservedAt ?? sourceEpisode.createdAt } : null)}
target_feedback：${JSON.stringify(feedback)}
related_memories：${JSON.stringify(related.map((item) => ({ id: item.id, text: item.text, shortTitle: item.shortTitle, tags: item.tags, hasImage: Boolean(item.visual || item.attachments?.some((a) => a.kind === "image")) })))}

返回严格 JSON：
{"shortTitle":"雨后散步","narrative":"我记得那天雨刚停，你慢慢走过还泛着光的小路。","visualMode":"imaginative_illustration","papoPresence":"absent","visualReason":"没有现场照片，用温暖手绘保留这个具体生活瞬间","imagePrompt":"A warm hand-drawn watercolor and colored-pencil illustration of a person taking a quiet walk on a damp neighborhood path after rain, natural face and relaxed expression in a gently simplified comic style, reflections in small puddles, visible paper texture and loose linework, clearly illustrated and non-photographic, no animals, no icons, no text, no logo","relatedMemoryIds":[],"needsClientReferences":false,"provenance":{"sourceType":"unknown","userStance":"not_present","sharedScene":"not_present"}}`;
}
