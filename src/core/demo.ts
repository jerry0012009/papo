import type { CaptureResult, CreatureProfile } from "./types";

export function createContrastSummary(input: {
  deepProfile: CreatureProfile;
  quietProfile: CreatureProfile;
  deepResult: CaptureResult;
  quietResult: CaptureResult;
}) {
  const deepAction = input.deepResult.events[0]?.actionDecision.action ?? "quiet";
  const quietAction = input.quietResult.events[0]?.actionDecision.action ?? "quiet";
  const deepLine = summarizeInnerChoice(input.deepResult);
  const quietLine = summarizeInnerChoice(input.quietResult);
  return [
    `同一句输入下，深想型选择${actionTone(deepAction)}，安静型选择${actionTone(quietAction)}。`,
    `养成差异：深想型深入倾向 ${input.deepProfile.policyProfile.preferDepth}、回忆倾向 ${input.deepProfile.policyProfile.recallTendency}；安静型安静倾向 ${input.quietProfile.policyProfile.quietTendency}、主动性 ${input.quietProfile.policyProfile.preferProactivity}。`,
    `它们的内在选择也不一样：深想型「${deepLine}」；安静型「${quietLine}」。`
  ].join(" ");
}

function actionTone(action: string) {
  const map: Record<string, string> = {
    recall: "把旧片段带回来",
    review: "继续复盘",
    ask: "追问确认",
    save_episode: "写成共同经历",
    save_long_term: "建议长期记住",
    observe: "先轻轻观察",
    quiet: "安静陪着",
    respond: "先回应你",
    draft_reminder: "准备之后再回来",
    draft_question_list: "拆成小问题"
  };
  return map[action] ?? action;
}

function summarizeInnerChoice(result: CaptureResult) {
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
