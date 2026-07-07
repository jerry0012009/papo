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
  return [
    `同一句话下，被你鼓励多想的 Papo ${actionTone(deepAction)}；被你教会轻声陪着的 Papo ${actionTone(quietAction)}。`,
    `养成差异：${deepProfileLine(input.deepProfile, input.quietProfile)}；${quietProfileLine(input.quietProfile, input.deepProfile)}。`,
    `接话方式也被养得不一样：多想的那只「${deepLine}」；轻声的那只「${quietLine}」。`
  ].join(" ");
}

function deepProfileLine(deep: CreatureProfile, quiet: CreatureProfile) {
  const parts = ["被你鼓励多想的 Papo 更愿意停下来多想一点"];
  if (deep.policyProfile.recallTendency > quiet.policyProfile.recallTendency) parts.push("更容易把以前的小事带回来一起听");
  if (deep.policyProfile.preferProactivity > quiet.policyProfile.preferProactivity) parts.push("也更可能轻轻接一句话");
  return parts.join("，");
}

function quietProfileLine(quiet: CreatureProfile, deep: CreatureProfile) {
  const parts = ["被你教会轻声陪着的 Papo 更会收住声音"];
  if (quiet.policyProfile.quietTendency > deep.policyProfile.quietTendency) parts.push("先陪着，不急着打扰你");
  if (quiet.policyProfile.privacySensitivity >= deep.policyProfile.privacySensitivity) parts.push("保存前会多等你的意思");
  return parts.join("，");
}

function actionTone(action: string) {
  const map: Record<string, string> = {
    recall: "把以前的小事带回来",
    review: "多停一下继续想",
    ask: "追问确认",
    save_episode: "把这件事认真留下",
    save_long_term: "更认真记住这件事",
    observe: "先轻轻观察",
    quiet: "安静陪着",
    respond: "先回应你",
    draft_reminder: "之后轻轻回来提醒",
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
