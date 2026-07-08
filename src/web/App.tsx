import {
  Check,
  Eye,
  History,
  ImagePlus,
  Lightbulb,
  Loader2,
  MessageCircle,
  MessagesSquare,
  Mic,
  Plus,
  RefreshCcw,
  Save,
  Send,
  Sparkles,
  Square,
  UserRound,
  X
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { audioObservationPreview, imageSummaryPreview } from "../core/display-text";
import { toCreatureMemoryVoice } from "../core/memory";
import { PET_KINDS, normalizePetKind, petKindLabel } from "../core/pet-kinds";
import type {
  ActionResult,
  CreatureProfile,
  CreatureState,
  DogInteractionState,
  EpisodeMemory,
  FeedbackKind,
  MessageCognitionTrace,
  SegmentKind,
  SensingTrace,
  StreamSegment
} from "../core/types";
import {
  activeEmergence,
  buttonCapture,
  createProfile,
  curiousCapture,
  dreamMemories,
  getProfile,
  makeSegment,
  markPapoRead,
  resolveAssetUrl,
  sendFeedback,
  summarizeImage,
  observeAudio,
  updateLongTermMemory,
  wakeProfile,
} from "./api";
import {
  audioSliceBatchId,
  currentLiveBatchId,
  imageSegmentContent,
  liveBatchBoundaryMs as liveBatchBoundaryFor,
  LIVE_BATCH_AUDIO_GRACE_MS,
  LIVE_BATCH_MAX_WAIT_MS,
  LIVE_BATCH_MS,
  LIVE_LISTENING_MAX_MS,
  shouldSuppressForcedAudioSlice
} from "./live-listening";
import { formatPapoDateTime, papoTimeZone } from "./time";

type Tab = "home" | "chat" | "memory" | "profile";

interface EmergenceSurface {
  text: string;
  memoryId?: string;
  cognitionTrace?: MessageCognitionTrace;
}

type ConversationMessage = CreatureProfile["conversation"][number];
type ConversationSection =
  | { kind: "batch"; id: string; batchId: string; messages: ConversationMessage[] }
  | { kind: "single"; id: string; message: ConversationMessage };

const CHAT_PAGE_SIZE = 24;
const INITIAL_CHAT_VISIBLE_COUNT = CHAT_PAGE_SIZE * 2;
const LOCAL_USER_ID_KEY = "papo:userId";
const PUBLIC_BASE_URL = import.meta.env.BASE_URL ?? "/";
const IMAGE_UPLOAD_TARGET_BYTES = 3_500_000;
const IMAGE_UPLOAD_HARD_LIMIT_BYTES = 11_500_000;

interface AudioSliceMeta {
  index: number;
  observedAt: string;
  batchId: string;
}

interface LiveBatchBuffer {
  segments: StreamSegment[];
  closed: boolean;
  audioSettled: boolean;
  flushTimer?: number;
  updatedAt: number;
}

type PendingSegmentState = "processing" | "ready" | "failed";
type StagedChatSegment = StreamSegment & {
  status?: PendingSegmentState;
  previewUrl?: string;
  statusText?: string;
  displayText?: string;
};

export function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [profile, setProfile] = useState<CreatureProfile>();
  const [needsAuth, setNeedsAuth] = useState(false);
  const [chatSegments, setChatSegments] = useState<StagedChatSegment[]>([]);
  const [emergence, setEmergence] = useState<EmergenceSurface>();
  const [listening, setListening] = useState(false);
  const [listeningElapsed, setListeningElapsed] = useState(0);
  const [quickRecording, setQuickRecording] = useState(false);
  const [quickAudioProcessing, setQuickAudioProcessing] = useState(false);
  const [quickRecordingElapsed, setQuickRecordingElapsed] = useState(0);
  const [feedbackPendingKey, setFeedbackPendingKey] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const quickMediaStreamRef = useRef<MediaStream | null>(null);
  const quickMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const quickAudioChunksRef = useRef<Blob[]>([]);
  const quickRecordingStartedAtRef = useRef<number | undefined>(undefined);
  const quickRecordingTickTimerRef = useRef<number | undefined>(undefined);
  const quickRecordingStopTimerRef = useRef<number | undefined>(undefined);
  const audioRecorderChunksRef = useRef<Blob[]>([]);
  const activeAudioSliceMetaRef = useRef<AudioSliceMeta | undefined>(undefined);
  const audioObservationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const liveCaptureQueueRef = useRef<Promise<void>>(Promise.resolve());
  const liveBatchBuffersRef = useRef<Map<string, LiveBatchBuffer>>(new Map());
  const segmentIndexRef = useRef(1);
  const lastAudioSliceRequestAtRef = useRef(0);
  const listeningStartedAtRef = useRef<number | undefined>(undefined);
  const profileRef = useRef<CreatureProfile | undefined>(undefined);
  const tickTimerRef = useRef<number | undefined>(undefined);
  const segmentTimerRef = useRef<number | undefined>(undefined);
  const stopTimerRef = useRef<number | undefined>(undefined);

  const latestPapoMessage = useMemo(
    () => profile?.conversation?.find((message) => message.role === "papo" && message.channel !== "wake"),
    [profile?.conversation]
  );
  const unreadPapoCount = useMemo(() => countUnreadPapoMessages(profile), [profile?.conversation, profile?.readState?.lastReadPapoMessageId]);
  const hasUnreadPapoMessage = unreadPapoCount > 0;
  const hasActiveHermesTask = useMemo(
    () => Boolean(profile?.hermes?.tasks?.some((task) => task.status === "pending" || task.status === "sent")),
    [profile?.hermes?.tasks]
  );

  useEffect(() => {
    void bootstrap();
    return () => {
      stopListening();
      stopQuickAudioObservation();
    };
  }, []);

  useEffect(() => {
    if (tab !== "chat" || !profile?.userId || !latestPapoMessage) return;
    if (profile.readState?.lastReadPapoMessageId === latestPapoMessage.id) return;
    void markPapoRead(profile.userId, latestPapoMessage.id)
      .then(setProfile)
      .catch(() => {
        // Read cursor sync is best-effort; the next profile poll will retry if needed.
      });
  }, [latestPapoMessage?.id, profile?.userId, profile?.readState?.lastReadPapoMessageId, tab]);

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const testWindow = window as typeof window & { papoRequestAudioSliceForTest?: (force: boolean) => void };
    testWindow.papoRequestAudioSliceForTest = requestAudioSlice;
    return () => {
      delete testWindow.papoRequestAudioSliceForTest;
    };
  });

  useEffect(() => {
    if (!profile?.userId) return;
    const intervalMs = hasActiveHermesTask ? 3_000 : 60_000;
    const timer = window.setInterval(async () => {
      try {
        const next = await getProfile(profile.userId);
        setProfile(next);
      } catch {
        // Polling is only for passive proactive-message sync; user actions still surface errors.
      }
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [hasActiveHermesTask, profile?.userId]);

  async function bootstrap() {
    try {
      setBusy(true);
      setNeedsAuth(false);
      const savedUserId = readSavedUserId();
      if (!savedUserId) {
        setNeedsAuth(true);
        return;
      }
      const active = await getProfile(savedUserId);
      const woke = await wakeProfile(active.userId);
      saveUserId(active.userId);
      setProfile(woke.profile);
    } catch (caught) {
      forgetSavedUserId();
      setNeedsAuth(true);
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function login(userId: string) {
    await run(async () => {
      const cleanUserId = userId.trim();
      const active = await getProfile(cleanUserId);
      const woke = await wakeProfile(active.userId);
      saveUserId(active.userId);
      setNeedsAuth(false);
      setProfile(woke.profile);
      setTab("home");
    });
  }

  async function register(userId: string, petKind: string) {
    await run(async () => {
      const cleanUserId = userId.trim();
      const active = await createProfile({ userId: cleanUserId, creatureName: "Papo", petKind });
      const woke = await wakeProfile(active.userId);
      saveUserId(active.userId);
      setNeedsAuth(false);
      setProfile(woke.profile);
      setTab("home");
    });
  }

  function logout() {
    stopListening();
    forgetSavedUserId();
    setProfile(undefined);
    setChatSegments([]);
    setEmergence(undefined);
    setTab("home");
    setNeedsAuth(true);
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
    if (!chatSegments.length && !listening) {
      await submitTextCapture(cleanText, "chat");
      return;
    }
    if (!cleanText && !chatSegments.length) return;
    await run(async () => {
      const readySegments = chatSegments.filter((segment) => stagedSegmentReady(segment));
      const batchId = readySegments[0]?.batchId ?? currentBatchId();
      const textSegment = cleanText
        ? [makeSegment(`chat-text-${Date.now()}`, "text", listening ? "这 30 秒里你补充的话" : "你刚说的话", cleanText, { observedAt: new Date().toISOString(), batchId })]
        : [];
      const segments = [...textSegment, ...readySegments].filter((segment) => segment.content.trim()).map((segment, index) => ensureSegmentContext(segment, index));
      if (listening) {
        await submitLiveSegments(segments, { flushDelayMs: LIVE_BATCH_AUDIO_GRACE_MS });
      } else {
        const result = await curiousCapture(profile.userId, segments);
        setProfile(result.profile);
      }
      revokeStagedPreviewUrls(chatSegments);
      setChatSegments([]);
      setTab("chat");
    });
  }

  async function uploadChatImageSummary(file?: File) {
    if (!file) return;
    const observedAt = file.lastModified ? new Date(file.lastModified).toISOString() : new Date().toISOString();
    const localPreviewUrl = URL.createObjectURL(file);
    const localSegmentId = `chat-image-${Date.now()}`;
    const label = "照片";
    setError(undefined);
    setChatSegments((current) => [
      ...current,
      makeSegment(localSegmentId, "image_summary", label, "", {
        observedAt,
        batchId: current[0]?.batchId ?? currentBatchId(),
        attachments: [
          {
            id: `${localSegmentId}-local`,
            kind: "image",
            label: file.name || label,
            mime: browserImageMime(file.type),
            url: localPreviewUrl,
            createdAt: new Date().toISOString(),
            observedAt,
            sizeBytes: file.size
          }
        ]
      }) as StagedChatSegment
    ].map((segment) => segment.id === localSegmentId ? { ...segment, previewUrl: localPreviewUrl, status: "processing" } : segment));
    setTab("chat");

    try {
      const location = await currentLocationSnapshot();
      const dataUrl = await readImageFileAsUploadDataUrl(file);
      const result = await summarizeImage(dataUrl, file.name || "对话照片");
      const content = imageSegmentContent(result.summary, file.name || "照片");
      const asset = result.asset
        ? {
            ...result.asset,
            label: file.name || result.asset.label,
            observedAt,
            location
          }
        : undefined;
      setChatSegments((current) =>
        current.map((segment) =>
          segment.id === localSegmentId
            ? {
                ...segment,
                content,
                location,
                attachments: asset ? [asset] : segment.attachments,
                sensingTrace: result.sensingTrace,
                status: "ready",
                displayText: imageSummaryPreview(content)
              }
            : segment
        )
      );
    } catch (caught) {
      setChatSegments((current) =>
        current.map((segment) =>
          segment.id === localSegmentId
            ? {
                ...segment,
                status: "failed",
                statusText: imageUploadErrorMessage(caught)
              }
            : segment
        )
      );
      setError(imageUploadErrorMessage(caught));
    }
  }

  async function uploadChatAudioObservation(file?: File) {
    if (!file) return;
    await run(async () => {
      const dataUrl = await readAudioFileAsDataUrl(file);
      const result = await observeAudio(dataUrl, file.name || "对话录音");
      const content = sensingSegmentContent(result.observation);
      if (!content) return;
      const segment = makeSegment(`chat-audio-${Date.now()}`, "audio_observation", file.name || "录音", content, {
        observedAt: new Date().toISOString(),
        batchId: currentBatchId()
      });
      segment.sensingTrace = result.sensingTrace;
      if (listening) {
        await submitLiveSegments([ensureSegmentContext(segment, 0)]);
      } else {
        setChatSegments((current) => [
          ...current,
          { ...segment, label: file.name || `录音 ${current.length + 1}`, batchId: current[0]?.batchId ?? segment.batchId }
        ]);
      }
      setTab("chat");
    });
  }

  async function recordQuickAudioObservation() {
    if (!profile || listening || quickRecording || quickAudioProcessing) return;
    const Recorder = getMediaRecorder();
    if (!Recorder) {
      setError("当前浏览器不支持直接录音。你可以继续上传音频或开始陪我听。");
      return;
    }

    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices?.getUserMedia?.({ audio: true });
    } catch {
      setError("我还听不到麦克风。你可以上传音频，或者先用文字告诉 Papo。");
      return;
    }
    if (!stream) {
      setError("我还没有听到可用的麦克风声音。你可以上传音频，或者先用文字告诉 Papo。");
      return;
    }

    stopQuickAudioObservation();
    quickMediaStreamRef.current = stream;
    quickAudioChunksRef.current = [];
    quickRecordingStartedAtRef.current = Date.now();
    setQuickRecordingElapsed(0);
    setQuickRecording(true);
    setError(undefined);
    const mimeType = preferredAudioMimeType(Recorder);
    try {
      const recorder = new Recorder(stream, mimeType ? { mimeType } : undefined);
      quickMediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) quickAudioChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        void finishQuickAudioObservation(recorder, mimeType);
      };
      recorder.onerror = () => {
        setError("这次录音断开了。你可以再录一次，或者直接打字告诉 Papo。");
        cleanupQuickRecording();
      };
      recorder.start();
      quickRecordingTickTimerRef.current = window.setInterval(() => {
        if (!quickRecordingStartedAtRef.current) return;
        setQuickRecordingElapsed(Math.floor((Date.now() - quickRecordingStartedAtRef.current) / 1000));
      }, 250);
      quickRecordingStopTimerRef.current = window.setTimeout(() => {
        stopQuickAudioObservation();
      }, 60_000);
      setTab("chat");
    } catch (caught) {
      cleanupQuickRecording();
      setError(errorMessage(caught));
    }
  }

  function stopQuickAudioObservation() {
    const recorder = quickMediaRecorderRef.current;
    if (recorder && recorder.state === "recording") {
      try {
        recorder.stop();
      } catch (caught) {
        setError(errorMessage(caught));
        cleanupQuickRecording();
      }
      return;
    }
    if (quickRecording && !quickAudioProcessing) cleanupQuickRecording();
  }

  async function finishQuickAudioObservation(recorder: MediaRecorder, mimeType: string) {
    const chunks = quickAudioChunksRef.current;
    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
    cleanupQuickRecording({ keepChunks: true });
    if (totalSize <= 0) {
      quickAudioChunksRef.current = [];
      return;
    }
    setQuickAudioProcessing(true);
    setBusy(true);
    setError(undefined);
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || chunks[0]?.type || "audio/webm" });
      const dataUrl = await blobToDataUrl(blob);
      const result = await observeAudio(dataUrl, "刚录的一段声音");
      const content = sensingSegmentContent(result.observation);
      if (!content) return;
      const segment = makeSegment(`chat-mic-${Date.now()}`, "audio_observation", "刚录的一段声音", content, {
        observedAt: new Date().toISOString(),
        batchId: currentBatchId()
      });
      segment.sensingTrace = result.sensingTrace;
      setChatSegments((current) => [
        ...current,
        { ...segment, label: `麦克风 ${current.length + 1}`, batchId: current[0]?.batchId ?? segment.batchId }
      ]);
      setTab("chat");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      quickAudioChunksRef.current = [];
      setQuickAudioProcessing(false);
      setBusy(false);
    }
  }

  function cleanupQuickRecording(options: { keepChunks?: boolean } = {}) {
    if (quickRecordingTickTimerRef.current) window.clearInterval(quickRecordingTickTimerRef.current);
    if (quickRecordingStopTimerRef.current) window.clearTimeout(quickRecordingStopTimerRef.current);
    quickRecordingTickTimerRef.current = undefined;
    quickRecordingStopTimerRef.current = undefined;
    quickRecordingStartedAtRef.current = undefined;
    quickMediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    quickMediaStreamRef.current = null;
    quickMediaRecorderRef.current = null;
    if (!options.keepChunks) quickAudioChunksRef.current = [];
    setQuickRecording(false);
    setQuickRecordingElapsed(0);
  }

  async function giveFeedback(kind: FeedbackKind, targetId?: string, content?: string, modality: "text" | "audio_observation" | "button" = content ? "text" : "button") {
    if (!profile) return;
    const pendingKey = feedbackActionKey(kind, targetId);
    setFeedbackPendingKey(pendingKey);
    await run(async () => {
      const { profile: next } = await sendFeedback(profile.userId, kind, targetId, { content, modality });
      setProfile(next);
    }).finally(() => {
      setFeedbackPendingKey((current) => (current === pendingKey ? undefined : current));
    });
  }

  async function observeFeedbackAudio(file: File) {
    setBusy(true);
    setError(undefined);
    try {
      const dataUrl = await readAudioFileAsDataUrl(file);
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

  async function runDreaming() {
    if (!profile) return;
    await run(async () => {
      const result = await dreamMemories(profile.userId);
      setProfile(result.profile);
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
    setTab("chat");
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
    audioRecorderChunksRef.current = [];
    activeAudioSliceMetaRef.current = undefined;
    audioObservationQueueRef.current = Promise.resolve();
    liveCaptureQueueRef.current = Promise.resolve();
    clearLiveBatchBuffers();
    segmentIndexRef.current = 1;
    lastAudioSliceRequestAtRef.current = 0;
    listeningStartedAtRef.current = Date.now();
    setListeningElapsed(0);
    setListening(true);
    setError(undefined);

    if (Recorder) {
      try {
        const mimeType = preferredAudioMimeType(Recorder);
        startAudioRecorder(stream, Recorder, mimeType);
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
      setListeningElapsed(Math.min(LIVE_LISTENING_MAX_MS / 1000, Math.floor((Date.now() - listeningStartedAtRef.current) / 1000)));
    }, 1000);
    segmentTimerRef.current = window.setInterval(() => {
      requestAudioSlice(false);
    }, LIVE_BATCH_MS);
    stopTimerRef.current = window.setTimeout(() => stopListening(), LIVE_LISTENING_MAX_MS);
  }

  function startAudioRecorder(stream: MediaStream, Recorder: typeof MediaRecorder, mimeType: string) {
    if (!listeningStartedAtRef.current) return;
    audioRecorderChunksRef.current = [];
    const recorder = new Recorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) audioRecorderChunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const meta = activeAudioSliceMetaRef.current;
      activeAudioSliceMetaRef.current = undefined;
      const chunks = audioRecorderChunksRef.current;
      audioRecorderChunksRef.current = [];
      if (meta) {
        const totalSize = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
        if (totalSize > 0) {
          enqueueAudioObservationBlob(new Blob(chunks, { type: recorder.mimeType || mimeType || chunks[0]?.type || "audio/webm" }), meta);
        } else {
          markLiveBatchAudioSettled(meta.batchId);
        }
      }
      if (shouldStartNextAudioRecorder()) startAudioRecorder(stream, Recorder, mimeType);
    };
    recorder.onerror = () => {
      setError("这次听到一半断开了。已经整理出来的内容会继续留在这里。");
    };
    mediaRecorderRef.current = recorder;
    recorder.start();
  }

  function shouldStartNextAudioRecorder() {
    const startedAt = listeningStartedAtRef.current;
    const stream = mediaStreamRef.current;
    return Boolean(startedAt && stream?.active && Date.now() - startedAt < LIVE_LISTENING_MAX_MS);
  }

  function stopListening() {
    if (tickTimerRef.current) window.clearInterval(tickTimerRef.current);
    if (segmentTimerRef.current) window.clearInterval(segmentTimerRef.current);
    if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
    tickTimerRef.current = undefined;
    segmentTimerRef.current = undefined;
    stopTimerRef.current = undefined;
    setListening(false);
    requestAudioSlice(true);
    closeAllLiveBatches();
    listeningStartedAtRef.current = undefined;
    window.setTimeout(() => stopMediaCapture(), 350);
  }

  function requestAudioSlice(force: boolean) {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    const now = Date.now();
    if (force && shouldSuppressForcedAudioSlice(now, lastAudioSliceRequestAtRef.current)) return;
    lastAudioSliceRequestAtRef.current = now;
    const meta = nextAudioSliceMeta();
    activeAudioSliceMetaRef.current = meta;
    markLiveBatchClosed(meta.batchId);
    try {
      recorder.stop();
    } catch (caught) {
      if (force) setError(errorMessage(caught));
    }
  }

  function nextAudioSliceMeta(): AudioSliceMeta {
    const index = segmentIndexRef.current;
    segmentIndexRef.current += 1;
    return {
      index,
      observedAt: new Date().toISOString(),
      batchId: batchIdForSegment(index)
    };
  }

  function enqueueAudioObservationBlob(blob: Blob, meta: AudioSliceMeta) {
    audioObservationQueueRef.current = audioObservationQueueRef.current
      .then(() => processAudioObservationBlob(blob, meta))
      .catch((caught) => {
        markLiveBatchAudioSettled(meta.batchId);
        console.warn("Papo live audio slice was skipped after sensing failed.", {
          batchId: meta.batchId,
          index: meta.index,
          error: errorMessage(caught)
        });
      });
  }

  async function processAudioObservationBlob(blob: Blob, meta: AudioSliceMeta) {
    const dataUrl = await blobToDataUrl(blob);
    const result = await observeAudio(dataUrl, `语音片段 ${meta.index}`);
    const content = chooseAudioObservation(result.observation);
    if (!content.trim()) {
      markLiveBatchAudioSettled(meta.batchId);
      return;
    }
    submitLiveSegments([
      makeSegment(`live-audio-${Date.now()}-${meta.index}`, "audio_observation", `听到的声音 ${meta.index}`, content.trim(), {
        observedAt: meta.observedAt,
        batchId: meta.batchId
      })
    ].map((segment) => ({ ...segment, sensingTrace: result.sensingTrace })), { audioSettledBatchId: meta.batchId });
  }

  function submitLiveSegments(segments: StreamSegment[], options: { audioSettledBatchId?: string; flushDelayMs?: number } = {}) {
    const usefulSegments = segments.filter((segment) => segment.content.trim()).map((segment, index) => ensureSegmentContext(segment, index));
    if (!usefulSegments.length) {
      if (options.audioSettledBatchId) markLiveBatchAudioSettled(options.audioSettledBatchId);
      return;
    }
    const touchedBatchIds = new Set<string>();
    for (const segment of usefulSegments) {
      const batchId = segment.batchId ?? currentBatchId();
      const buffer = ensureLiveBatchBuffer(batchId);
      if (!buffer.segments.some((item) => item.id === segment.id)) {
        buffer.segments.push({ ...segment, batchId });
      }
      buffer.updatedAt = Date.now();
      scheduleLiveBatchFlush(batchId);
      touchedBatchIds.add(batchId);
    }
    if (typeof options.flushDelayMs === "number") {
      for (const batchId of touchedBatchIds) scheduleLiveBatchFlush(batchId, options.flushDelayMs);
    }
    if (options.audioSettledBatchId) markLiveBatchAudioSettled(options.audioSettledBatchId);
  }

  function flushLiveBatch(batchId: string) {
    const buffer = liveBatchBuffersRef.current.get(batchId);
    if (!buffer) return;
    if (buffer.flushTimer) window.clearTimeout(buffer.flushTimer);
    liveBatchBuffersRef.current.delete(batchId);
    const usefulSegments = buffer.segments
      .filter((segment) => segment.content.trim())
      .map((segment, index) => ({ ...segment, position: index + 1, batchId }));
    if (!usefulSegments.length) return;
    enqueueLiveCapture(usefulSegments);
  }

  function enqueueLiveCapture(usefulSegments: StreamSegment[]) {
    liveCaptureQueueRef.current = liveCaptureQueueRef.current.catch(() => undefined).then(async () => {
      const latestProfile = profileRef.current;
      if (!latestProfile) return;
      const result = await curiousCapture(latestProfile.userId, usefulSegments);
      profileRef.current = result.profile;
      setProfile(result.profile);
    }).catch((caught) => {
      setError(`Papo 刚才整理这一小段时断开了。${errorMessage(caught)}`);
    });
  }

  function ensureLiveBatchBuffer(batchId: string): LiveBatchBuffer {
    const existing = liveBatchBuffersRef.current.get(batchId);
    if (existing) return existing;
    const buffer: LiveBatchBuffer = {
      segments: [],
      closed: isPastLiveBatchBoundary(batchId),
      audioSettled: false,
      updatedAt: Date.now()
    };
    liveBatchBuffersRef.current.set(batchId, buffer);
    scheduleLiveBatchFlush(batchId);
    return buffer;
  }

  function markLiveBatchClosed(batchId: string) {
    const buffer = ensureLiveBatchBuffer(batchId);
    buffer.closed = true;
    scheduleLiveBatchFlush(batchId);
  }

  function markLiveBatchAudioSettled(batchId: string) {
    const buffer = ensureLiveBatchBuffer(batchId);
    buffer.audioSettled = true;
    scheduleLiveBatchFlush(batchId);
  }

  function closeAllLiveBatches() {
    for (const batchId of liveBatchBuffersRef.current.keys()) {
      const buffer = ensureLiveBatchBuffer(batchId);
      buffer.closed = true;
      scheduleLiveBatchFlush(batchId);
    }
  }

  function scheduleLiveBatchFlush(batchId: string, explicitDelayMs?: number) {
    const buffer = liveBatchBuffersRef.current.get(batchId);
    if (!buffer) return;
    if (buffer.flushTimer) window.clearTimeout(buffer.flushTimer);
    const delay = explicitDelayMs ?? liveBatchFlushDelay(batchId, buffer);
    buffer.flushTimer = window.setTimeout(() => flushLiveBatch(batchId), delay);
  }

  function liveBatchFlushDelay(batchId: string, buffer: LiveBatchBuffer) {
    if (buffer.closed && buffer.audioSettled) return LIVE_BATCH_AUDIO_GRACE_MS;
    if (buffer.closed) return LIVE_BATCH_MAX_WAIT_MS;
    return Math.max(0, liveBatchBoundaryMs(batchId) - Date.now()) + LIVE_BATCH_MAX_WAIT_MS;
  }

  function liveBatchBoundaryMs(batchId: string) {
    return liveBatchBoundaryFor(listeningStartedAtRef.current, batchId);
  }

  function isPastLiveBatchBoundary(batchId: string) {
    return liveBatchBoundaryMs(batchId) <= Date.now();
  }

  function clearLiveBatchBuffers() {
    for (const buffer of liveBatchBuffersRef.current.values()) {
      if (buffer.flushTimer) window.clearTimeout(buffer.flushTimer);
    }
    liveBatchBuffersRef.current.clear();
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
    return currentLiveBatchId(listeningStartedAtRef.current, nowMs);
  }

  function batchIdForSegment(index: number) {
    return audioSliceBatchId(listeningStartedAtRef.current, index);
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
    if (!activeAudioSliceMetaRef.current) audioRecorderChunksRef.current = [];
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

  if (!profile && needsAuth) {
    return (
      <AuthView
        busy={busy}
        error={error}
        onLogin={login}
        onRegister={register}
      />
    );
  }

  if (!profile) {
    return (
      <main className="shell loading">
        <ShibaAvatar idle />
        <p>{busy ? "Papo 正在醒来" : error ?? "无法载入小动物"}</p>
      </main>
    );
  }

  const pageTitle = tab === "home" ? "Papo" : tab === "chat" ? "和 Papo 说话" : tab === "memory" ? "Papo 记得的生活" : "小狗资料";

  return (
    <Tooltip.Provider delayDuration={180}>
      <main className={`shell app-shell tab-${tab}`}>
        <aside className="app-sidebar" aria-label="Papo 导航">
          <div className="sidebar-brand">
            <AvatarPreview petKind={profile.petKind} state={profile.state} dogState={profile.dogState} />
            <div>
              <strong>{profile.creatureName}</strong>
              <span>{papoMoodLabel(profile.state)}</span>
            </div>
          </div>
          <nav className="nav">
            <NavButton active={tab === "home"} icon={Eye} label="首页" onClick={() => setTab("home")} />
            <NavButton active={tab === "chat"} icon={MessagesSquare} label="对话" unreadCount={hasUnreadPapoMessage ? unreadPapoCount : 0} onClick={() => setTab("chat")} />
            <NavButton active={tab === "memory"} icon={History} label="记忆" onClick={() => setTab("memory")} />
          </nav>
        </aside>

        <section className="app-main">
          <header className="topbar app-topbar">
            <button className="icon-button" onClick={() => setTab("profile")} aria-label="看看哪只 Papo 在身边">
              <UserRound size={19} />
            </button>
            <div>
              <p className="eyebrow">住在手机里的小狗</p>
              <h1>{pageTitle}</h1>
              <p className="eyebrow">{profile.creatureName} 正在陪着你</p>
            </div>
            <button className="icon-button" onClick={askEmergence} disabled={busy} aria-label="轻轻碰一下 Papo">
              <Sparkles size={19} />
            </button>
          </header>

          <section className="view-frame">
            {error ? <div className="notice">{error}</div> : null}

            {tab === "home" ? (
              <HomeView
                profile={profile}
                emergence={emergence}
                unreadPapoCount={unreadPapoCount}
                busy={busy}
                onGoCapture={() => setTab("chat")}
                onGoCurious={startListening}
                onGoChat={() => setTab("chat")}
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
                onRecordAudio={recordQuickAudioObservation}
                onStopQuickRecording={stopQuickAudioObservation}
                listening={listening}
                listeningElapsed={listeningElapsed}
                quickRecording={quickRecording}
                quickAudioProcessing={quickAudioProcessing}
                quickRecordingElapsed={quickRecordingElapsed}
                onStartListening={startListening}
                onStopListening={stopListening}
              />
            ) : null}
            {tab === "memory" ? <MemoryView profile={profile} onFeedback={giveFeedback} onObserveFeedbackAudio={observeFeedbackAudio} onEditMemory={editLongTermMemory} onDream={runDreaming} busy={busy} feedbackPendingKey={feedbackPendingKey} /> : null}
            {tab === "profile" ? (
              <ProfileView
                profile={profile}
                onLogout={logout}
              />
            ) : null}
          </section>
        </section>

        <CompanionPanel
          profile={profile}
          unreadPapoCount={unreadPapoCount}
          busy={busy}
          listening={listening}
          listeningElapsed={listeningElapsed}
          onGoChat={() => setTab("chat")}
          onGoProfile={() => setTab("profile")}
          onAskEmergence={askEmergence}
          onToggleListening={listening ? stopListening : startListening}
        />
      </main>
    </Tooltip.Provider>
  );
}

function AuthView(props: {
  busy: boolean;
  error?: string;
  onLogin: (userId: string) => Promise<void>;
  onRegister: (userId: string, petKind: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"register" | "login">("register");
  const [userId, setUserId] = useState("");
  const [petKind, setPetKind] = useState("shiba");
  const [localError, setLocalError] = useState("");
  const cleanUserId = userId.trim();
  const canSubmit = /^[a-zA-Z0-9_-]{3,40}$/.test(cleanUserId);

  async function submit() {
    if (!canSubmit) {
      setLocalError("User ID 只能使用 3-40 位英文、数字、下划线或短横线。");
      return;
    }
    setLocalError("");
    if (mode === "login") {
      await props.onLogin(cleanUserId);
      return;
    }
    await props.onRegister(cleanUserId, petKind);
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-hero">
          <AvatarPreview
            petKind={petKind}
            state={{ mood: "bright", curiosity: 80, attachment: 74, energy: 78, confidence: 60, safety: 44, arousal: 60 }}
          />
          <div>
            <p className="eyebrow">Papo</p>
            <h1>养一只自己的小动物</h1>
            <p>每个账号只有一只 Papo，记忆、性格、Hermes 会按 User ID 分开保存。</p>
          </div>
        </div>

        <div className="auth-tabs" role="tablist" aria-label="登录方式">
          <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")} type="button">注册</button>
          <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")} type="button">登录</button>
        </div>

        <label className="field-label">
          User ID
          <input
            autoFocus
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            placeholder="例如 jerry"
            autoComplete="username"
          />
        </label>

        {mode === "register" ? (
          <div className="pet-picker" aria-label="选择小动物类型">
            {PET_KINDS.map((pet) => (
              <button
                key={pet.id}
                type="button"
                className={normalizePetKind(petKind) === pet.id ? "pet-option active" : "pet-option"}
                onClick={() => setPetKind(pet.id)}
              >
                <AvatarPreview petKind={pet.id} />
                <span>{pet.label}</span>
              </button>
            ))}
          </div>
        ) : null}

        {localError || props.error ? <p className="auth-error">{localError || props.error}</p> : null}
        <button className="primary auth-submit" onClick={submit} disabled={props.busy || !canSubmit} type="button">
          {props.busy ? "处理中" : mode === "register" ? "开始养 Papo" : "回到我的 Papo"}
        </button>
      </section>
    </main>
  );
}

function HomeView(props: {
  profile: CreatureProfile;
  emergence?: EmergenceSurface;
  unreadPapoCount: number;
  busy: boolean;
  onGoCapture: () => void;
  onGoCurious: () => void;
  onGoChat: () => void;
}) {
  const latestReply = props.unreadPapoCount ? latestVisiblePapoReply(props.profile) : "";
  const actionLine = papoVisibleActionLine(props.profile);
  return (
    <section className="home-screen">
      <section className="home-stage">
        <div className="home-stage-top">
          <span className="mood-pill">{papoMoodLabel(props.profile.state)}</span>
          <HomeBrainPeek profile={props.profile} />
        </div>
        <div className="home-avatar-wrap">
          <AvatarPreview petKind={props.profile.petKind} state={props.profile.state} dogState={props.profile.dogState} />
        </div>
        <div className="home-speech">
          <h2>{props.profile.creatureName}</h2>
          <p>{latestReply || actionLine}</p>
        </div>
      </section>
      <aside className="home-side">
        {props.unreadPapoCount ? (
          <button className="proactive-nudge" onClick={props.onGoChat}>
            <MessagesSquare size={16} />
            Papo 新说
            <span>{Math.min(3, props.unreadPapoCount)}</span>
          </button>
        ) : null}

        <div className="home-actions">
          <button className="primary home-listen-action" onClick={props.onGoCurious} title="开启 3 分钟持续听，Papo 会按约 30 秒分段理解你周围发生的事。">
            <Sparkles size={18} />
            陪我一会儿
          </button>
          <button className="secondary-action" onClick={props.onGoCapture}>
            <MessageCircle size={18} />
            跟 Papo 说
          </button>
        </div>
        <p className="home-action-note">陪伴会持续听 3 分钟，并按约 30 秒分段交给 Papo。</p>
        <HomeIllustrationsPeek profile={props.profile} />

        {props.emergence?.text ? <EmergenceCard emergence={props.emergence} profile={props.profile} /> : null}
      </aside>
    </section>
  );
}

function CompanionPanel(props: {
  profile: CreatureProfile;
  unreadPapoCount: number;
  busy: boolean;
  listening: boolean;
  listeningElapsed: number;
  onGoChat: () => void;
  onGoProfile: () => void;
  onAskEmergence: () => void;
  onToggleListening: () => void;
}) {
  const latestReply = props.unreadPapoCount ? latestVisiblePapoReply(props.profile) : "";
  return (
    <aside className="companion-panel" aria-label="Papo 当前状态">
      <section className="companion-card companion-hero">
        <div className="companion-avatar">
          <AvatarPreview petKind={props.profile.petKind} state={props.profile.state} dogState={props.profile.dogState} />
        </div>
        <div>
          <span className="status-dot" />
          <strong>{props.profile.creatureName}</strong>
          <p>{props.listening ? `正在听 ${formatListeningTime(props.listeningElapsed)}` : papoVisibleActionLine(props.profile)}</p>
        </div>
      </section>

      {props.unreadPapoCount ? (
        <button className="companion-nudge" onClick={props.onGoChat}>
          <MessagesSquare size={16} />
          Papo 新说
          <span>{Math.min(3, props.unreadPapoCount)}</span>
        </button>
      ) : latestReply ? (
        <section className="companion-card companion-last">
          <small>刚才</small>
          <p>{latestReply}</p>
        </section>
      ) : null}

      <div className="companion-actions">
        <button className="primary companion-listen-action" onClick={props.onToggleListening} disabled={props.busy} title="开启后 Papo 会持续听一会儿，并分段整理声音线索。">
          <Sparkles size={17} />
          {props.listening ? "停下" : "陪我"}
        </button>
        <button className="secondary-action" onClick={props.onGoChat}>
          <MessageCircle size={17} />
          对话
        </button>
      </div>

      <HermesTaskNotice profile={props.profile} />

      <div className="companion-tools">
        <button onClick={props.onAskEmergence} disabled={props.busy}>
          <Sparkles size={16} />
          轻轻碰一下
        </button>
        <button onClick={props.onGoProfile}>
          <UserRound size={16} />
          资料
        </button>
        <HomeBrainPeek profile={props.profile} compact />
      </div>
      <HomeIllustrationsPeek profile={props.profile} compact />
    </aside>
  );
}

function HomeIllustrationsPeek({ profile, compact = false }: { profile: CreatureProfile; compact?: boolean }) {
  const illustrations = (profile.illustrations ?? []).slice(0, 6);
  if (!illustrations.length) return null;
  const latest = illustrations[0];
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button className={compact ? "illustration-peek compact" : "illustration-peek"} type="button">
          <ImagePlus size={16} />
          Papo 画过
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-overlay" />
        <Dialog.Content className="illustration-dialog" aria-label="Papo 画过的小画">
          <div className="illustration-dialog-head">
            <div>
              <strong>Papo 画过的小画</strong>
              <span>{latest.title}</span>
            </div>
            <Dialog.Close asChild>
              <button type="button">收起</button>
            </Dialog.Close>
          </div>
          <div className="illustration-grid">
            {illustrations.map((item) => (
              <a href={resolveAssetUrl(item.attachment.url)} target="_blank" rel="noreferrer" className="illustration-card" key={item.id}>
                <img src={resolveAssetUrl(item.attachment.url)} alt={item.title} loading="lazy" />
                <strong>{item.title}</strong>
                {item.caption ? <span>{item.caption}</span> : null}
              </a>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AvatarPreview({ petKind, state, dogState, idle = false }: { petKind?: string; state?: CreatureState; dogState?: DogInteractionState; idle?: boolean }) {
  const normalizedPetKind = normalizePetKind(petKind);
  if (normalizedPetKind === "shiba") return <ShibaAvatar state={state} dogState={dogState} idle={idle} />;
  return <AgentPetSprite petKind={normalizedPetKind} dogState={dogState} idle={idle} />;
}

function AgentPetSprite({ petKind, dogState, idle = false }: { petKind: string; dogState?: DogInteractionState; idle?: boolean }) {
  const animation = agentPetAnimation(dogState?.animation);
  return (
    <div
      className={`agent-pet-avatar ${idle ? "idle" : ""}`}
      style={{
        backgroundImage: `url('${publicAssetPath(`pets/agent-pet/${petKind}/spritesheet.webp`)}')`,
        "--sprite-frames": animation.frames,
        "--sprite-row-y": `${animation.row * -134}px`,
        "--sprite-end-x": `${(animation.frames - 1) * -124}px`
      } as CSSProperties}
      aria-label={`${petKindLabel(petKind)} 正在${dogState?.label ?? "陪着你"}`}
    />
  );
}

function agentPetAnimation(animation?: DogInteractionState["animation"]) {
  switch (animation) {
    case "play":
    case "wag":
      return { row: 3, frames: 4 };
    case "bounce":
    case "stretch":
      return { row: 4, frames: 5 };
    case "sniff":
    case "peek":
      return { row: 8, frames: 6 };
    case "listen":
    case "sun":
      return { row: 6, frames: 6 };
    case "nap":
      return { row: 0, frames: 6 };
    case "idle":
    default:
      return { row: 0, frames: 6 };
  }
}

function publicAssetPath(path: string) {
  return `${PUBLIC_BASE_URL.replace(/\/?$/, "/")}${path.replace(/^\//, "")}`;
}

function ShibaAvatar({ state, dogState, idle = false }: { state?: CreatureState; dogState?: DogInteractionState; idle?: boolean }) {
  const mood = state?.mood ?? "calm";
  const className = [
    "shiba",
    `shiba-${mood}`,
    dogState ? `dog-action-${dogState.animation}` : "",
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

function HomeBrainPeek({ profile, compact = false }: { profile: CreatureProfile; compact?: boolean }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button className={compact ? "home-brain-trigger compact" : "home-brain-trigger"} type="button">
          <Eye size={14} />
          小眼睛
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-overlay" />
        <Dialog.Content className="ui-sheet" aria-label="Papo 状态和模型阶段">
          <div className="ui-sheet-head">
            <Dialog.Title>Papo 状态</Dialog.Title>
            <Dialog.Close asChild>
              <button className="icon-button small" type="button" aria-label="收起小眼睛">
                <RefreshCcw size={15} />
              </button>
            </Dialog.Close>
          </div>
          <StatePolicySnapshot profile={profile} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function StatePolicySnapshot({ profile }: { profile: CreatureProfile }) {
  const state = profile.state;
  const policy = profile.policyProfile;
  const recentRuns = (profile.semanticBrainHistory ?? []).slice(0, 3);
  const statusDiary = statusDiaryItems(profile).slice(0, 8);
  return (
    <div className="state-policy-snapshot">
      <section>
        <strong>状态</strong>
        <StateMeter label="好奇" value={state.curiosity} />
        <StateMeter label="亲近" value={state.attachment} />
        <StateMeter label="精力" value={state.energy} />
        <StateMeter label="确信" value={state.confidence} />
      </section>
      <section>
        <strong>性格倾向</strong>
        <StateMeter label="深聊" value={policy.preferDepth} />
        <StateMeter label="主动" value={policy.preferProactivity} />
        <StateMeter label="回想" value={policy.recallTendency} />
        <StateMeter label="安静" value={policy.quietTendency} />
      </section>
      {recentRuns.length ? (
        <section>
          <strong>最近模型阶段</strong>
          {recentRuns.map((run, index) => (
            <small key={`${run.id}-${run.stage ?? run.source}-${index}`}>{stageLabel(run.stage ?? run.source)} · {run.model ?? run.providerName} · {run.status}</small>
          ))}
        </section>
      ) : null}
      {statusDiary.length ? (
        <section>
          <strong>最近状态日记</strong>
          <div className="status-diary-list">
            {statusDiary.map((item) => (
              <article className="status-diary-item" key={item.id}>
                <span>{formatPapoDateTime(item.at)}</span>
                <b>{item.title}</b>
                {item.detail ? <small>{item.detail}</small> : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

interface StatusDiaryItem {
  id: string;
  at: string;
  title: string;
  detail?: string;
}

function statusDiaryItems(profile: CreatureProfile): StatusDiaryItem[] {
  const items: StatusDiaryItem[] = [];
  const dogStates = [profile.dogState, ...(profile.dogStateHistory ?? [])].filter(Boolean);
  const seenDogStates = new Set<string>();
  for (const dogState of dogStates) {
    const key = `${dogState.id}:${dogState.selectedAt}`;
    if (seenDogStates.has(key)) continue;
    seenDogStates.add(key);
    items.push({
      id: `dog:${key}`,
      at: dogState.selectedAt,
      title: dogState.label,
      detail: visibleCreatureText(dogState.actionText || dogState.reason)
    });
  }

  for (const change of profile.stateChanges ?? []) {
    items.push({
      id: `state:${change.at}:${change.reason}`,
      at: change.at,
      title: "状态变了一点",
      detail: `${stateChangeSummary(change.before, change.after)}${change.reason ? ` · ${change.reason}` : ""}`
    });
  }

  for (const message of profile.conversation ?? []) {
    const eventDeltas = message.cognitionTrace?.eventDecisions?.flatMap((event) => event.stateDeltas ?? []) ?? [];
    if (eventDeltas.length) {
      items.push({
        id: `message-state:${message.id}`,
        at: message.at,
        title: actionDiaryTitle(message),
        detail: stateDeltaSummary(eventDeltas)
      });
    }
    const feedbackDeltas = message.cognitionTrace?.feedbackDecision?.stateDeltas ?? [];
    if (feedbackDeltas.length) {
      items.push({
        id: `feedback-state:${message.id}`,
        at: message.at,
        title: "收到反馈后调整",
        detail: stateDeltaSummary(feedbackDeltas)
      });
    }
  }

  for (const dream of profile.dreamHistory ?? []) {
    items.push({
      id: `dream:${dream.id}`,
      at: dream.at,
      title: "整理了一次记忆",
      detail: [visibleCreatureText(dream.summary), stateDeltaSummary(dream.stateDeltas ?? [])].filter(Boolean).join(" · ")
    });
  }

  for (const emergence of profile.emergenceHistory ?? []) {
    if (!emergence.message?.trim()) continue;
    items.push({
      id: `emergence:${emergence.id}`,
      at: emergence.at,
      title: "主动想起你",
      detail: visibleCreatureText(emergence.message)
    });
  }

  for (const wake of profile.wakeHistory ?? []) {
    const deltas = objectStateDeltas(wake.stateDelta);
    if (!deltas.length) continue;
    items.push({
      id: `wake:${wake.id}`,
      at: wake.at,
      title: "回来时重新贴近",
      detail: `${stateDeltaSummary(deltas)}${wake.stateChangeReason ? ` · ${wake.stateChangeReason}` : ""}`
    });
  }

  return items.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
}

function actionDiaryTitle(message: CreatureProfile["conversation"][number]) {
  const action = message.cognitionTrace?.eventDecisions?.[0]?.action;
  if (message.role === "papo") return "回应之后状态变化";
  if (action === "quiet") return "听完后安静陪着";
  if (action === "save_long_term" || action === "save_episode") return "听完后留下记忆";
  if (action === "use_hermes") return "去问虾虾帮忙";
  if (action === "generate_illustration") return "画了一张小画";
  return "听完后状态变化";
}

function stateChangeSummary(before: CreatureState, after: CreatureState) {
  const deltas = (["curiosity", "attachment", "energy", "arousal", "safety", "confidence"] as const)
    .map((key) => ({ key, before: before[key], after: after[key], delta: after[key] - before[key] }))
    .filter((item) => item.delta !== 0);
  return stateDeltaSummary(deltas);
}

function objectStateDeltas(deltas: Partial<Record<keyof Omit<CreatureState, "mood">, number>>) {
  return Object.entries(deltas).flatMap(([key, delta]) => {
    if (!delta) return [];
    return [{ key, before: 0, after: delta, delta }];
  });
}

function stateDeltaSummary(items: Array<{ key: string; delta: number }>) {
  const labels: Record<string, string> = {
    curiosity: "好奇",
    attachment: "亲近",
    energy: "精力",
    arousal: "活跃",
    safety: "安全感",
    confidence: "确信"
  };
  return items
    .filter((item) => item.delta !== 0)
    .map((item) => `${labels[item.key] ?? item.key} ${item.delta > 0 ? "+" : ""}${item.delta}`)
    .join("，");
}

function StateMeter({ label, value }: { label: string; value: number }) {
  const safeValue = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="state-meter">
      <span>{label}</span>
      <div aria-hidden="true">
        <i style={{ width: `${safeValue}%` }} />
      </div>
      <b>{safeValue}</b>
    </div>
  );
}

function papoVisibleActionLine(profile: CreatureProfile) {
  const action = visibleCreatureText(profile.dogState?.actionText);
  if (action) return action;
  return "Papo 趴在旁边，等你说下一件事。";
}

function papoMoodLabel(state: CreatureState) {
  if (state.energy < 35) return "有点困";
  if (state.attachment > 72) return "很亲近";
  if (state.curiosity > 72) return "在好奇";
  if (state.safety > 76) return "慢慢听";
  if (state.mood === "bright") return "很精神";
  return "在身边";
}

function ChatView(props: {
  profile: CreatureProfile;
  busy: boolean;
  stagedSegments: StagedChatSegment[];
  onChangeStagedSegments: (segments: StagedChatSegment[] | ((current: StagedChatSegment[]) => StagedChatSegment[])) => void;
  onSubmitMoment: (text: string) => Promise<void>;
  onUploadImage: (file?: File) => void;
  onUploadAudio: (file?: File) => void;
  onRecordAudio: () => void;
  onStopQuickRecording: () => void;
  listening: boolean;
  listeningElapsed: number;
  quickRecording: boolean;
  quickAudioProcessing: boolean;
  quickRecordingElapsed: number;
  onStartListening: () => void;
  onStopListening: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [submittingMoment, setSubmittingMoment] = useState(false);
  const [visibleCount, setVisibleCount] = useState(INITIAL_CHAT_VISIBLE_COUNT);
  const composerRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDetailsElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const allMessages = useMemo(
    () => [...(props.profile.conversation ?? [])].filter((message) => message.channel !== "wake"),
    [props.profile.conversation]
  );
  const messages = allMessages.slice(0, visibleCount).reverse();
  const sections = groupConversationSections(messages);
  const waitingForStagedSegments = props.stagedSegments.some((segment) => !stagedSegmentReady(segment));
  const canSubmit = !waitingForStagedSegments && Boolean(draft.trim() || props.stagedSegments.some((segment) => stagedSegmentReady(segment) && segment.content.trim()));
  const hasOlderMessages = allMessages.length > visibleCount;
  const listeningTotalSeconds = Math.floor(LIVE_LISTENING_MAX_MS / 1000);
  const listeningRemainingSeconds = Math.max(0, listeningTotalSeconds - props.listeningElapsed);

  const loadOlderMessages = useCallback(() => {
    setVisibleCount((current) => Math.min(allMessages.length, current + CHAT_PAGE_SIZE));
  }, [allMessages.length]);

  useEffect(() => {
    setVisibleCount(INITIAL_CHAT_VISIBLE_COUNT);
  }, [props.profile.userId]);

  useEffect(() => {
    if (!hasOlderMessages) return;
    const onScroll = () => {
      if (window.scrollY < 120) loadOlderMessages();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [hasOlderMessages, loadOlderMessages]);

  useLayoutEffect(() => {
    window.requestAnimationFrame(() => {
      threadEndRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
    });
  }, [props.profile.conversation?.[0]?.id, props.stagedSegments.length]);

  function updateStagedSegmentContent(index: number, content: string) {
    props.onChangeStagedSegments((current) => current.map((segment, currentIndex) => (currentIndex === index ? { ...segment, content } : segment)));
  }

  function removeStagedSegment(index: number) {
    const segment = props.stagedSegments[index] as StagedChatSegment | undefined;
    if (segment?.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(segment.previewUrl);
    props.onChangeStagedSegments((current) => current.filter((_, currentIndex) => currentIndex !== index));
  }

  function uploadImageFromMenu(file?: File) {
    addMenuRef.current?.removeAttribute("open");
    props.onUploadImage(file);
  }

  function uploadAudioFromMenu(file?: File) {
    addMenuRef.current?.removeAttribute("open");
    props.onUploadAudio(file);
  }

  async function submitDraft() {
    const text = draft.trim();
    if (submittingMoment || (!text && !props.stagedSegments.length)) return;
    setDraft("");
    setSubmittingMoment(true);
    try {
      await props.onSubmitMoment(text);
    } finally {
      setSubmittingMoment(false);
    }
  }
  return (
    <section className="chat-screen">
      <header className="chat-top">
        <AvatarPreview petKind={props.profile.petKind} state={props.profile.state} dogState={props.profile.dogState} />
        <div>
          <strong>{props.listening ? "Papo 正在听" : "Papo 在这里"}</strong>
          <span>{props.listening ? formatListeningTime(props.listeningElapsed) : papoMoodLabel(props.profile.state)}</span>
        </div>
        <button className="listen-toggle" onClick={props.listening ? props.onStopListening : props.onStartListening} disabled={props.busy}>
          <Sparkles size={17} />
          {props.listening ? "停下" : "陪我"}
        </button>
      </header>
      <HermesTaskNotice profile={props.profile} />
      <section className="chat-thread" aria-label="和 Papo 的对话">
        {messages.length ? (
          <div className="chat-list">
            {hasOlderMessages ? (
              <button className="load-older-button" onClick={loadOlderMessages}>
                看更早的消息
              </button>
            ) : null}
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
        <div ref={threadEndRef} aria-hidden="true" />
      </section>
      <div className="chat-composer" ref={composerRef}>
          {props.listening ? (
            <section className="listening-session-status" aria-live="polite">
              <div>
                <Mic size={16} />
                <span>陪你听着 {formatListeningTime(props.listeningElapsed)} / {formatListeningTime(listeningTotalSeconds)}</span>
                <small>剩余 {formatListeningTime(listeningRemainingSeconds)}</small>
              </div>
              <button type="button" onClick={props.onStopListening} aria-label="停止陪我听">
                <Square size={15} />
                停止
              </button>
            </section>
          ) : null}
          {props.quickRecording || props.quickAudioProcessing ? (
            <section className={props.quickRecording ? "quick-audio-status recording" : "quick-audio-status processing"} aria-live="polite">
              <div>
                <Mic size={16} />
                <span>{props.quickRecording ? `录音中 ${formatListeningTime(props.quickRecordingElapsed)}` : "正在整理录音"}</span>
              </div>
              {props.quickRecording ? (
                <button type="button" onClick={props.onStopQuickRecording}>
                  <Square size={15} />
                  停止
                </button>
              ) : null}
            </section>
          ) : null}
          {props.stagedSegments.length ? (
            <section className="staged-moment" aria-label="待发送的素材">
              {props.stagedSegments.map((segment, index) => (
                <article className={`staged-segment ${segment.kind} ${segment.status ?? "ready"}`} key={segment.id}>
                  {segment.kind === "image_summary" ? (
                    <StagedImagePreview segment={segment} />
                  ) : segment.kind === "audio_observation" ? (
                    <div className="staged-audio-summary">
                      <Mic size={18} />
                      <span>一段声音</span>
                    </div>
                  ) : (
                    <textarea
                      value={segment.content}
                      onChange={(event) => updateStagedSegmentContent(index, event.target.value)}
                      rows={3}
                      placeholder={stagedSegmentPlaceholder(segment.kind)}
                    />
                  )}
                  <button className="staged-remove" onClick={() => removeStagedSegment(index)} disabled={props.busy} aria-label="移除这项素材">
                    <X size={14} />
                  </button>
                </article>
              ))}
            </section>
          ) : null}
          <div className="composer-tools">
            <details className="composer-add-menu" ref={addMenuRef}>
              <summary aria-label="添加素材">
                <Plus size={19} />
              </summary>
              <div className="composer-add-options">
                <label className="upload-button compact-upload">
                  <ImagePlus size={16} />
                  相册
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(event) => {
                      uploadImageFromMenu(event.currentTarget.files?.[0]);
                      event.currentTarget.value = "";
                    }}
                    disabled={props.busy}
                  />
                </label>
                <label className="upload-button compact-upload">
                  <ImagePlus size={16} />
                  拍照
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    capture="environment"
                    onChange={(event) => {
                      uploadImageFromMenu(event.currentTarget.files?.[0]);
                      event.currentTarget.value = "";
                    }}
                    disabled={props.busy}
                  />
                </label>
                <label className="upload-button compact-upload">
                  <Mic size={16} />
                  音频
                  <input
                    type="file"
                    accept="audio/webm,audio/wav,audio/mpeg,audio/mp3,audio/mp4,audio/m4a,audio/ogg,audio/aac"
                    onChange={(event) => {
                      uploadAudioFromMenu(event.currentTarget.files?.[0]);
                      event.currentTarget.value = "";
                    }}
                    disabled={props.busy}
                  />
                </label>
              </div>
            </details>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={1}
              placeholder="告诉 Papo..."
            />
            <button className="composer-mic-button" onClick={props.onRecordAudio} disabled={props.busy || props.listening || props.quickRecording || props.quickAudioProcessing} aria-label="录一段声音">
              {props.quickAudioProcessing ? <Loader2 size={18} className="spin-icon" /> : <Mic size={18} />}
            </button>
            <button className="primary chat-send-button" onClick={submitDraft} disabled={props.busy || submittingMoment || !canSubmit} aria-label="发送给 Papo">
              {submittingMoment ? <Loader2 size={18} className="spin-icon" /> : <Send size={18} />}
            </button>
          </div>
      </div>
    </section>
  );
}

function StagedImagePreview({ segment }: { segment: StagedChatSegment }) {
  const image = segment.attachments?.find((attachment) => attachment.kind === "image");
  const src = image ? resolveAssetUrl(image.url) : undefined;
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild disabled={!src}>
        <button className="staged-image-preview" type="button" aria-label="查看待发送照片">
          {src ? <img src={src} alt="待发送照片" /> : <ImagePlus size={20} />}
        </button>
      </Dialog.Trigger>
      {segment.status === "processing" ? (
        <span className="staged-image-overlay" aria-label="正在处理图片">
          <Loader2 size={18} className="spin-icon" />
        </span>
      ) : null}
      {segment.status === "failed" ? <span className="staged-image-error">{segment.statusText ?? "没传上去"}</span> : null}
      {src ? (
        <Dialog.Portal>
          <Dialog.Overlay className="ui-overlay" />
          <Dialog.Content className="photo-preview-dialog">
            <Dialog.Close asChild>
              <button className="dialog-close" aria-label="关闭">
                <X size={16} />
              </button>
            </Dialog.Close>
            <img src={src} alt="待发送照片预览" />
          </Dialog.Content>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  );
}

function stagedSegmentPlaceholder(kind: SegmentKind) {
  if (kind === "image_summary") return "可以改成你想让 Papo 看见的照片内容";
  if (kind === "audio_observation") return "可以改成你想让 Papo 听见的话";
  return "可以补充这件事";
}

function ChatBubble({ message, profile }: { message: ConversationMessage; profile: CreatureProfile }) {
  const context = messageContextText(message);
  const text = chatBubbleText(message);
  return (
    <article className={`chat-bubble ${message.role}`}>
      <div className="chat-bubble-head">
        <div>
          <strong>{messageTitle(message)}</strong>
          <span>
            {context ? `${context} · ` : ""}{formatPapoDateTime(message.at)}
          </span>
        </div>
        {message.cognitionTrace || message.sensingTrace ? <DeveloperTrace trace={message.cognitionTrace} sensingTrace={message.sensingTrace} profile={profile} /> : null}
      </div>
      <p>{text}</p>
      <AttachmentStrip attachments={message.attachments} />
      {message.observedAt || message.location ? (
        <small>
          {[
            message.observedAt ? `观察 ${formatPapoDateTime(message.observedAt)}` : "",
            message.location ? locationText(message.location) : ""
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
      ) : null}
    </article>
  );
}

function AttachmentStrip({ attachments }: { attachments?: NonNullable<StreamSegment["attachments"]> }) {
  const images = (attachments ?? []).filter((attachment) => attachment.kind === "image");
  if (!images.length) return null;
  return (
    <div className="attachment-strip">
      {images.map((image) => (
        <a href={resolveAssetUrl(image.url)} target="_blank" rel="noreferrer" className="attachment-thumb" key={image.id}>
          <img src={resolveAssetUrl(image.url)} alt={image.label} loading="lazy" />
        </a>
      ))}
    </div>
  );
}

function DeveloperTrace({ trace, sensingTrace, profile }: { trace?: ConversationMessage["cognitionTrace"]; sensingTrace?: SensingTrace; profile: CreatureProfile }) {
  return (
    <Dialog.Root>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <Dialog.Trigger asChild>
            <button className="trace-trigger" type="button" aria-label="查看这句话背后的模型调用">
              <Eye size={14} />
              背后
            </button>
          </Dialog.Trigger>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="ui-tooltip" sideOffset={6}>
            查看认知流程
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-overlay" />
        <Dialog.Content className="ui-sheet trace-sheet" aria-label="这句话背后的模型调用">
          <div className="ui-sheet-head">
            <Dialog.Title>认知流程</Dialog.Title>
            <Dialog.Close asChild>
              <button className="icon-button small" type="button" aria-label="关闭认知流程">
                <RefreshCcw size={15} />
              </button>
            </Dialog.Close>
          </div>
          <DeveloperTraceBody trace={trace} sensingTraces={sensingTrace ? [sensingTrace] : undefined} profile={profile} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DeveloperTraceBody({ trace, sensingTraces, profile }: { trace?: ConversationMessage["cognitionTrace"]; sensingTraces?: SensingTrace[]; profile: CreatureProfile }) {
  const allSensingTraces = uniqueSensingTraces([...(sensingTraces ?? []), ...(trace?.sensingTraces ?? [])]);
  return (
      <div className="developer-trace-body">
        {allSensingTraces.length ? (
          <section className="cognition-flow">
            <strong>感知流程</strong>
            <div className="flow-chain">
              {allSensingTraces.map((item, index) => (
                <SensingTraceBlock item={item} index={index} trace={trace} key={`${item.at}-${item.label}-${index}`} />
              ))}
            </div>
          </section>
        ) : null}
        {trace ? (
        <>
        <section>
          <strong>模型调用</strong>
          {trace.modelRuns.length ? (
            <ul>
              {trace.modelRuns.map((run, index) => (
                <li key={`${run.id}-${run.stage ?? run.source}-${index}`}>
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
                  <TraceList items={actionStateDeltaItems(event.stateDeltas ?? [])} />
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
                  {trace.memoryDecisions.map((memory, index) => (
                    <div className="trace-memory-result" key={`${memory.candidateId}-${memory.status}-${index}`}>
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
                {(trace.feedbackDecision.memoryChanges ?? []).map((change, index) => (
                  <div className="trace-memory-result" key={`${change.targetType}-${change.targetId}-${index}`}>
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
        </>
        ) : null}
      </div>
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

function sensingStatusLabel(status: SensingTrace["status"]) {
  const labels: Record<SensingTrace["status"], string> = {
    content: "进入注意候选",
    empty: "没有继续处理",
    unreadable: "没有继续处理"
  };
  return labels[status];
}

function SensingTraceBlock({ item, index, trace }: { item: SensingTrace; index: number; trace?: ConversationMessage["cognitionTrace"] }) {
  const linkedEvents = linkedSensingEvents(item, trace);
  const attentionRun = trace?.modelRuns.find((run) => (run.stage ?? run.source) === "attention");
  return (
    <TraceBlock title={`${index + 1}. ${item.modality === "audio" ? "声音感知" : "图片感知"} · ${sensingStatusLabel(item.status)}`}>
      <small>{item.label}</small>
      <small>感知模型：{item.provider}{item.model ? ` · ${item.model}` : ""}{item.route ? ` · ${item.route}` : ""}</small>
      <p>{item.observation ? `感知输出：${item.observation}` : "感知输出：没有可用生活信息。"}</p>
      <p>流程路由：{sensingRouteText(item)}</p>
      {linkedEvents.length ? (
        linkedEvents.map((event) => (
          <div className="trace-memory-result" key={event.eventId}>
            <b>注意 LLM：继续处理</b>
            <p>{event.noticed}</p>
            <small>{event.reason}</small>
          </div>
        ))
      ) : item.status === "content" ? (
        <div className="trace-memory-result">
          <b>{attentionRun ? "注意 LLM：未选为后续事件" : "注意 LLM：尚未记录"}</b>
          <small>{attentionRun ? `${attentionRun.status} · ${attentionRun.message}` : "这条消息只记录了感知结果，没有随消息保存后续认知 trace。"}</small>
        </div>
      ) : (
        <div className="trace-memory-result">
          <b>注意 LLM：未调用</b>
          <small>流程规则只结算这段输入，不把空白、噪音或不可读音频伪造成事件。</small>
        </div>
      )}
      <TraceList items={item.ruleTrace} />
    </TraceBlock>
  );
}

function sensingRouteText(item: SensingTrace) {
  if (item.status === "content") {
    return `${item.decision} 如果这段所在批次提交成功，下一步由注意 LLM 判断是否继续进入行动和记忆。`;
  }
  if (item.status === "unreadable") {
    return "音频模型没有返回可读内容；流程规则只把这段音频标记为已结算，不触发注意、行动或记忆。";
  }
  return "音频/图片模型没有返回可用生活信息；流程规则只结算这段输入，不触发注意、行动或记忆。";
}

function linkedSensingEvents(item: SensingTrace, trace?: ConversationMessage["cognitionTrace"]) {
  if (!trace?.eventDecisions?.length || !item.observation) return [];
  return trace.eventDecisions.filter((event) => {
    const source = `${event.sourceLabel}\n${event.sourceText}`;
    return source.includes(item.label) || source.includes(item.observation ?? "");
  });
}

function uniqueSensingTraces(items: SensingTrace[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.at}:${item.modality}:${item.label}:${item.status}:${item.observation ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function RelatedMemories({ ids, profile }: { ids: string[]; profile: CreatureProfile }) {
  const seen = new Set<string>();
  const memories = ids
    .filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
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
  if (result.kind === "hermes_task") {
    return (
      <div className="trace-action-result">
        <b>虾虾任务</b>
        {result.title ? <p>{result.title}</p> : null}
        {result.text ? <small>{result.text}</small> : null}
        {result.hermesTaskId ? <small>异步任务已发送</small> : null}
      </div>
    );
  }
  if (result.kind === "illustration_draft" || result.kind === "illustration") {
    return (
      <div className="trace-action-result">
        <b>{result.kind === "illustration" ? "插画已生成" : "插画草稿"}</b>
        {result.title ? <p>{result.title}</p> : null}
        {result.caption ? <small>说明：{result.caption}</small> : null}
        {result.prompt ? <small>提示词：{result.prompt}</small> : null}
        {result.style ? <small>风格：{result.style}</small> : null}
        {result.sourceIds?.length ? <small>基于 {result.sourceIds.length} 条真实素材</small> : null}
        {result.attachment ? <AttachmentStrip attachments={[result.attachment]} /> : null}
      </div>
    );
  }
  return null;
}

function actionTraceItems(items: string[]) {
  return items.filter((item) => /^(intent=|action_reason=|should_reply=|action_result=|state_delta=|guardrail: action=)/.test(item));
}

function actionStateDeltaItems(items?: Array<{ key: string; before: number; after: number; delta: number }>) {
  return (items ?? []).map((item) => `状态 ${item.key}: ${item.before} -> ${item.after} (${item.delta > 0 ? "+" : ""}${item.delta})`);
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
    continue: "用户补充反馈",
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
  targetType: "memory" | "episode" | "candidate";
  operation: "created" | "updated" | "purged" | "unchanged";
}) {
  const target = change.targetType === "memory" ? "记忆" : change.targetType === "candidate" ? "候选" : "经历";
  const operation = {
    created: "已创建",
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
    draft_question_list: "问题清单",
    use_hermes: "问虾虾",
    generate_illustration: "生成插画"
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
  onDream: () => void;
  busy: boolean;
  feedbackPendingKey?: string;
}) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"all" | "candidate" | "long">("all");
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState("");
  const memories = [...(props.profile.longTermMemories ?? [])]
    .filter((memory) => `${memory.text} ${memory.kind} ${(memory.tags ?? []).join(" ")}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const otherMemories = memories.filter((memory) => memory.kind !== "creature_self_memory");
  const candidates = [...(props.profile.memoryCandidates ?? [])]
    .filter((candidate) => candidate.status === "candidate")
    .filter((candidate) => `${candidate.candidateText} ${candidate.memoryKind} ${(candidate.tags ?? []).join(" ")}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const showCandidates = view === "all" || view === "candidate";
  const showLongTerm = view === "all" || view === "long";

  return (
    <section className="stack">
      <div className="panel">
        <PanelTitle icon={History} title="Papo 记得的生活" />
        <p className="muted">候选是 Papo 还在拿捏的记忆，长期记忆是已经留下来的回忆。你可以分别维护它们。</p>
        <button className="dream-button" onClick={props.onDream} disabled={props.busy}>
          <Sparkles size={16} />
          整理记忆
        </button>
        <div className="segmented-control" role="group" aria-label="选择记忆类型">
          <button className={view === "all" ? "active" : ""} onClick={() => setView("all")}>全部</button>
          <button className={view === "candidate" ? "active" : ""} onClick={() => setView("candidate")}>候选 {candidates.length}</button>
          <button className={view === "long" ? "active" : ""} onClick={() => setView("long")}>长期 {otherMemories.length}</button>
        </div>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="找一找哪件事" />
        {showCandidates && candidates.length ? (
          <section className="memory-section">
            <h3>候选记忆</h3>
            {candidates.map((candidate, index) => (
              <MemoryCandidateCard
                candidate={candidate}
                profile={props.profile}
                key={`candidate-${candidate.id}-${index}`}
                onFeedback={props.onFeedback}
                onObserveFeedbackAudio={props.onObserveFeedbackAudio}
                feedbackPendingKey={props.feedbackPendingKey}
              />
            ))}
          </section>
        ) : null}
        {showLongTerm && otherMemories.length ? (
          <section className="memory-section">
            <h3>长期记忆</h3>
            {otherMemories.map((memory, index) => (
          <article className="memory-surface" key={`long-${memory.id}-${index}`}>
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
              <button onClick={() => props.onFeedback("important", memory.id, undefined, "button")} disabled={props.busy || isFeedbackPending(props.feedbackPendingKey, "important", memory.id)}>
                <Save size={16} />
                {isFeedbackPending(props.feedbackPendingKey, "important", memory.id) ? "尝试中" : "很重要"}
              </button>
              <button onClick={() => props.onFeedback("remind", memory.id, undefined, "button")} disabled={props.busy || isFeedbackPending(props.feedbackPendingKey, "remind", memory.id)}>
                <Lightbulb size={16} />
                {isFeedbackPending(props.feedbackPendingKey, "remind", memory.id) ? "尝试中" : "提醒我"}
              </button>
              <button onClick={() => props.onFeedback("forget", memory.id)} disabled={props.busy || isFeedbackPending(props.feedbackPendingKey, "forget", memory.id)}>
                <RefreshCcw size={16} />
                {isFeedbackPending(props.feedbackPendingKey, "forget", memory.id) ? "尝试中" : memory.weight <= 0 ? "彻底忘掉" : "忘掉"}
              </button>
            </div>
            <MemoryFeedbackBox
              targetId={memory.id}
              onFeedback={props.onFeedback}
              onObserveFeedbackAudio={props.onObserveFeedbackAudio}
              pending={isFeedbackPending(props.feedbackPendingKey, "continue", memory.id)}
            />
            <MemoryTraceList memory={memory} profile={props.profile} />
          </article>
            ))}
          </section>
        ) : null}
        {(showCandidates && candidates.length) || (showLongTerm && otherMemories.length) ? null : <p className="muted">这里还没有符合筛选的记忆。</p>}
      </div>
    </section>
  );
}

function MemoryCandidateCard(props: {
  candidate: CreatureProfile["memoryCandidates"][number];
  profile: CreatureProfile;
  onFeedback: (kind: FeedbackKind, targetId?: string, content?: string, modality?: "text" | "audio_observation" | "button") => void;
  onObserveFeedbackAudio: (file: File) => Promise<string>;
  feedbackPendingKey?: string;
}) {
  const sourceEpisode = props.profile.episodes.find((episode) => episode.id === props.candidate.sourceEpisodeId);
  return (
    <article className="memory-surface candidate-memory">
      <div className="memory-main">
        <div>
          <span>{formatPapoDateTime(props.candidate.createdAt)} · 候选 · {memoryKindLabel(props.candidate.memoryKind)}</span>
          <strong className="memory-text-preview">{normalizeMemoryText(props.candidate.candidateText)}</strong>
        </div>
        {shouldShowFullMemoryText(props.candidate.candidateText) ? (
          <details className="memory-details memory-full-text">
            <summary>完整内容</summary>
            <p>{normalizeMemoryText(props.candidate.candidateText)}</p>
          </details>
        ) : null}
        <AttachmentStrip attachments={props.candidate.attachments} />
        {sourceEpisode ? (
          <details className="memory-details">
            <summary>来源</summary>
            <div className="memory-detail-body">
              <div>
                <span>来自这次经历</span>
                <p>{episodeUserLine(sourceEpisode, episodeSourceMessages(props.profile, sourceEpisode))}</p>
              </div>
            </div>
          </details>
        ) : null}
      </div>
      <div className="memory-actions">
        <button onClick={() => props.onFeedback("remember", props.candidate.id, undefined, "button")} disabled={isFeedbackPending(props.feedbackPendingKey, "remember", props.candidate.id)}>
          <Save size={16} />
          {isFeedbackPending(props.feedbackPendingKey, "remember", props.candidate.id) ? "尝试中" : "长期记住"}
        </button>
        <button onClick={() => props.onFeedback("important", props.candidate.id, undefined, "button")} disabled={isFeedbackPending(props.feedbackPendingKey, "important", props.candidate.id)}>
          <Lightbulb size={16} />
          {isFeedbackPending(props.feedbackPendingKey, "important", props.candidate.id) ? "尝试中" : "很重要"}
        </button>
        <button onClick={() => props.onFeedback("forget", props.candidate.id, undefined, "button")} disabled={isFeedbackPending(props.feedbackPendingKey, "forget", props.candidate.id)}>
          <RefreshCcw size={16} />
          {isFeedbackPending(props.feedbackPendingKey, "forget", props.candidate.id) ? "尝试中" : "放下"}
        </button>
      </div>
      <MemoryFeedbackBox
        targetId={props.candidate.id}
        onFeedback={props.onFeedback}
        onObserveFeedbackAudio={props.onObserveFeedbackAudio}
        pending={isFeedbackPending(props.feedbackPendingKey, "continue", props.candidate.id)}
      />
    </article>
  );
}

function MemoryMainLines({ memory, profile }: { memory: CreatureProfile["longTermMemories"][number]; profile: CreatureProfile }) {
  const sourceEpisode = memorySourceEpisode(memory, profile);

  return (
    <div className="memory-main">
      <div>
        <span>{formatPapoDateTime(memory.createdAt)}</span>
        <strong className="memory-text-preview">{memoryResultLine(memory)}</strong>
      </div>
      {shouldShowFullMemoryText(memoryResultLine(memory)) ? (
        <details className="memory-details memory-full-text">
          <summary>完整记忆</summary>
          <p>{memoryResultLine(memory)}</p>
        </details>
      ) : null}
      <AttachmentStrip attachments={memory.attachments} />
      {sourceEpisode ? (
        <details className="memory-details">
          <summary>详情</summary>
          <div className="memory-detail-body">
            <div>
              <span>你当时说</span>
              <p>{episodeUserLine(sourceEpisode, episodeSourceMessages(profile, sourceEpisode))}</p>
              <AttachmentStrip attachments={sourceEpisode.attachments} />
            </div>
            {episodePapoLine(sourceEpisode) ? (
              <div>
                <span>Papo 当时回你</span>
                <p>{episodePapoLine(sourceEpisode)}</p>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function MemoryTraceList({ memory, profile }: { memory: CreatureProfile["longTermMemories"][number]; profile: CreatureProfile }) {
  const traces = memoryTraceMessages(memory, profile);
  if (!traces.length) return null;
  return (
    <details className="memory-trace-list">
      <summary aria-label="查看这条记忆背后的模型流程">
        <Eye size={14} />
        小眼睛
      </summary>
      <div className="memory-trace-stack">
        {traces.map((message) => (
          <section className="memory-trace-item" key={message.id}>
            <strong>{memoryTraceTitle(message)}</strong>
            <small>{formatPapoDateTime(message.at)}</small>
            {message.cognitionTrace ? <DeveloperTraceBody trace={message.cognitionTrace} profile={profile} /> : null}
          </section>
        ))}
      </div>
    </details>
  );
}

function memoryTraceMessages(memory: CreatureProfile["longTermMemories"][number], profile: CreatureProfile) {
  const sourceEpisodeId = memory.sourceEpisodeId;
  return (profile.conversation ?? [])
    .filter((message) => {
      const trace = message.cognitionTrace;
      if (!trace) return false;
      if (message.relatedMemoryIds?.includes(memory.id)) return true;
      if (trace.feedbackDecision?.targetId === memory.id) return true;
      if (trace.feedbackDecision?.memoryChanges?.some((change) => change.targetId === memory.id)) return true;
      if (sourceEpisodeId && trace.feedbackDecision?.memoryChanges?.some((change) => change.targetId === sourceEpisodeId)) return true;
      if (sourceEpisodeId && trace.memoryDecisions?.some((decision) => decision.sourceEpisodeId === sourceEpisodeId)) return true;
      return false;
    })
    .slice(0, 4);
}

function memoryTraceTitle(message: ConversationMessage) {
  const source = message.cognitionTrace?.source;
  if (source === "feedback") return "反馈怎样改变它";
  if (source === "emergence") return "Papo 后来怎样想起它";
  if (source === "curious_stream" || source === "button") return "它当时怎样被理解";
  return "模型流程";
}

function MemoryFeedbackBox(props: {
  targetId: string;
  onFeedback: (kind: FeedbackKind, targetId?: string, content?: string, modality?: "text" | "audio_observation" | "button") => void;
  onObserveFeedbackAudio: (file: File) => Promise<string>;
  pending?: boolean;
}) {
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackModality, setFeedbackModality] = useState<"text" | "audio_observation">("text");
  function submit() {
    const content = feedbackText.trim();
    if (!content || props.pending) return;
    props.onFeedback("continue", props.targetId, content, feedbackModality);
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
            accept="audio/webm,audio/wav,audio/mpeg,audio/mp3,audio/mp4,audio/m4a,audio/ogg,audio/aac"
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
        <button className="primary" onClick={submit} disabled={!feedbackText.trim() || props.pending}>
          <MessageCircle size={16} />
          {props.pending ? "发送中" : "发送反馈"}
        </button>
      </div>
    </details>
  );
}

function ProfileView(props: {
  profile: CreatureProfile;
  onLogout: () => void;
}) {
  return (
    <section className="stack">
      <div className="panel">
        <PanelTitle icon={UserRound} title="账号" />
        <div className="account-card">
          <AvatarPreview petKind={props.profile.petKind} state={props.profile.state} dogState={props.profile.dogState} />
          <div>
            <strong>{props.profile.creatureName}</strong>
            <span>User ID：{props.profile.userId}</span>
            <span>小动物：{petKindLabel(props.profile.petKind)}</span>
            <span>默认时间：{papoTimeZone}</span>
          </div>
        </div>
        <button onClick={props.onLogout}>
          <RefreshCcw size={18} />
          退出登录
        </button>
      </div>
    </section>
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

function EmergenceCard({ emergence, profile }: { emergence: EmergenceSurface; profile: CreatureProfile }) {
  return (
    <section className="memory-surface active">
      <div className="emergence-card-head">
        <strong>Papo 想起一件事</strong>
        {emergence.cognitionTrace ? <DeveloperTrace trace={emergence.cognitionTrace} profile={profile} /> : null}
      </div>
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

function shouldShowFullMemoryText(text: string) {
  return normalizeMemoryText(text).length > 90;
}

function memoryKindLabel(kind: CreatureProfile["longTermMemories"][number]["kind"]) {
  const labels: Record<CreatureProfile["longTermMemories"][number]["kind"], string> = {
    user_preference: "偏好",
    long_theme: "长期主题",
    creature_self_memory: "成长",
    safety_rule: "边界",
    future_review: "以后回看",
    relationship: "关系",
    habit: "习惯",
    open_question: "开放问题"
  };
  return labels[kind] ?? kind;
}

function normalizeMemoryText(text: string) {
  return toCreatureMemoryVoice(text)
    .replace(/^用户(?=喜欢|讨厌|正在|准备|希望|担心|提到|说|觉得|认为|想|需要|不喜欢|习惯|经常|已经|今天|明天|最近|曾经)/, "你")
    .replace(/^用户[：:]\s*/, "你：")
    .replace(/^关于用户[：:]\s*/, "关于你：")
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

function chatBubbleText(message: ConversationMessage) {
  if (message.displayText?.trim()) return visibleCreatureText(message.displayText);
  const text = visibleMessageText(message);
  if (message.modality === "audio_observation") return audioObservationPreview(text);
  if (message.modality === "image_summary") return imageSummaryPreview(text);
  return text;
}

function latestVisiblePapoReply(profile: CreatureProfile) {
  const latest = profile.conversation?.find((message) => message.role === "papo" && message.channel !== "wake");
  const text = visiblePapoReplyText(latest?.text);
  if (!text) return "";
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
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

function NavButton(props: { active: boolean; icon: typeof Check; label: string; unreadCount?: number; onClick: () => void }) {
  return (
    <button className={props.active ? "active" : ""} onClick={props.onClick}>
      <props.icon size={19} />
      <span>
        {props.label}
        {props.unreadCount ? <i className="unread-dot" aria-label={`${props.unreadCount} 条未读 Papo 回复`}>{Math.min(9, props.unreadCount)}</i> : null}
      </span>
    </button>
  );
}

function HermesTaskNotice({ profile }: { profile: CreatureProfile }) {
  const activeTasks = (profile.hermes?.tasks ?? []).filter((task) => task.status === "pending" || task.status === "sent");
  if (!activeTasks.length) return null;
  return (
    <div className="hermes-notice">
      <Sparkles size={16} />
      <span>正在召唤好朋友虾虾...</span>
      <small>{activeTasks[0].title ?? "外部任务处理中"}</small>
    </div>
  );
}

function feedbackActionKey(kind: FeedbackKind, targetId?: string) {
  return `${kind}:${targetId ?? ""}`;
}

function isFeedbackPending(pendingKey: string | undefined, kind: FeedbackKind, targetId?: string) {
  return pendingKey === feedbackActionKey(kind, targetId);
}

function countUnreadPapoMessages(profile: CreatureProfile | undefined) {
  const messages = (profile?.conversation ?? []).filter((message) => message.role === "papo" && message.channel !== "wake");
  if (!messages.length) return 0;
  const readMessageId = profile?.readState?.lastReadPapoMessageId;
  const count = readMessageId ? messages.findIndex((message) => message.id === readMessageId) : Math.min(messages.length, 3);
  if (count < 0) return Math.min(messages.length, 3);
  return Math.min(count, 3);
}

function readSavedUserId() {
  return window.localStorage.getItem(LOCAL_USER_ID_KEY)?.trim() || "";
}

function saveUserId(userId: string) {
  window.localStorage.setItem(LOCAL_USER_ID_KEY, userId);
}

function forgetSavedUserId() {
  window.localStorage.removeItem(LOCAL_USER_ID_KEY);
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

function stagedSegmentReady(segment: StagedChatSegment | StreamSegment) {
  return !("status" in segment) || !segment.status || segment.status === "ready";
}

function revokeStagedPreviewUrls(segments: StagedChatSegment[]) {
  for (const segment of segments) {
    if (segment.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(segment.previewUrl);
  }
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

async function readImageFileAsUploadDataUrl(file: File) {
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) throw new Error("请选择 PNG、JPG 或 WebP 图片。");
  const dataUrl = await compressImageForUpload(file);
  if (dataUrl.length > IMAGE_UPLOAD_HARD_LIMIT_BYTES) throw new Error("这张照片没有压缩成功，请再试一次。");
  return dataUrl;
}

async function compressImageForUpload(file: File) {
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(sourceUrl);
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器暂时不能处理这张照片。");
    let smallest = "";
    for (const maxSide of [1600, 1280, 1024, 768, 512, 384, 256]) {
      const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.82, 0.74, 0.66, 0.58, 0.5, 0.42]) {
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        if (!smallest || dataUrl.length < smallest.length) smallest = dataUrl;
        if (dataUrl.length <= IMAGE_UPLOAD_TARGET_BYTES) return dataUrl;
      }
    }
    if (smallest && smallest.length <= IMAGE_UPLOAD_HARD_LIMIT_BYTES) return smallest;
    throw new Error("这张照片没有压缩成功，请再试一次。");
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function loadImageElement(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("这张照片没有读出来。"));
    image.src = url;
  });
}

function browserImageMime(type: string): "image/png" | "image/jpeg" | "image/webp" {
  if (type === "image/png" || type === "image/webp") return type;
  return "image/jpeg";
}

function imageUploadErrorMessage(error: unknown) {
  const message = errorMessage(error);
  if (/Invalid request|too large|PayloadTooLarge|request entity too large|body exceeded|Image is too large/i.test(message)) return "照片没有压缩成功，请再试一次。";
  return message;
}

async function readAudioFileAsDataUrl(file: File) {
  return normalizeAudioDataUrl(await readFileAsDataUrl(file), file.name);
}

function normalizeAudioDataUrl(dataUrl: string, fileName: string) {
  if (/^data:audio\//.test(dataUrl)) return dataUrl;
  const mime = audioMimeFromFileName(fileName);
  if (!mime) return dataUrl;
  return dataUrl.replace(/^data:[^,]*;base64,/, `data:${mime};base64,`);
}

function audioMimeFromFileName(fileName: string) {
  const extension = fileName.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    webm: "audio/webm",
    wav: "audio/wav",
    wave: "audio/wav",
    mp3: "audio/mpeg",
    mpeg: "audio/mpeg",
    mp4: "audio/mp4",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    aac: "audio/aac"
  };
  return extension ? map[extension] : undefined;
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

function formatListeningTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
