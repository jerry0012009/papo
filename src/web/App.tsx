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

type ConversationMessage = CreatureProfile["conversation"][number];
type ConversationSection =
  | { kind: "batch"; id: string; batchId: string; messages: ConversationMessage[] }
  | { kind: "single"; id: string; message: ConversationMessage };

const feedbacks: Array<{ kind: FeedbackKind; label: string; icon: typeof Check }> = [
  { kind: "understood", label: "理解对了", icon: Check },
  { kind: "continue", label: "继续想", icon: Lightbulb },
  { kind: "not_now", label: "这次不用", icon: CircleOff },
  { kind: "remember", label: "记住", icon: Save },
  { kind: "forget", label: "忘掉", icon: RefreshCcw }
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
  const [lastResult, setLastResult] = useState<CaptureResult>();
  const [emergence, setEmergence] = useState<string>();
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

  async function uploadImageSummary(file?: File) {
    if (!file) return;
    await run(async () => {
      const observedAt = file.lastModified ? new Date(file.lastModified).toISOString() : new Date().toISOString();
      const location = await currentLocationSnapshot();
      const dataUrl = await readFileAsDataUrl(file);
      const result = await summarizeImage(dataUrl, file.name || "上传照片");
      setSegments((current) => [
        ...current,
        makeSegment(`image-${Date.now()}`, "image_summary", file.name || `照片 ${current.length + 1}`, result.summary, {
          observedAt,
          batchId: currentBatchId(),
          location
        })
      ]);
      setDemoNote(result.semanticSource === "llm" ? "视觉语义脑已经把照片压成一段 image_summary，并记录了可用的时间/地点。" : "当前没有真实视觉模型，已加入一段可手动修改的图片摘要和可用元数据。");
      setTab("curious");
    });
  }

  async function uploadAudioTranscript(file?: File) {
    if (!file) return;
    await run(async () => {
      const dataUrl = await readFileAsDataUrl(file);
      const result = await transcribeAudio(dataUrl, file.name || "上传录音");
      setSegments((current) => [
        ...current,
        makeSegment(`audio-${Date.now()}`, "audio_transcript", file.name || `录音 ${current.length + 1}`, result.transcript, {
          observedAt: new Date().toISOString(),
          batchId: currentBatchId()
        })
      ]);
      setDemoNote(result.semanticSource === "llm" ? "音频语义脑已经把录音转成一段 audio_transcript。" : "当前没有真实音频模型，已加入一段可手动修改的录音转写。");
      setTab("curious");
    });
  }

  async function giveFeedback(kind: FeedbackKind, targetId?: string, content?: string, modality: "text" | "audio_transcript" | "button" = content ? "text" : "button") {
    if (!profile) return;
    await run(async () => {
      const { profile: next, feedback } = await sendFeedback(profile.userId, kind, targetId, { content, modality });
      setProfile(next);
      setLearningNote(feedback.learningNote);
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
      setEmergence(result.emergence.text);
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
      setError("没有拿到麦克风权限。可以继续用文字模拟一段信息流。");
      return;
    }
    if (!stream) {
      setError("没有可用的麦克风输入。可以继续用文字模拟一段信息流。");
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
          setError("录音分段中断。已经得到的片段会继续保留。");
        };
        mediaRecorderRef.current = recorder;
        recorder.start();
      } catch {
        if (!Recognition) {
          stopMediaCapture();
          setListening(false);
          listeningStartedAtRef.current = undefined;
          setError("当前浏览器无法启动录音分段。可以继续用文字或手动上传录音。");
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
          content = chooseAudioTranscript(result.transcript, localTranscript);
        } catch (caught) {
          content = localTranscript || `语音片段 ${index} 已录下，但暂时没有转写成功。${errorMessage(caught)}`;
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
    setDemoNote("我已经放入 8 段生活化信息流：背景、日历、隐私、语音和重复片段。下一步点“开始观察”。");
    setDemoSummary(undefined);
    setTab("curious");
  }

  async function runGuidedDemo() {
    await run(async () => {
      const main = await createProfile("Papo 演示主线");
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
      const deep = await createProfile("Papo 深想型");
      const quiet = await createProfile("Papo 安静型");
      const deepFirst = await buttonCapture(deep.userId, input);
      const quietFirst = await buttonCapture(quiet.userId, input);
      for (let index = 0; index < 3; index += 1) {
        await sendFeedback(deep.userId, "continue", deepFirst.episodes[0]?.id);
        await sendFeedback(quiet.userId, "not_now", quietFirst.episodes[0]?.id);
      }
      const deepResult = await buttonCapture(deep.userId, input);
      const quietResult = await buttonCapture(quiet.userId, input);

      setProfiles(await listProfiles());
      setProfile(emerged.profile);
      setLastResult({ ...curiousResult, profile: emerged.profile });
      setLearningNote(learned);
      setEmergence(emerged.emergence.text);
      setDemoSummary({
        attention: `它看了 ${curiousResult.curiousSession?.totalSegments ?? demoCuriousSegments.length} 段，只认真注意到 ${curiousResult.events.length} 段。`,
        feedback: learned || "它已经收到“记住”和“继续想”的反馈，并更新了状态与策略。",
        contrast: `同一句输入下，深想型选择 ${deepResult.events[0] ? actionText(deepResult.events[0].actionDecision.action) : "无动作"}，安静型选择 ${quietResult.events[0] ? actionText(quietResult.events[0].actionDecision.action) : "无动作"}。`,
        emergence: emerged.emergence.text
      });
      setDemoNote("完整演示已准备好：主线小动物、A/B 养成对比和主动浮现都已生成。");
      setTab("demo");
    });
  }

  async function runDemoContrast() {
    await run(async () => {
      const input = "我有点担心自己又把妈妈复查这件事拖到睡前，明明它很重要。";
      const a = await createProfile("Papo 深想型");
      const b = await createProfile("Papo 安静型");
      const aFirst = await buttonCapture(a.userId, input);
      const bFirst = await buttonCapture(b.userId, input);
      let aProfile = aFirst.profile;
      let bProfile = bFirst.profile;
      for (let i = 0; i < 3; i += 1) {
        aProfile = (await sendFeedback(a.userId, "continue", aFirst.episodes[0].id)).profile;
        bProfile = (await sendFeedback(b.userId, "not_now", bFirst.episodes[0].id)).profile;
      }
      const aResult = await buttonCapture(a.userId, input);
      await buttonCapture(b.userId, input);
      setProfiles(await listProfiles());
      setProfile(aResult.profile);
      setLastResult(aResult);
      setLearningNote("A 连续收到“继续想”，B 连续收到“这次不用”。同一句输入下，A 会更愿意展开，B 会更克制。");
      setDemoNote(`已创建两个小动物：${aProfile.creatureName} 和 ${bProfile.creatureName}。你可以去“小动物切换”查看差异。`);
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
        <button className="icon-button" onClick={() => setTab("profile")} aria-label="切换用户">
          <UserRound size={19} />
        </button>
        <div>
          <p className="eyebrow">{provider?.name ?? "Fallback demo brain"}</p>
          <h1>{profile.creatureName}</h1>
          {provider?.usesRealModel ? <p className="eyebrow">LLM 语义脑已配置</p> : null}
        </div>
        <button className="icon-button" onClick={askEmergence} disabled={busy} aria-label="它现在在想什么">
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

      {tab === "chat" ? <ChatView profile={profile} busy={busy} onSubmitText={(text) => submitTextCapture(text, "chat")} /> : null}
      {tab === "memory" ? <MemoryView profile={profile} onFeedback={giveFeedback} onTranscribeFeedbackAudio={transcribeFeedbackAudio} onEditMemory={editLongTermMemory} /> : null}
      {tab === "brain" ? <BrainView profile={profile} /> : null}
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
  emergence?: string;
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
          <p className="eyebrow">当前心情</p>
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
          单次输入
        </button>
        <button onClick={props.onGoCurious}>
          <Sparkles size={18} />
          陪我一会儿
        </button>
      </div>

      {props.wakeMessage ? (
        <section className="wake-note">
          <span>醒来时</span>
          <p>{props.wakeMessage}</p>
          {props.wakeThought ? <p>{props.wakeThought}</p> : null}
        </section>
      ) : null}
      {props.emergence ? <section className="memory-surface active">{props.emergence}</section> : null}
      {props.learningNote ? <section className="learning-note">{props.learningNote}</section> : null}
      {props.lastFeedback ? <FeedbackImpactCard feedback={props.lastFeedback} /> : null}

      <StateGrid state={props.profile.state} />

      {props.lastResult ? (
        <section className="panel">
          <PanelTitle icon={Eye} title="刚才的注意事件" />
          <p className="response">{props.lastResult.response}</p>
          {props.lastResult.curiousSession ? (
            <div className="session-audit">
              <p>{props.lastResult.curiousSession.creatureReport}</p>
              {props.lastResult.curiousSession.ignored.slice(0, 4).map((item) => (
                <small key={item.segmentId}>
                  未选 {item.label}：{item.whyIgnored}
                </small>
              ))}
            </div>
          ) : null}
          {props.lastResult.harnessTrace?.length ? (
            <div className="trace-line">{props.lastResult.harnessTrace.join(" -> ")}</div>
          ) : null}
          <div className="event-list">
            {props.lastResult.events.map((event) => (
              <AttentionCard key={event.id} event={event} />
            ))}
          </div>
        </section>
      ) : null}

      {props.selectedEpisode ? (
        <EpisodeCard
          episode={props.selectedEpisode}
          sourceMessages={episodeSourceMessages(props.profile, props.selectedEpisode)}
          onFeedback={props.onFeedback}
          onTranscribeFeedbackAudio={props.onTranscribeFeedbackAudio}
          compact={false}
        />
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
          <path className="shiba-tail-ring" d="M120 86c23-7 29-34 10-43-17-8-32 8-23 22 6 10 21 7 21-3" />
          <path className="shiba-tail-tip" d="M129 43c13 9 9 29-8 36" />
        </g>
        <g className="shiba-body">
          <path className="shiba-body-fur" d="M42 87c8-23 51-28 73-8 17 15 15 45-9 52-21 7-55 5-69-8-11-10-10-24 5-36Z" />
          <path className="shiba-chest" d="M60 92c8 8 27 8 35 0 7 14 3 31-17 32-19 1-26-15-18-32Z" />
          <ellipse className="shiba-paw left" cx="55" cy="127" rx="15" ry="9" />
          <ellipse className="shiba-paw right" cx="99" cy="127" rx="15" ry="9" />
        </g>
        <g className="shiba-head">
          <path className="shiba-ear left" d="M46 42 34 10c-2-6 4-11 9-7l25 22Z" />
          <path className="shiba-ear-inner left" d="M46 33 40 15l15 14Z" />
          <path className="shiba-ear right" d="M113 42 126 10c2-6-4-11-9-7L92 25Z" />
          <path className="shiba-ear-inner right" d="M113 33 119 15l-15 14Z" />
          <path className="shiba-head-fur" d="M37 59c0-26 19-42 43-42s43 16 43 42c0 28-19 49-43 49S37 87 37 59Z" />
          <path className="shiba-urajiro left" d="M44 64c0-17 11-31 25-34 2 19-5 38-19 48-4-3-6-8-6-14Z" />
          <path className="shiba-urajiro right" d="M116 64c0-17-11-31-25-34-2 19 5 38 19 48 4-3 6-8 6-14Z" />
          <ellipse className="shiba-brow left" cx="64" cy="50" rx="8" ry="4" />
          <ellipse className="shiba-brow right" cx="96" cy="50" rx="8" ry="4" />
          <ellipse className="shiba-eye left" cx="64" cy="61" rx="5.5" ry="7" />
          <ellipse className="shiba-eye right" cx="96" cy="61" rx="5.5" ry="7" />
          <circle className="shiba-eye-shine left" cx="62" cy="58" r="1.6" />
          <circle className="shiba-eye-shine right" cx="94" cy="58" r="1.6" />
          <ellipse className="shiba-cheek left" cx="50" cy="77" rx="8" ry="5" />
          <ellipse className="shiba-cheek right" cx="110" cy="77" rx="8" ry="5" />
          <path className="shiba-muzzle" d="M61 76c4-10 34-10 38 0 4 12-5 24-19 24S57 88 61 76Z" />
          <path className="shiba-nose" d="M73 76c2-5 12-5 14 0 1 5-2 8-7 8s-8-3-7-8Z" />
          <path className="shiba-mouth" d="M80 84c0 8-10 10-14 4M80 84c0 8 10 10 14 4" />
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
        <PanelTitle icon={Sparkles} title="Curious Mode" />
        <section className="listening-panel">
          <div>
            <strong>{props.listening ? "我正在录这一小段世界" : "Curious 录音感知"}</strong>
            <p>
              最多录 3 分钟，每 30 秒把音频送去转写成一段。原始音频不保存，只把转写片段放进信息流。
            </p>
          </div>
          <button onClick={props.listening ? props.onStopListening : props.onStartListening} disabled={props.busy}>
            <Sparkles size={18} />
            {props.listening ? `停止 ${formatListeningTime(props.listeningElapsed)}` : "开始听 3 分钟"}
          </button>
        </section>
        <label className="upload-button">
          <ImagePlus size={18} />
          上传截图生成摘要
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
          上传录音转写
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
              <select value={segment.kind} onChange={(event) => updateSegment(index, { kind: event.target.value as SegmentKind })}>
                <option value="text">文字</option>
                <option value="image_summary">截图摘要</option>
                <option value="audio_transcript">录音转写</option>
              </select>
            </div>
            <textarea value={segment.content} onChange={(event) => updateSegment(index, { content: event.target.value })} rows={4} />
          </div>
        ))}
        <div className="action-row">
          <button onClick={addSegment}>
            <Plus size={18} />
            加片段
          </button>
          <button className="primary" onClick={props.onSubmit} disabled={props.busy}>
            <Eye size={18} />
            开始观察
          </button>
        </div>
      </div>
    </section>
  );
}

function ChatView({ profile, busy, onSubmitText }: { profile: CreatureProfile; busy: boolean; onSubmitText: (text: string) => Promise<void> }) {
  const [draft, setDraft] = useState("");
  const messages = [...(profile.conversation ?? [])].slice(0, 50).reverse();
  const sections = groupConversationSections(messages);
  const inputCount = messages.filter((message) => message.role !== "papo").length;
  const papoCount = messages.filter((message) => message.role === "papo").length;
  async function submitDraft() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await onSubmitText(text);
  }
  return (
    <section className="stack">
      <div className="panel">
        <PanelTitle icon={MessagesSquare} title="对话和注意流" />
        <div className="chat-composer">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            placeholder="直接告诉 Papo 一件刚发生的事"
          />
          <button className="primary" onClick={submitDraft} disabled={busy || !draft.trim()}>
            <MessageCircle size={18} />
            说给 Papo
          </button>
        </div>
        <div className="conversation-summary">
          <span>{inputCount} 条注意素材</span>
          <span>{papoCount} 条 Papo 回应</span>
        </div>
        {messages.length ? (
          <div className="chat-list">
            {sections.map((section) =>
              section.kind === "batch" ? (
                <section className="chat-batch" key={section.id}>
                  <div className="chat-batch-head">
                    <strong>30秒共同片段</strong>
                    <span>
                      {section.batchId} · {section.messages.length} 条素材
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

function ChatBubble({ message }: { message: ConversationMessage }) {
  return (
    <article className={`chat-bubble ${message.role}`}>
      <div>
        <strong>{messageTitle(message)}</strong>
        <span>
          {messageFlowText(message)} · {new Date(message.at).toLocaleString("zh-CN")}
        </span>
      </div>
      <p>{message.text}</p>
      {message.batchId || message.observedAt || message.location ? (
        <small>
          {[
            message.batchId ? `批次 ${message.batchId}` : "",
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
        <PanelTitle icon={History} title="长期记忆" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索旧记忆" />
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
                    保存
                  </button>
                  <button onClick={() => setEditingId(undefined)}>取消</button>
                </div>
              </>
            ) : (
              <p>{memory.text}</p>
            )}
            <span>{memory.kind} · 权重 {memory.weight}</span>
            <div className="memory-actions">
              <button
                onClick={() => {
                  setEditingId(memory.id);
                  setDraft(memory.text);
                }}
              >
                <MessageCircle size={16} />
                修改
              </button>
              <button onClick={() => props.onFeedback("forget", memory.id)}>
                <RefreshCcw size={16} />
                忘掉
              </button>
            </div>
          </article>
        ))}
      </div>
      <div className="panel">
        <PanelTitle icon={Brain} title="小动物自己的成长记忆" />
        {selfMemories.map((memory) => (
          <article className="memory-surface" key={memory.id}>
            <p>{memory.text}</p>
            <span>{memory.consolidatedBecause ?? "creature_self_memory"} · 权重 {memory.weight}</span>
          </article>
        ))}
      </div>
      <div className="panel">
        <PanelTitle icon={Eye} title="情景记忆" />
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

function BrainView({ profile }: { profile: CreatureProfile }) {
  const latestEpisode = profile.episodes[0];
  const latestEmergence = profile.emergenceHistory?.[0];
  const semanticRuns = profile.semanticBrainHistory ?? [];
  return (
    <section className="stack">
      <StateGrid state={profile.state} />
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
      <PanelTitle icon={UserRound} title="小动物切换" />
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
        新建小动物
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
        <PanelTitle icon={Wand2} title="演示模式" />
        <p className="response">用生活化素材演示三件事：它会从信息流里注意，它会被反馈养成，它会主动想起旧片段。</p>
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
          一键准备 4 分钟演示
        </button>
        <button onClick={props.onLoadCurious} disabled={props.busy}>
          <Sparkles size={18} />
          场景 1：填入 8 段信息流
        </button>
        <button onClick={props.onRunContrast} disabled={props.busy}>
          <UserRound size={18} />
          场景 2：生成 A/B 养成对比
        </button>
        <button onClick={props.onEmerge} disabled={props.busy}>
          <Lightbulb size={18} />
          场景 3：让它现在想一想
        </button>
      </div>
      <div className="panel">
        <PanelTitle icon={Brain} title="后续任务" />
        <p className="response">Curious Mode 后续会加入持续录音：最多 3 分钟，每 30 秒自动切成一段 audio transcript，再作为注意素材进入同一套 session audit。</p>
      </div>
    </section>
  );
}

function AttentionCard({ event }: { event: AttentionEvent }) {
  return (
    <article className="attention-card">
      <div>
        <span>{event.triggerLabel}</span>
        <strong>{event.attentionStrength}</strong>
      </div>
      <p>{event.noticed}</p>
      <small>{event.reason}</small>
      <details className="brain-details">
        <summary>为什么它注意到了这个</summary>
        <div className="score-list">
          {event.scoreBreakdown?.contributions.map((item) => (
            <span key={`${event.id}-${item.label}-${item.reason}`}>
              {item.label} {item.value >= 0 ? "+" : ""}
              {item.value}: {item.reason}
            </span>
          ))}
        </div>
        <p>{event.actionDecision.reason}</p>
        {event.actionDecision.blockedActions.length ? (
          <p>被拦截：{event.actionDecision.blockedActions.map((item) => `${actionText(item.action)}: ${item.reason}`).join("；")}</p>
        ) : null}
      </details>
      <footer>
        <span>{actionText(event.actionDecision.action)} · {event.actionDecision.confidence}</span>
        <span>隐私 {event.privacyRisk}</span>
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
        <strong>权重 {props.episode.weight}</strong>
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
        <textarea
          value={feedbackText}
          onChange={(event) => {
            setFeedbackText(event.target.value);
            setFeedbackModality("text");
          }}
          rows={props.compact ? 2 : 3}
          placeholder="也可以告诉 Papo：为什么对、为什么不想要、要怎么记"
        />
        <label className="upload-button compact-upload">
          <Mic size={16} />
          语音反馈
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
      {props.episode.decisionTrace?.length && !props.compact ? (
        <details className="brain-details">
          <summary>开发者 trace</summary>
          <small>{props.episode.decisionTrace.join(" -> ")}</small>
        </details>
      ) : null}
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
  const title = episode.sourceBatchId ? "来自30秒共同片段" : "来自当时的输入";
  return (
    <div className={`episode-source ${compact ? "compact" : ""}`}>
      <strong>{title}</strong>
      <small>
        {[
          episode.sourceBatchId ? `批次 ${episode.sourceBatchId}` : "",
          episode.sourceObservedAt ? `观察 ${new Date(episode.sourceObservedAt).toLocaleString("zh-CN")}` : "",
          episode.sourceLocation ? locationText(episode.sourceLocation) : ""
        ]
          .filter(Boolean)
          .join(" · ")}
      </small>
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

function FeedbackImpactCard({ feedback }: { feedback: FeedbackRecord }) {
  const stateDeltas = feedback.stateDeltas ?? [];
  const policyDeltas = feedback.policyDeltas ?? [];
  if (!stateDeltas.length && !policyDeltas.length) return null;
  return (
    <section className="feedback-impact">
      <strong>这次养成变化</strong>
      {feedback.inputText ? <p>你还补充了：{feedback.inputText}</p> : null}
      <div>
        {stateDeltas.map((item) => (
          <span key={`state-${item.key}`}>
            {stateDriveLabel(item.key)} {deltaText(item.delta)}
          </span>
        ))}
        {policyDeltas.map((item) => (
          <span key={`policy-${item.key}`}>
            {policyLabel(item.key)} {deltaText(item.delta)}
          </span>
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

function stateDriveLabel(key: keyof Omit<CreatureState, "mood">) {
  const map = {
    curiosity: "好奇心",
    attachment: "依恋度",
    energy: "精力",
    arousal: "唤醒度",
    safety: "安全感",
    confidence: "表达自信"
  };
  return map[key];
}

function deltaText(delta: number) {
  return `${delta > 0 ? "+" : ""}${delta}`;
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

function moodText(mood: CreatureState["mood"]) {
  const map = {
    curious: "好奇地贴近",
    calm: "安静地陪着",
    attached: "更想靠近你",
    careful: "谨慎地观察",
    tired: "有点低电量",
    bright: "亮起来了"
  };
  return map[mood];
}

function stateHeadline(profile: CreatureProfile) {
  const latest = profile.conversation?.[0];
  if (latest?.role === "papo") {
    if (latest.channel === "button") return "刚回应过你";
    if (latest.channel === "curious") return "刚陪你听完一段";
    if (latest.channel === "feedback") return "正在学你的反馈";
    if (latest.channel === "emergence") return "自己想起一点";
  }
  const wake = profile.wakeHistory?.[0];
  if (wake && wake.elapsedMinutes >= 60) return "刚从小睡里醒来";
  return moodText(profile.state.mood);
}

function stateSentence(profile: CreatureProfile) {
  const state = profile.state;
  const latestChange = profile.stateChanges?.[0];
  if (latestChange?.reason.includes("button capture")) return "刚才那句话让它集中了一次注意，精力会轻微下降，依恋和唤醒会有一点变化。";
  if (latestChange?.reason.includes("feedback")) return "它刚被你的反馈调整过，之后类似片段的回应方式会跟着变。";
  if (latestChange?.reason.includes("wake")) return "这次打开应用触发了醒来节律，能量、唤醒度和好奇心按时间差重新计算。";
  if (state.energy < 35) return "它会短一点回应，把重要片段先存下来。";
  if (state.safety > 74) return "它会更谨慎处理隐私和长期保存。";
  if (state.curiosity > 72) return "它更容易从信息流里挑出新主题。";
  if (state.attachment > 68) return "它更愿意把当前片段和你们的旧经历连起来。";
  return "它正在用稳定的注意力观察当前片段。";
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
  if (state.safety > 74) return "会先保护隐私和边界";
  return "会先观察，再决定要不要靠近";
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

function messageChannelText(channel: CreatureProfile["conversation"][number]["channel"]) {
  const map = {
    wake: "醒来时",
    button: "认真注意后",
    curious: "陪你看完后",
    feedback: "学到反馈后",
    emergence: "自己想起时"
  };
  return map[channel];
}

function messageTitle(message: CreatureProfile["conversation"][number]) {
  if (message.role === "papo") return messageChannelText(message.channel);
  if (message.channel === "feedback") return "你给 Papo 反馈";
  if (message.modality === "image_summary") return "你给 Papo 看了照片";
  if (message.modality === "audio_transcript") return "Papo 听到一段声音";
  return "你告诉 Papo";
}

function messageFlowText(message: CreatureProfile["conversation"][number]) {
  if (message.role === "papo") return "Papo 输出";
  if (message.channel === "feedback") return "反馈也是对话输入";
  if (message.channel === "curious") return "进入30秒注意批次";
  return "进入注意素材";
}

function locationText(location: NonNullable<StreamSegment["location"]>) {
  const accuracy = typeof location.accuracy === "number" ? `，约 ${Math.round(location.accuracy)} 米` : "";
  return location.label ?? `位置 ${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}${accuracy}`;
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

function chooseAudioTranscript(modelTranscript: string, localTranscript: string) {
  const modelText = modelTranscript.trim();
  const localText = localTranscript.trim();
  const modelIsFallback = /不能真实转写|暂时没有返回转写|请手动补充|没有转写成功/.test(modelText);
  if ((!modelText || modelIsFallback) && localText) return localText;
  return modelText || localText;
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
