import {
  Brain,
  Check,
  CircleOff,
  Eye,
  History,
  ImagePlus,
  Lightbulb,
  MessageCircle,
  MessagesSquare,
  Mic,
  Plus,
  RefreshCcw,
  Save,
  Sparkles,
  Wand2,
  UserRound
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createContrastSummary } from "../core/demo";
import { normalizeSharedMemoryText } from "../core/memory";
import type {
  AttentionEvent,
  CaptureResult,
  CreatureProfile,
  CreatureState,
  EpisodeMemory,
  FeedbackRecord,
  FeedbackKind,
  SegmentKind,
  StreamSegment
} from "../core/types";
import {
  activeEmergence,
  buttonCapture,
  createProfile,
  curiousCapture,
  getProfile,
  getProvider,
  listProfiles,
  makeSegment,
  sendFeedback,
  summarizeImage,
  transcribeAudio,
  updateLongTermMemory,
  wakeProfile,
  type ProfileSummary,
  type ProviderInfo
} from "./api";

type Tab = "home" | "curious" | "chat" | "memory" | "brain" | "profile" | "demo";

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface DemoSummary {
  attention: string;
  feedback: string;
  contrast: string;
  emergence: string;
}

interface EmergenceSurface {
  text: string;
  memoryId?: string;
  whyNow?: string;
  driveSource?: string;
  ruleTrace?: string[];
}

type ConversationMessage = CreatureProfile["conversation"][number];
type ConversationSection =
  | { kind: "batch"; id: string; batchId: string; messages: ConversationMessage[] }
  | { kind: "single"; id: string; message: ConversationMessage };

const feedbacks: Array<{ kind: FeedbackKind; label: string; icon: typeof Check }> = [
  { kind: "understood", label: "这次懂了", icon: Check },
  { kind: "continue", label: "再想一会儿", icon: Lightbulb },
  { kind: "not_now", label: "先安静点", icon: CircleOff },
  { kind: "remember", label: "帮我记住", icon: Save },
  { kind: "forget", label: "帮我放下", icon: RefreshCcw }
];

const starterSegments: Array<{ kind: SegmentKind; label: string; content: string }> = [
  {
    kind: "text",
    label: "早晨记录",
    content: "今天早上只是匆匆吃了面包，没发生什么特别的事。"
  },
  {
    kind: "image_summary",
    label: "日历截图",
    content: "日历里标着周五 9:30 妈妈复查，旁边还有准备病历和医保卡的备注。"
  },
  {
    kind: "audio_transcript",
    label: "语音转写",
    content: "我有点担心自己又把妈妈复查这件事拖到睡前，明明它很重要。"
  }
];

const demoCuriousSegments: Array<{ kind: SegmentKind; label: string; content: string }> = [
  { kind: "text", label: "背景 1", content: "今天早餐吃了面包，路上有点堵。" },
  { kind: "image_summary", label: "日历截图", content: "周五 9:30 妈妈复查，备注写着提前准备病历、医保卡和上次检查单。" },
  { kind: "text", label: "隐私片段", content: "短信里有一个验证码 4921 和缴费链接，这段不应该被长期保存。" },
  { kind: "audio_transcript", label: "语音 1", content: "我有点担心自己又把妈妈复查这件事拖到最后，明明很重要。" },
  { kind: "image_summary", label: "购物截图", content: "购物车里有洗衣液、纸巾和一个水杯。" },
  { kind: "text", label: "朋友提醒", content: "朋友说我最近总是把重要家事压到睡前才处理，容易焦虑。" },
  { kind: "audio_transcript", label: "语音 2", content: "下周想提前一天提醒自己准备资料，不要又临时找东西。" },
  { kind: "text", label: "重复背景", content: "妈妈复查这件事刚才已经说过一次，这里只是重复提醒。" }
];

export function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [provider, setProvider] = useState<ProviderInfo>();
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [profile, setProfile] = useState<CreatureProfile>();
  const [segments, setSegments] = useState(
    starterSegments.map((segment, index) => makeSegment(`segment-${index + 1}`, segment.kind, segment.label, segment.content))
  );
  const [chatSegments, setChatSegments] = useState<StreamSegment[]>([]);
  const [lastResult, setLastResult] = useState<CaptureResult>();
  const [emergence, setEmergence] = useState<EmergenceSurface>();
  const [learningNote, setLearningNote] = useState<string>();
  const [lastFeedback, setLastFeedback] = useState<FeedbackRecord>();
  const [wakeMessage, setWakeMessage] = useState<string>();
  const [wakeThought, setWakeThought] = useState<string>();
  const [demoNote, setDemoNote] = useState<string>();
  const [demoSummary, setDemoSummary] = useState<DemoSummary>();
  const [readPapoMessageId, setReadPapoMessageId] = useState<string>();
  const [listening, setListening] = useState(false);
  const [listeningElapsed, setListeningElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const audioFlushRef = useRef<Promise<void>>(Promise.resolve());
  const transcriptBufferRef = useRef("");
  const segmentIndexRef = useRef(1);
  const listeningStartedAtRef = useRef<number | undefined>(undefined);
  const tickTimerRef = useRef<number | undefined>(undefined);
  const segmentTimerRef = useRef<number | undefined>(undefined);
  const stopTimerRef = useRef<number | undefined>(undefined);

  const selectedEpisode = lastResult?.episodes[0] ?? profile?.episodes[0];
  const latestPapoMessage = useMemo(
    () => profile?.conversation?.find((message) => message.role === "papo" && message.channel !== "wake"),
    [profile?.conversation]
  );
  const hasUnreadPapoMessage = Boolean(latestPapoMessage && latestPapoMessage.id !== readPapoMessageId);

  useEffect(() => {
    void bootstrap();
    return () => stopListening();
  }, []);

  useEffect(() => {
    if (tab === "chat" && latestPapoMessage) setReadPapoMessageId(latestPapoMessage.id);
  }, [latestPapoMessage?.id, tab]);

  async function bootstrap() {
    try {
      setBusy(true);
      const [providerInfo, existingProfiles] = await Promise.all([getProvider(), listProfiles()]);
      setProvider(providerInfo);
      let nextProfiles = existingProfiles;
      let active = existingProfiles[0] ? await getProfile(existingProfiles[0].userId) : undefined;
      if (!active) {
        active = await createProfile("Papo");
        nextProfiles = await listProfiles();
      }
      const woke = await wakeProfile(active.userId);
      setProfiles(nextProfiles);
      setProfile(woke.profile);
      setWakeMessage(woke.wake.message);
      setWakeThought(woke.wake.innerThought);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function selectProfile(userId: string) {
    const active = await getProfile(userId);
    const woke = await wakeProfile(active.userId);
    setProfile(woke.profile);
    setWakeMessage(woke.wake.message);
    setWakeThought(woke.wake.innerThought);
    setTab("home");
  }

  async function addProfile() {
    const name = `Papo ${profiles.length + 1}`;
    const next = await createProfile(name);
    setProfiles(await listProfiles());
    const woke = await wakeProfile(next.userId);
    setProfile(woke.profile);
    setWakeMessage(woke.wake.message);
    setWakeThought(woke.wake.innerThought);
  }

  async function submitTextCapture(text: string, nextTab: Tab = "chat") {
    const cleanText = text.trim();
    if (!profile || !cleanText) return;
    await run(async () => {
      const result = await buttonCapture(profile.userId, cleanText);
      setLastResult(result);
      setProfile(result.profile);
      setLearningNote(undefined);
      setTab(nextTab);
    });
  }

  async function submitChatMoment(text: string) {
    const cleanText = text.trim();
    if (!profile) return;
    if (!chatSegments.length) {
      await submitTextCapture(cleanText, "chat");
      return;
    }
    await run(async () => {
      const batchId = chatSegments[0]?.batchId ?? currentBatchId();
      const textSegment = cleanText
        ? [makeSegment(`chat-text-${Date.now()}`, "text", "你刚说的话", cleanText, { observedAt: new Date().toISOString(), batchId })]
        : [];
      const result = await curiousCapture(
        profile.userId,
        [...textSegment, ...chatSegments].filter((segment) => segment.content.trim()).map((segment, index) => ensureSegmentContext(segment, index))
      );
      setChatSegments([]);
      setLastResult(result);
      setProfile(result.profile);
      setLearningNote(undefined);
      setTab("chat");
    });
  }

  async function submitCurious() {
    if (!profile) return;
    await run(async () => {
      const result = await curiousCapture(
        profile.userId,
        segments.filter((segment) => segment.content.trim()).map((segment, index) => ensureSegmentContext(segment, index))
      );
      setLastResult(result);
      setProfile(result.profile);
      setLearningNote(undefined);
      setTab("home");
    });
  }

  async function uploadChatImageSummary(file?: File) {
    if (!file) return;
    await run(async () => {
      const observedAt = file.lastModified ? new Date(file.lastModified).toISOString() : new Date().toISOString();
      const location = await currentLocationSnapshot();
      const dataUrl = await readFileAsDataUrl(file);
      const result = await summarizeImage(dataUrl, file.name || "对话照片");
      const content = sensingSegmentContent(result.summary, result.error);
      setChatSegments((current) => [
        ...current,
        makeSegment(`chat-image-${Date.now()}`, "image_summary", file.name || `照片 ${current.length + 1}`, content, {
          observedAt,
          batchId: current[0]?.batchId ?? currentBatchId(),
          location
        })
      ]);
      setDemoNote(result.error ? "照片先留在这一小段里，等你补一句我再一起听。" : result.semanticSource === "llm" ? "照片已经变成一段可改准的小片段，会和这半分钟里的话一起给我听。" : "照片先放进这一小段，对话提交时会一起给我听。");
      setTab("chat");
    });
  }

  async function uploadChatAudioTranscript(file?: File) {
    if (!file) return;
    await run(async () => {
      const dataUrl = await readFileAsDataUrl(file);
      const result = await transcribeAudio(dataUrl, file.name || "对话录音");
      const content = sensingSegmentContent(result.transcript, result.error);
      setChatSegments((current) => [
        ...current,
        makeSegment(`chat-audio-${Date.now()}`, "audio_transcript", file.name || `录音 ${current.length + 1}`, content, {
          observedAt: new Date().toISOString(),
          batchId: current[0]?.batchId ?? currentBatchId()
        })
      ]);
      setDemoNote(result.error ? "录音先留在这一小段里，等你补一句我再一起听。" : result.semanticSource === "llm" ? "录音已经变成一段可改准的小片段，会和这半分钟里的话一起给我听。" : "录音先放进这一小段，对话提交时会一起给我听。");
      setTab("chat");
    });
  }

  async function uploadImageSummary(file?: File) {
    if (!file) return;
    await run(async () => {
      const observedAt = file.lastModified ? new Date(file.lastModified).toISOString() : new Date().toISOString();
      const location = await currentLocationSnapshot();
      const dataUrl = await readFileAsDataUrl(file);
      const result = await summarizeImage(dataUrl, file.name || "上传照片");
      const content = sensingSegmentContent(result.summary, result.error);
      setSegments((current) => [
        ...current,
        makeSegment(`image-${Date.now()}`, "image_summary", file.name || `照片 ${current.length + 1}`, content, {
          observedAt,
          batchId: currentBatchId(),
          location
        })
      ]);
      setDemoNote(result.error ? "照片已经留在这一小段里，先补一句再给我看。" : result.semanticSource === "llm" ? "我已经把照片看成一段可改准的小片段，并记下可用的时间和地点。" : "照片已经进入这一小段，你可以先改准再给我看。");
      setTab("curious");
    });
  }

  async function uploadAudioTranscript(file?: File) {
    if (!file) return;
    await run(async () => {
      const dataUrl = await readFileAsDataUrl(file);
      const result = await transcribeAudio(dataUrl, file.name || "上传录音");
      const content = sensingSegmentContent(result.transcript, result.error);
      setSegments((current) => [
        ...current,
        makeSegment(`audio-${Date.now()}`, "audio_transcript", file.name || `录音 ${current.length + 1}`, content, {
          observedAt: new Date().toISOString(),
          batchId: currentBatchId()
        })
      ]);
      setDemoNote(result.error ? "录音已经留在这一小段里，先补一句再给我听。" : result.semanticSource === "llm" ? "我已经把录音听成一段可改准的小片段。" : "录音已经进入这一小段，你可以先改准再给我听。");
      setTab("curious");
    });
  }

  async function giveFeedback(kind: FeedbackKind, targetId?: string, content?: string, modality: "text" | "audio_transcript" | "button" = content ? "text" : "button") {
    if (!profile) return;
    await run(async () => {
      const { profile: next, feedback } = await sendFeedback(profile.userId, kind, targetId, { content, modality });
      setProfile(next);
      setLearningNote(feedback.replyText ?? feedback.learningNote);
      setLastFeedback(feedback);
      setLastResult((current) => (current ? { ...current, profile: next } : current));
    });
  }

  async function transcribeFeedbackAudio(file: File) {
    setBusy(true);
    setError(undefined);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const result = await transcribeAudio(dataUrl, file.name || "反馈录音");
      return result.transcript;
    } catch (caught) {
      setError(errorMessage(caught));
      return "";
    } finally {
      setBusy(false);
    }
  }

  async function editLongTermMemory(memoryId: string, text: string) {
    if (!profile) return;
    await run(async () => {
      const next = await updateLongTermMemory(profile.userId, memoryId, text);
      setProfile(next);
    });
  }

  async function askEmergence() {
    if (!profile) return;
    await run(async () => {
      const result = await activeEmergence(profile.userId);
      setProfile(result.profile);
      setEmergence(result.emergence);
      setTab("home");
    });
  }

  async function startListening() {
    if (listening) return;
    const Recognition = getSpeechRecognition();
    const Recorder = getMediaRecorder();
    if (!Recorder && !Recognition) {
      setError("当前浏览器不支持录音或实时语音转写。可以继续用文字或手动粘贴录音转写。");
      return;
    }

    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices?.getUserMedia?.({ audio: true });
    } catch {
      setError("我还听不到麦克风。你可以先写一小段给 Papo，或者手动加一段录音。");
      return;
    }
    if (!stream) {
      setError("我还没有听到可用的麦克风声音。你可以先写一小段给 Papo，或者手动加一段录音。");
      return;
    }

    mediaStreamRef.current = stream;
    recordedChunksRef.current = [];
    transcriptBufferRef.current = "";
    segmentIndexRef.current = 1;
    listeningStartedAtRef.current = Date.now();
    setListeningElapsed(0);
    setListening(true);
    setError(undefined);

    if (Recorder) {
      try {
        const mimeType = preferredAudioMimeType(Recorder);
        const recorder = new Recorder(stream, mimeType ? { mimeType } : undefined);
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) recordedChunksRef.current.push(event.data);
        };
        recorder.onerror = () => {
          setError("这次听到一半断开了。已经整理出来的小片段会继续留在这里。");
        };
        mediaRecorderRef.current = recorder;
        recorder.start();
      } catch {
        if (!Recognition) {
          stopMediaCapture();
          setListening(false);
          listeningStartedAtRef.current = undefined;
          setError("这个浏览器暂时没法让 Papo 连续听。你可以先写给它，或者手动加一段录音。");
          return;
        }
      }
    }

    if (Recognition) {
      const recognition = new Recognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "zh-CN";
      recognition.onresult = (event) => {
        let finalText = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (result.isFinal) finalText += result[0].transcript;
        }
        if (finalText.trim()) transcriptBufferRef.current = `${transcriptBufferRef.current} ${finalText.trim()}`.trim();
      };
      recognition.onerror = (event) => {
        if (!mediaRecorderRef.current) setError(`语音监听中断：${event.error ?? "未知错误"}`);
      };
      recognition.onend = () => {
        if (listeningStartedAtRef.current) {
          try {
            recognition.start();
          } catch {
            // Some browsers throw if restart happens too quickly.
          }
        }
      };
      recognitionRef.current = recognition;
      recognition.start();
    }

    tickTimerRef.current = window.setInterval(() => {
      if (!listeningStartedAtRef.current) return;
      setListeningElapsed(Math.min(180, Math.floor((Date.now() - listeningStartedAtRef.current) / 1000)));
    }, 1000);
    segmentTimerRef.current = window.setInterval(() => {
      void queueAudioTranscriptSegment(false);
    }, 30_000);
    stopTimerRef.current = window.setTimeout(() => stopListening(), 180_000);
  }

  function stopListening() {
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    if (tickTimerRef.current) window.clearInterval(tickTimerRef.current);
    if (segmentTimerRef.current) window.clearInterval(segmentTimerRef.current);
    if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
    tickTimerRef.current = undefined;
    segmentTimerRef.current = undefined;
    stopTimerRef.current = undefined;
    listeningStartedAtRef.current = undefined;
    setListening(false);
    void queueAudioTranscriptSegment(true).finally(() => stopMediaCapture());
  }

  function queueAudioTranscriptSegment(force: boolean) {
    audioFlushRef.current = audioFlushRef.current.then(() => flushAudioTranscriptSegment(force)).catch((caught) => {
      setError(errorMessage(caught));
    });
    return audioFlushRef.current;
  }

  async function flushAudioTranscriptSegment(force: boolean) {
    const localTranscript = transcriptBufferRef.current.trim();
    transcriptBufferRef.current = "";
    const chunks = await takeRecordedAudioChunks();
    if (!chunks.length && !localTranscript && !force) return;
    if (!chunks.length && !localTranscript) return;
    const index = segmentIndexRef.current;
    segmentIndexRef.current += 1;

    let content = localTranscript;
    if (chunks.length) {
      const blob = new Blob(chunks, { type: mediaRecorderRef.current?.mimeType || chunks[0]?.type || "audio/webm" });
      if (blob.size > 0) {
        try {
          const dataUrl = await blobToDataUrl(blob);
          const result = await transcribeAudio(dataUrl, `语音片段 ${index}`);
          content = chooseAudioTranscript(result.transcript, localTranscript, Boolean(result.error));
        } catch (caught) {
          content = localTranscript;
          if (!content) setError(`第 ${index} 段声音没听清。你可以手动补一小段给我。${errorMessage(caught)}`);
        }
      }
    }

    if (!content.trim()) return;
    setSegments((current) => [
      ...current,
      makeSegment(`live-audio-${Date.now()}-${index}`, "audio_transcript", `语音片段 ${index}`, content.trim(), {
        observedAt: new Date().toISOString(),
        batchId: batchIdForSegment(index)
      })
    ]);
  }

  function ensureSegmentContext(segment: StreamSegment, index: number): StreamSegment {
    return {
      ...segment,
      position: segment.position ?? index + 1,
      observedAt: segment.observedAt ?? new Date().toISOString(),
      batchId: segment.batchId ?? currentBatchId()
    };
  }

  function currentBatchId(nowMs = Date.now()) {
    const startedAt = listeningStartedAtRef.current;
    if (!startedAt) return manualBatchId(nowMs);
    const index = Math.max(1, Math.floor((nowMs - startedAt) / 30_000) + 1);
    return liveBatchId(startedAt, index);
  }

  function batchIdForSegment(index: number) {
    const startedAt = listeningStartedAtRef.current;
    return startedAt ? liveBatchId(startedAt, index) : manualBatchId();
  }

  async function takeRecordedAudioChunks() {
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === "recording") {
      try {
        recorder.requestData();
        await delay(180);
      } catch {
        // Keep any chunks already emitted.
      }
    }
    const chunks = recordedChunksRef.current;
    recordedChunksRef.current = [];
    return chunks;
  }

  function stopMediaCapture() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // Recorder may already be stopped by the browser.
      }
    }
    mediaRecorderRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }

  function loadDemoCurious() {
    setSegments(demoCuriousSegments.map((segment, index) => makeSegment(`demo-${index + 1}`, segment.kind, segment.label, segment.content)));
    setDemoNote("我把 8 段日常小片段放到 Papo 面前了：有背景、有日历、有隐私味道、有声音，也有重复。现在可以让它自己挑出真正想看的地方。");
    setDemoSummary(undefined);
    setTab("curious");
  }

  async function runGuidedDemo() {
    await run(async () => {
      const main = await createProfile("Papo 小团");
      const curiousResult = await curiousCapture(
        main.userId,
        demoCuriousSegments.map((segment, index) => makeSegment(`guided-${index + 1}`, segment.kind, segment.label, segment.content))
      );
      const targetEpisode = curiousResult.episodes[0];
      let learned = "";
      if (targetEpisode) {
        await sendFeedback(main.userId, "remember", targetEpisode.id);
        learned = (await sendFeedback(main.userId, "continue", targetEpisode.id)).feedback.learningNote;
      }
      const emerged = await activeEmergence(main.userId);

      const input = "我有点担心自己又把妈妈复查这件事拖到睡前，明明它很重要。";
      const deep = await createProfile("Papo 小想");
      const quiet = await createProfile("Papo 小静");
      const deepFirst = await buttonCapture(deep.userId, input);
      const quietFirst = await buttonCapture(quiet.userId, input);
      for (let index = 0; index < 3; index += 1) {
        await sendFeedback(deep.userId, "continue", deepFirst.episodes[0]?.id);
        await sendFeedback(quiet.userId, "not_now", quietFirst.episodes[0]?.id);
      }
      const deepResult = await buttonCapture(deep.userId, input);
      const quietResult = await buttonCapture(quiet.userId, input);
      const contrast = createContrastSummary({
        deepProfile: deepResult.profile,
        quietProfile: quietResult.profile,
        deepResult,
        quietResult
      });

      setProfiles(await listProfiles());
      setProfile(emerged.profile);
      setLastResult({ ...curiousResult, profile: emerged.profile });
      setLearningNote(learned);
      setEmergence(emerged.emergence);
      setDemoSummary({
        attention: `它看了 ${curiousResult.curiousSession?.totalSegments ?? demoCuriousSegments.length} 段，只认真注意到 ${curiousResult.events.length} 段。`,
        feedback: learned || "它已经听见“帮我记住”和“再想一会儿”，正在把这点养进后面的回应里。",
        contrast,
        emergence: emerged.emergence.text
      });
      setDemoNote("这只 Papo 已经走完一圈：先注意生活片段，再被你反馈养成，然后自己想起一条旧记忆。");
      setTab("demo");
    });
  }

  async function runDemoContrast() {
    await run(async () => {
      const input = "我有点担心自己又把妈妈复查这件事拖到睡前，明明它很重要。";
      const a = await createProfile("Papo 小想");
      const b = await createProfile("Papo 小静");
      const aFirst = await buttonCapture(a.userId, input);
      const bFirst = await buttonCapture(b.userId, input);
      let aProfile = aFirst.profile;
      let bProfile = bFirst.profile;
      for (let i = 0; i < 3; i += 1) {
        aProfile = (await sendFeedback(a.userId, "continue", aFirst.episodes[0].id)).profile;
        bProfile = (await sendFeedback(b.userId, "not_now", bFirst.episodes[0].id)).profile;
      }
      const aResult = await buttonCapture(a.userId, input);
      const bResult = await buttonCapture(b.userId, input);
      const contrast = createContrastSummary({
        deepProfile: aResult.profile,
        quietProfile: bResult.profile,
        deepResult: aResult,
        quietResult: bResult
      });
      setProfiles(await listProfiles());
      setProfile(aResult.profile);
      setLastResult(aResult);
      setLearningNote(contrast);
      setDemoNote(`${aProfile.creatureName} 和 ${bProfile.creatureName} 刚被不同反馈养了一小会儿。${contrast}`);
      setTab("home");
    });
  }

  async function run(action: () => Promise<void>) {
    try {
      setBusy(true);
      setError(undefined);
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!profile) {
    return (
      <main className="shell loading">
        <ShibaAvatar idle />
        <p>{busy ? "Papo 正在醒来" : error ?? "无法载入小动物"}</p>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <button className="icon-button" onClick={() => setTab("profile")} aria-label="看看哪只 Papo 在身边">
          <UserRound size={19} />
        </button>
        <div>
          <p className="eyebrow">住在手机里的小狗</p>
          <h1>{profile.creatureName}</h1>
          <p className="eyebrow">正在陪你攒小片段</p>
        </div>
        <button className="icon-button" onClick={askEmergence} disabled={busy} aria-label="问问 Papo 现在想到什么">
          <Sparkles size={19} />
        </button>
      </header>

      {error ? <div className="notice">{error}</div> : null}

      {tab === "home" ? (
        <HomeView
          profile={profile}
          lastResult={lastResult}
          selectedEpisode={selectedEpisode}
          emergence={emergence}
          learningNote={learningNote}
          lastFeedback={lastFeedback}
          wakeMessage={wakeMessage}
          wakeThought={wakeThought}
          busy={busy}
          onFeedback={giveFeedback}
          onTranscribeFeedbackAudio={transcribeFeedbackAudio}
          onGoCapture={() => setTab("chat")}
          onGoCurious={() => setTab("curious")}
        />
      ) : null}

      {tab === "curious" ? (
        <CuriousView
          segments={segments}
          setSegments={setSegments}
          onSubmit={submitCurious}
          busy={busy}
          listening={listening}
          listeningElapsed={listeningElapsed}
          onUploadImage={uploadImageSummary}
          onUploadAudio={uploadAudioTranscript}
          onStartListening={startListening}
          onStopListening={stopListening}
        />
      ) : null}

      {tab === "chat" ? (
        <ChatView
          profile={profile}
          busy={busy}
          stagedSegments={chatSegments}
          onChangeStagedSegments={setChatSegments}
          onSubmitMoment={submitChatMoment}
          onUploadImage={uploadChatImageSummary}
          onUploadAudio={uploadChatAudioTranscript}
        />
      ) : null}
      {tab === "memory" ? <MemoryView profile={profile} onFeedback={giveFeedback} onTranscribeFeedbackAudio={transcribeFeedbackAudio} onEditMemory={editLongTermMemory} /> : null}
      {tab === "brain" ? <BrainView profile={profile} provider={provider} /> : null}
      {tab === "profile" ? <ProfileView profiles={profiles} activeId={profile.userId} onSelect={selectProfile} onAdd={addProfile} /> : null}
      {tab === "demo" ? (
        <DemoView
          onRunGuided={runGuidedDemo}
          onLoadCurious={loadDemoCurious}
          onRunContrast={runDemoContrast}
          onEmerge={askEmergence}
          note={demoNote}
          summary={demoSummary}
          busy={busy}
        />
      ) : null}

      <nav className="nav">
        <NavButton active={tab === "home"} icon={Eye} label="首页" onClick={() => setTab("home")} />
        <NavButton active={tab === "chat"} icon={MessagesSquare} label="对话" unread={hasUnreadPapoMessage} onClick={() => setTab("chat")} />
        <NavButton active={tab === "curious"} icon={Sparkles} label="陪我" onClick={() => setTab("curious")} />
        <NavButton active={tab === "memory"} icon={History} label="记忆" onClick={() => setTab("memory")} />
        <NavButton active={tab === "brain"} icon={Brain} label="脑态" onClick={() => setTab("brain")} />
        <NavButton active={tab === "demo"} icon={Wand2} label="演示" onClick={() => setTab("demo")} />
      </nav>
    </main>
  );
}

function HomeView(props: {
  profile: CreatureProfile;
  lastResult?: CaptureResult;
  selectedEpisode?: EpisodeMemory;
  emergence?: EmergenceSurface;
  learningNote?: string;
  lastFeedback?: FeedbackRecord;
  wakeMessage?: string;
  wakeThought?: string;
  busy: boolean;
  onFeedback: (kind: FeedbackKind, targetId?: string, content?: string, modality?: "text" | "audio_transcript" | "button") => void;
  onTranscribeFeedbackAudio: (file: File) => Promise<string>;
  onGoCapture: () => void;
  onGoCurious: () => void;
}) {
  return (
    <section className="stack">
      <div className="hero">
        <ShibaAvatar state={props.profile.state} />
        <div className="hero-copy">
          <p className="eyebrow">Papo 现在</p>
          <h2>{stateHeadline(props.profile)}</h2>
          <p>{stateSentence(props.profile)}</p>
          <div className="dog-state-cues">
            <span>{dogMotionText(props.profile.state)}</span>
            <span>{dogSenseText(props.profile.state)}</span>
          </div>
        </div>
      </div>

      <div className="action-row">
        <button onClick={props.onGoCapture}>
          <MessageCircle size={18} />
          跟 Papo 说
        </button>
        <button onClick={props.onGoCurious}>
          <Sparkles size={18} />
          陪我一会儿
        </button>
      </div>

      {props.wakeMessage ? (
        <section className="wake-note">
          <span>Papo 抬头看了你一眼</span>
          <p>{props.wakeMessage}</p>
          {props.wakeThought ? <p>{props.wakeThought}</p> : null}
        </section>
      ) : null}
      {props.emergence ? <EmergenceCard emergence={props.emergence} /> : null}
      {props.learningNote ? <section className="learning-note">{props.learningNote}</section> : null}
      {props.lastFeedback ? <FeedbackImpactCard feedback={props.lastFeedback} /> : null}

      <BodySignals state={props.profile.state} />
      <RaisedShape profile={props.profile} />

      {props.lastResult ? (
        <section className="panel">
          <PanelTitle icon={Eye} title="刚才我竖起耳朵的地方" />
          <p className="response">{props.lastResult.response}</p>
          {props.lastResult.curiousSession ? (
            <div className="session-audit">
              <p>{props.lastResult.curiousSession.creatureReport}</p>
              {props.lastResult.curiousSession.ignored.slice(0, 4).map((item) => (
                <small key={item.segmentId}>
                  我先放过了 {item.label}：{item.whyIgnored}
                </small>
              ))}
            </div>
          ) : null}
          <div className="event-list">
            {props.lastResult.events.map((event) => (
              <AttentionCard key={event.id} event={event} />
            ))}
          </div>
        </section>
      ) : null}

      {props.selectedEpisode ? (
        <div className="home-episode-slot">
          <EpisodeCard
            episode={props.selectedEpisode}
            sourceMessages={episodeSourceMessages(props.profile, props.selectedEpisode)}
            onFeedback={props.onFeedback}
            onTranscribeFeedbackAudio={props.onTranscribeFeedbackAudio}
            compact={false}
          />
        </div>
      ) : null}
    </section>
  );
}

function ShibaAvatar({ state, idle = false }: { state?: CreatureState; idle?: boolean }) {
  const mood = state?.mood ?? "calm";
  const className = [
    "shiba",
    `shiba-${mood}`,
    idle ? "idle" : "",
    state && state.curiosity > 72 ? "is-alert" : "",
    state && state.attachment > 68 ? "is-attached" : "",
    state && state.energy < 35 ? "is-tired" : "",
    state && state.safety > 74 ? "is-careful" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className} aria-label="Papo 是一只卡通柴犬">
      <svg className="shiba-svg" viewBox="0 0 160 150" role="img" aria-hidden="true">
        <g className="shiba-tail">
          <path className="shiba-tail-ring" d="M118 88c26-8 33-38 11-49-19-9-36 9-26 25 7 11 24 8 24-4" />
          <path className="shiba-tail-tip" d="M128 40c15 10 11 33-9 41" />
        </g>
        <g className="shiba-body">
          <path className="shiba-body-fur" d="M39 88c10-24 53-30 76-9 18 16 16 44-8 53-22 8-57 6-72-8-11-11-10-25 4-36Z" />
          <path className="shiba-chest" d="M59 91c9 9 31 9 40 0 7 15 1 32-20 33-20 1-29-16-20-33Z" />
          <ellipse className="shiba-paw left" cx="55" cy="128" rx="16" ry="9" />
          <ellipse className="shiba-paw right" cx="101" cy="128" rx="16" ry="9" />
          <path className="shiba-toes left" d="M49 128c2 3 6 3 8 0M58 128c2 3 6 3 8 0" />
          <path className="shiba-toes right" d="M95 128c2 3 6 3 8 0M104 128c2 3 6 3 8 0" />
        </g>
        <g className="shiba-head">
          <path className="shiba-ear left" d="M47 42 34 9c-2-6 4-11 10-7l25 25Z" />
          <path className="shiba-ear-inner left" d="M47 33 40 15l16 15Z" />
          <path className="shiba-ear right" d="M113 42 126 9c2-6-4-11-10-7L91 27Z" />
          <path className="shiba-ear-inner right" d="M113 33 120 15l-16 15Z" />
          <path className="shiba-head-fur" d="M35 59c0-27 20-44 45-44s45 17 45 44c0 29-20 50-45 50S35 88 35 59Z" />
          <path className="shiba-forehead" d="M70 23c5 7 15 7 20 0 4 16 0 31-10 38-10-7-14-22-10-38Z" />
          <path className="shiba-urajiro left" d="M43 65c0-18 11-32 27-36 2 20-6 39-21 50-4-3-6-8-6-14Z" />
          <path className="shiba-urajiro right" d="M117 65c0-18-11-32-27-36-2 20 6 39 21 50 4-3 6-8 6-14Z" />
          <ellipse className="shiba-brow left" cx="63" cy="50" rx="8" ry="4" />
          <ellipse className="shiba-brow right" cx="97" cy="50" rx="8" ry="4" />
          <ellipse className="shiba-eye left" cx="64" cy="62" rx="5.8" ry="7.2" />
          <ellipse className="shiba-eye right" cx="96" cy="62" rx="5.8" ry="7.2" />
          <circle className="shiba-eye-shine left" cx="62" cy="59" r="1.7" />
          <circle className="shiba-eye-shine right" cx="94" cy="59" r="1.7" />
          <ellipse className="shiba-cheek left" cx="49" cy="78" rx="9" ry="5.5" />
          <ellipse className="shiba-cheek right" cx="111" cy="78" rx="9" ry="5.5" />
          <path className="shiba-muzzle" d="M59 76c5-11 37-11 42 0 5 13-5 25-21 25S54 89 59 76Z" />
          <path className="shiba-nose" d="M72 76c2-5 14-5 16 0 1 5-3 8-8 8s-9-3-8-8Z" />
          <path className="shiba-mouth" d="M80 84c0 8-10 11-15 5M80 84c0 8 10 11 15 5" />
        </g>
      </svg>
    </div>
  );
}

function CuriousView(props: {
  segments: StreamSegment[];
  setSegments: (segments: StreamSegment[] | ((current: StreamSegment[]) => StreamSegment[])) => void;
  onSubmit: () => void;
  busy: boolean;
  listening: boolean;
  listeningElapsed: number;
  onUploadImage: (file?: File) => void;
  onUploadAudio: (file?: File) => void;
  onStartListening: () => void;
  onStopListening: () => void;
}) {
  function updateSegment(index: number, patch: Partial<StreamSegment>) {
    props.setSegments(props.segments.map((segment, current) => (current === index ? { ...segment, ...patch } : segment)));
  }

  function addSegment() {
    props.setSegments([
      ...props.segments,
      makeSegment(`segment-${Date.now()}`, "text", `片段 ${props.segments.length + 1}`, "")
    ]);
  }

  return (
    <section className="stack">
      <div className="panel">
        <PanelTitle icon={Sparkles} title="陪我看一小段世界" />
        <section className="listening-panel">
          <div>
            <strong>{props.listening ? "我正在听这一小段世界" : "陪我听一会儿"}</strong>
            <p>
              最多听 3 分钟，每 30 秒整理成一小段。原始声音不保存，只把可改准的小片段放进这次共同经历。
            </p>
          </div>
          <button onClick={props.listening ? props.onStopListening : props.onStartListening} disabled={props.busy}>
            <Sparkles size={18} />
            {props.listening ? `停止 ${formatListeningTime(props.listeningElapsed)}` : "开始听 3 分钟"}
          </button>
        </section>
        <label className="upload-button">
          <ImagePlus size={18} />
          加一张照片
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              props.onUploadImage(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
            disabled={props.busy}
          />
        </label>
        <label className="upload-button">
          <Mic size={18} />
          加一段录音
          <input
            type="file"
            accept="audio/webm,audio/wav,audio/mpeg,audio/mp3,audio/mp4,audio/m4a,audio/ogg"
            onChange={(event) => {
              props.onUploadAudio(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
            disabled={props.busy}
          />
        </label>
        {props.segments.map((segment, index) => (
          <div className="segment-editor" key={segment.id}>
            <div className="segment-row">
              <input value={segment.label} onChange={(event) => updateSegment(index, { label: event.target.value })} />
              <SegmentKindPicker value={segment.kind} onChange={(kind) => updateSegment(index, { kind })} />
            </div>
            <textarea value={segment.content} onChange={(event) => updateSegment(index, { content: event.target.value })} rows={4} />
          </div>
        ))}
        <div className="action-row">
          <button onClick={addSegment}>
            <Plus size={18} />
            加一小段
          </button>
          <button className="primary" onClick={props.onSubmit} disabled={props.busy}>
            <Eye size={18} />
            让 Papo 看看
          </button>
        </div>
      </div>
    </section>
  );
}

function ChatView(props: {
  profile: CreatureProfile;
  busy: boolean;
  stagedSegments: StreamSegment[];
  onChangeStagedSegments: (segments: StreamSegment[] | ((current: StreamSegment[]) => StreamSegment[])) => void;
  onSubmitMoment: (text: string) => Promise<void>;
  onUploadImage: (file?: File) => void;
  onUploadAudio: (file?: File) => void;
}) {
  const [draft, setDraft] = useState("");
  const messages = [...(props.profile.conversation ?? [])].slice(0, 50).reverse();
  const sections = groupConversationSections(messages);
  const inputCount = messages.filter((message) => message.role !== "papo").length;
  const papoCount = messages.filter((message) => message.role === "papo").length;
  const canSubmit = Boolean(draft.trim() || props.stagedSegments.some((segment) => segment.content.trim()));

  function updateStagedSegment(index: number, patch: Partial<StreamSegment>) {
    props.onChangeStagedSegments((current) => current.map((segment, currentIndex) => (currentIndex === index ? { ...segment, ...patch } : segment)));
  }

  function removeStagedSegment(index: number) {
    props.onChangeStagedSegments((current) => current.filter((_, currentIndex) => currentIndex !== index));
  }

  async function submitDraft() {
    const text = draft.trim();
    if (!text && !props.stagedSegments.length) return;
    setDraft("");
    await props.onSubmitMoment(text);
  }
  return (
    <section className="stack">
      <div className="panel">
        <PanelTitle icon={MessagesSquare} title="和 Papo 的小日常" />
        <div className="chat-composer">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            placeholder="直接告诉 Papo 一件刚发生的事"
          />
          <div className="composer-tools">
            <label className="upload-button compact-upload">
              <ImagePlus size={16} />
              加照片
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  props.onUploadImage(event.currentTarget.files?.[0]);
                  event.currentTarget.value = "";
                }}
                disabled={props.busy}
              />
            </label>
            <label className="upload-button compact-upload">
              <Mic size={16} />
              加录音
              <input
                type="file"
                accept="audio/webm,audio/wav,audio/mpeg,audio/mp3,audio/mp4,audio/m4a,audio/ogg"
                onChange={(event) => {
                  props.onUploadAudio(event.currentTarget.files?.[0]);
                  event.currentTarget.value = "";
                }}
                disabled={props.busy}
              />
            </label>
            <button className="primary" onClick={submitDraft} disabled={props.busy || !canSubmit}>
              <MessageCircle size={18} />
              {props.stagedSegments.length ? "让 Papo 听听" : "说给 Papo"}
            </button>
          </div>
          {props.stagedSegments.length ? (
            <section className="staged-moment">
              <strong>准备一起给我听的这一小段</strong>
              {props.stagedSegments.map((segment, index) => (
                <article className="staged-segment" key={segment.id}>
                  <div className="segment-row">
                    <input value={segment.label} onChange={(event) => updateStagedSegment(index, { label: event.target.value })} />
                    <SegmentKindPicker value={segment.kind} onChange={(kind) => updateStagedSegment(index, { kind })} />
                  </div>
                  <textarea value={segment.content} onChange={(event) => updateStagedSegment(index, { content: event.target.value })} rows={3} />
                  <button onClick={() => removeStagedSegment(index)} disabled={props.busy}>
                    <RefreshCcw size={16} />
                    先不带这段
                  </button>
                </article>
              ))}
            </section>
          ) : null}
        </div>
        <div className="conversation-summary">
          <span>{inputCount} 条你递来的小片段</span>
          <span>{papoCount} 次 Papo 回应</span>
        </div>
        {messages.length ? (
          <div className="chat-list">
            {sections.map((section) =>
              section.kind === "batch" ? (
                <section className="chat-batch" key={section.id}>
                  <div className="chat-batch-head">
                    <strong>半分钟里的一小段</strong>
                    <span>
                      {section.messages.length} 条小片段
                    </span>
                  </div>
                  {section.messages.map((message) => (
                    <ChatBubble message={message} key={message.id} />
                  ))}
                </section>
              ) : (
                <ChatBubble message={section.message} key={section.id} />
              )
            )}
          </div>
        ) : (
          <p className="muted">还没有对话。等你给 Papo 文字、照片或声音，它的注意和回应会在这里连成一条时间线。</p>
        )}
      </div>
    </section>
  );
}

function SegmentKindPicker({ value, onChange }: { value: SegmentKind; onChange: (kind: SegmentKind) => void }) {
  const options: Array<{ kind: SegmentKind; label: string; icon: typeof MessageCircle }> = [
    { kind: "text", label: "文字", icon: MessageCircle },
    { kind: "image_summary", label: "照片", icon: ImagePlus },
    { kind: "audio_transcript", label: "录音", icon: Mic }
  ];
  return (
    <div className="segment-kind-picker" aria-label="这一小段的样子">
      {options.map((option) => (
        <button
          key={option.kind}
          type="button"
          className={value === option.kind ? "active" : ""}
          aria-pressed={value === option.kind}
          onClick={() => onChange(option.kind)}
        >
          <option.icon size={15} />
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ChatBubble({ message }: { message: ConversationMessage }) {
  const context = messageContextText(message);
  return (
    <article className={`chat-bubble ${message.role}`}>
      <div>
        <strong>{messageTitle(message)}</strong>
        <span>
          {context ? `${context} · ` : ""}{new Date(message.at).toLocaleString("zh-CN")}
        </span>
      </div>
      <p>{message.text}</p>
      {message.observedAt || message.location ? (
        <small>
          {[
            message.observedAt ? `观察 ${new Date(message.observedAt).toLocaleString("zh-CN")}` : "",
            message.location ? locationText(message.location) : ""
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
      ) : null}
    </article>
  );
}

function groupConversationSections(messages: ConversationMessage[]): ConversationSection[] {
  return messages.reduce<ConversationSection[]>((sections, message) => {
    if (message.role !== "papo" && message.batchId) {
      const previous = sections[sections.length - 1];
      if (previous?.kind === "batch" && previous.batchId === message.batchId) {
        previous.messages.push(message);
        return sections;
      }
      sections.push({ kind: "batch", id: `batch-${message.batchId}-${message.id}`, batchId: message.batchId, messages: [message] });
      return sections;
    }

    sections.push({ kind: "single", id: message.id, message });
    return sections;
  }, []);
}

function MemoryView(props: {
  profile: CreatureProfile;
  onFeedback: (kind: FeedbackKind, targetId?: string, content?: string, modality?: "text" | "audio_transcript" | "button") => void;
  onTranscribeFeedbackAudio: (file: File) => Promise<string>;
  onEditMemory: (memoryId: string, text: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState("");
  const memories = props.profile.longTermMemories.filter((memory) =>
    `${memory.text} ${memory.kind} ${memory.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase())
  );
  const selfMemories = memories.filter((memory) => memory.kind === "creature_self_memory");
  const otherMemories = memories.filter((memory) => memory.kind !== "creature_self_memory");

  return (
    <section className="stack">
      <div className="panel">
        <PanelTitle icon={History} title="我抱着的小事" />
        <p className="muted">我把和你一起遇见过的小事抱在这里。你教我记准的，我会慢慢记稳；该放下的，我也会松开。</p>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="找一找我抱着哪件小事" />
        {otherMemories.map((memory) => (
          <article className="memory-surface" key={memory.id}>
            {editingId === memory.id ? (
              <>
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} />
                <div className="memory-actions">
                  <button
                    className="primary"
                    onClick={() => {
                      props.onEditMemory(memory.id, draft);
                      setEditingId(undefined);
                    }}
                  >
                    <Save size={16} />
                    嗯，就这样记
                  </button>
                  <button onClick={() => setEditingId(undefined)}>先照旧抱着</button>
                </div>
              </>
            ) : (
              <p>{memoryCreatureLine(memory)}</p>
            )}
            <span>{memoryFeelingText(memory)}</span>
            {memory.consolidatedBecause ? <small>{memoryKeptBecauseText(memory.consolidatedBecause)}</small> : null}
            <div className="memory-actions">
              <button
                onClick={() => {
                  setEditingId(memory.id);
                  setDraft(memory.text);
                }}
              >
                <MessageCircle size={16} />
                教我记准
              </button>
            </div>
            <MemoryFeedbackBox
              memory={memory}
              onFeedback={props.onFeedback}
              onTranscribeFeedbackAudio={props.onTranscribeFeedbackAudio}
            />
          </article>
        ))}
        {otherMemories.length ? null : <p className="muted">我还没有真正记下一段和你的事。</p>}
      </div>
      <div className="panel">
        <PanelTitle icon={Brain} title="我身上长出的习惯" />
        {selfMemories.map((memory) => (
          <article className="memory-surface" key={memory.id}>
            <p>{memoryCreatureLine(memory)}</p>
            <span>{memoryFamiliarityText(memory.weight)}，我在一点点认识自己。</span>
          </article>
        ))}
        {selfMemories.length ? null : <p className="muted">我身上还没长出新的小习惯，等以后从你身边慢慢学。</p>}
      </div>
      <div className="panel">
        <PanelTitle icon={Eye} title="刚刚还热着的小事" />
        {props.profile.episodes.map((episode) => (
          <EpisodeCard
            key={episode.id}
            episode={episode}
            sourceMessages={episodeSourceMessages(props.profile, episode)}
            onFeedback={props.onFeedback}
            onTranscribeFeedbackAudio={props.onTranscribeFeedbackAudio}
            compact
          />
        ))}
      </div>
    </section>
  );
}

function MemoryFeedbackBox(props: {
  memory: CreatureProfile["longTermMemories"][number];
  onFeedback: (kind: FeedbackKind, targetId?: string, content?: string, modality?: "text" | "audio_transcript" | "button") => void;
  onTranscribeFeedbackAudio: (file: File) => Promise<string>;
}) {
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackModality, setFeedbackModality] = useState<"text" | "audio_transcript">("text");
  const actions: Array<{ kind: FeedbackKind; label: string; icon: typeof Check }> = [
    { kind: "continue", label: "再想一会儿", icon: Lightbulb },
    { kind: "not_now", label: "先安静点", icon: CircleOff },
    { kind: "remember", label: "帮我记稳", icon: Save },
    { kind: "forget", label: props.memory.weight <= 0 ? "这次彻底松开" : "帮我先放下", icon: RefreshCcw }
  ];

  function submit(kind: FeedbackKind) {
    const content = feedbackText.trim();
    props.onFeedback(kind, props.memory.id, content || undefined, content ? feedbackModality : "button");
    setFeedbackText("");
    setFeedbackModality("text");
  }

  return (
    <div className="feedback-input memory-feedback">
      <div className="feedback-teach">
        <strong>你想怎么教我想起它</strong>
        <span>你补的话会跟这段一起进到我心里；我会据此多想、安静、记稳或放下。</span>
      </div>
      <textarea
        value={feedbackText}
        onChange={(event) => {
          setFeedbackText(event.target.value);
          setFeedbackModality("text");
        }}
        rows={2}
        placeholder="告诉我：这件事哪里要记准、放轻，或下次怎么回应"
      />
      <label className="upload-button compact-upload">
        <Mic size={16} />
        说给我听
        <input
          type="file"
          accept="audio/webm,audio/wav,audio/mpeg,audio/mp3,audio/mp4,audio/m4a,audio/ogg"
          onChange={async (event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            const transcript = await props.onTranscribeFeedbackAudio(file);
            if (transcript.trim()) {
              setFeedbackText(transcript.trim());
              setFeedbackModality("audio_transcript");
            }
          }}
        />
      </label>
      <div className="feedback-row">
        {actions.map((item) => (
          <button key={item.kind} onClick={() => submit(item.kind)} aria-label={item.label}>
            <item.icon size={16} />
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function BrainView({ profile, provider }: { profile: CreatureProfile; provider?: ProviderInfo }) {
  const latestEpisode = profile.episodes[0];
  const latestEmergence = profile.emergenceHistory?.[0];
  const semanticRuns = profile.semanticBrainHistory ?? [];
  return (
    <section className="stack">
      <StateGrid state={profile.state} />
      <div className="panel">
        <PanelTitle icon={Brain} title="模型路由" />
        {provider ? (
          <div className="state-grid">
            {providerRouteRows(provider).map((row) => (
              <div className="state-item" key={row.label}>
                <div>
                  <span>{row.label}</span>
                  <strong>{row.value}</strong>
                </div>
                <small>{row.detail}</small>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">还没有模型路由信息。</p>
        )}
      </div>
      <div className="panel">
        <PanelTitle icon={Brain} title="语义脑诊断" />
        {semanticRuns.length ? (
          semanticRuns.slice(0, 5).map((run) => (
            <article className="change-row" key={run.id}>
              <p>{semanticStatusText(run.status)}：{run.message}</p>
              <span>{run.providerName} · {run.source} · {new Date(run.at).toLocaleString("zh-CN")}</span>
            </article>
          ))
        ) : (
          <p className="muted">还没有语义脑运行记录。</p>
        )}
      </div>
      <div className="panel">
        <PanelTitle icon={Brain} title="反馈策略" />
        <div className="state-grid">
          {Object.entries(profile.policyProfile ?? {}).map(([key, value]) => (
            <div className="state-item" key={key}>
              <div>
                <span>{policyLabel(key)}</span>
                <strong>{value}</strong>
              </div>
              <meter min={0} max={100} value={Number(value)} />
            </div>
          ))}
        </div>
      </div>
      <div className="panel">
        <PanelTitle icon={Eye} title="最近决策" />
        {latestEpisode?.actionDecision ? (
          <article className="change-row">
            <p>{actionText(latestEpisode.actionDecision.action)}：{latestEpisode.actionDecision.reason}</p>
            <span>{latestEpisode.actionDecision.ruleTrace.join(" -> ")}</span>
          </article>
        ) : (
          <p className="muted">还没有行动决策。</p>
        )}
      </div>
      <div className="panel">
        <PanelTitle icon={Sparkles} title="最近浮现" />
        {latestEmergence ? (
          <article className="change-row">
            <p>{latestEmergence.message}</p>
            <span>{latestEmergence.whyNow} · {latestEmergence.ruleTrace.join(" -> ")}</span>
          </article>
        ) : (
          <p className="muted">还没有主动浮现历史。</p>
        )}
      </div>
      <div className="panel">
        <PanelTitle icon={Save} title="记忆候选" />
        {(profile.memoryCandidates ?? []).slice(0, 5).map((candidate) => (
          <article className="change-row" key={candidate.id}>
            <p>{candidate.candidateText}</p>
            <span>{candidate.memoryKind} · {candidate.writePolicy} · confidence {candidate.confidence}</span>
          </article>
        ))}
      </div>
      <div className="panel">
        <PanelTitle icon={Brain} title="最近变化" />
        {profile.stateChanges.length ? (
          profile.stateChanges.map((change) => (
            <article className="change-row" key={`${change.at}-${change.reason}`}>
              <p>{change.reason}</p>
              <span>{new Date(change.at).toLocaleString("zh-CN")}</span>
            </article>
          ))
        ) : (
          <p className="muted">还没有反馈造成的状态变化。</p>
        )}
      </div>
      <div className="panel">
        <PanelTitle icon={Check} title="反馈历史" />
        {profile.feedbackHistory.map((feedback) => (
          <article className="change-row" key={feedback.id}>
            <p>{feedback.effect}</p>
            <span>{feedback.kind}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

function ProfileView(props: {
  profiles: ProfileSummary[];
  activeId: string;
  onSelect: (userId: string) => void;
  onAdd: () => void;
}) {
  return (
    <section className="panel">
      <PanelTitle icon={UserRound} title="哪只 Papo 在你身边" />
      <div className="profile-list">
        {props.profiles.map((profile) => (
          <button
            className={profile.userId === props.activeId ? "profile-pill active" : "profile-pill"}
            key={profile.userId}
            onClick={() => props.onSelect(profile.userId)}
          >
            <UserRound size={18} />
            <span>{profile.creatureName}</span>
          </button>
        ))}
      </div>
      <button className="primary" onClick={props.onAdd}>
        <Plus size={18} />
        再养一只 Papo
      </button>
    </section>
  );
}

function DemoView(props: {
  onRunGuided: () => void;
  onLoadCurious: () => void;
  onRunContrast: () => void;
  onEmerge: () => void;
  note?: string;
  summary?: DemoSummary;
  busy: boolean;
}) {
  return (
    <section className="stack">
      <div className="panel">
        <PanelTitle icon={Wand2} title="带 Papo 走一圈" />
        <p className="response">用几段日常小事，让 Papo 先竖起耳朵，再被你养成，最后自己想起旧片段。</p>
        {props.note ? <section className="learning-note">{props.note}</section> : null}
        {props.summary ? (
          <section className="demo-checklist">
            <p><Check size={16} /> {props.summary.attention}</p>
            <p><Check size={16} /> {props.summary.feedback}</p>
            <p><Check size={16} /> {props.summary.contrast}</p>
            <p><Check size={16} /> {props.summary.emergence}</p>
          </section>
        ) : null}
        <button className="primary" onClick={props.onRunGuided} disabled={props.busy}>
          <Wand2 size={18} />
          带 Papo 完整走一圈
        </button>
        <button onClick={props.onLoadCurious} disabled={props.busy}>
          <Sparkles size={18} />
          先递 8 段生活
        </button>
        <button onClick={props.onRunContrast} disabled={props.busy}>
          <UserRound size={18} />
          看两只 Papo 被养成不同样子
        </button>
        <button onClick={props.onEmerge} disabled={props.busy}>
          <Lightbulb size={18} />
          问问 Papo 想到什么
        </button>
      </div>
    </section>
  );
}

function AttentionCard({ event }: { event: AttentionEvent }) {
  return (
    <article className="attention-card">
      <div>
        <span>{event.triggerLabel}</span>
        <strong>{attentionStrengthText(event.attentionStrength)}</strong>
      </div>
      <p>{event.noticed}</p>
      <small>{event.creatureExperience.earReason}</small>
      <details className="brain-details">
        <summary>我刚才怎么理解</summary>
        <p>{event.creatureExperience.rememberedScene ?? "这次还没有强烈拉起旧片段。"}</p>
        <p>{event.creatureExperience.actionFeeling}</p>
        <p>{event.creatureExperience.saveFeeling}</p>
      </details>
      <footer>
        <span>{actionText(event.actionDecision.action)}</span>
        <span>{privacyFeelingText(event.privacyRisk)}</span>
      </footer>
    </article>
  );
}

function EpisodeCard(props: {
  episode: EpisodeMemory;
  sourceMessages?: ConversationMessage[];
  compact: boolean;
  onFeedback: (kind: FeedbackKind, targetId?: string, content?: string, modality?: "text" | "audio_transcript" | "button") => void;
  onTranscribeFeedbackAudio: (file: File) => Promise<string>;
}) {
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackModality, setFeedbackModality] = useState<"text" | "audio_transcript">("text");

  function submitFeedback(kind: FeedbackKind) {
    const content = feedbackText.trim();
    props.onFeedback(kind, props.episode.id, content || undefined, content ? feedbackModality : "button");
    setFeedbackText("");
    setFeedbackModality("text");
  }

  return (
    <article className="episode-card">
      <div className="episode-head">
        <span>{props.episode.source === "button" ? "你递给我的片段" : "我自己注意到的片段"}</span>
        <strong>{memoryFamiliarityText(props.episode.weight)}</strong>
      </div>
      <h3>{props.episode.creatureResponse || props.episode.noticed}</h3>
      {!props.compact ? (
        <div className="episode-experience">
          <p><strong>我刚才注意到：</strong>{noticedText(props.episode.noticed)}</p>
          <p><strong>我为什么注意：</strong>{props.episode.creatureExperience?.earReason ?? props.episode.importanceReason}</p>
          <p><strong>我想起了什么：</strong>{props.episode.creatureExperience?.rememberedScene ?? "这次还没有强烈拉起旧片段。"}</p>
          <p><strong>我猜你在做：</strong>{props.episode.possibleIntent}</p>
          <p><strong>我当时的状态：</strong>{episodeStateText(props.episode)}</p>
          <p><strong>我选择：</strong>{props.episode.creatureExperience?.actionFeeling ?? props.episode.actionDecision?.reason}</p>
          <p><strong>要不要长期记：</strong>{props.episode.creatureExperience?.saveFeeling ?? "先作为情景记忆，等你的反馈决定。"}</p>
        </div>
      ) : null}
      <EpisodeSourceMoment episode={props.episode} messages={props.sourceMessages ?? []} compact={props.compact} />
      <div className="feedback-input">
        <div className="feedback-teach">
          <strong>这一下你怎么养我</strong>
          <span>你补的一句话，也会被我当成反馈一起听进去。</span>
        </div>
        <textarea
          value={feedbackText}
          onChange={(event) => {
            setFeedbackText(event.target.value);
            setFeedbackModality("text");
          }}
          rows={props.compact ? 2 : 3}
          placeholder="也可以补一句：哪里懂对了、哪里先放下、要怎么记准"
        />
        <label className="upload-button compact-upload">
          <Mic size={16} />
          说给我听
          <input
            type="file"
            accept="audio/webm,audio/wav,audio/mpeg,audio/mp3,audio/mp4,audio/m4a,audio/ogg"
            onChange={async (event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!file) return;
              const transcript = await props.onTranscribeFeedbackAudio(file);
              if (transcript.trim()) {
                setFeedbackText(transcript.trim());
                setFeedbackModality("audio_transcript");
              }
            }}
          />
        </label>
      </div>
      <div className="feedback-row">
        {feedbacks.map((item) => (
          <button key={item.kind} onClick={() => submitFeedback(item.kind)} aria-label={item.label}>
            <item.icon size={16} />
            {item.label}
          </button>
        ))}
      </div>
    </article>
  );
}

function EpisodeSourceMoment({ episode, messages, compact }: { episode: EpisodeMemory; messages: ConversationMessage[]; compact: boolean }) {
  if (!messages.length && !episode.sourceBatchId && !episode.sourceObservedAt && !episode.sourceLocation) return null;
  const title = episode.sourceBatchId ? "来自半分钟里的一小段" : "来自当时你给我的片段";
  const momentParts = [
    episode.sourceObservedAt ? `那时 ${new Date(episode.sourceObservedAt).toLocaleString("zh-CN")}` : "",
    episode.sourceLocation ? locationText(episode.sourceLocation) : ""
  ].filter(Boolean);
  return (
    <div className={`episode-source ${compact ? "compact" : ""}`}>
      <strong>{title}</strong>
      {momentParts.length ? <small>{momentParts.join(" · ")}</small> : null}
      {!compact && messages.length ? (
        <div className="episode-source-list">
          {messages.map((message) => (
            <p key={message.id}>
              <span>{messageTitle(message)}</span>
              {message.text}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function episodeSourceMessages(profile: CreatureProfile, episode: EpisodeMemory) {
  const messages = profile.conversation ?? [];
  const matched = messages.filter((message) => {
    if (message.role === "papo") return false;
    if (episode.sourceBatchId && message.batchId === episode.sourceBatchId) return true;
    if (episode.sourceSegmentId && message.sourceId === episode.sourceSegmentId) return true;
    return false;
  });
  return matched.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

function episodeStateText(episode: EpisodeMemory) {
  const state = episode.stateSnapshot;
  const parts = [];
  if (state.curiosity > 70) parts.push("好奇心比较高，所以更容易被新主题吸引");
  if (state.attachment > 60) parts.push("依恋度较高，所以更愿意联想旧记忆");
  if (state.energy < 35) parts.push("精力偏低，所以会短一点回应");
  if (state.safety > 70) parts.push("安全感偏谨慎，所以不会急着保存隐私内容");
  return parts.length ? parts.join("；") : "状态稳定，适合认真观察这一段";
}

function noticedText(text: string) {
  return text
    .replace(/^我刚才注意到[:：]?\s*/, "")
    .replace(/^我注意到[:：]?\s*/, "")
    .replace(/^我听到[:：]?\s*/, "");
}

function EmergenceCard({ emergence }: { emergence: EmergenceSurface }) {
  return (
    <section className="memory-surface active">
      <strong>Papo 自己想起一点</strong>
      <p>{emergence.text}</p>
      {emergence.whyNow ? <small>我为什么这时想起：{emergence.whyNow}</small> : null}
      {emergence.driveSource ? <span>{emergenceDriveText(emergence.driveSource)}</span> : null}
    </section>
  );
}

function FeedbackImpactCard({ feedback }: { feedback: FeedbackRecord }) {
  const stateDeltas = feedback.stateDeltas ?? [];
  const policyDeltas = feedback.policyDeltas ?? [];
  const changes = feedbackChangeLines(stateDeltas, policyDeltas);
  if (!changes.length) return null;
  return (
    <section className="feedback-impact">
      <strong>我这一下变了一点</strong>
      {feedback.inputText ? <p>你刚才还告诉我：{feedback.inputText}</p> : null}
      <div>
        {changes.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
    </section>
  );
}

function StateGrid({ state }: { state: CreatureState }) {
  const rows = useMemo(
    () => [
      ["好奇心", state.curiosity],
      ["依恋度", state.attachment],
      ["精力", state.energy],
      ["唤醒度", state.arousal],
      ["安全感", state.safety],
      ["表达自信", state.confidence]
    ],
    [state]
  );
  return (
    <section className="state-grid">
      {rows.map(([label, value]) => (
        <div className="state-item" key={label}>
          <div>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
          <meter min={0} max={100} value={Number(value)} />
        </div>
      ))}
    </section>
  );
}

function BodySignals({ state }: { state: CreatureState }) {
  const signals = [
    ["耳朵", dogSenseText(state)],
    ["尾巴", dogMotionText(state)],
    ["小脑袋", mindSignalText(state)],
    ["边界", boundarySignalText(state)]
  ];
  return (
    <section className="body-signals" aria-label="Papo 的身体信号">
      {signals.map(([label, text]) => (
        <span key={label}>
          <strong>{label}</strong>
          {text}
        </span>
      ))}
    </section>
  );
}

function RaisedShape({ profile }: { profile: CreatureProfile }) {
  const lines = raisedShapeLines(profile);
  if (!lines.length) return null;
  return (
    <section className="raising-shape">
      <strong>我被你养成的样子</strong>
      <div>
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
    </section>
  );
}

function raisedShapeLines(profile: CreatureProfile) {
  const selfMemoryLines = profile.longTermMemories
    .filter((memory) => memory.kind === "creature_self_memory" && memory.tags.includes("被你养成") && memory.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .map((memory) => normalizeMemoryText(memory.text))
    .slice(0, 2);
  if (selfMemoryLines.length) return selfMemoryLines;

  const lines: string[] = [];
  const policy = profile.policyProfile;
  if (policy.preferDepth >= 55) lines.push("你把我养得更愿意多停一下，再把旧片段连起来。");
  if (policy.quietTendency >= 50) lines.push("你把我养得更会先安静陪着，不急着追问。");
  if (policy.privacySensitivity >= 65) lines.push("你把我养得更小心边界，保存前会多等你的意思。");
  if (policy.recallTendency >= 58 && lines.length < 2) lines.push("你把我养得更容易从旧记忆里想起相近的小事。");
  if (!lines.length) lines.push("我还在慢慢学你的偏好，等你教我哪些要多想，哪些先放下。");
  return lines.slice(0, 2);
}

function mindSignalText(state: CreatureState) {
  if (state.curiosity > 72) return "我会先找最让我在意的一小段";
  if (state.confidence > 62) return "我更敢把自己的理解说出来";
  if (state.energy < 35) return "我会先抱住重点，少说一点";
  return "先听，再决定要不要回应";
}

function boundarySignalText(state: CreatureState) {
  if (state.safety > 74) return "我会更小心处理隐私和保存";
  if (state.arousal > 64) return "对突然出现的动静更敏感";
  return "边界稳定，可以认真靠近";
}

function feedbackChangeLines(
  stateDeltas: NonNullable<FeedbackRecord["stateDeltas"]>,
  policyDeltas: NonNullable<FeedbackRecord["policyDeltas"]>
) {
  const lines: string[] = [];
  const state = new Map(stateDeltas.map((item) => [item.key, item.delta]));
  const policy = new Map(policyDeltas.map((item) => [item.key, item.delta]));

  if ((state.get("curiosity") ?? 0) > 0 || (policy.get("preferDepth") ?? 0) > 0) {
    lines.push("下次遇到相似的小片段，我会多停一下，愿意展开一点。");
  }
  if ((policy.get("recallTendency") ?? 0) > 0 || (state.get("attachment") ?? 0) > 0) {
    lines.push("我会更容易把这段和你们以前的小事连起来。");
  }
  if ((policy.get("quietTendency") ?? 0) > 0 || (state.get("arousal") ?? 0) < 0) {
    lines.push("我学会收小一点声音，不是每次竖起耳朵都打扰你。");
  }
  if ((policy.get("privacySensitivity") ?? 0) > 0 || (state.get("safety") ?? 0) > 0) {
    lines.push("我会更小心守住边界，保存前多等你的意思。");
  }
  if ((state.get("confidence") ?? 0) > 0) {
    lines.push("我会更敢把自己的理解轻轻说出来。");
  }
  if ((state.get("energy") ?? 0) < 0) {
    lines.push("我刚认真用过一点力，接下来会先抱住重点。");
  }
  return lines.length ? [...new Set(lines)] : ["我已经把你的反馈放进后面的回应方式里。"];
}

function attentionStrengthText(strength: number) {
  if (strength >= 82) return "认真盯住";
  if (strength >= 62) return "竖起耳朵";
  if (strength >= 42) return "轻轻注意";
  return "先放过去";
}

function privacyFeelingText(risk: number) {
  if (risk >= 55) return "这段我会先小心放着";
  if (risk >= 25) return "这段先不急着长期留下";
  return "这段可以轻轻记成情景";
}

function emergenceDriveText(drive: string) {
  const map: Record<string, string> = {
    safety: "因为我现在更谨慎",
    curiosity: "因为我还想继续想",
    attachment: "因为我想靠近旧片段",
    rhythm: "因为节律把旧记忆带回我这里",
    wake_rhythm: "因为醒来时碰到我抱着的旧记忆",
    wake_self_memory: "因为醒来时碰到你养出来的习惯",
    memory_resonance: "因为新片段碰到我抱着的旧记忆"
  };
  return map[drive] ?? "因为我现在的状态把这段带了回来";
}

function memoryFamiliarityText(weight: number) {
  if (weight >= 85) return "我已经记得很稳了";
  if (weight >= 65) return "我记得比较清楚";
  if (weight >= 35) return "这段对我还很新";
  if (weight <= 0) return "我已经把这段放下了";
  return "这段在我这里变淡了";
}

function memoryKindText(kind: CreatureProfile["longTermMemories"][number]["kind"]) {
  const map = {
    user_preference: "下次我会照着这个方式靠近你",
    long_theme: "这是会反复回来找我的主题",
    creature_self_memory: "这是我认识自己的小痕迹",
    safety_rule: "这是你教我的边界",
    future_review: "到时候我会把它想起来",
    relationship: "这是我们之间变熟的一小段",
    habit: "这是我闻出来的习惯",
    open_question: "这是我还想继续歪头想的事"
  };
  return map[kind];
}

function memoryFeelingText(memory: CreatureProfile["longTermMemories"][number]) {
  const familiarity = memoryFamiliarityText(memory.weight);
  const kindText = memoryKindText(memory.kind);
  if (memory.weight <= 0) return `${familiarity}，现在我先不把它叼回来。`;
  return `${familiarity}。${kindText}。`;
}

function memoryCreatureLine(memory: CreatureProfile["longTermMemories"][number]) {
  const rawText = memory.text.trim();
  const text = normalizeMemoryText(rawText);
  const map = {
    user_preference: `我记住你喜欢我这样做：${text}`,
    long_theme: `我会把这件事放在耳边，之后听见相近的声音就想起它：${text}`,
    creature_self_memory: `我身上长出一点新习惯：${text}`,
    safety_rule: `这条边界我会先守住：${text}`,
    future_review: `这件事以后可能还会回来，我先抱着：${text}`,
    relationship: `这段让我更认识你一点：${text}`,
    habit: `我闻到一个反复出现的小习惯：${text}`,
    open_question: `这件事我还会歪头想一想：${text}`
  };
  return map[memory.kind];
}

function memoryKeptBecauseText(reason: string) {
  return `我当时把它抱住，是因为${normalizeMemoryText(reason)}`;
}

function normalizeMemoryText(text: string) {
  return normalizeSharedMemoryText(text)
    .replace(/^(你主动|你确认|你后来教我)[：:]\s*/, "")
    .replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, "$1$2")
    .replace(/[。！？.!?]+$/, "");
}

function PanelTitle({ icon: Icon, title }: { icon: typeof Brain; title: string }) {
  return (
    <div className="panel-title">
      <Icon size={18} />
      <h2>{title}</h2>
    </div>
  );
}

function NavButton(props: { active: boolean; icon: typeof Brain; label: string; unread?: boolean; onClick: () => void }) {
  return (
    <button className={props.active ? "active" : ""} onClick={props.onClick}>
      <props.icon size={19} />
      <span>
        {props.label}
        {props.unread ? <i className="unread-dot" aria-label="有未读 Papo 回复" /> : null}
      </span>
    </button>
  );
}

function stateHeadline(profile: CreatureProfile) {
  const latest = profile.conversation?.[0];
  if (latest?.role === "papo") {
    if (latest.channel === "button") return "刚把耳朵转向你";
    if (latest.channel === "curious") return "刚陪你听过一小段";
    if (latest.channel === "feedback") return "正在把你的意思记进身体里";
    if (latest.channel === "emergence") return "刚自己想起一小段";
  }
  if (latest?.role === "user" || latest?.role === "world") return "刚收到你递来的一小段";
  const wake = profile.wakeHistory?.[0];
  if (wake) return wake.elapsedMinutes >= 60 ? "刚从小睡里醒来" : "刚抬头看见你";
  return restingHeadline(profile);
}

function stateSentence(profile: CreatureProfile) {
  const state = profile.state;
  const latest = profile.conversation?.[0];
  const latestChange = profile.stateChanges?.[0];
  if (latest?.role === "papo" && latest.channel === "feedback") return "你刚刚教过我一次，我会把这种偏好带到后面相似的小片段里。";
  if (latest?.role === "papo" && latest.channel === "emergence") return "那条旧记忆刚从我里面冒出来，我会带着这个方向继续听下一段。";
  if (latest?.role === "papo" && latest.channel === "curious") return "我刚从一小段世界里挑出自己在意的地方，还没有把所有东西都吞下去。";
  if (latest?.role === "papo" && latest.channel === "button") return "刚才那句话让我竖起耳朵，我正在判断要回应、记住，还是先轻轻问一句。";
  if (latest?.role === "user" || latest?.role === "world") return "我已经接住这一小段，正在把文字、照片或声音放进同一个小情景里听。";
  if (latestChange?.reason.includes("button capture")) return "刚才那句话让我竖起耳朵，身体还留着一点被你叫住后的反应。";
  if (latestChange?.reason.includes("feedback")) return "我刚被你养成了一点，之后遇到相似片段会更接近你的意思。";
  if (latestChange?.reason.includes("wake")) return "这次重新见到你以后，我先稳住自己，再把耳朵留给新的小片段。";
  const memory = strongestSharedMemory(profile);
  if (memory) return `我还抱着这段旧小事：${normalizeMemoryText(memory.text)}。下一段相近的生活靠近时，我会先轻轻想起它。`;
  const raisedMemory = strongestRaisedMemory(profile);
  if (raisedMemory) return `你教过我的这点还在身体里：${normalizeMemoryText(raisedMemory.text)}。我会带着这种听法等你下一段。`;
  if (!profile.episodes.length) return "我还没有和你攒下真实生活片段，所以先把耳朵留给你接下来递来的文字、照片或声音。";
  if (state.energy < 35) return "我会短一点回应，把重要片段先抱住，等有力气再展开。";
  if (state.safety > 74) return "我会先闻一闻边界，隐私和长期保存都会更谨慎。";
  if (state.curiosity > 72) return "我的耳朵现在更容易被新主题牵动，但还是会挑最值得在意的那一小段。";
  if (state.attachment > 68) return "我更想把你现在给我的片段，和我们以前经历过的小事连起来。";
  return "我正安静陪着你，先观察，再决定要不要靠近。";
}

function restingHeadline(profile: CreatureProfile) {
  if (strongestSharedMemory(profile)) return "抱着一小段旧事";
  if (strongestRaisedMemory(profile)) return "带着你教过的听法";
  if (!profile.episodes.length) return "等第一段生活靠近";
  const state = profile.state;
  if (state.energy < 35) return "趴着听你";
  if (state.safety > 74) return "先小心闻一闻";
  if (state.attachment > 68) return "身体往你这边靠";
  if (state.confidence > 70 && state.energy > 55) return "眼睛亮了一点";
  if (state.arousal < 36) return "安静贴着这一刻";
  if (state.curiosity > 62) return "耳朵正朝着你";
  return "安静等你靠近";
}

function strongestSharedMemory(profile: CreatureProfile) {
  return profile.longTermMemories
    .filter((memory) => memory.weight > 0 && memory.kind !== "creature_self_memory" && Boolean(memory.sourceEpisodeId))
    .sort((a, b) => b.weight - a.weight)[0];
}

function strongestRaisedMemory(profile: CreatureProfile) {
  return profile.longTermMemories
    .filter((memory) => memory.weight > 0 && memory.kind === "creature_self_memory" && memory.tags.includes("被你养成"))
    .sort((a, b) => b.weight - a.weight)[0];
}

function dogMotionText(state: CreatureState) {
  if (state.energy < 35) return "尾巴慢下来，眼睛有点困";
  if (state.curiosity > 72) return "耳朵竖起来，尾巴轻快地摆";
  if (state.attachment > 68) return "身体往前靠，像想贴近你";
  if (state.safety > 74) return "耳朵谨慎地转着，先闻一闻";
  return "呼吸很稳，安静看着这一刻";
}

function dogSenseText(state: CreatureState) {
  if (state.arousal > 64) return "现在对新动静很敏感";
  if (state.confidence > 62) return "表达更确定一点";
  if (state.safety > 74) return "我会先保护隐私和边界";
  return "我会先观察，再决定要不要靠近";
}

function actionText(action: AttentionEvent["suggestedAction"]) {
  const map = {
    observe: "观察",
    respond: "回应",
    ask: "轻问",
    save_episode: "存情景",
    save_long_term: "存长期",
    recall: "回忆",
    review: "复盘",
    quiet: "安静",
    draft_reminder: "提醒草稿",
    draft_question_list: "问题清单"
  };
  return map[action];
}

function semanticStatusText(status: NonNullable<CreatureProfile["semanticBrainHistory"]>[number]["status"]) {
  const map = {
    skipped: "规则兜底",
    applied: "LLM 已参与",
    empty: "LLM 空输出",
    invalid: "LLM 输出无效",
    failed: "LLM 调用失败"
  };
  return map[status];
}

function messageTitle(message: CreatureProfile["conversation"][number]) {
  if (message.role === "papo") return "Papo";
  if (message.channel === "feedback") return "你的反馈";
  if (message.modality === "image_summary") return "你给 Papo 看了照片";
  if (message.modality === "audio_transcript") return "一段声音";
  return message.role === "world" ? "周围的一段" : "你";
}

function messageContextText(message: CreatureProfile["conversation"][number]) {
  if (message.role === "papo") return "";
  if (message.channel === "feedback") return "你在教我";
  if (message.channel === "curious") return "和这一小段世界放在一起";
  return "说给 Papo";
}

function locationText(location: NonNullable<StreamSegment["location"]>) {
  const accuracy = typeof location.accuracy === "number" ? `，约 ${Math.round(location.accuracy)} 米` : "";
  return location.label ?? `位置 ${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}${accuracy}`;
}

function providerRouteRows(provider: ProviderInfo) {
  const diagnostics = provider.diagnostics ?? {};
  return [
    {
      label: "语义脑",
      value: diagnostics.textProvider ?? provider.kind,
      detail: diagnostics.textModel ?? provider.name
    },
    {
      label: "视觉感知",
      value: diagnostics.visionProvider ?? provider.kind,
      detail: diagnostics.visionModel ?? "未单独配置"
    },
    {
      label: "声音感知",
      value: diagnostics.audioProvider ?? provider.kind,
      detail: [diagnostics.audioModel, diagnostics.audioRoute].filter(Boolean).join(" · ") || "未单独配置"
    }
  ];
}

function policyLabel(key: string) {
  const map: Record<string, string> = {
    preferDepth: "深入倾向",
    preferProactivity: "主动倾向",
    privacySensitivity: "隐私敏感",
    saveThreshold: "保存阈值",
    askThreshold: "询问阈值",
    recallTendency: "回忆倾向",
    quietTendency: "安静倾向"
  };
  return map[key] ?? key;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "发生未知错误";
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("录音片段读取失败"));
    reader.readAsDataURL(blob);
  });
}

function getSpeechRecognition(): SpeechRecognitionConstructor | undefined {
  const webWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return webWindow.SpeechRecognition ?? webWindow.webkitSpeechRecognition;
}

function getMediaRecorder(): typeof MediaRecorder | undefined {
  return window.MediaRecorder;
}

function preferredAudioMimeType(Recorder: typeof MediaRecorder) {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];
  return candidates.find((type) => Recorder.isTypeSupported(type)) ?? "";
}

function chooseAudioTranscript(modelTranscript: string, localTranscript: string, hasModelError = false) {
  const modelText = modelTranscript.trim();
  const localText = localTranscript.trim();
  const modelIsFallback = /不能真实转写|暂时没有返回转写|请手动补充|没有转写成功|暂时没有听清|你可以补一句/.test(modelText);
  if (hasModelError) return localText;
  if ((!modelText || modelIsFallback) && localText) return localText;
  return modelText || localText;
}

function sensingSegmentContent(text: string, error?: string) {
  return error ? "" : text;
}

async function currentLocationSnapshot(): Promise<StreamSegment["location"] | undefined> {
  if (!navigator.geolocation) return undefined;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          label: "上传时的位置"
        }),
      () => resolve(undefined),
      { enableHighAccuracy: false, maximumAge: 300_000, timeout: 2500 }
    );
  });
}

function liveBatchId(startedAt: number, index: number) {
  return `live-${new Date(startedAt).toISOString()}-${String(index).padStart(2, "0")}`;
}

function manualBatchId(nowMs = Date.now()) {
  return `manual-${Math.floor(nowMs / 30_000)}`;
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatListeningTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
