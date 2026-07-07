import {
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
  UserRound
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toCreatureMemoryVoice } from "../core/memory";
import type {
  ActionResult,
  CreatureProfile,
  CreatureState,
  EpisodeMemory,
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
  listProfiles,
  makeSegment,
  sendFeedback,
  summarizeImage,
  observeAudio,
  updateLongTermMemory,
  wakeProfile,
  type ProfileSummary
} from "./api";

type Tab = "home" | "chat" | "memory" | "profile";

interface EmergenceSurface {
  text: string;
  memoryId?: string;
}

type ConversationMessage = CreatureProfile["conversation"][number];
type ConversationSection =
  | { kind: "batch"; id: string; batchId: string; messages: ConversationMessage[] }
  | { kind: "single"; id: string; message: ConversationMessage };

const episodeFeedbacks: Array<{ kind: FeedbackKind; label: string; icon: typeof Check }> = [
  { kind: "understood", label: "懂了", icon: Check },
  { kind: "continue", label: "再想想", icon: Lightbulb },
  { kind: "not_now", label: "轻一点", icon: CircleOff },
  { kind: "remember", label: "记住", icon: Save },
  { kind: "forget", label: "放下", icon: RefreshCcw }
];

export function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [profile, setProfile] = useState<CreatureProfile>();
  const [chatSegments, setChatSegments] = useState<StreamSegment[]>([]);
  const [emergence, setEmergence] = useState<EmergenceSurface>();
  const [readPapoMessageId, setReadPapoMessageId] = useState<string>();
  const [listening, setListening] = useState(false);
  const [listeningElapsed, setListeningElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const audioFlushRef = useRef<Promise<void>>(Promise.resolve());
  const segmentIndexRef = useRef(1);
  const listeningStartedAtRef = useRef<number | undefined>(undefined);
  const profileRef = useRef<CreatureProfile | undefined>(undefined);
  const tickTimerRef = useRef<number | undefined>(undefined);
  const segmentTimerRef = useRef<number | undefined>(undefined);
  const stopTimerRef = useRef<number | undefined>(undefined);

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

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  async function bootstrap() {
    try {
      setBusy(true);
      const existingProfiles = await listProfiles();
      let nextProfiles = existingProfiles;
      let active = existingProfiles[0] ? await getProfile(existingProfiles[0].userId) : undefined;
      if (!active) {
        active = await createProfile("Papo");
        nextProfiles = await listProfiles();
      }
      const woke = await wakeProfile(active.userId);
      setProfiles(nextProfiles);
      setProfile(woke.profile);
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
    setTab("home");
  }

  async function addProfile() {
    const name = `Papo ${profiles.length + 1}`;
    const next = await createProfile(name);
    setProfiles(await listProfiles());
    const woke = await wakeProfile(next.userId);
    setProfile(woke.profile);
  }

  async function submitTextCapture(text: string, nextTab: Tab = "chat") {
    const cleanText = text.trim();
    if (!profile || !cleanText) return;
    await run(async () => {
      const result = await buttonCapture(profile.userId, cleanText);
      setProfile(result.profile);
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
      setProfile(result.profile);
      setTab("chat");
    });
  }

  async function uploadChatImageSummary(file?: File) {
    if (!file) return;
    await run(async () => {
      const observedAt = file.lastModified ? new Date(file.lastModified).toISOString() : new Date().toISOString();
      const location = await currentLocationSnapshot();
      const dataUrl = await readFileAsDataUrl(file);
      const result = await summarizeImage(dataUrl, file.name || "对话照片");
      const content = sensingSegmentContent(result.summary);
      if (!content) return;
      setChatSegments((current) => [
        ...current,
        makeSegment(`chat-image-${Date.now()}`, "image_summary", file.name || `照片 ${current.length + 1}`, content, {
          observedAt,
          batchId: current[0]?.batchId ?? currentBatchId(),
          location
        })
      ]);
      setTab("chat");
    });
  }

  async function uploadChatAudioObservation(file?: File) {
    if (!file) return;
    await run(async () => {
      const dataUrl = await readFileAsDataUrl(file);
      const result = await observeAudio(dataUrl, file.name || "对话录音");
      const content = sensingSegmentContent(result.observation);
      if (!content) return;
      setChatSegments((current) => [
        ...current,
        makeSegment(`chat-audio-${Date.now()}`, "audio_observation", file.name || `录音 ${current.length + 1}`, content, {
          observedAt: new Date().toISOString(),
          batchId: current[0]?.batchId ?? currentBatchId()
        })
      ]);
      setTab("chat");
    });
  }

  async function giveFeedback(kind: FeedbackKind, targetId?: string, content?: string, modality: "text" | "audio_observation" | "button" = content ? "text" : "button") {
    if (!profile) return;
    await run(async () => {
      const { profile: next } = await sendFeedback(profile.userId, kind, targetId, { content, modality });
      setProfile(next);
    });
  }

  async function observeFeedbackAudio(file: File) {
    setBusy(true);
    setError(undefined);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const result = await observeAudio(dataUrl, file.name || "反馈录音");
      return result.observation;
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
    const Recorder = getMediaRecorder();
    if (!Recorder) {
      setError("当前浏览器不支持录音。你可以继续用文字、照片或上传音频。");
      return;
    }

    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices?.getUserMedia?.({ audio: true });
    } catch {
      setError("我还听不到麦克风。你可以先用文字告诉 Papo，或者加照片补充。");
      return;
    }
    if (!stream) {
      setError("我还没有听到可用的麦克风声音。你可以先用文字告诉 Papo，或者加照片补充。");
      return;
    }

    mediaStreamRef.current = stream;
    recordedChunksRef.current = [];
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
          setError("这次听到一半断开了。已经整理出来的内容会继续留在这里。");
        };
        mediaRecorderRef.current = recorder;
        recorder.start();
      } catch {
        stopMediaCapture();
        setListening(false);
        listeningStartedAtRef.current = undefined;
        setError("这个浏览器暂时没法让 Papo 连续听。你可以先写给它，或者加照片补充。");
        return;
      }
    }

    tickTimerRef.current = window.setInterval(() => {
      if (!listeningStartedAtRef.current) return;
      setListeningElapsed(Math.min(180, Math.floor((Date.now() - listeningStartedAtRef.current) / 1000)));
    }, 1000);
    segmentTimerRef.current = window.setInterval(() => {
      void queueAudioObservationSegment(false);
    }, 30_000);
    stopTimerRef.current = window.setTimeout(() => stopListening(), 180_000);
  }

  function stopListening() {
    if (tickTimerRef.current) window.clearInterval(tickTimerRef.current);
    if (segmentTimerRef.current) window.clearInterval(segmentTimerRef.current);
    if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
    tickTimerRef.current = undefined;
    segmentTimerRef.current = undefined;
    stopTimerRef.current = undefined;
    listeningStartedAtRef.current = undefined;
    setListening(false);
    void queueAudioObservationSegment(true).finally(() => stopMediaCapture());
  }

  function queueAudioObservationSegment(force: boolean) {
    audioFlushRef.current = audioFlushRef.current.then(() => flushAudioObservationSegment(force)).catch((caught) => {
      setError(errorMessage(caught));
    });
    return audioFlushRef.current;
  }

  async function flushAudioObservationSegment(force: boolean) {
    const chunks = await takeRecordedAudioChunks();
    if (!chunks.length && !force) return;
    if (!chunks.length) return;
    const index = segmentIndexRef.current;
    segmentIndexRef.current += 1;

    let content = "";
    const blob = new Blob(chunks, { type: mediaRecorderRef.current?.mimeType || chunks[0]?.type || "audio/webm" });
    if (blob.size > 0) {
      const dataUrl = await blobToDataUrl(blob);
      const result = await observeAudio(dataUrl, `语音片段 ${index}`);
      content = chooseAudioObservation(result.observation);
    }

    if (!content.trim()) return;
    await submitLiveAudioSegment(
      makeSegment(`live-audio-${Date.now()}-${index}`, "audio_observation", `听到的声音 ${index}`, content.trim(), {
        observedAt: new Date().toISOString(),
        batchId: batchIdForSegment(index)
      })
    );
  }

  async function submitLiveAudioSegment(segment: StreamSegment) {
    const activeProfile = profileRef.current;
    if (!activeProfile) return;
    try {
      const result = await curiousCapture(activeProfile.userId, [ensureSegmentContext(segment, 0)]);
      profileRef.current = result.profile;
      setProfile(result.profile);
    } catch (caught) {
      setError(`Papo 刚才听到一点声音，但整理时断开了。${errorMessage(caught)}`);
    }
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
          <p className="eyebrow">正在陪着你</p>
        </div>
        <button className="icon-button" onClick={askEmergence} disabled={busy} aria-label="轻轻碰一下 Papo">
          <Sparkles size={19} />
        </button>
      </header>

      {error ? <div className="notice">{error}</div> : null}

      {tab === "home" ? (
        <HomeView
          profile={profile}
          emergence={emergence}
          busy={busy}
          onGoCapture={() => setTab("chat")}
          onGoCurious={() => setTab("chat")}
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
          onUploadAudio={uploadChatAudioObservation}
          listening={listening}
          listeningElapsed={listeningElapsed}
          onStartListening={startListening}
          onStopListening={stopListening}
        />
      ) : null}
      {tab === "memory" ? <MemoryView profile={profile} onFeedback={giveFeedback} onObserveFeedbackAudio={observeFeedbackAudio} onEditMemory={editLongTermMemory} /> : null}
      {tab === "profile" ? (
        <ProfileView
          profiles={profiles}
          activeId={profile.userId}
          onSelect={selectProfile}
          onAdd={addProfile}
        />
      ) : null}

      <nav className="nav">
        <NavButton active={tab === "home"} icon={Eye} label="首页" onClick={() => setTab("home")} />
        <NavButton active={tab === "chat"} icon={MessagesSquare} label="对话" unread={hasUnreadPapoMessage} onClick={() => setTab("chat")} />
        <NavButton active={tab === "memory"} icon={History} label="记忆" onClick={() => setTab("memory")} />
      </nav>
    </main>
  );
}

function HomeView(props: {
  profile: CreatureProfile;
  emergence?: EmergenceSurface;
  busy: boolean;
  onGoCapture: () => void;
  onGoCurious: () => void;
}) {
  return (
    <section className="stack">
      <div className="hero">
        <ShibaAvatar state={props.profile.state} />
        <div className="hero-copy">
          <p className="eyebrow">Papo 在这里</p>
          <h2>{presenceHeadline(props.profile)}</h2>
          <p>{presenceSentence(props.profile)}</p>
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

      {props.emergence?.text ? <EmergenceCard emergence={props.emergence} /> : null}
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
          <path className="shiba-tail-shadow" d="M116 91c28-8 37-41 13-54-21-11-41 9-29 28 8 13 28 9 28-5" />
          <path className="shiba-tail-ring" d="M118 88c26-8 33-38 11-49-19-9-36 9-26 25 7 11 24 8 24-4" />
          <path className="shiba-tail-tip" d="M128 40c15 10 11 33-9 41" />
        </g>
        <g className="shiba-body">
          <path className="shiba-body-fur" d="M35 91c11-27 55-33 82-11 20 16 18 44-7 54-23 9-62 7-77-8-11-11-9-24 2-35Z" />
          <path className="shiba-back-leg left" d="M37 106c-12 9-9 25 8 27 13 1 22-7 21-19-8-1-18-3-29-8Z" />
          <path className="shiba-back-leg right" d="M123 106c12 9 9 25-8 27-13 1-22-7-21-19 8-1 18-3 29-8Z" />
          <path className="shiba-chest" d="M56 88c9 13 39 13 48 0 10 19 1 40-24 41-25 1-35-21-24-41Z" />
          <path className="shiba-collar" d="M58 91c11 6 34 6 45 0" />
          <circle className="shiba-tag" cx="81" cy="98" r="4" />
          <ellipse className="shiba-paw left" cx="53" cy="128" rx="16" ry="9" />
          <ellipse className="shiba-paw right" cx="103" cy="128" rx="16" ry="9" />
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
          <path className="shiba-face-mask" d="M56 73c3-15 45-15 48 0 4 20-7 34-24 34S52 93 56 73Z" />
          <ellipse className="shiba-brow left" cx="63" cy="50" rx="8" ry="4" />
          <ellipse className="shiba-brow right" cx="97" cy="50" rx="8" ry="4" />
          <ellipse className="shiba-eye left" cx="64" cy="62" rx="5.8" ry="7.2" />
          <ellipse className="shiba-eye right" cx="96" cy="62" rx="5.8" ry="7.2" />
          <circle className="shiba-eye-shine left" cx="62" cy="59" r="1.7" />
          <circle className="shiba-eye-shine right" cx="94" cy="59" r="1.7" />
          <ellipse className="shiba-cheek left" cx="49" cy="78" rx="9" ry="5.5" />
          <ellipse className="shiba-cheek right" cx="111" cy="78" rx="9" ry="5.5" />
          <circle className="shiba-whisker-dot left one" cx="67" cy="83" r="1.2" />
          <circle className="shiba-whisker-dot left two" cx="64" cy="89" r="1" />
          <circle className="shiba-whisker-dot right one" cx="93" cy="83" r="1.2" />
          <circle className="shiba-whisker-dot right two" cx="96" cy="89" r="1" />
          <path className="shiba-muzzle" d="M59 76c5-11 37-11 42 0 5 13-5 25-21 25S54 89 59 76Z" />
          <path className="shiba-nose" d="M72 76c2-5 14-5 16 0 1 5-3 8-8 8s-9-3-8-8Z" />
          <path className="shiba-mouth" d="M80 84c0 8-10 11-15 5M80 84c0 8 10 11 15 5" />
          <path className="shiba-tongue" d="M76 92c1 8 7 8 8 0" />
        </g>
      </svg>
    </div>
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
  listening: boolean;
  listeningElapsed: number;
  onStartListening: () => void;
  onStopListening: () => void;
}) {
  const [draft, setDraft] = useState("");
  const composerRef = useRef<HTMLDivElement>(null);
  const messages = [...(props.profile.conversation ?? [])].filter((message) => message.channel !== "wake").slice(0, 50).reverse();
  const sections = groupConversationSections(messages);
  const canSubmit = Boolean(draft.trim() || props.stagedSegments.some((segment) => segment.content.trim()));

  useEffect(() => {
    composerRef.current?.scrollIntoView({ block: "end" });
  }, [props.profile.conversation?.[0]?.id, props.stagedSegments.length]);

  function updateStagedSegmentContent(index: number, content: string) {
    props.onChangeStagedSegments((current) => current.map((segment, currentIndex) => (currentIndex === index ? { ...segment, content } : segment)));
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
        <section className="chat-presence">
          <ShibaAvatar state={props.profile.state} />
          <div>
            <strong>{props.listening ? "Papo 正在旁边听" : "Papo 趴在旁边等你"}</strong>
            <p>{props.listening ? `已经陪了 ${formatListeningTime(props.listeningElapsed)}。` : "你可以直接说一件事，也可以让它陪在旁边。"}</p>
          </div>
        </section>
        {messages.length ? (
          <div className="chat-list">
            {sections.map((section) =>
              section.kind === "batch" ? (
                <section className="chat-batch" key={section.id}>
                  <div className="chat-batch-head">
                    <strong>同一次事件</strong>
                    <span>{batchMomentSummary(section.messages)}</span>
                  </div>
                  {section.messages.map((message) => (
                    <ChatBubble message={message} profile={props.profile} key={message.id} />
                  ))}
                </section>
              ) : (
                <ChatBubble message={section.message} profile={props.profile} key={section.id} />
              )
            )}
          </div>
        ) : (
          <p className="muted">还没有对话。第一件小事会从这里开始。</p>
        )}
        <section className="listening-panel">
          <div>
            <strong>{props.listening ? "正在陪你听" : "陪你听一会儿"}</strong>
            <p>
              {props.listening
                ? "听清的事会自己进对话，嘈杂时就轻轻放过去。"
                : "开始后你仍然可以继续打字或加照片。"}
            </p>
          </div>
          <button onClick={props.listening ? props.onStopListening : props.onStartListening} disabled={props.busy}>
            <Sparkles size={18} />
            {props.listening ? `停下 ${formatListeningTime(props.listeningElapsed)}` : "开始陪我听"}
          </button>
        </section>
        <div className="chat-composer" ref={composerRef}>
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
              <strong>这次分享里还带着</strong>
              {props.stagedSegments.map((segment, index) => (
                <article className="staged-segment" key={segment.id}>
                  <div className="staged-attachment-head">
                    <span className="staged-kind">
                      <StagedSegmentIcon kind={segment.kind} />
                      {stagedSegmentKindText(segment.kind)}
                    </span>
                    <strong>{segment.label}</strong>
                  </div>
                  <textarea
                    value={segment.content}
                    onChange={(event) => updateStagedSegmentContent(index, event.target.value)}
                    rows={3}
                    placeholder={stagedSegmentPlaceholder(segment.kind)}
                  />
                  <button onClick={() => removeStagedSegment(index)} disabled={props.busy}>
                    <RefreshCcw size={16} />
                    这次先不带
                  </button>
                </article>
              ))}
            </section>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function StagedSegmentIcon({ kind }: { kind: SegmentKind }) {
  const Icon = kind === "image_summary" ? ImagePlus : kind === "audio_observation" ? Mic : MessageCircle;
  return <Icon size={15} />;
}

function stagedSegmentKindText(kind: SegmentKind) {
  if (kind === "image_summary") return "照片";
  if (kind === "audio_observation") return "录音";
  return "文字";
}

function stagedSegmentPlaceholder(kind: SegmentKind) {
  if (kind === "image_summary") return "可以改成你想让 Papo 看见的照片内容";
  if (kind === "audio_observation") return "可以改成你想让 Papo 听见的话";
  return "可以补充这件事";
}

function ChatBubble({ message, profile }: { message: ConversationMessage; profile: CreatureProfile }) {
  const context = messageContextText(message);
  return (
    <article className={`chat-bubble ${message.role}`}>
      <div className="chat-bubble-head">
        <div>
          <strong>{messageTitle(message)}</strong>
          <span>
            {context ? `${context} · ` : ""}{new Date(message.at).toLocaleString("zh-CN")}
          </span>
        </div>
        {message.role === "papo" && message.cognitionTrace ? <DeveloperTrace trace={message.cognitionTrace} profile={profile} /> : null}
      </div>
      <p>{visibleMessageText(message)}</p>
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

function DeveloperTrace({ trace, profile }: { trace: NonNullable<ConversationMessage["cognitionTrace"]>; profile: CreatureProfile }) {
  return (
    <details className="developer-trace">
      <summary aria-label="查看这句话背后的模型调用">
        <Eye size={14} />
        背后
      </summary>
      <div className="developer-trace-body">
        <section>
          <strong>模型调用</strong>
          {trace.modelRuns.length ? (
            <ul>
              {trace.modelRuns.map((run) => (
                <li key={run.id}>
                  <span>{stageLabel(run.stage ?? run.source)}</span>
                  <code>{run.model ?? trace.model ?? run.providerName}</code>
                  <small>{run.status} · {run.message}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p>这条消息没有记录到新增模型阶段。</p>
          )}
        </section>
        {trace.eventDecisions?.length ? (
          <section className="cognition-flow">
            <strong>认知流程</strong>
            {trace.eventDecisions.map((event) => (
              <div className="flow-chain" key={event.eventId}>
                <TraceBlock title="1. 注意">
                  <small>{event.sourceLabel}</small>
                  <p>{visibleCreatureText(event.sourceText)}</p>
                  <p>{event.noticed}</p>
                  <small>{event.reason}</small>
                  <RelatedMemories ids={event.relatedMemoryIds} profile={profile} />
                </TraceBlock>
                <TraceBlock title={`2. 行动 · ${actionLabel(event.action)}`}>
                  <p>{event.visibleReply ? `说出口：${event.visibleReply}` : "这一步没有外显回复。"}</p>
                  <ActionResultView result={event.actionResult} />
                  <TraceList items={actionTraceItems(event.decisionTrace)} />
                </TraceBlock>
                <TraceBlock title="3. 记忆">
                  <p>{event.episodeKept ? "形成了一条 episode。" : "没有保留为 episode。"}</p>
                  <p>{event.memoryCandidateKept ? "进入记忆候选，交给记忆模型判断。" : "没有进入记忆候选。"}</p>
                  <TraceList items={memoryTraceItems(event.decisionTrace)} />
                </TraceBlock>
              </div>
            ))}
            {trace.memoryDecisions?.length ? (
              <div className="flow-chain">
                <TraceBlock title="4. 记忆模型结果">
                  {trace.memoryDecisions.map((memory) => (
                    <div className="trace-memory-result" key={memory.candidateId}>
                      <b>{memoryStatusText(memory.status, memory.writePolicy)}</b>
                      <p>{memory.text}</p>
                      <small>{memory.memoryKind} · {memory.why}</small>
                    </div>
                  ))}
                </TraceBlock>
              </div>
            ) : null}
          </section>
        ) : null}
        {trace.feedbackDecision ? (
          <section className="cognition-flow">
            <strong>反馈流程</strong>
            <div className="flow-chain">
              <TraceBlock title="1. 反馈输入">
                <p>{feedbackKindLabel(trace.feedbackDecision.kind)}</p>
                {trace.feedbackDecision.inputText ? <small>{trace.feedbackDecision.inputText}</small> : null}
                {trace.feedbackDecision.targetId ? <small>目标：{trace.feedbackDecision.targetId}</small> : null}
              </TraceBlock>
              <TraceBlock title="2. 模型理解">
                <p>{trace.feedbackDecision.effect}</p>
                <small>{trace.feedbackDecision.learningNote}</small>
              </TraceBlock>
              <TraceBlock title="3. 实际修改">
                <TraceList items={feedbackDeltaItems(trace.feedbackDecision.stateDeltas ?? [], "state")} />
                <TraceList items={feedbackDeltaItems(trace.feedbackDecision.policyDeltas ?? [], "policy")} />
                {(trace.feedbackDecision.memoryCandidateIds ?? []).length ? (
                  <small>关联候选：{(trace.feedbackDecision.memoryCandidateIds ?? []).join("、")}</small>
                ) : null}
                {(trace.feedbackDecision.memoryChanges ?? []).map((change) => (
                  <div className="trace-memory-result" key={`${change.targetType}-${change.targetId}`}>
                    <b>{feedbackMemoryChangeTitle(change)}</b>
                    {change.beforeWeight !== undefined || change.afterWeight !== undefined ? (
                      <small>权重：{change.beforeWeight ?? "无"} -&gt; {change.afterWeight ?? "已删除"}</small>
                    ) : null}
                    {change.beforeText !== change.afterText ? (
                      <small>内容：{change.beforeText ?? "无"} -&gt; {change.afterText ?? "已删除"}</small>
                    ) : null}
                    {change.beforeKind !== change.afterKind ? (
                      <small>类型：{change.beforeKind ?? "无"} -&gt; {change.afterKind ?? "已删除"}</small>
                    ) : null}
                  </div>
                ))}
                {!(trace.feedbackDecision.stateDeltas ?? []).length &&
                !(trace.feedbackDecision.policyDeltas ?? []).length &&
                !(trace.feedbackDecision.memoryCandidateIds ?? []).length &&
                !(trace.feedbackDecision.memoryChanges ?? []).length ? (
                  <p>没有写入数值或记忆修改。</p>
                ) : null}
              </TraceBlock>
              <TraceBlock title={`4. 外显回应 · ${trace.feedbackDecision.responseAction ?? "quiet"}`}>
                <p>{trace.feedbackDecision.replyText ? `说出口：${trace.feedbackDecision.replyText}` : "这一步没有外显回复。"}</p>
              </TraceBlock>
            </div>
          </section>
        ) : null}
        {trace.emergenceDecision ? (
          <section className="cognition-flow">
            <strong>浮现流程</strong>
            <div className="flow-chain">
              <TraceBlock title="1. 模型决定">
                <p>{trace.emergenceDecision.shouldEmerge ? "决定主动浮现。" : "决定保持安静。"}</p>
                <small>{trace.emergenceDecision.whyNow}</small>
              </TraceBlock>
              <TraceBlock title={`2. 选择记忆 · ${trace.emergenceDecision.driveSource}`}>
                {trace.emergenceDecision.memoryId ? <small>memoryId：{trace.emergenceDecision.memoryId}</small> : null}
                <RelatedMemories ids={trace.emergenceDecision.relatedMemoryIds} profile={profile} />
                <small>主动程度：{trace.emergenceDecision.proactiveLevel ?? "未提供"}</small>
              </TraceBlock>
              <TraceBlock title="3. 外显回应">
                <p>{trace.emergenceDecision.message ? `说出口：${trace.emergenceDecision.message}` : "这一步没有外显回复。"}</p>
              </TraceBlock>
              <TraceBlock title="4. 结构校验">
                <TraceList items={trace.emergenceDecision.ruleTrace} />
              </TraceBlock>
            </div>
          </section>
        ) : null}
        {trace.harnessTrace?.length ? (
          <section>
            <strong>结构规则</strong>
            <TraceList items={trace.harnessTrace} />
          </section>
        ) : null}
      </div>
    </details>
  );
}

function TraceBlock(props: { title: string; children: ReactNode }) {
  return (
    <div className="trace-block">
      <b>{props.title}</b>
      {props.children}
    </div>
  );
}

function TraceList({ items }: { items: string[] }) {
  const visible = items.filter(Boolean);
  if (!visible.length) return null;
  return (
    <ul className="trace-list">
      {visible.map((item, index) => (
        <li key={`${item}-${index}`}>{item}</li>
      ))}
    </ul>
  );
}

function RelatedMemories({ ids, profile }: { ids: string[]; profile: CreatureProfile }) {
  const memories = ids
    .map((id) => profile.longTermMemories.find((memory) => memory.id === id))
    .filter((memory): memory is CreatureProfile["longTermMemories"][number] => Boolean(memory));
  if (!memories.length) return null;
  return (
    <ul className="trace-list">
      {memories.map((memory) => (
        <li key={memory.id}>{memory.text}</li>
      ))}
    </ul>
  );
}

function ActionResultView({ result }: { result?: ActionResult }) {
  if (!result || result.kind === "none" || result.kind === "visible_reply") return null;
  if (result.kind === "memory_intent") {
    return (
      <div className="trace-action-result">
        <b>记忆意图</b>
        {result.title ? <p>{result.title}</p> : null}
        {result.text ? <small>{result.text}</small> : null}
      </div>
    );
  }
  if (result.kind === "reminder_draft") {
    return (
      <div className="trace-action-result">
        <b>提醒草稿</b>
        {result.title ? <p>{result.title}</p> : null}
        {result.dueText ? <small>时间：{result.dueText}</small> : null}
        {result.text ? <small>内容：{result.text}</small> : null}
      </div>
    );
  }
  if (result.kind === "question_list_draft") {
    return (
      <div className="trace-action-result">
        <b>{result.title ?? "问题清单"}</b>
        {result.text ? <small>{result.text}</small> : null}
        {result.items?.length ? (
          <ul className="trace-list">
            {result.items.map((item, index) => (
              <li key={`${item}-${index}`}>{item}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  return null;
}

function actionTraceItems(items: string[]) {
  return items.filter((item) => /^(intent=|action_reason=|should_reply=|action_result=|guardrail: action=)/.test(item));
}

function memoryTraceItems(items: string[]) {
  return items.filter((item) => /^(episode=|memory_candidate=)/.test(item));
}

function memoryStatusText(status: string, policy: string) {
  const statusText: Record<string, string> = {
    candidate: "候选保留",
    promoted: "写入长期记忆",
    dismissed: "没有留下"
  };
  const policyText: Record<string, string> = {
    auto: "自动写入",
    ask_user: "等用户确认",
    wait_feedback: "等后续反馈",
    do_not_save: "不保存"
  };
  return `${statusText[status] ?? status} · ${policyText[policy] ?? policy}`;
}

function feedbackKindLabel(kind: string) {
  const labels: Record<string, string> = {
    understood: "用户表示这次懂了",
    continue: "用户让 Papo 再想一会儿",
    not_now: "用户让 Papo 先安静",
    remember: "用户要求记住",
    important: "用户标记这件事很重要",
    remind: "用户希望以后提醒",
    correct: "用户修正这条记忆",
    forget: "用户要求放下"
  };
  return labels[kind] ?? kind;
}

function feedbackDeltaItems(items: Array<{ key: string; before: number; after: number; delta: number }>, prefix: string) {
  return items.map((item) => `${prefix}.${item.key}: ${item.before} -> ${item.after} (${item.delta > 0 ? "+" : ""}${item.delta})`);
}

function feedbackMemoryChangeTitle(change: {
  targetType: "memory" | "episode";
  operation: "updated" | "purged" | "unchanged";
}) {
  const target = change.targetType === "memory" ? "记忆" : "经历";
  const operation = {
    updated: "已更新",
    purged: "已删除",
    unchanged: "未改变"
  }[change.operation];
  return `${target}${operation}`;
}

function stageLabel(stage: string) {
  const labels: Record<string, string> = {
    attention: "注意",
    action: "行动",
    memory: "记忆",
    feedback: "反馈",
    emergence: "想起",
    harness: "总流程",
    button: "直接输入",
    curious_stream: "陪伴输入"
  };
  return labels[stage] ?? stage;
}

function actionLabel(action: string) {
  const labels: Record<string, string> = {
    observe: "观察",
    respond: "回应",
    ask: "追问",
    save_episode: "留下经历",
    save_long_term: "长期记住",
    recall: "带着记忆回应",
    review: "整理",
    quiet: "安静",
    draft_reminder: "提醒草稿",
    draft_question_list: "问题清单"
  };
  return labels[action] ?? action;
}

function groupConversationSections(messages: ConversationMessage[]): ConversationSection[] {
  const sections = messages.reduce<ConversationSection[]>((sections, message) => {
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
  return sections.flatMap((section) =>
    section.kind === "batch" && section.messages.length === 1
      ? [{ kind: "single" as const, id: section.messages[0].id, message: section.messages[0] }]
      : [section]
  );
}

function batchMomentSummary(messages: ConversationMessage[]) {
  const kinds = [...new Set(messages.map((message) => messageKindNoun(message)))];
  if (!kinds.length) return "一起给 Papo";
  if (kinds.length === 1) return `${kinds[0]}一起`;
  if (kinds.length === 2) return `${kinds[0]}和${kinds[1]}一起`;
  return `${kinds.slice(0, -1).join("、")}和${kinds[kinds.length - 1]}一起`;
}

function messageKindNoun(message: ConversationMessage) {
  if (message.modality === "image_summary") return "照片";
  if (message.modality === "audio_observation") return "声音";
  return "文字";
}

function MemoryView(props: {
  profile: CreatureProfile;
  onFeedback: (kind: FeedbackKind, targetId?: string, content?: string, modality?: "text" | "audio_observation" | "button") => void;
  onObserveFeedbackAudio: (file: File) => Promise<string>;
  onEditMemory: (memoryId: string, text: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState("");
  const memories = [...props.profile.longTermMemories]
    .filter((memory) => `${memory.text} ${memory.kind} ${memory.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const otherMemories = memories.filter((memory) => memory.kind !== "creature_self_memory");

  return (
    <section className="stack">
      <div className="panel">
        <PanelTitle icon={History} title="Papo 记得的生活" />
        <p className="muted">按时间放着 Papo 真正留下的回忆。点开一条，可以看原始来龙去脉或反馈。</p>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="找一找哪件事" />
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
                  <button onClick={() => setEditingId(undefined)}>先不改</button>
                </div>
              </>
            ) : (
              <MemoryMainLines memory={memory} profile={props.profile} />
            )}
            <div className="memory-actions">
              <button
                onClick={() => {
                  setEditingId(memory.id);
                  setDraft(memory.text);
                }}
              >
                <MessageCircle size={16} />
                改准
              </button>
              <button onClick={() => props.onFeedback("important", memory.id, undefined, "button")}>
                <Save size={16} />
                很重要
              </button>
              <button onClick={() => props.onFeedback("remind", memory.id, undefined, "button")}>
                <Lightbulb size={16} />
                提醒我
              </button>
              <button onClick={() => props.onFeedback("forget", memory.id)}>
                <RefreshCcw size={16} />
                {memory.weight <= 0 ? "彻底忘掉" : "忘掉"}
              </button>
            </div>
            <MemoryFeedbackBox
              memory={memory}
              onFeedback={props.onFeedback}
              onObserveFeedbackAudio={props.onObserveFeedbackAudio}
            />
          </article>
        ))}
        {otherMemories.length ? null : <p className="muted">我还没有真正记下一件和你有关的事。</p>}
      </div>
      <div className="panel">
        <PanelTitle icon={Eye} title="最近一起经历过" />
        {props.profile.episodes.map((episode) => (
          <EpisodeCard
            key={episode.id}
            episode={episode}
            sourceMessages={episodeSourceMessages(props.profile, episode)}
            onFeedback={props.onFeedback}
            onObserveFeedbackAudio={props.onObserveFeedbackAudio}
            compact
          />
        ))}
      </div>
    </section>
  );
}

function MemoryMainLines({ memory, profile }: { memory: CreatureProfile["longTermMemories"][number]; profile: CreatureProfile }) {
  const sourceEpisode = memorySourceEpisode(memory, profile);

  return (
    <div className="memory-main">
      <div>
        <span>{new Date(memory.createdAt).toLocaleString("zh-CN")}</span>
        <strong>{memoryResultLine(memory)}</strong>
      </div>
      <details className="memory-details">
        <summary>详情</summary>
        <div className="memory-detail-body">
          {sourceEpisode ? (
            <>
              <div>
                <span>你当时说</span>
                <p>{episodeUserLine(sourceEpisode, episodeSourceMessages(profile, sourceEpisode))}</p>
              </div>
              {episodePapoLine(sourceEpisode) ? (
                <div>
                  <span>Papo 当时回你</span>
                  <p>{episodePapoLine(sourceEpisode)}</p>
                </div>
              ) : null}
            </>
          ) : null}
          {memory.consolidatedBecause ? (
            <div>
              <span>为什么留下</span>
              <p>{visibleCreatureText(memory.consolidatedBecause)}</p>
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}

function MemoryFeedbackBox(props: {
  memory: CreatureProfile["longTermMemories"][number];
  onFeedback: (kind: FeedbackKind, targetId?: string, content?: string, modality?: "text" | "audio_observation" | "button") => void;
  onObserveFeedbackAudio: (file: File) => Promise<string>;
}) {
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackModality, setFeedbackModality] = useState<"text" | "audio_observation">("text");
  function submit() {
    const content = feedbackText.trim();
    if (!content) return;
    props.onFeedback("continue", props.memory.id, content, feedbackModality);
    setFeedbackText("");
    setFeedbackModality("text");
  }

  return (
    <details className="memory-feedback">
      <summary>反馈</summary>
      <div className="feedback-input">
        <textarea
          value={feedbackText}
          onChange={(event) => {
            setFeedbackText(event.target.value);
            setFeedbackModality("text");
          }}
          rows={2}
          placeholder="告诉 Papo：哪里要记准、放轻，或下次怎么回应"
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
              const observation = await props.onObserveFeedbackAudio(file);
              if (observation.trim()) {
                setFeedbackText(observation.trim());
                setFeedbackModality("audio_observation");
              }
            }}
          />
        </label>
        <button className="primary" onClick={submit} disabled={!feedbackText.trim()}>
          <MessageCircle size={16} />
          发送反馈
        </button>
      </div>
    </details>
  );
}

function ProfileView(props: {
  profiles: ProfileSummary[];
  activeId: string;
  onSelect: (userId: string) => void;
  onAdd: () => void;
}) {
  return (
    <section className="stack">
      <div className="panel">
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
      </div>
    </section>
  );
}

function EpisodeCard(props: {
  episode: EpisodeMemory;
  sourceMessages?: ConversationMessage[];
  compact: boolean;
  onFeedback: (kind: FeedbackKind, targetId?: string, content?: string, modality?: "text" | "audio_observation" | "button") => void;
  onObserveFeedbackAudio: (file: File) => Promise<string>;
}) {
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackModality, setFeedbackModality] = useState<"text" | "audio_observation">("text");
  const userLine = episodeUserLine(props.episode, props.sourceMessages ?? []);
  const papoLine = episodePapoLine(props.episode);

  function submitFeedback(kind: FeedbackKind) {
    const content = feedbackText.trim();
    props.onFeedback(kind, props.episode.id, content || undefined, content ? feedbackModality : "button");
    setFeedbackText("");
    setFeedbackModality("text");
  }

  return (
    <article className="episode-card">
      <div className="episode-head">
        <span>{props.episode.source === "button" ? "你告诉我的事" : "Papo 回应过的事"}</span>
      </div>
      <div className="episode-moment">
        <div>
          <span>你</span>
          <p>{userLine}</p>
        </div>
        {papoLine ? (
          <div>
            <span>Papo</span>
            <strong>{papoLine}</strong>
          </div>
        ) : null}
      </div>
      <EpisodeSourceMoment episode={props.episode} messages={props.sourceMessages ?? []} compact={props.compact} />
      <div className="feedback-input">
        <div className="feedback-teach">
          <strong>你想怎么补充</strong>
          <span>还有想让 Papo 记准或放轻的地方吗？</span>
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
              const observation = await props.onObserveFeedbackAudio(file);
              if (observation.trim()) {
                setFeedbackText(observation.trim());
                setFeedbackModality("audio_observation");
              }
            }}
          />
        </label>
      </div>
      <div className="feedback-row">
        {episodeFeedbacks.map((item) => (
          <button key={item.kind} onClick={() => submitFeedback(item.kind)} aria-label={item.label}>
            <item.icon size={16} />
            {item.label}
          </button>
        ))}
      </div>
    </article>
  );
}

function episodeUserLine(episode: EpisodeMemory, messages: ConversationMessage[]) {
  const sourceText = messages
    .filter((message) => message.role !== "papo")
    .map((message) => visibleCreatureText(message.text).trim())
    .filter(Boolean)
    .join(" / ");
  return sourceText || visibleCreatureText(episode.inputSummary || noticedText(episode.noticed));
}

function episodePapoLine(episode: EpisodeMemory) {
  const cleaned = visiblePapoReplyText(episode.creatureResponse || "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned) return summarizeForEpisode(cleaned);
  return "";
}

function summarizeForEpisode(text: string) {
  return text.length > 52 ? `${text.slice(0, 52)}...` : text;
}

function EpisodeSourceMoment({ episode, messages, compact }: { episode: EpisodeMemory; messages: ConversationMessage[]; compact: boolean }) {
  if (!messages.length && !episode.sourceBatchId && !episode.sourceObservedAt && !episode.sourceLocation) return null;
  const title = episode.sourceBatchId ? "来自同一次事件" : "来自当时你给我的片段";
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
              {visibleCreatureText(message.text)}
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

function noticedText(text: string) {
  return text
    .replace(/^我刚才注意到[:：]?\s*/, "")
    .replace(/^我注意到[:：]?\s*/, "")
    .replace(/^我听到[:：]?\s*/, "");
}

function EmergenceCard({ emergence }: { emergence: EmergenceSurface }) {
  return (
    <section className="memory-surface active">
      <strong>Papo 想起一件事</strong>
      <p>{visibleCreatureText(emergence.text)}</p>
    </section>
  );
}

function memorySourceEpisode(memory: CreatureProfile["longTermMemories"][number], profile: CreatureProfile) {
  return memory.sourceEpisodeId ? profile.episodes.find((episode) => episode.id === memory.sourceEpisodeId) : undefined;
}

function memoryResultLine(memory: CreatureProfile["longTermMemories"][number]) {
  return extractRememberedMoment(memory.text);
}

function normalizeMemoryText(text: string) {
  return toCreatureMemoryVoice(text)
    .replace(/^(你主动|你确认|你后来教我)[：:]\s*/, "")
    .replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, "$1$2")
    .replace(/[。！？.!?]+$/, "");
}

function extractRememberedMoment(text: string) {
  const normalized = normalizeMemoryText(text)
    .replace(/^你当时告诉我[：:]\s*/, "")
    .replace(/^我当时听见这件事[：:]\s*/, "")
    .replace(/^我和你一起经历过这件事[：:]\s*/, "")
    .replace(/^你刚告诉我的这件事[：:]\s*/, "")
    .replace(/^我接住你刚告诉来的这件事[：:]\s*/, "")
    .replace(/我也记住它发生时的线索[：:].*$/g, "")
    .replace(/那件事发生时的线索[：:].*$/g, "")
    .trim();
  const [beforeResponse] = normalized.split(/当时我回应你[：:]/);
  const [beforeReason] = beforeResponse.split(/我当时(?:还没|决定|认真|先)/);
  const cleaned = visibleCreatureText(beforeReason)
    .replace(/^[：:，,。.\s]+/, "")
    .replace(/[。！？.!?]+$/, "")
    .trim();
  return cleaned;
}

function visibleMessageText(message: ConversationMessage) {
  return message.role === "papo" ? visiblePapoReplyText(message.text) : visibleCreatureText(message.text);
}

function visiblePapoReplyText(text: string | undefined) {
  return visibleCreatureText(text).replace(/\s+/g, " ").trim();
}

function visibleCreatureText(text: string | undefined) {
  if (!text) return "";
  return text.replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, "$1$2").trim();
}

function PanelTitle({ icon: Icon, title }: { icon: typeof Check; title: string }) {
  return (
    <div className="panel-title">
      <Icon size={18} />
      <h2>{title}</h2>
    </div>
  );
}

function NavButton(props: { active: boolean; icon: typeof Check; label: string; unread?: boolean; onClick: () => void }) {
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

function presenceHeadline(profile: CreatureProfile) {
  const latest = profile.conversation?.[0];
  if (latest?.role === "papo") {
    if (latest.channel === "button") return "有一句话给你";
    if (latest.channel === "curious") return "刚陪你听了一会儿";
    if (latest.channel === "feedback") return "刚学会一点你的意思";
    if (latest.channel === "emergence") return latest.relatedMemoryIds?.length ? "刚想起一件你们说过的事" : "刚安静了一下";
  }
  if (latest?.role === "user" || latest?.role === "world") return "收到了你刚给的事";
  if (!profile.episodes.length) return "等第一段生活靠近";
  return "等你继续说";
}

function presenceSentence(profile: CreatureProfile) {
  const latest = profile.conversation?.[0];
  if (latest?.role === "papo" && latest.channel === "feedback") return "你刚才教过我的那一点，已经放进后面的回应里。";
  if (latest?.role === "papo" && latest.channel === "emergence") {
    return latest.relatedMemoryIds?.length ? "那件事已经在对话里，你可以点进去继续说。" : "它先安静等着，等你给它新的生活片段。";
  }
  if (latest?.role === "papo" && latest.channel === "curious") return "刚才听到的内容已经整理进对话，你可以接着补文字、照片或声音。";
  if (latest?.role === "papo" && latest.channel === "button") return "Papo 刚回了你一句，在对话里可以继续接上。";
  if (latest?.role === "user" || latest?.role === "world") return "文字、照片或声音会留在同一次对话里，让 Papo 接着回应。";
  if (!profile.episodes.length) return "我还没有和你经历过多少事。你可以直接跟我说话，也可以给我照片或声音。";
  return "你可以继续说，也可以传照片、录音，或让 Papo 听一会儿。";
}

function messageTitle(message: CreatureProfile["conversation"][number]) {
  if (message.role === "papo") return "Papo";
  if (message.channel === "feedback") return "你的反馈";
  if (message.modality === "image_summary") return "你给 Papo 看了照片";
  if (message.modality === "audio_observation") return "一段声音";
  return message.role === "world" ? "周围的一段" : "你";
}

function messageContextText(message: CreatureProfile["conversation"][number]) {
  if (message.role === "papo") return "";
  if (message.channel === "feedback") return "你在教我";
  if (message.channel === "curious") return "和这次陪伴放在一起";
  return "说给 Papo";
}

function locationText(location: NonNullable<StreamSegment["location"]>) {
  const accuracy = typeof location.accuracy === "number" ? `，约 ${Math.round(location.accuracy)} 米` : "";
  return location.label ?? `位置 ${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}${accuracy}`;
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

function getMediaRecorder(): typeof MediaRecorder | undefined {
  return window.MediaRecorder;
}

function preferredAudioMimeType(Recorder: typeof MediaRecorder) {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];
  return candidates.find((type) => Recorder.isTypeSupported(type)) ?? "";
}

function chooseAudioObservation(modelObservation: string) {
  return modelObservation.trim();
}

function sensingSegmentContent(text: string) {
  return text.trim();
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
