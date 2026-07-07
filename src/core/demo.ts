import type { CaptureResult, CreatureProfile } from "./types";

export function createContrastSummary(input: {
  deepProfile: CreatureProfile;
  quietProfile: CreatureProfile;
  deepResult: CaptureResult;
  quietResult: CaptureResult;
}) {
  const deepAction = input.deepResult.events[0]?.actionDecision.action ?? "quiet";
  const quietAction = input.quietResult.events[0]?.actionDecision.action ?? "quiet";
  const deepLine = summarizeVisibleStyle(input.deepResult);
  const quietLine = summarizeVisibleStyle(input.quietResult);
  const deepName = input.deepProfile.creatureName || "Papo 小想";
  const quietName = input.quietProfile.creatureName || "Papo 小静";
  return [
    `同一句担心，两只 Papo 的接法已经分开了。`,
    `${deepName}被你鼓励多想后，会${actionTone(deepAction)}；${deepProfileLine(input.deepProfile, input.quietProfile)}。`,
    `${quietName}被你教着轻声陪后，会${actionTone(quietAction)}；${quietProfileLine(input.quietProfile, input.deepProfile)}。`,
    `它们说出口的第一反应也不一样：${deepName}「${deepLine}」；${quietName}「${quietLine}」。`
  ].join(" ");
}

function deepProfileLine(deep: CreatureProfile, quiet: CreatureProfile) {
  const parts = ["更愿意停下来多想一点"];
  if (deep.policyProfile.recallTendency > quiet.policyProfile.recallTendency) parts.push("更容易把以前的小事带回来一起听");
  if (deep.policyProfile.preferProactivity > quiet.policyProfile.preferProactivity) parts.push("也更可能轻轻接一句话");
  return parts.join("，");
}

function quietProfileLine(quiet: CreatureProfile, deep: CreatureProfile) {
  const parts = ["更会收住声音"];
  if (quiet.policyProfile.quietTendency > deep.policyProfile.quietTendency) parts.push("先陪着，不急着打扰你");
  if (quiet.policyProfile.privacySensitivity >= deep.policyProfile.privacySensitivity) parts.push("保存前会多等你的意思");
  return parts.join("，");
}

function actionTone(action: string) {
  const map: Record<string, string> = {
    recall: "把以前的小事带回来",
    review: "多停一下继续想",
    ask: "先问你一句",
    save_episode: "把这件事放在心上",
    save_long_term: "把这件事记得更稳",
    observe: "先轻轻观察",
    quiet: "安静陪着",
    respond: "先回应你",
    draft_reminder: "记得之后再回来看",
    draft_question_list: "把问题拆开陪你看"
  };
  return map[action] ?? action;
}

function summarizeVisibleStyle(result: CaptureResult) {
  return summarizeText(
    result.events[0]?.creatureExperience.actionFeeling ??
      result.events[0]?.actionDecision.reason ??
      result.response
  );
}

function summarizeText(text: string) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > 52 ? `${cleaned.slice(0, 52)}...` : cleaned;
}
