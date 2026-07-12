export interface ModelTaskProjection {
  text: string;
  kind: "plain_input" | "adult_self_media_revision";
  confirmedFacts?: {
    subject: "user_self";
    age: number;
    lifeStage: "adult";
  };
  objective?: string;
  retainedRequestDetails?: string[];
}

/**
 * Keeps the user's stored/displayed message untouched while giving model stages a
 * compact task view when quoted wording from an old, inaccurate depiction could
 * be mistaken for a request to create that depiction.
 */
export function projectInputForModel(text: string): ModelTaskProjection {
  const age = explicitUserAge(text);
  if (!age || age < 18 || !isSelfMediaRevision(text) || !describesAgeMismatch(text)) {
    return { text, kind: "plain_input" };
  }
  return {
    kind: "adult_self_media_revision",
    confirmedFacts: { subject: "user_self", age, lifeStage: "adult" },
    objective: "Revise an existing self-depiction so the user looks age-accurate and the visual treatment feels mature; preserve the requested activity and relationship from the original work.",
    retainedRequestDetails: retainedRequestDetails(text),
    text: [
      "Structured user task:",
      `- subject: the user themself, confirmed age ${age}, adult`,
      "- operation: revise or replace an existing media item",
      "- desired result: age-accurate adult appearance and a more mature visual treatment",
      "- continuity: preserve the activity, companion relationship, and other requested facts from the existing item or attachments",
      ...retainedRequestDetails(text).map((detail) => `- retained request detail: ${detail}`)
    ].join("\n")
  };
}

function retainedRequestDetails(text: string) {
  return text
    .split(/[，。；,;\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && !describesAgeMismatch(part) && !/(?:今年|现在|本人|我)?\s*\d{1,3}\s*岁/.test(part))
    .slice(0, 4);
}

export function explicitUserAge(text: string) {
  const match = text.match(/(?:今年|现在|本人|我)?\s*(\d{1,3})\s*岁/);
  const age = match ? Number(match[1]) : undefined;
  return age && age <= 120 ? age : undefined;
}

function isSelfMediaRevision(text: string) {
  return /(?:我|本人|自己)/.test(text)
    && /(?:画|形象|角色|照片|插画|动作卡|视频|卡片)/i.test(text)
    && /(?:改|调整|修订|重做|重新|新做|替换|不符合|不准确|不对)/i.test(text);
}

function describesAgeMismatch(text: string) {
  return /(?:低龄|幼态|年龄不符|年龄不对|太年轻|不像.*岁|看起来.*岁|小男孩|小女孩|儿童|未成年|小孩|少年)/i.test(text);
}
