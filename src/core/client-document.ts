import { z } from "zod";
import { makeId } from "./ids";
import type { ModelProvider } from "./provider";
import type { ClientDimension, ClientDocument, ClientFact, CreatureProfile } from "./types";

const dimensions = [
  "identity", "personality", "family", "growth", "leisure", "values", "health", "work", "environment",
  "community", "family_relationships", "intimate_relationships", "social_relationships"
] as const satisfies readonly ClientDimension[];

const updateSchema = z.object({
  preferredName: z.preprocess(normalizePreferredNameInput, z.string().trim().min(1).max(40).optional()),
  facts: z.array(z.object({
    dimension: z.string().trim().min(1).max(40),
    text: z.string().trim().min(2).max(180),
    confidence: z.number().min(0).max(100),
    sourceIds: z.array(z.string().min(1).max(120)).min(1).max(8)
  })).max(24).default([])
});

export async function updateClientDocument(profile: CreatureProfile, provider: ModelProvider, sourceIds: string[]) {
  const memories = profile.longTermMemories.filter((memory) => sourceIds.includes(memory.id) || (memory.sourceEpisodeId && sourceIds.includes(memory.sourceEpisodeId)));
  const feedback = profile.feedbackHistory.filter((item) => item.targetId && sourceIds.includes(item.targetId)).slice(0, 6);
  if (!memories.length && !feedback.length) return false;
  const current = profile.clientDocument ?? emptyClientDocument(profile.createdAt);
  const raw = await provider.generateJson<unknown>(clientUpdatePrompt(profile, current, memories, feedback, sourceIds));
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid Client.md update (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
  const allowedSourceIds = new Set(sourceIds);
  const normalizedFacts = parsed.data.facts.flatMap((fact) => {
    const dimension = normalizeDimension(fact.dimension);
    const validSourceIds = fact.sourceIds.filter((id) => allowedSourceIds.has(id));
    return dimension && validSourceIds.length ? [{ ...fact, dimension, sourceIds: validSourceIds }] : [];
  });
  const currentNameSources = current.preferredNameSourceIds ?? [];
  const replacesPreferredName = currentNameSources.some((id) => allowedSourceIds.has(id));
  const preferredName = parsed.data.preferredName ?? (replacesPreferredName ? undefined : current.preferredName);
  const preferredNameSourceIds = parsed.data.preferredName ? sourceIds : (replacesPreferredName ? [] : currentNameSources);
  const retainedFacts = current.facts.flatMap((fact) => {
    const remainingSourceIds = fact.sourceIds.filter((id) => !allowedSourceIds.has(id));
    return remainingSourceIds.length ? [{ ...fact, sourceIds: remainingSourceIds }] : [];
  });
  const facts = mergeClientFacts(retainedFacts, normalizedFacts, new Date().toISOString(), preferredName);
  profile.clientDocument = {
    preferredName,
    preferredNameSourceIds,
    facts,
    markdown: renderClientMarkdown(preferredName, facts),
    updatedAt: new Date().toISOString(),
    revision: current.revision + 1
  };
  return true;
}

export async function reconcileClientDocument(profile: CreatureProfile, provider: ModelProvider) {
  const current = profile.clientDocument ?? emptyClientDocument(profile.createdAt);
  if (!current.facts.length) return false;
  const allowed = new Set(profile.longTermMemories.map((memory) => memory.id));
  const raw = await provider.generateJson<unknown>(clientReconcilePrompt(profile, current));
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid Client.md reconciliation (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
  const preferredName = parsed.data.preferredName ?? current.preferredName;
  const now = new Date().toISOString();
  const facts: ClientFact[] = parsed.data.facts.flatMap((fact) => {
    const dimension = normalizeDimension(fact.dimension);
    const sourceIds = fact.sourceIds.filter((id) => allowed.has(id));
    if (!dimension || !sourceIds.length) return [];
    return [{ id: makeId("client"), dimension, text: preferredName ? fact.text.replace(/^对方/, preferredName) : fact.text, confidence: fact.confidence, sourceIds, updatedAt: now }];
  });
  profile.clientDocument = {
    preferredName,
    preferredNameSourceIds: preferredName ? (current.preferredNameSourceIds ?? []) : [],
    facts,
    markdown: renderClientMarkdown(preferredName, facts),
    updatedAt: now,
    revision: current.revision + 1
  };
  return true;
}

export function clientContextFor(profile: CreatureProfile, subject: string) {
  const document = profile.clientDocument;
  if (!document) return undefined;
  const selected = document.facts.filter((fact) => dimensionRelevant(fact.dimension, subject)).slice(0, 12);
  if (!selected.length && !document.preferredName) return undefined;
  return {
    preferredName: document.preferredName,
    facts: selected.map(({ dimension, text, confidence, sourceIds }) => ({ dimension, text, confidence, sourceIds }))
  };
}

export function emptyClientDocument(now = new Date().toISOString()): ClientDocument {
  return { facts: [], markdown: "# Client\n\n还在慢慢认识你。", updatedAt: now, revision: 0 };
}

function mergeClientFacts(current: ClientFact[], incoming: Array<Omit<ClientFact, "id" | "updatedAt">>, now: string, preferredName?: string) {
  const facts = [...current];
  for (const item of incoming) {
    const key = factKey(item.text, preferredName);
    const existing = facts.find((fact) => fact.dimension === item.dimension && factKey(fact.text, preferredName) === key);
    if (existing) Object.assign(existing, item, { sourceIds: [...new Set([...existing.sourceIds, ...item.sourceIds])], updatedAt: now });
    else facts.push({ id: makeId("client"), ...item, updatedAt: now });
  }
  return facts
    .map((fact) => preferredName ? { ...fact, text: fact.text.replace(/^对方/, preferredName) } : fact)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 80);
}

function factKey(text: string, preferredName?: string) {
  const normalized = preferredName ? text.replaceAll(preferredName, "对方") : text;
  return normalized.replace(/[，。,.；;\s]/g, "").slice(0, 36);
}

function normalizeDimension(value: string): ClientDimension | undefined {
  if ((dimensions as readonly string[]).includes(value)) return value as ClientDimension;
  const aliases: Record<string, ClientDimension> = {
    name: "identity", identity_info: "identity", basic_info: "identity",
    privacy: "values", privacy_boundary: "values", boundaries: "values", preferences: "personality",
    hobbies: "leisure", interests: "leisure", sports: "leisure",
    career: "work", occupation: "work", developer: "work",
    pets: "family", pet: "family", home: "environment",
    relationships: "social_relationships", friends: "social_relationships"
  };
  return aliases[value.toLowerCase().replace(/[\s-]+/g, "_")];
}

function normalizePreferredNameInput(value: unknown) {
  if (value === null || value === "") return undefined;
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  if (/^(仅明确时填写|未记录|未知|无|none|null|undefined)$/i.test(normalized)) return undefined;
  return normalized;
}

function renderClientMarkdown(preferredName: string | undefined, facts: ClientFact[]) {
  const labels: Record<ClientDimension, string> = {
    identity: "称呼与身份", personality: "性格", family: "家庭", growth: "成长", leisure: "休闲",
    values: "精神追求", health: "健康", work: "工作", environment: "生活环境", community: "集体与社团",
    family_relationships: "家庭关系", intimate_relationships: "亲密关系", social_relationships: "人际关系"
  };
  const sections = dimensions.flatMap((dimension) => {
    const items = facts.filter((fact) => fact.dimension === dimension);
    return items.length ? [`## ${labels[dimension]}`, ...items.map((fact) => `- ${fact.text}`), ""] : [];
  });
  return ["# Client", "", preferredName ? `> 希望被称呼为：${preferredName}` : "> 尚未记录明确称呼", "", ...sections].join("\n").trim();
}

function dimensionRelevant(dimension: ClientDimension, subject: string) {
  const keys: Record<ClientDimension, RegExp> = {
    identity: /称呼|名字|我是|叫我|身份|自己|照片|画像/,
    personality: /性格|感受|情绪|习惯|喜欢|讨厌/,
    family: /家|父母|妈妈|爸爸|孩子|兄弟|姐妹/,
    growth: /成长|小时候|过去|学校|经历/,
    leisure: /休闲|运动|游戏|旅行|兴趣|爱好|音乐|电影|阅读/,
    values: /价值|理想|追求|意义|信念|精神/,
    health: /健康|身体|睡眠|饮食|药|医院|运动/,
    work: /工作|同事|公司|项目|职业|会议/,
    environment: /家里|住处|房间|城市|环境|天气/,
    community: /社团|集体|团队|组织|社区/,
    family_relationships: /家人|家庭关系|父母|孩子|伴侣/,
    intimate_relationships: /恋爱|对象|伴侣|亲密|男友|女友|丈夫|妻子/,
    social_relationships: /朋友|同事|人际|关系|聚会/
  };
  return keys[dimension].test(subject);
}

function clientUpdatePrompt(profile: CreatureProfile, current: ClientDocument, memories: CreatureProfile["longTermMemories"], feedback: CreatureProfile["feedbackHistory"], sourceIds: string[]) {
  return `你是 Papo 的 Client.md 维护脑。只把已有证据支持、对长期理解有帮助的认识写入每用户私有档案。

规则：
- 不从普通寒暄、一次情绪或模糊推测概括人格、疾病、关系或身份。
- preferredName 只在证据明确记录“叫我 X/我是 X/告诉 Papo 自己的名字是 X”时更新；符合时必须填写，没有明确证据才省略。若有多个名字，选择证据中首选或最常用的短称呼。
- facts 使用第三人称中性事实，不写“用户”，直接写称呼；没有称呼时写“对方”。
- 每条 fact 必须带真实 sourceIds；只使用 allowedSourceIds。
- 保留当前仍成立的认识，只返回本次新增或需要修订的 facts。
- 健康、亲密关系等敏感维度需要明确表达和较高置信度，不做推断。

Papo：${profile.creatureName}
当前称呼：${current.preferredName ?? "未记录"}
当前档案：${current.markdown}
allowedSourceIds：${JSON.stringify(sourceIds)}
新长期记忆：${JSON.stringify(memories.map((memory) => ({ id: memory.id, text: memory.text, shortTitle: memory.shortTitle, tags: memory.tags })))}
相关反馈：${JSON.stringify(feedback.map((item) => ({ id: item.id, targetId: item.targetId, inputText: item.inputText, effect: item.effect })))}

返回严格 JSON：
{"preferredName":"仅明确时填写","facts":[{"dimension":"leisure","text":"Jerry 喜欢游泳","confidence":88,"sourceIds":["ltm_xxx"]}]}`;
}

function clientReconcilePrompt(profile: CreatureProfile, current: ClientDocument) {
  return `你是 Papo 的 Client.md 总校订脑。请把现有事实去重、压缩并重分到正确维度，返回一份完整替换稿。

硬性规则：
- 只能使用 current_facts 已有内容，禁止新增推断；sourceIds 必须原样来自对应事实。
- 合并语义重复项；每个独立、长期有用的事实保留一条，不保留“体现信任/联结意愿”等泛化套话。
- 姓名性别归 identity；宠物与家庭成员归 family；足球、游戏、漫画偏好归 leisure；开发者/项目归 work；体重与健康进展归 health；隐私和记忆控制偏好归 values。事故等一次性事件不是稳定画像，应删除。
- preferredName 必须保留已有明确称呼“${current.preferredName ?? "无"}”；没有明确称呼则省略字段，绝不能输出规则文字或占位词。
- text 不写“用户”“该用户”“对方”，有称呼就直接使用称呼。
- 只返回事实，不写建议 Papo 应该怎么做。

pet：${profile.creatureName}
preferredName：${current.preferredName ?? "未记录"}
current_facts：${JSON.stringify(current.facts.map(({ dimension, text, confidence, sourceIds }) => ({ dimension, text, confidence, sourceIds })))}

返回严格 JSON：
{"preferredName":"Jerry","facts":[{"dimension":"leisure","text":"Jerry 喜欢踢足球","confidence":95,"sourceIds":["ltm_xxx"]}]}`;
}
