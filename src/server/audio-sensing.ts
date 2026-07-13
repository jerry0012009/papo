import { z } from "zod";
import type { AudioSceneType, AudioSensingContent, SpeakerIdentityEvidence, SpeakerNameSource } from "../core/types";

const MAX_TRANSCRIPT_CHARS = 20_000;
const speakerSchema = z.object({
  speakerId: z.string().regex(/^speaker_[1-9]\d*$/),
  displayName: z.preprocess(nullToUndefined, z.string().trim().min(1).max(120).optional()),
  nameSource: z.enum(["unknown", "user_statement", "self_introduction", "reliable_context"]).default("unknown"),
  confidence: z.number().min(0).max(1).default(0),
  evidence: z.preprocess(nullToUndefined, z.string().trim().min(1).max(500).optional())
});

const audioContentSchema = z.object({
  sceneType: z.enum(["environment", "conversation", "lecture", "meeting", "interview", "unknown"]).default("unknown"),
  sourceType: z.enum(["live_environment", "device_playback", "mixed", "unknown"]).default("unknown"),
  transcript: z.preprocess(nullToEmpty, z.string().max(MAX_TRANSCRIPT_CHARS)),
  environmentObservation: z.preprocess(nullToUndefined, z.string().trim().max(800).optional()),
  speakers: z.array(speakerSchema).max(12).default([])
});

export interface NormalizedAudioSensing {
  text: string;
  unreadable: boolean;
  audioContent?: AudioSensingContent;
}

export function buildAudioSensingPrompt(
  label: string,
  companionContext?: string,
  options: { devicePlaybackActive?: boolean; echoCancellationRequested?: boolean; audioInputSource?: "microphone" | "voice_communication" } = {}
) {
  const playbackContext = options.devicePlaybackActive
    ? `系统在录音窗口内检测到这台手机正在播放媒体。硬件回声抑制${options.echoCancellationRequested ? "已请求" : "未覆盖整个窗口"}，但不能假设它完全消除了扬声器声。清晰、连续、像节目/视频/播客的声音应标为 device_playback；同时存在现场真人说话时标为 mixed。不得把媒体主播的观点、经历或自称归因给用户。`
    : "系统未检测到本机媒体播放；仍需只根据音频证据判断来源，无法确认时使用 unknown。";
  return `请直接分析音频，先忠实保留可听见的内容，不要在感知阶段做记忆判断或过早摘要。

根据音频场景自适应处理：
- environment：没有持续言语时，transcript 留空，environmentObservation 只写一条简短、直接可听见的环境观察。
- conversation：transcript 保留主要交流内容、关键原话、数字、时间、名称和决定；可省略纯口头填充，但不能改写事实。
- lecture / meeting / interview：transcript 写较完整的分说话人记录，保留数字、专有名词、例子、论点、论据、转折、结论和待办，不设统一字数限制，不要先压缩成摘要。

说话人使用 speaker_1、speaker_2 等稳定标签。只有音频中的明确自我介绍，或提供的可靠上下文，才可填写 displayName。不能凭声线、猜测或常识关联姓名。nameSource 只能是 unknown、user_statement、self_introduction、reliable_context；有姓名时必须提供 evidence 和 0..1 confidence，没有可靠姓名时 displayName 省略、nameSource=unknown。
sourceType 必须区分声音来源：live_environment 是现场真人/环境；device_playback 是本机视频、音乐、播客等播放声；mixed 是两者同时存在；unknown 是证据不足。设备播放内容可以被忠实转写，但必须保留“媒体中的说话者”语义，不能写成用户本人说过或认同。
只描述可直接听见的内容；不确定就明确写不确定。无法读取时只返回 ERROR_AUDIO_UNREADABLE，没有任何可用声音时返回空文本。
返回严格 JSON，不要 Markdown：
{"sceneType":"lecture","sourceType":"device_playback","transcript":"[speaker_1] ...\n[speaker_2] ...","environmentObservation":"...","speakers":[{"speakerId":"speaker_1","displayName":"...","nameSource":"self_introduction","confidence":0.95,"evidence":"说话者明确说‘我是...’"}]}

标签：${label}
录音来源上下文：${playbackContext}
${companionContext ? `当前陪伴上下文（只可作为可靠语义背景，不能用来猜姓名）：${companionContext}` : ""}`;
}

export function normalizeAudioSensingResult(raw: string): NormalizedAudioSensing {
  const trimmed = unwrapQuoted(raw.trim());
  if (!trimmed || /^["'“”‘’\s]+$/.test(trimmed)) return { text: "", unreadable: false };
  if (isUnreadable(trimmed)) return { text: "", unreadable: true };
  const structured = parseStructuredAudio(trimmed);
  if (structured) {
    const audioContent = normalizeAudioContent(structured);
    const text = audioContentForCognition(audioContent);
    if (!text || isEmptyAudioContent(text)) return { text: "", unreadable: false, audioContent };
    return { text, unreadable: false, audioContent };
  }
  if (isEmptyAudioContent(trimmed)) return { text: "", unreadable: false };
  const audioContent: AudioSensingContent = {
    sceneType: "unknown",
    sourceType: "unknown",
    transcript: trimmed.slice(0, MAX_TRANSCRIPT_CHARS),
    speakers: inferAnonymousSpeakerLabels(trimmed)
  };
  return { text: audioContent.transcript, unreadable: false, audioContent };
}

export function audioContentForCognition(content: AudioSensingContent) {
  const transcript = content.transcript.trim();
  const environment = content.environmentObservation?.trim();
  if (transcript && environment) return `${transcript}\n[环境声] ${environment}`;
  return transcript || environment || "";
}

function parseStructuredAudio(text: string) {
  const candidate = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!candidate.startsWith("{")) return undefined;
  try {
    const parsed = audioContentSchema.safeParse(JSON.parse(candidate));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAudioContent(input: z.infer<typeof audioContentSchema>): AudioSensingContent {
  const speakers = input.speakers.map((speaker) => normalizeSpeaker(speaker)).slice(0, 12);
  return {
    sceneType: input.sceneType,
    sourceType: input.sourceType,
    transcript: input.transcript.trim().slice(0, MAX_TRANSCRIPT_CHARS),
    environmentObservation: input.environmentObservation?.trim() || undefined,
    speakers
  };
}

function normalizeSpeaker(input: z.infer<typeof speakerSchema>): SpeakerIdentityEvidence {
  const nameAllowed = input.nameSource !== "unknown" && input.confidence >= 0.7 && Boolean(input.evidence?.trim());
  return {
    speakerId: input.speakerId as `speaker_${number}`,
    displayName: nameAllowed ? input.displayName : undefined,
    nameSource: (nameAllowed ? input.nameSource : "unknown") as SpeakerNameSource,
    confidence: nameAllowed ? input.confidence : Math.min(input.confidence, 0.69),
    evidence: nameAllowed ? input.evidence : undefined,
    sourceSegmentIds: []
  };
}

function inferAnonymousSpeakerLabels(transcript: string): SpeakerIdentityEvidence[] {
  const ids = [...new Set([...transcript.matchAll(/\b(speaker_[1-9]\d*)\b/g)].map((match) => match[1]))].slice(0, 12);
  return ids.map((speakerId) => ({
    speakerId: speakerId as `speaker_${number}`,
    nameSource: "unknown",
    confidence: 0,
    sourceSegmentIds: []
  }));
}

function isUnreadable(text: string) {
  return text === "ERROR_AUDIO_UNREADABLE" || /无法(获取|读取|处理|访问).{0,12}音频/.test(text);
}

function isEmptyAudioContent(text: string) {
  const normalized = text.replace(/\s+/g, "");
  return [
    /没有可用生活信息/,
    /没有可识别的说话内容/,
    /没有可识别.*生活事件/,
    /无可用生活信息/,
    /无声音内容/,
    /没有明显.*内容/,
    /未听到.*内容/,
    /听不清.*内容/
  ].some((pattern) => pattern.test(normalized));
}

function unwrapQuoted(text: string) {
  const quoted = text.match(/^["“](.*)["”]$/s) ?? text.match(/^['‘](.*)['’]$/s);
  return (quoted ? quoted[1] : text).trim();
}

function nullToUndefined(value: unknown) {
  return value === null || value === "" ? undefined : value;
}

function nullToEmpty(value: unknown) {
  return value === null || value === undefined ? "" : value;
}
