import {
  Bell,
  BellOff,
  Camera,
  Check,
  ChevronRight,
  ArrowLeft,
  Download,
  Eye,
  HelpCircle,
  History,
  ImagePlus,
  Images,
  Lightbulb,
  Loader2,
  MessageCircle,
  MessagesSquare,
  Mic,
  Plus,
  PawPrint,
  RefreshCcw,
  RotateCcw,
  Save,
  Settings,
  Send,
  Sparkles,
  Smartphone,
  Square,
  Play,
  UserRound,
  X
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { audioObservationPreview, imageSummaryPreview } from "../core/display-text";
import { memoryShortTitle, toCreatureMemoryVoice } from "../core/memory";
import { PET_KINDS, normalizePetKind, petKindLabel, petKindMeta } from "../core/pet-kinds";
import type {
  ActionResult,
  CreatureProfile,
  CreatureState,
  DogInteractionState,
  EpisodeMemory,
  FeedbackKind,
  MediaAttachment,
  MessageCognitionTrace,
  SegmentKind,
  SensingTrace,
  StreamSegment
} from "../core/types";
import {
  activeEmergence,
  acceptConversationTurn,
  buttonCapture,
  createProfile,
  dreamMemories,
  dismissConversationJob,
  generateInitialActionCards,
  getProfile,
  registerCompanionSession,
  endCompanionSession,
  loginProfile,
  makeSegment,
  markPapoRead,
  resolveAssetUrl,
  revokeDeviceSessions,
  sendFeedback,
  summarizeImage,
  observeAudio,
  observeCameraFrame,
  touchPet,
  updateLongTermMemory,
  updateActionCard,
  updatePetProfile,
  updateProfileName,
  updateProfilePassword,
  wakeProfile
} from "./api";
import {
  audioSliceBatchId,
  currentLiveBatchId,
  imageSegmentContent,
  liveBatchBoundaryMs as liveBatchBoundaryFor,
  LIVE_BATCH_AUDIO_GRACE_MS,
  LIVE_BATCH_MAX_WAIT_MS,
  LIVE_BATCH_MS,
  LIVE_LISTENING_DURATION_OPTIONS,
  LIVE_LISTENING_DEFAULT_MS,
  shouldSuppressForcedAudioSlice
} from "./live-listening";

type ActionCardDisplayMode = "disabled" | "static" | "dynamic";
type ActionCardUpdate = { displayMode?: ActionCardDisplayMode; disabled?: boolean; deleted?: boolean };
import {
  clearNativeListeningCredentials,
  getNativeListeningStatus,
  onNativeListeningEvent,
  startNativeListening,
  stopNativeListening,
  supportsNativeListening,
  type CameraFacing,
  type ListeningMode,
  type NativeListeningStatus
} from "./native-listening";
import {
  disablePushNotifications,
  enablePushNotifications,
  inspectPushNotifications,
  pushNotificationStateText,
  syncExistingPushSubscription,
  type PushNotificationState
} from "./push-notifications";
import { inspectAppUpdate, openAppUpdateDownload, type AppUpdateState } from "./app-update";
import { MediaThumbnail } from "./MediaViewer";
import type { MediaViewerItem } from "./media-viewer-types";
import { formatPapoDateTime, papoTimeZone } from "./time";

type Tab = "home" | "chat" | "memory" | "profile";

interface EmergenceSurface {
  text: string;
  memoryId?: string;
  cognitionTrace?: MessageCognitionTrace;
}

type ConversationMessage = CreatureProfile["conversation"][number];
type ConversationSection =
  | { kind: "live"; id: string; sessionKey: string; messages: ConversationMessage[] }
  | { kind: "batch"; id: string; batchId: string; messages: ConversationMessage[] }
  | { kind: "single"; id: string; message: ConversationMessage };

const CHAT_PAGE_SIZE = 24;
const INITIAL_CHAT_VISIBLE_COUNT = CHAT_PAGE_SIZE * 2;
const LOCAL_USER_ID_KEY = "papo:userId";
const LOCAL_PASSWORD_PREFIX = "papo:password:";
const LOCAL_PROFILE_SNAPSHOT_KEY = "papo:profileSnapshot";
const PUBLIC_BASE_URL = import.meta.env.BASE_URL ?? "/";
const IMAGE_UPLOAD_TARGET_BYTES = 3_500_000;

function initialAppRoute(): { tab: Tab; memoryId?: string } {
  const params = new URLSearchParams(window.location.search);
  const open = params.get("open");
  const tab: Tab = open === "chat" || open === "memory" || open === "profile" ? open : "home";
  const memoryId = tab === "memory" ? params.get("memory")?.trim() || undefined : undefined;
  return { tab, memoryId };
}

function requestMemoryNavigation(memoryId: string) {
  window.dispatchEvent(new CustomEvent("papo:open-memory", { detail: memoryId }));
}
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
  uploadDataUrl?: string;
};

export function App() {
  const [tab, setTab] = useState<Tab>(() => initialAppRoute().tab);
  const [targetMemoryId, setTargetMemoryId] = useState<string | undefined>(() => initialAppRoute().memoryId);
  const [profile, setProfile] = useState<CreatureProfile>();
  const [loadingPetKind] = useState(() => randomRegistrationPetKind());
  const [loadingProfileSnapshot, setLoadingProfileSnapshot] = useState<Partial<CreatureProfile> | undefined>(() => readProfileSnapshot());
  const [needsAuth, setNeedsAuth] = useState(false);
  const [chatSegments, setChatSegments] = useState<StagedChatSegment[]>([]);
  const [emergence, setEmergence] = useState<EmergenceSurface>();
  const [listening, setListening] = useState(false);
  const [listeningElapsed, setListeningElapsed] = useState(0);
  const [listeningDurationMs, setListeningDurationMs] = useState(LIVE_LISTENING_DEFAULT_MS);
  const [listeningMode, setListeningMode] = useState<ListeningMode>("listen");
  const [listeningDurationPickerOpen, setListeningDurationPickerOpen] = useState(false);
  const [quickRecording, setQuickRecording] = useState(false);
  const [quickAudioProcessing, setQuickAudioProcessing] = useState(false);
  const [quickRecordingElapsed, setQuickRecordingElapsed] = useState(0);
  const [feedbackPendingKey, setFeedbackPendingKey] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
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
  const cameraObservationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const liveBatchBuffersRef = useRef<Map<string, LiveBatchBuffer>>(new Map());
  const segmentIndexRef = useRef(1);
  const lastAudioSliceRequestAtRef = useRef(0);
  const lastCameraCaptureAtRef = useRef(0);
  const listeningStartedAtRef = useRef<number | undefined>(undefined);
  const listeningDurationMsRef = useRef(LIVE_LISTENING_DEFAULT_MS);
  const listeningModeRef = useRef<ListeningMode>("listen");
  const nativeListeningActiveRef = useRef(false);
  const profileRef = useRef<CreatureProfile | undefined>(undefined);
  const retryTurnRef = useRef<{ signature: string; turnId: string } | undefined>(undefined);
  const tickTimerRef = useRef<number | undefined>(undefined);
  const segmentTimerRef = useRef<number | undefined>(undefined);
  const stopTimerRef = useRef<number | undefined>(undefined);

  const latestPapoMessage = useMemo(
    () => profile?.conversation?.find((message) => message.role === "papo" && message.channel !== "wake"),
    [profile?.conversation]
  );
  const unreadPapoCount = useMemo(() => countUnreadPapoMessages(profile), [profile?.conversation, profile?.readState?.lastReadPapoMessageId]);
  const hasUnreadPapoMessage = unreadPapoCount > 0;
  const hasActiveConversationJobs = useMemo(
    () => (profile?.jobs ?? []).some((job) => job.status === "queued" || job.status === "running"),
    [profile?.jobs]
  );
  const hasActiveHermesTask = useMemo(
    () => Boolean(profile?.hermes?.tasks?.some((task) => task.status === "pending" || task.status === "sent")),
    [profile?.hermes?.tasks]
  );

  const navigateTab = useCallback((nextTab: Tab, push = true) => {
    setTab(nextTab);
    setTargetMemoryId(undefined);
    const url = new URL(window.location.href);
    if (nextTab === "home") url.searchParams.delete("open");
    else url.searchParams.set("open", nextTab);
    url.searchParams.delete("memory");
    window.history[push ? "pushState" : "replaceState"]({ ...(window.history.state ?? {}), papoTab: nextTab }, "", url);
  }, []);

  const openMemory = useCallback((memoryId?: string, push = true) => {
    setTab("memory");
    setTargetMemoryId(memoryId);
    const url = new URL(window.location.href);
    url.searchParams.set("open", "memory");
    if (memoryId) url.searchParams.set("memory", memoryId);
    else url.searchParams.delete("memory");
    if (push && memoryId && window.history.state?.papoTab !== "memory") {
      const listUrl = new URL(url);
      listUrl.searchParams.delete("memory");
      window.history.pushState({ ...(window.history.state ?? {}), papoTab: "memory", memoryId: undefined }, "", listUrl);
    }
    window.history[push ? "pushState" : "replaceState"]({ ...(window.history.state ?? {}), papoTab: "memory", memoryId }, "", url);
  }, []);

  useEffect(() => {
    if (!window.history.state?.papoTab) {
      const route = initialAppRoute();
      if (route.tab === "memory" && route.memoryId) {
        const detailUrl = new URL(window.location.href);
        const listUrl = new URL(detailUrl);
        listUrl.searchParams.delete("memory");
        window.history.replaceState({ ...(window.history.state ?? {}), papoTab: "memory", memoryId: undefined }, "", listUrl);
        window.history.pushState({ ...(window.history.state ?? {}), papoTab: "memory", memoryId: route.memoryId }, "", detailUrl);
      } else {
        window.history.replaceState({ ...(window.history.state ?? {}), papoTab: route.tab, memoryId: route.memoryId }, "");
      }
    }
    const restoreRoute = () => {
      const state = window.history.state as { papoTab?: Tab; memoryId?: string } | null;
      if (!state?.papoTab) return;
      setTab(state.papoTab);
      setTargetMemoryId(state.papoTab === "memory" ? state.memoryId : undefined);
    };
    const handleMemoryLink = (event: Event) => openMemory((event as CustomEvent<string>).detail);
    window.addEventListener("popstate", restoreRoute);
    window.addEventListener("papo:open-memory", handleMemoryLink);
    return () => {
      window.removeEventListener("popstate", restoreRoute);
      window.removeEventListener("papo:open-memory", handleMemoryLink);
    };
  }, [openMemory]);
  const pendingActionCards = useMemo(() => countPendingActionCards(profile), [profile?.jobs, profile?.actionCards, profile?.conversation, profile?.emergenceHistory]);
  const pendingPetMotions = profile ? petProfileFor(profile).initialMotion?.status === "pending" : false;

  useEffect(() => {
    void bootstrap();
    return () => {
      if (nativeListeningActiveRef.current) clearListeningTimers();
      else stopListening();
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
    if (profile) {
      saveProfileSnapshot(profile);
      setLoadingProfileSnapshot(profile);
    }
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
    const intervalMs = hasActiveConversationJobs || hasActiveHermesTask || pendingActionCards > 0 || pendingPetMotions ? 3_000 : 60_000;
    const timer = window.setInterval(async () => {
      try {
        const next = await getProfile(profile.userId);
        setProfile(next);
      } catch {
        // Polling is only for passive proactive-message sync; user actions still surface errors.
      }
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [hasActiveConversationJobs, hasActiveHermesTask, pendingActionCards, pendingPetMotions, profile?.userId]);

  useEffect(() => {
    if (!profile?.userId) return;
    void syncExistingPushSubscription(profile.userId).catch(() => undefined);
  }, [profile?.userId]);

  useEffect(() => {
    if (!profile?.userId || !supportsNativeListening()) return;
    let active = true;
    let listener: Awaited<ReturnType<typeof onNativeListeningEvent>> | undefined;
    const refreshStatus = async () => {
      const status = await getNativeListeningStatus();
      if (active) applyNativeListeningStatus(status);
    };
    void refreshStatus().catch(() => undefined);
    void onNativeListeningEvent((event) => {
      if (!active) return;
      if (event.event === "batch-uploaded") {
        void getProfile(profile.userId).then(setProfile).catch(() => undefined);
      }
      if (event.event === "completed" || event.event === "stopped") {
        markActiveCompanionSessionEnded();
        clearNativeListeningUi();
      }
      if (event.event === "error") {
        setError(nativeListeningError(event.error));
        void refreshStatus();
      }
    }).then((handle) => {
      listener = handle;
    });
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshStatus().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      void listener?.remove();
    };
  }, [profile?.userId]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handleServiceWorkerMessage = (event: MessageEvent<{ type?: string; userId?: string }>) => {
      if (event.data?.type === "PAPO_OPEN_CHAT") setTab("chat");
      if (event.data?.type !== "PAPO_PUSH_MESSAGE" || !profileRef.current?.userId) return;
      if (event.data.userId && event.data.userId !== profileRef.current.userId) return;
      void getProfile(profileRef.current.userId).then(setProfile).catch(() => undefined);
    };
    navigator.serviceWorker.addEventListener("message", handleServiceWorkerMessage);
    return () => navigator.serviceWorker.removeEventListener("message", handleServiceWorkerMessage);
  }, []);

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

  async function login(userId: string, password?: string): Promise<{ ok: boolean; passwordRequired?: boolean }> {
    try {
      setBusy(true);
      setError(undefined);
      const cleanUserId = userId.trim();
      const active = await loginProfile(cleanUserId, password);
      saveProfilePassword(active.userId, password);
      const woke = await wakeProfile(active.userId);
      saveUserId(active.userId);
      setNeedsAuth(false);
      setProfile(woke.profile);
      setTab("home");
      return { ok: true };
    } catch (caught) {
      const rawMessage = caught instanceof Error ? caught.message : "";
      const message = errorMessage(caught);
      if (rawMessage === "Password required") return { ok: false, passwordRequired: true };
      setError(message);
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }

  async function register(userId: string, petKind: string) {
    await run(async () => {
      const cleanUserId = userId.trim();
      const active = await createProfile({ userId: cleanUserId, creatureName: "Papo", petKind });
      saveProfilePassword(active.userId);
      const woke = await wakeProfile(active.userId);
      saveUserId(active.userId);
      setNeedsAuth(false);
      setProfile(woke.profile);
      setTab("home");
    });
  }

  async function logout() {
    stopListening();
    if (profile?.userId) {
      await clearNativeListeningCredentials().catch(() => undefined);
      await revokeDeviceSessions(profile.userId).catch(() => undefined);
      await disablePushNotifications(profile.userId).catch(() => undefined);
      forgetProfilePassword(profile.userId);
    }
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
    const signature = `text:${cleanText}`;
    const turnId = retryTurnRef.current?.signature === signature ? retryTurnRef.current.turnId : clientTurnId();
    retryTurnRef.current = { signature, turnId };
    setError(undefined);
    try {
      const accepted = await acceptConversationTurn(profile.userId, {
        turnId,
        requestId: turnId,
        channel: "button",
        segments: [{ id: `${turnId}-text`, kind: "text", label: "你刚说的话", content: cleanText, observedAt: new Date().toISOString() }]
      });
      retryTurnRef.current = undefined;
      setProfile(accepted.profile);
      setTab(nextTab);
    } catch (caught) {
      setError(errorMessage(caught));
      throw caught;
    }
  }

  async function changePassword(currentPassword: string, newPassword: string) {
    if (!profile) return;
    const next = await updateProfilePassword(profile.userId, {
      currentPassword: currentPassword.trim() || undefined,
      newPassword: newPassword.trim() || undefined
    });
    saveProfilePassword(next.userId, newPassword.trim() || undefined);
    setProfile(next);
  }

  async function renameCreature(creatureName: string) {
    if (!profile) return;
    const cleanName = creatureName.trim();
    if (!cleanName || cleanName === profile.creatureName) return;
    await run(async () => {
      const next = await updateProfileName(profile.userId, cleanName);
      setProfile(next);
    });
  }

  async function changePetProfile(input: { guidance?: string; referenceSummary?: string; referenceAttachment?: MediaAttachment }) {
    if (!profile) return;
    const next = await updatePetProfile(profile.userId, input);
    setProfile(next);
  }

  async function startInitialActionCards(guidance?: string) {
    if (!profile) return;
    const next = await generateInitialActionCards(profile.userId, guidance);
    setProfile(next);
  }

  async function changeActionCard(cardId: string, input: ActionCardUpdate) {
    if (!profile) return;
    await run(async () => {
      const next = await updateActionCard(profile.userId, cardId, input);
      setProfile(next);
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
    const readySegments = chatSegments.filter((segment) => stagedSegmentReady(segment));
    const signature = JSON.stringify([cleanText, ...readySegments.map((segment) => [segment.id, segment.kind, segment.label])]);
    const turnId = retryTurnRef.current?.signature === signature ? retryTurnRef.current.turnId : clientTurnId();
    retryTurnRef.current = { signature, turnId };
    const segments = [
      ...(cleanText ? [{
        id: `${turnId}-text`,
        kind: "text" as const,
        label: listening ? "你补充的话" : "你刚说的话",
        content: cleanText,
        observedAt: new Date().toISOString(),
        batchId: listening ? currentBatchId() : undefined,
        companionSessionId: listening ? currentCompanionSessionId() : undefined
      }] : []),
      ...readySegments.map((segment, index) => ({
        id: `${turnId}-media-${index}`,
        kind: segment.kind,
        label: segment.label,
        content: segment.content || undefined,
        dataUrl: segment.uploadDataUrl,
        observedAt: segment.observedAt,
        batchId: segment.batchId,
        companionSessionId: listening ? currentCompanionSessionId() : segment.companionSessionId,
        location: segment.location
      }))
    ];
    setError(undefined);
    try {
      const accepted = await acceptConversationTurn(profile.userId, {
        turnId,
        requestId: turnId,
        channel: segments.length === 1 && segments[0].kind === "text" ? "button" : "curious",
        segments
      });
      retryTurnRef.current = undefined;
      setProfile(accepted.profile);
      revokeStagedPreviewUrls(chatSegments);
      setChatSegments([]);
      setTab("chat");
    } catch (caught) {
      setError(errorMessage(caught));
      throw caught;
    }
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
      setChatSegments((current) =>
        current.map((segment) =>
          segment.id === localSegmentId
            ? {
                ...segment,
                content: "",
                location,
                status: "ready",
                statusText: "发送后在后台理解",
                displayText: "一张照片",
                uploadDataUrl: dataUrl
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
    try {
      const dataUrl = await readAudioFileAsDataUrl(file);
      const segment = makeSegment(`chat-audio-${Date.now()}`, "audio_observation", file.name || "录音", "", {
        observedAt: new Date().toISOString(),
        batchId: currentBatchId()
      });
      setChatSegments((current) => [
        ...current,
        { ...segment, label: file.name || `录音 ${current.length + 1}`, batchId: current[0]?.batchId ?? segment.batchId, status: "ready", statusText: "发送后在后台转写", uploadDataUrl: dataUrl }
      ]);
      setTab("chat");
    } catch (caught) {
      setError(errorMessage(caught));
    }
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
      setError(`我还听不到麦克风。你可以上传音频，或者先用文字告诉 ${profile.creatureName}。`);
      return;
    }
    if (!stream) {
      setError(`我还没有听到可用的麦克风声音。你可以上传音频，或者先用文字告诉 ${profile.creatureName}。`);
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
        setError(`这次录音断开了。你可以再录一次，或者直接打字告诉 ${profile.creatureName}。`);
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
    setError(undefined);
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || chunks[0]?.type || "audio/webm" });
      const dataUrl = await blobToDataUrl(blob);
      const segment = makeSegment(`chat-mic-${Date.now()}`, "audio_observation", "刚录的一段声音", "", {
        observedAt: new Date().toISOString(),
        batchId: currentBatchId()
      });
      setChatSegments((current) => [
        ...current,
        { ...segment, label: `麦克风 ${current.length + 1}`, batchId: current[0]?.batchId ?? segment.batchId, status: "ready", statusText: "发送后在后台转写", uploadDataUrl: dataUrl }
      ]);
      setTab("chat");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      quickAudioChunksRef.current = [];
      setQuickAudioProcessing(false);
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

  async function handlePetTouch(action: PetInteractionAction) {
    if (!profile) return;
    try {
      const result = await touchPet(profile.userId, action);
      setProfile(result.profile);
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  function openListeningDurationPicker() {
    setTab("chat");
    if (listening) return;
    setListeningDurationPickerOpen(true);
  }

  async function startListening(durationMs = LIVE_LISTENING_DEFAULT_MS, mode: ListeningMode = "listen", cameraFacing: CameraFacing = "front") {
    setTab("chat");
    setListeningDurationPickerOpen(false);
    if (listening) return;
    if (supportsNativeListening()) {
      if (!profile) return;
      try {
        setError(undefined);
        const status = await startNativeListening({
          userId: profile.userId,
          creatureName: profile.creatureName,
          durationMs,
          mode,
          cameraFacing
        });
        applyNativeListeningStatus(status);
        void registerCompanionSession(profile.userId, `native-${status.startedAt}`, new Date(status.startedAt).toISOString()).catch(() => undefined);
      } catch (caught) {
        setError(nativeListeningError(caught instanceof Error ? caught.message : String(caught)));
      }
      return;
    }

    const Recorder = getMediaRecorder();
    if (!Recorder) {
      setError("当前浏览器不支持录音。你可以继续用文字、照片或上传音频。");
      return;
    }

    let stream: MediaStream | undefined;
    let cameraStream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices?.getUserMedia?.({ audio: true });
      if (mode === "watch") {
        cameraStream = await navigator.mediaDevices?.getUserMedia?.({
          video: {
            facingMode: { ideal: cameraFacing === "back" ? "environment" : "user" },
            width: { ideal: 640 },
            height: { ideal: 480 }
          }
        });
      }
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      cameraStream?.getTracks().forEach((track) => track.stop());
      setError(`我还听不到麦克风。你可以先用文字告诉 ${profile?.creatureName ?? "它"}，或者加照片补充。`);
      return;
    }
    if (!stream) {
      setError(`我还没有听到可用的麦克风声音。你可以先用文字告诉 ${profile?.creatureName ?? "它"}，或者加照片补充。`);
      return;
    }

    mediaStreamRef.current = stream;
    if (cameraStream) {
      try {
        await attachCameraStream(cameraStream);
      } catch {
        stream.getTracks().forEach((track) => track.stop());
        cameraStream.getTracks().forEach((track) => track.stop());
        setError("摄像头这次没有准备好，请重新选择陪伴模式。");
        return;
      }
    }
    audioRecorderChunksRef.current = [];
    activeAudioSliceMetaRef.current = undefined;
    audioObservationQueueRef.current = Promise.resolve();
    liveCaptureQueueRef.current = Promise.resolve();
    clearLiveBatchBuffers();
    segmentIndexRef.current = 1;
    lastAudioSliceRequestAtRef.current = 0;
    lastCameraCaptureAtRef.current = 0;
    listeningStartedAtRef.current = Date.now();
    if (profile) {
      const sessionId = `live-${new Date(listeningStartedAtRef.current).toISOString()}`;
      void registerCompanionSession(profile.userId, sessionId, new Date(listeningStartedAtRef.current).toISOString()).catch(() => undefined);
    }
    listeningDurationMsRef.current = durationMs;
    listeningModeRef.current = mode;
    setListeningDurationMs(durationMs);
    setListeningMode(mode);
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
        setError(`这个浏览器暂时没法让 ${profile?.creatureName ?? "它"} 连续听。你可以先写给它，或者加照片补充。`);
        return;
      }
    }

    tickTimerRef.current = window.setInterval(() => {
      if (!listeningStartedAtRef.current) return;
      setListeningElapsed(Math.min(listeningDurationMsRef.current / 1000, Math.floor((Date.now() - listeningStartedAtRef.current) / 1000)));
    }, 1000);
    segmentTimerRef.current = window.setInterval(() => {
      requestAudioSlice(false);
    }, LIVE_BATCH_MS);
    stopTimerRef.current = window.setTimeout(() => stopListening(), durationMs);
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
    return Boolean(startedAt && stream?.active && Date.now() - startedAt < listeningDurationMsRef.current);
  }

  function stopListening() {
    markActiveCompanionSessionEnded();
    if (nativeListeningActiveRef.current) {
      nativeListeningActiveRef.current = false;
      void stopNativeListening().catch((caught) => setError(nativeListeningError(errorMessage(caught))));
      clearNativeListeningUi();
      return;
    }
    stopWebListening();
  }

  function stopWebListening() {
    clearListeningTimers();
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
    if (listeningModeRef.current === "watch") {
      const CAMERA_INTERVAL_MS = 5 * 60_000; // 每 5 分钟拍一帧
      const lastCamera = lastCameraCaptureAtRef.current ?? 0;
      if (now - lastCamera >= CAMERA_INTERVAL_MS) {
        lastCameraCaptureAtRef.current = now;
        captureCameraFrame(meta);
      }
    }
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
    const auditOnly = !content.trim() || result.sensingTrace?.status !== "content";
    const segmentContent = auditOnly ? audioAuditSummary(result.sensingTrace?.status) : content.trim();
    submitLiveSegments([
      {
        ...makeSegment(`live-audio-${Date.now()}-${meta.index}`, "audio_observation", `听到的声音 ${meta.index}`, segmentContent, {
        observedAt: meta.observedAt,
        batchId: meta.batchId
        }),
        auditOnly
      }
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
      const batchId = usefulSegments[0]?.batchId ?? currentBatchId();
      const turnId = `turn_live_${batchId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      const accepted = await acceptConversationTurn(latestProfile.userId, {
        turnId,
        requestId: turnId,
        channel: "curious",
        segments: usefulSegments.map((segment) => ({
          id: segment.id,
          kind: segment.kind,
          label: segment.label,
          content: segment.content,
          observedAt: segment.observedAt,
          batchId: segment.batchId,
          companionSessionId: segment.companionSessionId,
          location: segment.location,
          auditOnly: segment.auditOnly,
          sensingTrace: segment.sensingTrace
        }))
      });
      profileRef.current = accepted.profile;
      setProfile(accepted.profile);
    }).catch((caught) => {
      setError(`${profileRef.current?.creatureName ?? "它"} 刚才整理这一小段时断开了。${errorMessage(caught)}`);
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
      batchId: segment.batchId ?? currentBatchId(),
      companionSessionId: segment.companionSessionId ?? currentCompanionSessionId()
    };
  }

  function currentCompanionSessionId() {
    const startedAt = listeningStartedAtRef.current;
    if (!startedAt) return undefined;
    return nativeListeningActiveRef.current
      ? `native-${startedAt}`
      : `live-${new Date(startedAt).toISOString()}`;
  }

  function markActiveCompanionSessionEnded() {
    const sessionId = currentCompanionSessionId();
    const userId = profileRef.current?.userId;
    if (!sessionId || !userId) return;
    void endCompanionSession(userId, sessionId).catch(() => undefined);
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
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    if (cameraVideoRef.current) cameraVideoRef.current.srcObject = null;
    cameraVideoRef.current = null;
  }

  function clearListeningTimers() {
    if (tickTimerRef.current) window.clearInterval(tickTimerRef.current);
    if (segmentTimerRef.current) window.clearInterval(segmentTimerRef.current);
    if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
    tickTimerRef.current = undefined;
    segmentTimerRef.current = undefined;
    stopTimerRef.current = undefined;
  }

  function applyNativeListeningStatus(status: NativeListeningStatus) {
    if (!status.active || status.endAt <= Date.now()) {
      clearNativeListeningUi();
      return;
    }
    nativeListeningActiveRef.current = true;
    listeningStartedAtRef.current = status.startedAt;
    listeningDurationMsRef.current = status.endAt - status.startedAt;
    listeningModeRef.current = status.mode;
    setListeningDurationMs(status.endAt - status.startedAt);
    setListeningMode(status.mode);
    setListeningElapsed(Math.max(0, Math.floor((Date.now() - status.startedAt) / 1000)));
    setListening(true);
    clearListeningTimers();
    tickTimerRef.current = window.setInterval(() => {
      setListeningElapsed(Math.max(0, Math.min(
        Math.floor((status.endAt - status.startedAt) / 1000),
        Math.floor((Date.now() - status.startedAt) / 1000)
      )));
      if (Date.now() >= status.endAt) clearNativeListeningUi();
    }, 1000);
  }

  function clearNativeListeningUi() {
    nativeListeningActiveRef.current = false;
    clearListeningTimers();
    listeningStartedAtRef.current = undefined;
    setListening(false);
  }

  async function attachCameraStream(stream: MediaStream) {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    cameraStreamRef.current = stream;
    cameraVideoRef.current = video;
  }

  function captureCameraFrame(meta: AudioSliceMeta) {
    const video = cameraVideoRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return;
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.68);
    cameraObservationQueueRef.current = cameraObservationQueueRef.current.catch(() => undefined).then(async () => {
      const result = await observeCameraFrame(dataUrl, "陪伴中的定时画面");
      const content = result.summary.trim();
      submitLiveSegments([{
        ...makeSegment(`live-camera-${Date.now()}-${meta.index}`, "image_summary", "陪伴中看到的画面", content || "这次定时画面没有看清。", {
          observedAt: meta.observedAt,
          batchId: meta.batchId
        }),
        auditOnly: !content,
        sensingTrace: result.sensingTrace
      }]);
    }).catch((caught) => {
      console.warn("Papo live camera frame was skipped after sensing failed.", { batchId: meta.batchId, error: errorMessage(caught) });
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
    const savedUserId = readSavedUserId();
    const loadingProfile = savedUserId && loadingProfileSnapshot?.userId === savedUserId ? loadingProfileSnapshot : undefined;
    return (
      <main className="shell loading">
        <AvatarPreview
          petKind={loadingProfile?.petKind ?? loadingPetKind}
          petProfile={loadingProfile?.petProfile}
          state={loadingProfile?.state}
          dogState={loadingProfile?.dogState}
          preferRegistrationImage={!loadingProfile?.petProfile?.avatarImage}
          idle
        />
        <p>{busy ? `${loadingProfile?.creatureName ?? petKindLabel(loadingPetKind)} 正在醒来` : error ?? "无法载入小动物"}</p>
      </main>
    );
  }

  const pageTitle = tab === "home" ? profile.creatureName : tab === "chat" ? `和 ${profile.creatureName} 说话` : tab === "memory" ? `${profile.creatureName} 记得的生活` : "我的";
  const species = petSpeciesNoun(profile.petKind);

  return (
    <Tooltip.Provider delayDuration={180}>
      <main className={`shell app-shell tab-${tab}`}>
        <aside className="app-sidebar" aria-label={`${profile.creatureName} 导航`}>
          <div className="sidebar-brand">
            <AvatarPreview petKind={profile.petKind} petProfile={petProfileFor(profile)} state={profile.state} dogState={profile.dogState} />
            <div>
              <strong>{profile.creatureName}</strong>
              <span>{papoMoodLabel(profile.state)}</span>
            </div>
          </div>
          <nav className="nav">
            <NavButton active={tab === "home"} icon={Eye} label="首页" onClick={() => navigateTab("home")} />
            <NavButton active={tab === "chat"} icon={MessagesSquare} label="对话" unreadCount={hasUnreadPapoMessage ? unreadPapoCount : 0} onClick={() => navigateTab("chat")} />
            <NavButton active={tab === "memory"} icon={History} label="记忆" onClick={() => navigateTab("memory")} />
            <NavButton active={tab === "profile"} icon={UserRound} label="我的" onClick={() => navigateTab("profile")} />
          </nav>
        </aside>

        <section className="app-main">
          <header className="topbar app-topbar">
            <div className="topbar-avatar" aria-hidden="true">
              <AvatarPreview petKind={profile.petKind} petProfile={petProfileFor(profile)} state={profile.state} dogState={profile.dogState} />
            </div>
            <div>
              <p className="eyebrow">住在手机里的{species}</p>
              <h1>{pageTitle}</h1>
              <p className="eyebrow">{profile.creatureName} 正在陪着你</p>
            </div>
            <button className="icon-button" onClick={askEmergence} disabled={busy} aria-label={`轻轻碰一下 ${profile.creatureName}`}>
              <Sparkles size={19} />
            </button>
          </header>

          <section className="view-frame">
            {error ? <div className="notice">{error}</div> : null}
            {pendingActionCards ? <ActionCardPendingNotice profile={profile} count={pendingActionCards} /> : null}
            {pendingPetMotions && !pendingActionCards ? <ActionCardPendingNotice profile={profile} count={petProfileFor(profile).initialMotion?.pendingCount ?? 4} /> : null}

            {tab === "home" ? (
              <HomeView
                profile={profile}
                emergence={emergence}
                unreadPapoCount={unreadPapoCount}
                busy={busy}
                onGoCapture={() => setTab("chat")}
                onGoCurious={openListeningDurationPicker}
                onGoChat={() => setTab("chat")}
                onPetTouch={handlePetTouch}
                onUpdateActionCard={changeActionCard}
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
                listeningMode={listeningMode}
                listeningElapsed={listeningElapsed}
                listeningDurationMs={listeningDurationMs}
                quickRecording={quickRecording}
                quickAudioProcessing={quickAudioProcessing}
                quickRecordingElapsed={quickRecordingElapsed}
                onStartListening={openListeningDurationPicker}
                onStopListening={stopListening}
                onDismissJob={async (jobId) => setProfile(await dismissConversationJob(profile.userId, jobId))}
              />
            ) : null}
            {tab === "memory" ? <MemoryView profile={profile} targetMemoryId={targetMemoryId} onOpenMemory={openMemory} onFeedback={giveFeedback} onObserveFeedbackAudio={observeFeedbackAudio} onEditMemory={editLongTermMemory} onDream={runDreaming} busy={busy} feedbackPendingKey={feedbackPendingKey} /> : null}
            {tab === "profile" ? (
              <ProfileView
                profile={profile}
                onLogout={logout}
                onRename={renameCreature}
                onChangePassword={changePassword}
                onChangePetProfile={changePetProfile}
                onGenerateInitialActionCards={startInitialActionCards}
                onGoMemory={openMemory}
                onGoChat={() => setTab("chat")}
                onUpdateActionCard={changeActionCard}
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
          onToggleListening={listening ? stopListening : openListeningDurationPicker}
          onUpdateActionCard={changeActionCard}
        />
        <ListeningDurationDialog
          open={listeningDurationPickerOpen}
          creatureName={profile.creatureName}
          onOpenChange={setListeningDurationPickerOpen}
          onSelect={(durationMs, mode, facing) => void startListening(durationMs, mode, facing)}
        />
      </main>
    </Tooltip.Provider>
  );
}

function AuthView(props: {
  busy: boolean;
  error?: string;
  onLogin: (userId: string, password?: string) => Promise<{ ok: boolean; passwordRequired?: boolean }>;
  onRegister: (userId: string, petKind: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"register" | "login">("register");
  const [userId, setUserId] = useState("");
  const [petKind, setPetKind] = useState("shiba");
  const [localError, setLocalError] = useState("");
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [password, setPassword] = useState("");
  const cleanUserId = userId.trim();
  const canSubmit = /^[a-zA-Z0-9_-]{3,40}$/.test(cleanUserId);

  async function submit() {
    if (!canSubmit) {
      setLocalError("User ID 只能使用 3-40 位英文、数字、下划线或短横线。");
      return;
    }
    setLocalError("");
    if (mode === "login") {
      const result = await props.onLogin(cleanUserId);
      if (result.passwordRequired) {
        setPassword("");
        setPasswordDialogOpen(true);
      }
      return;
    }
    await props.onRegister(cleanUserId, petKind);
  }

  async function submitPasswordLogin() {
    if (!password.trim()) {
      setLocalError("请输入这个账号的密码。");
      return;
    }
    setLocalError("");
    const result = await props.onLogin(cleanUserId, password);
    if (result.ok) setPasswordDialogOpen(false);
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-hero">
          <AvatarPreview
            petKind={petKind}
            state={{ mood: "bright", curiosity: 80, attachment: 74, energy: 78, confidence: 60, safety: 44, arousal: 60 }}
            preferRegistrationImage
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
                <AvatarPreview petKind={pet.id} idle preferRegistrationImage />
                <span>{pet.label}</span>
              </button>
            ))}
          </div>
        ) : null}

        {localError || props.error ? <p className="auth-error">{localError || props.error}</p> : null}
        <button className="primary auth-submit" onClick={submit} disabled={props.busy || !canSubmit} type="button">
          {props.busy ? "处理中" : mode === "register" ? "开始养 Papo" : "回到我的 Papo"}
        </button>
        <Dialog.Root open={passwordDialogOpen} onOpenChange={setPasswordDialogOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="ui-overlay" />
            <Dialog.Content className="ui-sheet password-dialog" aria-label="输入账号密码">
              <div className="ui-sheet-head">
                <Dialog.Title>输入密码</Dialog.Title>
                <Dialog.Close asChild>
                  <button className="icon-button small" type="button" aria-label="关闭">
                    <X size={15} />
                  </button>
                </Dialog.Close>
              </div>
              <label className="field-label">
                {cleanUserId}
                <input
                  autoFocus
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submitPasswordLogin();
                  }}
                  autoComplete="current-password"
                />
              </label>
              {localError || props.error ? <p className="auth-error">{localError || props.error}</p> : null}
              <button className="primary auth-submit" onClick={submitPasswordLogin} disabled={props.busy || !password.trim()} type="button">
                {props.busy ? "确认中" : "进入 Papo"}
              </button>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
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
  onPetTouch: (action: PetInteractionAction) => void;
  onUpdateActionCard: (cardId: string, input: ActionCardUpdate) => void;
}) {
  const latestReply = props.unreadPapoCount ? latestVisiblePapoReply(props.profile) : "";
  const actionLine = papoVisibleActionLine(props.profile);
  const [activeMotion, setActiveMotion] = useState<HomeMotion | undefined>();
  const touchActions = petTouchActions(props.profile);
  const actionCards = (props.profile.actionCards ?? []).filter((card) => !card.deleted && actionCardDisplayMode(card) !== "disabled").slice(0, 6);
  const motionItems: HomeMotion[] = [
    ...touchActions.map((item) => ({ kind: "pet" as const, ...item })),
    ...actionCards.map((card) => ({ kind: "card" as const, cardId: card.id }))
  ];
  const defaultCard = matchingHomeActionCard(props.profile, actionCards);
  const effectiveMotion: HomeMotion | undefined = activeMotion ?? (defaultCard ? { kind: "card", cardId: defaultCard.id } : undefined);
  const visibleAction = effectiveMotion?.kind === "pet" ? effectiveMotion.action : generatedPetActionFromState(props.profile.dogState);
  const activeCard = effectiveMotion?.kind === "card" ? actionCards.find((card) => card.id === effectiveMotion.cardId) : undefined;
  useEffect(() => {
    setActiveMotion(undefined);
  }, [props.profile.userId, props.profile.petKind, props.profile.actionCards?.length]);
  return (
    <section className="home-screen">
      <section className="home-stage">
        <div className="home-stage-top">
          <span className="mood-pill">{papoMoodLabel(props.profile.state)}</span>
          <div className="home-stage-tools">
            <PapoGuidePoster creatureName={props.profile.creatureName} />
            <HomeBrainPeek profile={props.profile} onUpdateActionCard={props.onUpdateActionCard} />
          </div>
        </div>
        <div className="home-avatar-wrap">
          {activeCard ? <button className="pet-touch-button home-action-card-viewer" type="button" aria-label={`切换 ${props.profile.creatureName} 动作`} title="换一个当下动作" onClick={() => setActiveMotion(nextHomeMotion(effectiveMotion, motionItems, visibleAction))}><ActionCardAvatar card={activeCard} mode={actionCardDisplayMode(activeCard)} /></button> : <button
            className="pet-touch-button"
            type="button"
            aria-label={`戳戳 ${props.profile.creatureName}`}
            title="戳戳它，换个小动作"
            onClick={() => {
              let foundIndex = -1;
              if (effectiveMotion?.kind === "pet") foundIndex = motionItems.findIndex((item) => item.kind === "pet" && item.action === effectiveMotion.action);
              else if (effectiveMotion?.kind === "card") foundIndex = motionItems.findIndex((item) => item.kind === "card" && item.cardId === effectiveMotion.cardId);
              else foundIndex = motionItems.findIndex((item) => item.kind === "pet" && item.action === visibleAction);
              const currentIndex = Math.max(0, foundIndex);
              const nextMotion = motionItems[(currentIndex + 1) % motionItems.length];
              setActiveMotion(nextMotion);
              if (nextMotion?.kind === "pet") props.onPetTouch(nextMotion.action);
            }}
          >
            <AvatarPreview petKind={props.profile.petKind} petProfile={petProfileFor(props.profile)} state={props.profile.state} dogState={props.profile.dogState} interactionAction={effectiveMotion?.kind === "pet" ? effectiveMotion.action : undefined} />
          </button>}
        </div>
        <div className="home-speech">
          <h2>{props.profile.creatureName}</h2>
          <p>{activeCard ? actionCardStatusText(activeCard, props.profile) : effectiveMotion?.kind === "pet" ? effectiveMotion.text : latestReply || actionLine}</p>
        </div>
      </section>
      <aside className="home-side">
        {props.unreadPapoCount ? (
          <button className="proactive-nudge" onClick={props.onGoChat}>
            <MessagesSquare size={16} />
            {props.profile.creatureName} 新说
            <span>{Math.min(3, props.unreadPapoCount)}</span>
          </button>
        ) : null}

        <div className="home-actions">
          <button className="primary home-listen-action" onClick={props.onGoCurious} title={`选择一段时间，让 ${props.profile.creatureName} 陪你听着。`}>
            <Sparkles size={18} />
            陪我一会儿
          </button>
          <button className="secondary-action" onClick={props.onGoCapture}>
            <MessageCircle size={18} />
            跟 {props.profile.creatureName} 说
          </button>
        </div>
        <p className="home-action-note">可以选 3、15 或 60 分钟。安静时它不打扰你，有事时再回应。</p>
        <HomeActionCardsPeek profile={props.profile} />
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
  onUpdateActionCard: (cardId: string, input: ActionCardUpdate) => void;
}) {
  const latestReply = props.unreadPapoCount ? latestVisiblePapoReply(props.profile) : "";
  return (
    <aside className="companion-panel" aria-label={`${props.profile.creatureName} 当前状态`}>
      <section className="companion-card companion-hero">
        <div className="companion-avatar">
          <AvatarPreview petKind={props.profile.petKind} petProfile={petProfileFor(props.profile)} state={props.profile.state} dogState={props.profile.dogState} />
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
          {props.profile.creatureName} 新说
          <span>{Math.min(3, props.unreadPapoCount)}</span>
        </button>
      ) : latestReply ? (
        <section className="companion-card companion-last">
          <small>刚才</small>
          <p>{latestReply}</p>
        </section>
      ) : null}

      <div className="companion-actions">
        <button className="primary companion-listen-action" onClick={props.onToggleListening} disabled={props.busy} title={`开启后 ${props.profile.creatureName} 会持续听一会儿，并分段整理声音线索。`}>
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
          我的
        </button>
        <HomeBrainPeek profile={props.profile} compact onUpdateActionCard={props.onUpdateActionCard} />
      </div>
      <HomeActionCardsPeek profile={props.profile} compact />
      <HomeIllustrationsPeek profile={props.profile} compact />
    </aside>
  );
}

function HomeActionCardsPeek({ profile, compact = false }: { profile: CreatureProfile; compact?: boolean }) {
  const cards = (profile.actionCards ?? []).filter((card) => !card.deleted && actionCardDisplayMode(card) !== "disabled").slice(0, 6);
  if (!cards.length) return null;
  const latest = cards[0];
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button className={compact ? "illustration-peek compact" : "illustration-peek"} type="button">
          <Sparkles size={16} />
          {profile.creatureName} 动过
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-overlay" />
        <Dialog.Content className="illustration-dialog" aria-label={`${profile.creatureName} 的动作卡`}>
          <div className="illustration-dialog-head">
            <div>
              <strong>{profile.creatureName} 的动作卡</strong>
              <span>{namedCreatureText(latest.title, profile.creatureName) || latest.title}</span>
            </div>
            <Dialog.Close asChild>
              <button type="button">收起</button>
            </Dialog.Close>
          </div>
          <div className="action-card-gallery">
            {cards.map((card) => (
              <article className="action-card-preview" key={card.id}>
                <MediaThumbnail item={actionCardMediaItem(card)} className="action-card-media" />
                <strong>{namedCreatureText(card.title, profile.creatureName) || card.title}</strong>
                {card.caption ? <span>{namedCreatureText(card.caption, profile.creatureName) || card.caption}</span> : null}
              </article>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function HomeIllustrationsPeek({ profile, compact = false }: { profile: CreatureProfile; compact?: boolean }) {
  const illustrations = (profile.illustrations ?? []).slice(0, 6);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const galleryOpenRef = useRef(galleryOpen);
  galleryOpenRef.current = galleryOpen;

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (galleryOpenRef.current && event.state?.papoOverlay !== "illustrations") setGalleryOpen(false);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  if (!illustrations.length) return null;
  const latest = illustrations[0];

  function openGallery() {
    window.history.pushState({ ...(window.history.state ?? {}), papoOverlay: "illustrations" }, "");
    setGalleryOpen(true);
  }

  function closeGallery() {
    if (window.history.state?.papoOverlay === "illustrations") window.history.back();
    else setGalleryOpen(false);
  }

  const mediaItems = illustrations.map(illustrationMediaItem);

  return (
    <>
      <Dialog.Root open={galleryOpen} modal={false}>
        <Dialog.Trigger asChild>
          <button className={compact ? "illustration-peek compact" : "illustration-peek"} type="button" onClick={openGallery}>
            <ImagePlus size={16} />
            {profile.creatureName} 画过
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="ui-overlay" />
          <Dialog.Content className="illustration-dialog" aria-label={`${profile.creatureName} 画过的小画`}>
            <div className="illustration-dialog-head">
              <div>
                <strong>{profile.creatureName} 画过的小画</strong>
                <span>{latest.title}</span>
              </div>
              <button type="button" onClick={closeGallery}>收起</button>
            </div>
            <div className="illustration-grid">
              {illustrations.map((item, index) => (
                <MediaThumbnail item={mediaItems[index]} items={mediaItems} index={index} className="illustration-card" key={item.id}>
                  <img src={resolveAssetUrl(item.attachment.url)} alt={item.title} loading="lazy" />
                  <strong>{item.title}</strong>
                  {item.caption ? <span>{item.caption}</span> : null}
                </MediaThumbnail>
              ))}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function ListeningDurationDialog(props: {
  open: boolean;
  creatureName: string;
  onOpenChange: (open: boolean) => void;
  onSelect: (durationMs: number, mode: ListeningMode, cameraFacing: CameraFacing) => void;
}) {
  const [mode, setMode] = useState<ListeningMode>("listen");
  const [durationMs, setDurationMs] = useState<number>(LIVE_LISTENING_DEFAULT_MS);
  const [cameraFacing, setCameraFacing] = useState<CameraFacing>("front");
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="duration-dialog" aria-describedby={undefined}>
          <div className="duration-dialog-head">
            <div>
              <Dialog.Title>怎么陪你</Dialog.Title>
              <p>{props.creatureName} {supportsNativeListening() ? "后台约每 2 分钟整理一次。" : "约每 30 秒整理一次。"}</p>
            </div>
            <Dialog.Close aria-label="关闭">
              <X size={18} />
            </Dialog.Close>
          </div>
          <div className="listening-mode-options" role="group" aria-label="陪伴方式">
            <button className={mode === "listen" ? "active" : ""} type="button" onClick={() => setMode("listen")}>
              <Mic size={17} />
              陪我
            </button>
            <button className={mode === "watch" ? "active" : ""} type="button" onClick={() => setMode("watch")}>
              <Camera size={17} />
              陪我+看我
            </button>
          </div>
          {mode === "watch" ? (
            <div className="camera-facing-options" role="group" aria-label="摄像头方向">
              <button className={cameraFacing === "front" ? "active" : ""} type="button" onClick={() => setCameraFacing("front")}>前置</button>
              <button className={cameraFacing === "back" ? "active" : ""} type="button" onClick={() => setCameraFacing("back")}>后置</button>
            </div>
          ) : null}
          <div className="duration-options" role="group" aria-label="陪伴时长">
            {LIVE_LISTENING_DURATION_OPTIONS.map((option) => (
              <button className={durationMs === option.value ? "active" : ""} type="button" key={option.value} onClick={() => setDurationMs(option.value)}>
                <strong>{option.label}</strong>
                <span>{option.description}</span>
              </button>
            ))}
          </div>
          <button className="primary duration-start" type="button" onClick={() => props.onSelect(durationMs, mode, cameraFacing)}>
            {mode === "watch" ? <Camera size={17} /> : <Mic size={17} />}
            开始陪伴
          </button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PapoGuidePoster({ creatureName }: { creatureName: string }) {
  const guideItems = [
    {
      title: "持续陪伴，但不打扰",
      text: `陪我会持续听一小段时间，按约 30 秒整理线索；${creatureName} 会自己判断要不要回应。`
    },
    {
      title: "它会主动找你",
      text: `状态、动机和记忆会一起影响 ${creatureName} 是否主动说话；没必要时它也会安静。`
    },
    {
      title: "它真的会记住",
      text: "经历、候选记忆、长期记忆分层保存，你的反馈会改变它之后怎么记。"
    },
    {
      title: "每晚观察日记漫画",
      text: `${creatureName} 可以把当天真实片段和照片整理成多格漫画，放进它画过。`
    },
    {
      title: "虾虾是背后的好朋友",
      text: `需要搜索、查资料或外部任务时，${creatureName} 可以异步请 Hermes/虾虾帮忙。`
    },
    {
      title: "你教它，它会变",
      text: "重要、忘记、反馈和改准会影响记忆权重、性格倾向和之后的回应方式。"
    },
    {
      title: "多脑协同",
      text: "注意、行动、记忆、动机、状态、性格各自负责一部分，让它更像一只小动物。"
    },
    {
      title: "隐私优先",
      text: "你可以给账号加密码；敏感内容进模型前会被遮蔽，也可以随时忘记不想保留的记忆。"
    }
  ];

  return (
    <Dialog.Root>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <Dialog.Trigger asChild>
            <button className="guide-trigger" type="button" aria-label={`了解 ${creatureName} 怎么陪你`}>
              <HelpCircle size={15} />
            </button>
          </Dialog.Trigger>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="ui-tooltip" sideOffset={6}>
            了解 {creatureName}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-overlay" />
        <Dialog.Content className="guide-dialog" aria-label={`${creatureName} 使用说明`}>
          <div className="guide-poster">
            <div className="guide-poster-head">
              <div>
                <p className="eyebrow">{creatureName} 是什么</p>
                <Dialog.Title>一只会陪伴、会记住、会自己行动的小动物</Dialog.Title>
              </div>
              <Dialog.Close asChild>
                <button className="icon-button small" type="button" aria-label="关闭说明">
                  <X size={15} />
                </button>
              </Dialog.Close>
            </div>
            <p className="guide-lead">
              你可以把文字、照片和声音交给它。{creatureName} 会先理解发生了什么，再决定要不要回应、记住、画下来，或者请虾虾帮忙。
            </p>
            <div className="guide-grid">
              {guideItems.map((item, index) => (
                <article className="guide-item" key={item.title}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{item.title}</strong>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>
            <div className="guide-footer">
              <b>最自然的用法</b>
              <span>点“陪我一会儿”，让它听着你周围的生活；想到什么就继续发文字、照片或录音。</span>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type PetInteractionAction = "idle" | "poke-wave" | "play-ball" | "nap";
type HomeMotion =
  | { kind: "pet"; action: PetInteractionAction; text: string }
  | { kind: "card"; cardId: string };

function AvatarPreview({ petKind, petProfile, state, dogState, idle = false, interactionAction, preferRegistrationImage = false }: { petKind?: string; petProfile?: CreatureProfile["petProfile"]; state?: CreatureState; dogState?: DogInteractionState; idle?: boolean; interactionAction?: PetInteractionAction; preferRegistrationImage?: boolean }) {
  if (petProfile?.avatarImage) return <CustomPetAvatar petProfile={petProfile} idle={idle} />;
  const normalizedPetKind = normalizePetKind(petKind);
  const meta = petKindMeta(normalizedPetKind);
  if (preferRegistrationImage && meta.registrationImage) return <RegistrationPetAvatar petKind={normalizedPetKind} idle={idle} />;
  if (normalizedPetKind === "shiba") return <ShibaAvatar state={state} dogState={dogState} idle={idle} />;
  if (normalizedPetKind === "british-shorthair") return <GeneratedPetAvatar petKind={normalizedPetKind} dogState={dogState} idle={idle} interactionAction={interactionAction} />;
  if (meta.registrationImage) return <RegistrationPetAvatar petKind={normalizedPetKind} idle={idle} />;
  return <AgentPetSprite petKind={normalizedPetKind} dogState={dogState} idle={idle} />;
}

function RegistrationPetAvatar({ petKind, idle = false }: { petKind: string; idle?: boolean }) {
  const meta = petKindMeta(petKind);
  if (!meta.registrationImage) return null;
  const registrationVideo = "registrationVideo" in meta ? meta.registrationVideo : undefined;
  return (
    <div
      className={`registration-pet-avatar ${registrationVideo ? "has-video" : ""} ${idle ? "idle" : ""}`}
      style={{ "--pet-accent": meta.accentColor } as CSSProperties}
      aria-label={meta.label}
    >
      {registrationVideo ? (
        <video src={publicAssetPath(registrationVideo)} poster={publicAssetPath(meta.registrationImage)} autoPlay loop muted playsInline preload="metadata" aria-hidden="true" />
      ) : (
        <img src={publicAssetPath(meta.registrationImage)} alt={meta.label} loading="lazy" />
      )}
    </div>
  );
}

function CustomPetAvatar({ petProfile, idle = false }: { petProfile: CreatureProfile["petProfile"]; idle?: boolean }) {
  if (!petProfile.avatarImage) return null;
  return (
    <div className={`custom-pet-avatar ${idle ? "idle" : ""}`} aria-label={petProfile.displaySpecies}>
      <img src={resolveAssetUrl(petProfile.avatarImage.url)} alt={petProfile.avatarImage.label} loading="lazy" />
    </div>
  );
}

function GeneratedPetAvatar({ petKind, dogState, idle = false, interactionAction }: { petKind: string; dogState?: DogInteractionState; idle?: boolean; interactionAction?: PetInteractionAction }) {
  const action = interactionAction ?? generatedPetActionFromState(dogState);
  const poster = publicAssetPath(`pets/generated/${petKind}-v1/${action}.webp`);
  const video = publicAssetPath(`pets/generated/${petKind}-v1/${action}.mp4`);
  return (
    <div className={`generated-pet-avatar has-video ${idle ? "idle" : ""} pet-action-${action}`} aria-label={`${petKindLabel(petKind)} 正在${dogState?.label ?? "陪着你"}`}>
      <video src={video} poster={poster} autoPlay loop muted playsInline preload="metadata" aria-hidden="true" />
    </div>
  );
}

function ActionCardAvatar({ card, mode = "dynamic" }: { card: NonNullable<CreatureProfile["actionCards"]>[number]; mode?: ActionCardDisplayMode }) {
  return (
    <div className="action-card-avatar" aria-label={card.title}>
      {mode === "static" && card.cover
        ? <img src={resolveAssetUrl(card.cover.url)} alt="" />
        : <video src={resolveAssetUrl(card.video.url)} poster={card.cover ? resolveAssetUrl(card.cover.url) : undefined} autoPlay loop muted playsInline preload="metadata" />}
    </div>
  );
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

function generatedPetActionFromState(dogState?: DogInteractionState): PetInteractionAction {
  switch (dogState?.animation) {
    case "nap":
    case "sun":
      return "nap";
    case "play":
    case "bounce":
    case "wag":
      return "play-ball";
    case "listen":
    case "peek":
    case "sniff":
    case "stretch":
      return "poke-wave";
    case "idle":
    default:
      return "idle";
  }
}

function petTouchActions(profile: CreatureProfile): Array<{ action: PetInteractionAction; text: string }> {
  const name = profile.creatureName;
  const species = petSpeciesNoun(profile.petKind);
  const tired = profile.state.energy < 35;
  if (tired) {
    return [
      { action: "nap", text: `${name} 眯着眼趴了一会儿。` },
      { action: "poke-wave", text: `${name} 抬起小爪，轻轻回应你。` },
      { action: "idle", text: `${name} 安安静静待在你身边。` }
    ];
  }
  return [
    { action: "poke-wave", text: `${name} 抬起小爪，像在跟你打招呼。` },
    { action: "play-ball", text: `${name} 把小球按在爪边，等你再戳一下。` },
    { action: "idle", text: `${name} 坐好了，圆圆地看着你。` },
    { action: "nap", text: `${name} ${species === "小猫" ? "缩成软软一团" : "趴下来歇了一小会儿"}。` }
  ];
}

function petSpeciesNoun(petKind?: string) {
  return petKindMeta(petKind).speciesNoun;
}

function petProfileFor(profile: CreatureProfile): CreatureProfile["petProfile"] {
  if (profile.petProfile) return profile.petProfile;
  const meta = petKindMeta(profile.petKind);
  return {
    updatedAt: profile.createdAt,
    source: "registration",
    displaySpecies: meta.label,
    appearance: meta.appearance,
    personality: "亲近、好奇，会在合适的时候回应用户。",
    habits: "喜欢待在用户旁边，听见重要的小事会靠近一点。",
    visualStyle: "温暖、干净、可爱的移动端小动物形象。",
    imagePrompt: meta.imagePrompt,
    motionStyle: "短循环动作，镜头稳定，全身居中，动作简单可爱。",
    initialMotion: { status: "idle" }
  };
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

function HomeBrainPeek({ profile, compact = false, onUpdateActionCard }: { profile: CreatureProfile; compact?: boolean; onUpdateActionCard?: (cardId: string, input: ActionCardUpdate) => void }) {
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
        <Dialog.Content className="ui-sheet" aria-label={`${profile.creatureName} 状态和模型阶段`}>
          <div className="ui-sheet-head">
            <Dialog.Title>{profile.creatureName} 状态</Dialog.Title>
            <Dialog.Close asChild>
              <button className="icon-button small" type="button" aria-label="收起小眼睛">
                <RefreshCcw size={15} />
              </button>
            </Dialog.Close>
          </div>
          <StatePolicySnapshot profile={profile} onUpdateActionCard={onUpdateActionCard} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function StatePolicySnapshot({ profile, onUpdateActionCard }: { profile: CreatureProfile; onUpdateActionCard?: (cardId: string, input: ActionCardUpdate) => void }) {
  const state = profile.state;
  const policy = profile.policyProfile;
  const petProfile = petProfileFor(profile);
  const recentRuns = (profile.semanticBrainHistory ?? []).slice(0, 3);
  const statusDiary = statusDiaryItems(profile).slice(0, 8);
  const actionCards = (profile.actionCards ?? []).filter((card) => !card.deleted).slice(0, 8);
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
      <section>
        <strong>形象档案</strong>
        <small>{petProfile.displaySpecies}</small>
        <small>{petProfile.appearance}</small>
        <small>{petProfile.personality}</small>
        <small>动作风格：{petProfile.motionStyle}</small>
        <small>初始动作：{petProfile.initialMotion?.status ?? "idle"}</small>
      </section>
      {profile.clientDocument ? (
        <section className="client-document-snapshot">
          <strong>Client.md</strong>
          <pre>{profile.clientDocument.markdown}</pre>
          <small>第 {profile.clientDocument.revision} 版 · {formatPapoDateTime(profile.clientDocument.updatedAt)}</small>
        </section>
      ) : null}
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
      {actionCards.length ? (
        <section>
          <strong>动作卡</strong>
          <div className="action-card-admin-list">
            {actionCards.map((card) => (
              <article className={`action-card-admin mode-${actionCardDisplayMode(card)}`} key={card.id}>
                <MediaThumbnail item={actionCardMediaItem(card)} className="action-card-admin-media" />
                <div>
                  <b>{namedCreatureText(card.title, profile.creatureName) || card.title}</b>
                  {card.caption ? <small>{namedCreatureText(card.caption, profile.creatureName) || card.caption}</small> : null}
                  <small>{formatPapoDateTime(card.createdAt)} · {card.model ?? card.providerName}</small>
                  <ActionCardModeControl card={card} onChange={(displayMode) => onUpdateActionCard?.(card.id, { displayMode })} />
                  <div className="action-card-controls">
                    <button type="button" onClick={() => onUpdateActionCard?.(card.id, { deleted: true })}>
                      删除
                    </button>
                  </div>
                </div>
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
      detail: namedCreatureText(dogState.actionText || dogState.reason, profile.creatureName)
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
  const action = namedCreatureText(profile.dogState?.actionText, profile.creatureName);
  if (action) return action;
  return `${profile.creatureName} 趴在旁边，等你说下一件事。`;
}

function namedCreatureText(text: string | undefined, creatureName: string) {
  const visible = visibleCreatureText(text);
  return visible ? visible.replace(/\bPapo\b/g, creatureName) : "";
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
  listeningMode: ListeningMode;
  listeningElapsed: number;
  listeningDurationMs: number;
  quickRecording: boolean;
  quickAudioProcessing: boolean;
  quickRecordingElapsed: number;
  onStartListening: () => void;
  onStopListening: () => void;
  onDismissJob: (jobId: string) => Promise<void>;
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
  const canSubmit = !waitingForStagedSegments && Boolean(draft.trim() || props.stagedSegments.some((segment) => stagedSegmentReady(segment) && (segment.content.trim() || segment.uploadDataUrl)));
  const hasOlderMessages = allMessages.length > visibleCount;
  const listeningTotalSeconds = Math.floor(props.listeningDurationMs / 1000);
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
    } catch {
      setDraft((current) => current || text);
    } finally {
      setSubmittingMoment(false);
    }
  }
  return (
    <section className="chat-screen">
      <header className="chat-top">
        <AvatarPreview petKind={props.profile.petKind} petProfile={petProfileFor(props.profile)} state={props.profile.state} dogState={props.profile.dogState} />
        <div>
          <strong>{props.listening ? `${props.profile.creatureName} 正在${props.listeningMode === "watch" ? "听和看" : "听"}` : `${props.profile.creatureName} 在这里`}</strong>
          <span>{props.listening ? formatListeningTime(props.listeningElapsed) : papoMoodLabel(props.profile.state)}</span>
        </div>
        <button className="listen-toggle" onClick={props.listening ? props.onStopListening : props.onStartListening} disabled={props.busy}>
          <Sparkles size={17} />
          {props.listening ? "停下" : "陪我"}
        </button>
      </header>
      <HermesTaskNotice profile={props.profile} />
      <section className="chat-thread" aria-label={`和 ${props.profile.creatureName} 的对话`}>
        {messages.length ? (
          <div className="chat-list">
            {hasOlderMessages ? (
              <button className="load-older-button" onClick={loadOlderMessages}>
                看更早的消息
              </button>
            ) : null}
            {sections.map((section) =>
              section.kind === "live" ? (
                <CompanionSessionCard section={section} profile={props.profile} key={section.id} />
              ) : section.kind === "batch" ? (
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
        <ConversationWorkIndicator profile={props.profile} onDismissJob={props.onDismissJob} />
        <div ref={threadEndRef} aria-hidden="true" />
      </section>
      <div className="chat-composer" ref={composerRef}>
          {props.listening ? (
            <section className="listening-session-status" aria-live="polite">
              <div>
                {props.listeningMode === "watch" ? <Camera size={16} /> : <Mic size={16} />}
                <span>陪你{props.listeningMode === "watch" ? "听和看" : "听着"} {formatListeningTime(props.listeningElapsed)} / {formatListeningTime(listeningTotalSeconds)}</span>
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
                      placeholder={stagedSegmentPlaceholder(segment.kind, props.profile.creatureName)}
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
              placeholder={`告诉 ${props.profile.creatureName}...`}
            />
            <button className="composer-mic-button" onClick={props.onRecordAudio} disabled={props.busy || props.listening || props.quickRecording || props.quickAudioProcessing} aria-label="录一段声音">
              {props.quickAudioProcessing ? <Loader2 size={18} className="spin-icon" /> : <Mic size={18} />}
            </button>
            <button className="primary chat-send-button" onClick={submitDraft} disabled={submittingMoment || !canSubmit} aria-label={`发送给 ${props.profile.creatureName}`}>
              {submittingMoment ? <Loader2 size={18} className="spin-icon" /> : <Send size={18} />}
            </button>
          </div>
      </div>
    </section>
  );
}

function StagedImagePreview({ segment }: { segment: StagedChatSegment }) {
  const image = segment.attachments?.find((attachment) => attachment.kind === "image");
  const src = segment.previewUrl ?? (image ? resolveAssetUrl(image.url) : undefined);
  const previewItem = image && src ? { ...attachmentMediaItem(image, "待发送照片"), src } : undefined;
  return (
    <div className="staged-image-preview-wrap">
      {src && previewItem ? (
        <MediaThumbnail item={previewItem} className="staged-image-preview"><img src={src} alt="待发送照片" /></MediaThumbnail>
      ) : <button className="staged-image-preview" type="button" disabled><ImagePlus size={20} /></button>}
      {segment.status === "processing" ? (
        <span className="staged-image-overlay" aria-label="正在处理图片">
          <Loader2 size={18} className="spin-icon" />
        </span>
      ) : null}
      {segment.status === "failed" ? <span className="staged-image-error">{segment.statusText ?? "没传上去"}</span> : null}
    </div>
  );
}

function stagedSegmentPlaceholder(kind: SegmentKind, creatureName: string) {
  if (kind === "image_summary") return `可以改成你想让 ${creatureName} 看见的照片内容`;
  if (kind === "audio_observation") return `可以改成你想让 ${creatureName} 听见的话`;
  return "可以补充这件事";
}

function ChatBubble({ message, profile }: { message: ConversationMessage; profile: CreatureProfile }) {
  const context = messageContextText(message, profile.creatureName);
  const text = chatBubbleText(message);
  return (
    <article className={`chat-bubble ${message.role}`}>
      <div className="chat-bubble-head">
        <div>
          <strong>{messageTitle(message, profile.creatureName)}</strong>
          <span>
            {context ? `${context} · ` : ""}{formatPapoDateTime(message.at)}
          </span>
        </div>
        {message.cognitionTrace || message.sensingTrace ? <DeveloperTrace trace={message.cognitionTrace} sensingTrace={message.sensingTrace} profile={profile} /> : null}
      </div>
      <p>{text}</p>
      <AttachmentStrip attachments={message.attachments} profile={profile} />
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

function CompanionSessionCard({ section, profile }: { section: Extract<ConversationSection, { kind: "live" }>; profile: CreatureProfile }) {
  const sorted = [...section.messages].sort((a, b) => Date.parse(a.observedAt ?? a.at) - Date.parse(b.observedAt ?? b.at));
  const audioMessages = sorted.filter((message) => message.modality === "audio_observation");
  const usefulAudio = audioMessages.filter((message) => !message.auditOnly && message.sensingTrace?.status === "content");
  const textMessages = sorted.filter((message) => message.modality === "text");
  const imageMessages = sorted.filter((message) => message.modality === "image_summary");
  const firstUseful = [...usefulAudio, ...textMessages, ...imageMessages][0];
  const summary = firstUseful ? chatBubbleText(firstUseful) : "我听了一会儿，这段没有需要打扰你的内容。";
  return (
    <section className="chat-batch companion-session">
      <div className="chat-batch-head">
        <strong>{profile.creatureName} 听了一会儿</strong>
        <span>{companionSessionSummary(audioMessages.length, usefulAudio.length, textMessages.length, imageMessages.length)}</span>
      </div>
      <p>{summary}</p>
      <details>
        <summary>查看 {sorted.length} 条分段记录</summary>
        <div className="companion-session-details">
          {sorted.map((message) => (
            <ChatBubble message={message} profile={profile} key={message.id} />
          ))}
        </div>
      </details>
    </section>
  );
}

function companionSessionSummary(audioCount: number, usefulAudioCount: number, textCount: number, imageCount: number) {
  const parts = [
    audioCount ? `${audioCount} 段声音` : "",
    usefulAudioCount ? `${usefulAudioCount} 段有内容` : "",
    textCount ? `${textCount} 条文字` : "",
    imageCount ? `${imageCount} 张照片` : ""
  ].filter(Boolean);
  return parts.join(" · ") || "已听过";
}

function AttachmentStrip({ attachments, profile }: { attachments?: NonNullable<StreamSegment["attachments"]>; profile: CreatureProfile }) {
  const mediaItems = (attachments ?? []).filter((attachment) => attachment.kind === "image" || attachment.kind === "video").map((attachment) => attachmentMediaItem(attachment, attachment.label, actionCardCoverForAttachment(attachment, profile)));
  if (!mediaItems.length) return null;
  return (
    <div className="attachment-strip">
      {mediaItems.map((item, index) => <MediaThumbnail item={item} items={mediaItems} index={index} className={item.kind === "image" ? "attachment-thumb" : "attachment-video"} key={item.id} />)}
    </div>
  );
}

function attachmentMediaItem(attachment: MediaAttachment, title = attachment.label, poster?: string): MediaViewerItem {
  return {
    id: attachment.id,
    kind: attachment.kind === "video" ? "video" : "image",
    src: resolveAssetUrl(attachment.url),
    title,
    mime: attachment.mime,
    poster
  };
}

function actionCardCoverForAttachment(attachment: MediaAttachment, profile: CreatureProfile) {
  if (attachment.kind !== "video") return undefined;
  const card = (profile.actionCards ?? []).find((item) => item.video.id === attachment.id)
    ?? (attachment.jobId ? (profile.actionCards ?? []).find((item) => item.jobId === attachment.jobId) : undefined);
  return card?.cover ? resolveAssetUrl(card.cover.url) : undefined;
}

function illustrationMediaItem(item: NonNullable<CreatureProfile["illustrations"]>[number]): MediaViewerItem {
  return attachmentMediaItem(item.attachment, item.title);
}

function actionCardMediaItem(card: NonNullable<CreatureProfile["actionCards"]>[number]): MediaViewerItem {
  return {
    ...attachmentMediaItem(card.video, card.title),
    kind: "video",
    poster: card.cover ? resolveAssetUrl(card.cover.url) : undefined
  };
}

function actionCardDisplayMode(card: NonNullable<CreatureProfile["actionCards"]>[number]): ActionCardDisplayMode {
  return card.displayMode ?? (card.disabled ? "disabled" : "dynamic");
}

function actionCardStatusText(card: NonNullable<CreatureProfile["actionCards"]>[number], profile: CreatureProfile) {
  return namedCreatureText(card.statusText || card.caption || card.title, profile.creatureName);
}

function matchingHomeActionCard(profile: CreatureProfile, cards: NonNullable<CreatureProfile["actionCards"]>) {
  return cards.find((card) => card.stateId === profile.dogState.id)
    ?? cards.find((card) => card.stateId && dogStateById(profile, card.stateId)?.animation === profile.dogState.animation);
}

function dogStateById(profile: CreatureProfile, id: string) {
  return [profile.dogState, ...(profile.dogStateHistory ?? [])].find((state) => state.id === id);
}

function nextHomeMotion(current: HomeMotion | undefined, items: HomeMotion[], fallbackAction: PetInteractionAction) {
  if (!items.length) return undefined;
  const currentIndex = current?.kind === "card"
    ? items.findIndex((item) => item.kind === "card" && item.cardId === current.cardId)
    : items.findIndex((item) => item.kind === "pet" && item.action === (current?.kind === "pet" ? current.action : fallbackAction));
  return items[(Math.max(0, currentIndex) + 1) % items.length];
}

function ActionCardModeControl({ card, onChange }: { card: NonNullable<CreatureProfile["actionCards"]>[number]; onChange: (mode: ActionCardDisplayMode) => void }) {
  const mode = actionCardDisplayMode(card);
  return (
    <div className="action-card-mode-control" role="group" aria-label={`${card.title} 首页展示方式`}>
      {(["disabled", "static", "dynamic"] as const).map((value) => (
        <button type="button" className={mode === value ? "active" : ""} aria-pressed={mode === value} onClick={() => onChange(value)} key={value}>
          {value === "disabled" ? "停用" : value === "static" ? "静态" : "动态"}
        </button>
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
                  <ActionResultView result={event.actionResult} profile={profile} />
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
    <div className="related-memory-links">
      {memories.map((memory) => (
        <button type="button" key={memory.id} onClick={() => requestMemoryNavigation(memory.id)}>
          <History size={14} />
          <span>{memory.shortTitle ?? memoryShortTitle(memory.narrative ?? memory.text)}</span>
          <ChevronRight size={14} />
        </button>
      ))}
    </div>
  );
}

function ActionResultView({ result, profile }: { result?: ActionResult; profile: CreatureProfile }) {
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
        {result.plan ? (
          <div className="trace-illustration-plan">
            <small>漫画规划：{result.plan.summary}</small>
            {result.plan.elements?.length ? <small>元素：{result.plan.elements.join(" / ")}</small> : null}
            {result.plan.panels?.length ? (
              <ol>
                {result.plan.panels.map((panel, index) => (
                  <li key={`${panel.title}-${index}`}>
                    <b>{panel.title}</b>
                    <span>{panel.scene}</span>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        ) : null}
        {result.sourceIds?.length ? <small>基于 {result.sourceIds.length} 条真实素材</small> : null}
        {result.attachment ? <AttachmentStrip attachments={[result.attachment]} profile={profile} /> : null}
      </div>
    );
  }
  if (result.kind === "action_card_draft" || result.kind === "action_card") {
    return (
      <div className="trace-action-result">
        <b>{result.kind === "action_card" ? "动作卡已生成" : "动作卡草稿"}</b>
        {result.title ? <p>{result.title}</p> : null}
        {result.caption ? <small>说明：{result.caption}</small> : null}
        {result.prompt ? <small>提示词：{result.prompt}</small> : null}
        {result.style ? <small>风格：{result.style}</small> : null}
        {result.durationSeconds ? <small>时长：{result.durationSeconds} 秒</small> : null}
        {result.sourceIds?.length ? <small>基于 {result.sourceIds.length} 条真实素材</small> : null}
        {result.videoAttachment ? <AttachmentStrip attachments={[result.videoAttachment]} profile={profile} /> : null}
      </div>
    );
  }
  if (result.kind === "pet_profile_update") {
    return (
      <div className="trace-action-result">
        <b>形象档案更新</b>
        {result.text ? <p>{result.text}</p> : null}
        {result.petProfile ? (
          <ul className="trace-list">
            {Object.entries(result.petProfile).map(([key, value]) => value ? <li key={key}>{key}: {String(value)}</li> : null)}
          </ul>
        ) : null}
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
    not_now: "用户让它先安静",
    remember: "用户要求记住",
    important: "用户标记这件事很重要",
    remind: "用户希望以后提醒",
    correct: "用户修正这条记忆",
    forget: "用户要求忘记"
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
    generate_illustration: "生成插画",
    generate_action_card: "生成动作卡",
    update_pet_profile: "更新形象档案"
  };
  return labels[action] ?? action;
}

function groupConversationSections(messages: ConversationMessage[]): ConversationSection[] {
  const sections = messages.reduce<ConversationSection[]>((sections, message) => {
    const liveKey = liveSessionKey(message.batchId);
    if (message.role !== "papo" && liveKey) {
      const previous = sections[sections.length - 1];
      if (previous?.kind === "live" && previous.sessionKey === liveKey) {
        previous.messages.push(message);
        return sections;
      }
      sections.push({ kind: "live", id: `live-${liveKey}-${message.id}`, sessionKey: liveKey, messages: [message] });
      return sections;
    }

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

function liveSessionKey(batchId?: string) {
  const match = batchId?.match(/^(live-.+)-\d{2}$/);
  return match?.[1];
}

function batchMomentSummary(messages: ConversationMessage[]) {
  const kinds = [...new Set(messages.map((message) => messageKindNoun(message)))];
  if (!kinds.length) return "一起给它";
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
  targetMemoryId?: string;
  onOpenMemory: (memoryId?: string) => void;
  onFeedback: (kind: FeedbackKind, targetId?: string, content?: string, modality?: "text" | "audio_observation" | "button") => void;
  onObserveFeedbackAudio: (file: File) => Promise<string>;
  onEditMemory: (memoryId: string, text: string) => void;
  onDream: () => void;
  busy: boolean;
  feedbackPendingKey?: string;
}) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"candidate" | "long">("long");
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
  const selectedMemory = props.targetMemoryId
    ? (props.profile.longTermMemories ?? []).find((memory) => memory.id === props.targetMemoryId && memory.kind !== "creature_self_memory")
    : undefined;

  useEffect(() => {
    if (!props.targetMemoryId) return;
    setQuery("");
    setView("long");
    const frame = window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".view-frame")?.scrollTo({ top: 0, behavior: "auto" }));
    return () => window.cancelAnimationFrame(frame);
  }, [props.targetMemoryId]);

  if (selectedMemory) return (
    <MemoryDetail
      memory={selectedMemory}
      profile={props.profile}
      editing={editingId === selectedMemory.id}
      draft={draft}
      onDraftChange={setDraft}
      onStartEdit={() => { setEditingId(selectedMemory.id); setDraft(selectedMemory.text); }}
      onCancelEdit={() => setEditingId(undefined)}
      onSaveEdit={() => { props.onEditMemory(selectedMemory.id, draft); setEditingId(undefined); }}
      onBack={() => window.history.state?.memoryId ? window.history.back() : props.onOpenMemory()}
      onFeedback={props.onFeedback}
      onObserveFeedbackAudio={props.onObserveFeedbackAudio}
      busy={props.busy}
      feedbackPendingKey={props.feedbackPendingKey}
    />
  );

  return (
    <section className="memory-view">
      <header className="memory-view-header">
        <div>
          <span className="memory-view-kicker">生活档案</span>
          <h2>{otherMemories.length} 段留下的经历</h2>
          <p>{candidates.length ? `还有 ${candidates.length} 条正在确认` : `${props.profile.creatureName} 会把真正值得长期留下的内容收在这里`}</p>
        </div>
        <button className="memory-organize-button" onClick={props.onDream} disabled={props.busy}>
          <Sparkles size={16} />
          整理
        </button>
      </header>
      <div className="memory-toolbar">
        <div className="segmented-control" role="group" aria-label="选择记忆类型">
          <button className={view === "long" ? "active" : ""} onClick={() => setView("long")}>已留下 {otherMemories.length}</button>
          <button className={view === "candidate" ? "active" : ""} onClick={() => setView("candidate")}>待确认 {candidates.length}</button>
        </div>
        <input aria-label="搜索记忆" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索一段生活" />
      </div>
      <div className="memory-content">
        {view === "candidate" && candidates.length ? (
          <section className="memory-section">
            <div className="memory-section-heading"><h3>待确认</h3><span>{candidates.length}</span></div>
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
        {view === "long" && otherMemories.length ? (
          <section className="memory-section">
            <div className="memory-section-heading"><h3>已留下</h3><span>{otherMemories.length}</span></div>
            {otherMemories.map((memory) => <MemoryArchiveRow key={memory.id} memory={memory} onOpen={() => props.onOpenMemory(memory.id)} />)}
          </section>
        ) : null}
        {(view === "candidate" && candidates.length) || (view === "long" && otherMemories.length) ? null : <p className="muted">这里还没有符合筛选的记忆。</p>}
      </div>
    </section>
  );
}

function MemoryArchiveRow({ memory, onOpen }: { memory: CreatureProfile["longTermMemories"][number]; onOpen: () => void }) {
  const image = memory.visual ?? memory.attachments?.find((attachment) => attachment.kind === "image");
  const title = memory.shortTitle ?? memoryShortTitle(memory.narrative ?? memory.text);
  const summary = normalizeMemoryText(memory.narrative ?? memory.text);
  return (
    <button className="memory-archive-row" id={`memory-${memory.id}`} type="button" onClick={onOpen} aria-label={`查看记忆：${title}`}>
      <span className={image ? "memory-archive-thumb has-image" : "memory-archive-thumb text-only"}>
        {image ? <img src={resolveAssetUrl(image.url)} alt="" loading="lazy" /> : <History size={22} />}
      </span>
      <span className="memory-archive-copy">
        <span>{formatPapoDateTime(memory.createdAt)} · {memoryKindLabel(memory.kind)}</span>
        <strong>{title}</strong>
        <small>{summary}</small>
      </span>
      <ChevronRight size={18} />
    </button>
  );
}

function MemoryDetail(props: {
  memory: CreatureProfile["longTermMemories"][number];
  profile: CreatureProfile;
  editing: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onBack: () => void;
  onFeedback: (kind: FeedbackKind, targetId?: string, content?: string, modality?: "text" | "audio_observation" | "button") => void;
  onObserveFeedbackAudio: (file: File) => Promise<string>;
  busy: boolean;
  feedbackPendingKey?: string;
}) {
  const { memory } = props;
  const title = memory.shortTitle ?? memoryShortTitle(memory.narrative ?? memory.text);
  const sourceEpisode = memorySourceEpisode(memory, props.profile);
  const displayText = normalizeMemoryText(memory.narrative ?? memory.text);
  return (
    <article className="memory-detail" id={`memory-${memory.id}`}>
      <header className="memory-detail-header">
        <button type="button" onClick={props.onBack} aria-label="返回记忆列表"><ArrowLeft size={19} /></button>
        <div><span>{formatPapoDateTime(memory.createdAt)}</span><h2>{title}</h2></div>
      </header>

      {memory.visual ? <MediaThumbnail item={attachmentMediaItem(memory.visual, title)} className="memory-detail-visual" /> : null}

      <section className="memory-detail-story">
        <span>{props.profile.creatureName} 记得</span>
        <p>{displayText}</p>
        <AttachmentStrip attachments={memory.attachments} profile={props.profile} />
      </section>

      {sourceEpisode ? (
        <section className="memory-detail-source">
          <span>那时发生的事</span>
          <p>{episodeUserLine(sourceEpisode, episodeSourceMessages(props.profile, sourceEpisode))}</p>
          <AttachmentStrip attachments={sourceEpisode.attachments} profile={props.profile} />
          {episodePapoLine(sourceEpisode) ? <small>{props.profile.creatureName} 当时说：{episodePapoLine(sourceEpisode)}</small> : null}
        </section>
      ) : null}

      <section className="memory-detail-maintenance">
        <div className="memory-detail-maintenance-head"><span>维护这段记忆</span><small>只有你可以修改或忘记</small></div>
        {props.editing ? (
          <div className="memory-detail-editor">
            <textarea value={props.draft} onChange={(event) => props.onDraftChange(event.target.value)} rows={5} />
            <div><button className="primary" type="button" onClick={props.onSaveEdit}><Save size={16} />保存</button><button type="button" onClick={props.onCancelEdit}>取消</button></div>
          </div>
        ) : (
          <div className="memory-detail-actions">
            <button type="button" onClick={props.onStartEdit}><MessageCircle size={16} />改准</button>
            <button type="button" onClick={() => props.onFeedback("important", memory.id, undefined, "button")} disabled={props.busy || isFeedbackPending(props.feedbackPendingKey, "important", memory.id)}><Save size={16} />{isFeedbackPending(props.feedbackPendingKey, "important", memory.id) ? "处理中" : "很重要"}</button>
            <button type="button" onClick={() => props.onFeedback("remind", memory.id, undefined, "button")} disabled={props.busy || isFeedbackPending(props.feedbackPendingKey, "remind", memory.id)}><Lightbulb size={16} />{isFeedbackPending(props.feedbackPendingKey, "remind", memory.id) ? "处理中" : "提醒我"}</button>
            <button type="button" onClick={() => props.onFeedback("forget", memory.id)} disabled={props.busy || isFeedbackPending(props.feedbackPendingKey, "forget", memory.id)}><RefreshCcw size={16} />{isFeedbackPending(props.feedbackPendingKey, "forget", memory.id) ? "处理中" : memory.weight <= 0 ? "彻底删除" : "忘记"}</button>
          </div>
        )}
        <MemoryFeedbackBox targetId={memory.id} creatureName={props.profile.creatureName} onFeedback={props.onFeedback} onObserveFeedbackAudio={props.onObserveFeedbackAudio} pending={isFeedbackPending(props.feedbackPendingKey, "continue", memory.id)} />
      </section>

      <MemoryTraceList memory={memory} profile={props.profile} />
    </article>
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
  const image = props.candidate.attachments?.find((attachment) => attachment.kind === "image") ?? props.candidate.previewVisual;
  const title = props.candidate.shortTitle ?? memoryShortTitle(props.candidate.candidateText);
  const content = normalizeMemoryText(props.candidate.candidateText);
  const pendingRemember = isFeedbackPending(props.feedbackPendingKey, "remember", props.candidate.id);
  const pendingImportant = isFeedbackPending(props.feedbackPendingKey, "important", props.candidate.id);
  const pendingForget = isFeedbackPending(props.feedbackPendingKey, "forget", props.candidate.id);
  return (
    <article className={`candidate-memory ${image ? "has-image" : "text-only"}`} aria-labelledby={`candidate-title-${props.candidate.id}`}>
      <div className="candidate-memory-preview">
        {image ? (
          <MediaThumbnail item={attachmentMediaItem(image, title)} className="candidate-memory-image" />
        ) : (
          <div className="candidate-memory-placeholder" aria-hidden="true">
            <History size={23} />
            <span>{props.candidate.previewStatus === "pending" ? "正在画下" : "一段生活"}</span>
          </div>
        )}
      </div>
      <div className="candidate-memory-body">
        <header className="candidate-memory-header">
          <span>{formatPapoDateTime(props.candidate.createdAt)} · {memoryKindLabel(props.candidate.memoryKind)}</span>
          <h3 id={`candidate-title-${props.candidate.id}`}>{title}</h3>
        </header>
        <p className="candidate-memory-text">{content}</p>
        {props.candidate.whyConsolidate ? (
          <p className="candidate-memory-reason"><Sparkles size={14} /><span><strong>{props.profile.creatureName} 为什么暂存</strong>{normalizeMemoryText(props.candidate.whyConsolidate)}</span></p>
        ) : null}
        {(sourceEpisode || (props.candidate.attachments?.length ?? 0) > (image ? 1 : 0)) ? (
          <details className="candidate-memory-source">
            <summary>查看原始经历</summary>
            {sourceEpisode ? <p>{episodeUserLine(sourceEpisode, episodeSourceMessages(props.profile, sourceEpisode))}</p> : null}
            <AttachmentStrip attachments={props.candidate.attachments?.filter((attachment) => attachment.id !== image?.id)} profile={props.profile} />
          </details>
        ) : null}
        <div className="candidate-memory-actions">
          <button className="primary" type="button" onClick={() => props.onFeedback("remember", props.candidate.id, undefined, "button")} disabled={pendingRemember}>
            <Check size={17} />{pendingRemember ? "正在留下" : "留下这段记忆"}
          </button>
          <button type="button" onClick={() => props.onFeedback("forget", props.candidate.id, undefined, "button")} disabled={pendingForget}>
            <X size={17} />{pendingForget ? "正在处理" : "忘记"}
          </button>
          <button className="candidate-important-button" type="button" onClick={() => props.onFeedback("important", props.candidate.id, undefined, "button")} disabled={pendingImportant}>
            <Lightbulb size={16} />{pendingImportant ? "正在标记" : "标为重要"}
          </button>
        </div>
        <MemoryFeedbackBox
          targetId={props.candidate.id}
          creatureName={props.profile.creatureName}
          onFeedback={props.onFeedback}
          onObserveFeedbackAudio={props.onObserveFeedbackAudio}
          pending={isFeedbackPending(props.feedbackPendingKey, "continue", props.candidate.id)}
        />
      </div>
    </article>
  );
}

function MemoryMainLines({ memory, profile }: { memory: CreatureProfile["longTermMemories"][number]; profile: CreatureProfile }) {
  const sourceEpisode = memorySourceEpisode(memory, profile);
  const displayText = memory.narrative ?? memoryResultLine(memory);
  const title = memory.shortTitle ?? memoryShortTitle(displayText);

  return (
    <div className="memory-main">
      {memory.visual ? <MediaThumbnail item={attachmentMediaItem(memory.visual, memory.shortTitle ?? "共同回忆")} className="memory-visual" /> : null}
      <div className="memory-copy">
        <div className="memory-meta"><span>{formatPapoDateTime(memory.createdAt)}</span><span>{memoryKindLabel(memory.kind)}</span></div>
        <h3>{title}</h3>
        <strong className="memory-text-preview">{displayText}</strong>
      </div>
      {shouldShowFullMemoryText(displayText) ? (
        <details className="memory-details memory-full-text">
          <summary>完整记忆</summary>
          <p>{displayText}</p>
        </details>
      ) : null}
      <AttachmentStrip attachments={memory.attachments} profile={profile} />
      {sourceEpisode ? (
        <details className="memory-details">
          <summary>详情</summary>
          <div className="memory-detail-body">
            <div>
              <span>你当时说</span>
              <p>{episodeUserLine(sourceEpisode, episodeSourceMessages(profile, sourceEpisode))}</p>
              <AttachmentStrip attachments={sourceEpisode.attachments} profile={profile} />
            </div>
            {episodePapoLine(sourceEpisode) ? (
              <div>
                <span>{profile.creatureName} 当时回你</span>
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
  if (source === "emergence") return "它后来怎样想起";
  if (source === "curious_stream" || source === "button") return "它当时怎样被理解";
  return "模型流程";
}

function MemoryFeedbackBox(props: {
  targetId: string;
  creatureName: string;
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
          placeholder={`告诉 ${props.creatureName}：标题、内容或画面想怎么改`}
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
  onLogout: () => void | Promise<void>;
  onRename: (creatureName: string) => Promise<void>;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  onChangePetProfile: (input: { guidance?: string; referenceSummary?: string; referenceAttachment?: MediaAttachment }) => Promise<void>;
  onGenerateInitialActionCards: (guidance?: string) => Promise<void>;
  onGoMemory: (memoryId?: string) => void;
  onGoChat: () => void;
  onUpdateActionCard: (cardId: string, input: ActionCardUpdate) => void;
}) {
  const petProfile = petProfileFor(props.profile);
  const initialMotionCount = initialMotionActionCardCount(props.profile);
  const allIllustrations = props.profile.illustrations ?? [];
  const illustrations = allIllustrations.slice(0, 8);
  const allActionCards = (props.profile.actionCards ?? []).filter((card) => !card.deleted);
  const actionCards = allActionCards.slice(0, 8);
  const illustrationMediaItems = illustrations.map(illustrationMediaItem);
  const memories = (props.profile.longTermMemories ?? []).filter((memory) => memory.kind !== "creature_self_memory");
  const candidates = (props.profile.memoryCandidates ?? []).filter((candidate) => candidate.status === "candidate");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const [nameDraft, setNameDraft] = useState(props.profile.creatureName);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameMessage, setNameMessage] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState("");
  const [petGuidance, setPetGuidance] = useState("");
  const [petReferenceSummary, setPetReferenceSummary] = useState("");
  const [petReferenceAttachment, setPetReferenceAttachment] = useState<MediaAttachment | undefined>();
  const [petReferencePreview, setPetReferencePreview] = useState("");
  const [petBusy, setPetBusy] = useState(false);
  const [petMessage, setPetMessage] = useState("");
  const [motionBusy, setMotionBusy] = useState(false);
  const [motionGuidance, setMotionGuidance] = useState("");
  const [motionMessage, setMotionMessage] = useState("");

  useEffect(() => {
    setNameDraft(props.profile.creatureName);
  }, [props.profile.userId, props.profile.creatureName]);

  useEffect(() => {
    return () => {
      if (petReferencePreview.startsWith("blob:")) URL.revokeObjectURL(petReferencePreview);
    };
  }, [petReferencePreview]);

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (settingsOpenRef.current && event.state?.papoOverlay !== "profile-settings") setSettingsOpen(false);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  function openSettings() {
    window.history.pushState({ ...(window.history.state ?? {}), papoOverlay: "profile-settings" }, "");
    setSettingsOpen(true);
  }

  function closeSettings() {
    if (window.history.state?.papoOverlay === "profile-settings") window.history.back();
    else setSettingsOpen(false);
  }

  async function saveName() {
    setNameBusy(true);
    setNameMessage("");
    try {
      await props.onRename(nameDraft);
      setNameMessage("名字已保存");
    } catch (caught) {
      setNameMessage(errorMessage(caught));
    } finally {
      setNameBusy(false);
    }
  }

  async function savePassword(nextPassword: string) {
    setPasswordBusy(true);
    setPasswordMessage("");
    try {
      await props.onChangePassword(currentPassword, nextPassword);
      setCurrentPassword("");
      setNewPassword("");
      setPasswordMessage(nextPassword.trim() ? "密码已保存" : "密码已清除");
    } catch (caught) {
      setPasswordMessage(errorMessage(caught));
    } finally {
      setPasswordBusy(false);
    }
  }

  async function choosePetReference(file?: File) {
    if (!file) return;
    if (petReferencePreview.startsWith("blob:")) URL.revokeObjectURL(petReferencePreview);
    const preview = URL.createObjectURL(file);
    setPetReferencePreview(preview);
    setPetReferenceAttachment(undefined);
    setPetReferenceSummary("");
    setPetMessage("正在看这张照片");
    try {
      const dataUrl = await readImageFileAsUploadDataUrl(file);
      const result = await summarizeImage(dataUrl, file.name || "小动物参考图");
      const observedAt = file.lastModified ? new Date(file.lastModified).toISOString() : new Date().toISOString();
      if (result.asset) {
        setPetReferenceAttachment({
          ...result.asset,
          label: file.name || result.asset.label,
          observedAt
        });
      }
      setPetReferenceSummary(result.summary);
      setPetMessage("照片已准备好");
    } catch (caught) {
      setPetMessage(imageUploadErrorMessage(caught));
    }
  }

  async function savePetProfile() {
    if (!petGuidance.trim() && !petReferenceSummary && !petReferenceAttachment) {
      setPetMessage("写一点想要的样子，或选一张参考图。");
      return;
    }
    setPetBusy(true);
    setPetMessage("");
    try {
      await props.onChangePetProfile({
        guidance: petGuidance.trim() || undefined,
        referenceSummary: petReferenceSummary || undefined,
        referenceAttachment: petReferenceAttachment
      });
      setPetMessage("形象已更新");
    } catch (caught) {
      setPetMessage(errorMessage(caught));
    } finally {
      setPetBusy(false);
    }
  }

  async function generateMotions() {
    setMotionBusy(true);
    setMotionMessage("");
    try {
      await props.onGenerateInitialActionCards(motionGuidance.trim() || undefined);
      setMotionGuidance("");
      setMotionMessage("开始生成动作了，完成后会自动出现在动作卡里。");
    } catch (caught) {
      setMotionMessage(errorMessage(caught));
    } finally {
      setMotionBusy(false);
    }
  }

  return (
    <section className="profile-hub">
      <header className="profile-identity">
        <div className="profile-identity-avatar">
          <AvatarPreview petKind={props.profile.petKind} petProfile={petProfile} state={props.profile.state} dogState={props.profile.dogState} />
        </div>
        <div className="profile-identity-copy">
          <span className="profile-kicker">我的 Papo</span>
          <h2>{props.profile.creatureName}</h2>
          <p>{petProfile.displaySpecies} · {papoMoodLabel(props.profile.state)}</p>
          <small>@{props.profile.userId}</small>
        </div>
        <button className="profile-settings-button" type="button" onClick={openSettings} aria-label="Papo 设置">
          <Settings size={20} />
        </button>
      </header>

      {!settingsOpen ? <>
      <section className="profile-stats" aria-label="我的内容概览">
        <button type="button" onClick={() => props.onGoMemory()}>
          <strong>{memories.length}</strong>
          <span>长期记忆</span>
        </button>
        <a href="#my-illustrations">
          <strong>{allIllustrations.length}</strong>
          <span>画过</span>
        </a>
        <a href="#my-actions">
          <strong>{allActionCards.filter((card) => actionCardDisplayMode(card) !== "disabled").length}</strong>
          <span>动作卡</span>
        </a>
      </section>

      <section className="profile-content-section" id="my-illustrations">
        <ProfileSectionHeading icon={Images} title="画过" meta={`${allIllustrations.length} 张`} />
        {illustrations.length ? (
          <div className="profile-illustration-rail">
            {illustrations.map((item, index) => (
              <MediaThumbnail item={illustrationMediaItems[index]} items={illustrationMediaItems} index={index} key={item.id}>
                <img src={resolveAssetUrl(item.attachment.url)} alt="" loading="lazy" />
                <span>{item.title}</span>
              </MediaThumbnail>
            ))}
          </div>
        ) : <ProfileEmptyState icon={Images} text={`${props.profile.creatureName} 画出的图片会收在这里`} />}
      </section>

      <section className="profile-content-section" id="my-actions">
        <ProfileSectionHeading icon={Play} title="动作卡" meta={`${allActionCards.filter((card) => actionCardDisplayMode(card) !== "disabled").length} 个可用`} />
        {actionCards.length ? (
          <div className="profile-action-rail">
            {actionCards.map((card) => (
              <article className={`profile-action-item mode-${actionCardDisplayMode(card)}`} key={card.id}>
                <ActionCardCover card={card} profile={props.profile} />
                <div>
                  <strong>{namedCreatureText(card.title, props.profile.creatureName) || card.title}</strong>
                  <ActionCardModeControl card={card} onChange={(displayMode) => props.onUpdateActionCard(card.id, { displayMode })} />
                </div>
              </article>
            ))}
          </div>
        ) : <ProfileEmptyState icon={Play} text="生成的动作会收在这里" />}
      </section>

      <section className="profile-content-section profile-memory-section">
        <ProfileSectionHeading icon={History} title="记忆" meta={candidates.length ? `${candidates.length} 条待确认` : `${memories.length} 条`} />
        {memories.length ? (
          <div className="profile-memory-rail">
            {memories.slice(0, 8).map((memory) => <MemoryCover key={memory.id} memory={memory} onClick={() => props.onGoMemory(memory.id)} />)}
          </div>
        ) : <ProfileEmptyState icon={History} text={`${props.profile.creatureName} 还在慢慢认识你`} />}
        <button className="profile-view-all" type="button" onClick={() => props.onGoMemory()}>查看全部记忆 <ChevronRight size={16} /></button>
      </section>
      </> : <>
      <header className="profile-settings-header">
        <button type="button" onClick={closeSettings} aria-label="返回我的"><ArrowLeft size={20} /></button>
        <div><strong>Papo 设置</strong><small>形象、设备与账号</small></div>
      </header>

      <section className="profile-settings-section">
        <ProfileSectionHeading icon={Sparkles} title={`${props.profile.creatureName} 的设定`} />
        <details className="profile-setting-group">
          <summary>
            <span><UserRound size={18} /><span><strong>名字</strong><small>{props.profile.creatureName}</small></span></span>
            <ChevronRight size={18} />
          </summary>
          <div className="profile-setting-body profile-name-settings">
          <label className="field-label">
            名字
            <input
              type="text"
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              maxLength={40}
              placeholder="给它起个名字"
            />
          </label>
          <button className="primary" onClick={() => void saveName()} disabled={nameBusy || !nameDraft.trim() || nameDraft.trim() === props.profile.creatureName} type="button">
            <Save size={16} />
            {nameBusy ? "保存中" : "保存名字"}
          </button>
          {nameMessage ? <small>{nameMessage}</small> : null}
          </div>
        </details>

        <details className="profile-setting-group">
          <summary>
            <span><ImagePlus size={18} /><span><strong>形象与性格</strong><small>{petProfile.displaySpecies} · {petProfile.personality}</small></span></span>
            <ChevronRight size={18} />
          </summary>
          <div className="profile-setting-body pet-profile-settings">
          <div className="pet-profile-head">
            <strong>小动物形象</strong>
            <span>{petProfile.displaySpecies}</span>
          </div>
          <div className="pet-profile-current">
            {petProfile.avatarImage ? (
              <img src={resolveAssetUrl(petProfile.avatarImage.url)} alt={petProfile.avatarImage.label} />
            ) : (
              <AvatarPreview petKind={props.profile.petKind} petProfile={petProfile} state={props.profile.state} dogState={props.profile.dogState} />
            )}
            <div>
              <small>{petProfile.appearance}</small>
              <small>{petProfile.personality}</small>
              <small>更新：{formatPapoDateTime(petProfile.updatedAt)}</small>
            </div>
          </div>
          <label className="field-label">
            你想把它养成什么样
            <textarea
              value={petGuidance}
              onChange={(event) => setPetGuidance(event.target.value)}
              maxLength={1200}
              rows={4}
              placeholder="例如：更像一只圆脸灰白英短，动作慢一点，喜欢蹲在我旁边看我工作。"
            />
          </label>
          <div className="pet-profile-reference">
            {petReferencePreview ? (
              <div className="profile-reference-thumb">
                <img src={petReferencePreview} alt="参考图预览" />
                <button type="button" onClick={() => {
                  if (petReferencePreview.startsWith("blob:")) URL.revokeObjectURL(petReferencePreview);
                  setPetReferencePreview("");
                  setPetReferenceAttachment(undefined);
                  setPetReferenceSummary("");
                }}>
                  <X size={14} />
                  删除
                </button>
              </div>
            ) : null}
            <label className="upload-button compact-upload">
              <ImagePlus size={16} />
              选择参考图
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  void choosePetReference(event.currentTarget.files?.[0]);
                  event.currentTarget.value = "";
                }}
              />
            </label>
          </div>
          <div className="pet-profile-actions">
            <button className="primary" onClick={() => void savePetProfile()} disabled={petBusy} type="button">
              <Sparkles size={16} />
              {petBusy ? "生成形象中" : "更换小动物形象"}
            </button>
          </div>
          {petMessage ? <small>{petMessage}</small> : null}
          </div>
        </details>

        <details className="profile-setting-group">
          <summary>
            <span><Play size={18} /><span><strong>生成动作</strong><small>初始动作 {Math.min(initialMotionCount, 4)}/4</small></span></span>
            <ChevronRight size={18} />
          </summary>
          <div className="profile-setting-body pet-motion-settings">
          <div className="pet-profile-head">
            <strong>动作卡</strong>
            <span>初始动作 {Math.min(initialMotionCount, 4)}/4</span>
          </div>
          <p className="muted">{initialMotionCount >= 4 ? `初始动作已经准备好。还想增加动作卡，直接在对话里告诉 ${props.profile.creatureName} 想做什么。` : `这里每次生成一个初始动作：先生成与当前形象一致的封面，再让它动起来。`}</p>
          <label className="field-label">
            这次想让它做什么
            <input
              type="text"
              value={motionGuidance}
              onChange={(event) => setMotionGuidance(event.target.value)}
              maxLength={800}
              placeholder="可选，例如：轻轻眨眼、追蝴蝶、趴下来睡觉"
            />
          </label>
          <div className="pet-profile-actions">
            <button onClick={() => initialMotionCount >= 4 ? props.onGoChat() : void generateMotions()} disabled={motionBusy || petProfile.initialMotion?.status === "pending"} type="button">
              <Sparkles size={16} />
              {petProfile.initialMotion?.status === "pending" ? "动作生成中" : motionBusy ? "启动中" : initialMotionCount >= 4 ? "去对话生成更多" : "生成一个初始动画"}
            </button>
          </div>
          {petProfile.initialMotion?.status === "failed" ? <small>动作生成失败：{petProfile.initialMotion.error}</small> : null}
          {motionMessage ? <small>{motionMessage}</small> : null}
          </div>
        </details>
      </section>

      <section className="profile-settings-section">
        <ProfileSectionHeading icon={Smartphone} title="设备与服务" />
        <PushNotificationSettings profile={props.profile} />
        <AppUpdateSettings />
      </section>

      <section className="profile-settings-section">
        <ProfileSectionHeading icon={UserRound} title="账号与安全" />
        <div className="profile-account-row">
          <span><strong>账号</strong><small>User ID · {props.profile.userId}</small></span>
          <span>{props.profile.hasPassword ? "已设密码" : "未设密码"}</span>
        </div>
        <details className="profile-setting-group">
          <summary>
            <span><Save size={18} /><span><strong>{props.profile.hasPassword ? "修改密码" : "创建密码"}</strong><small>保护你的 Papo 和记忆</small></span></span>
            <ChevronRight size={18} />
          </summary>
          <div className="profile-setting-body password-settings">
          <strong>{props.profile.hasPassword ? "修改密码" : "创建密码"}</strong>
          {props.profile.hasPassword ? (
            <label className="field-label">
              当前密码
              <input
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
              />
            </label>
          ) : null}
          <label className="field-label">
            新密码
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder={props.profile.hasPassword ? "输入新密码" : "输入后，这个账号会需要密码登录"}
              autoComplete="new-password"
            />
          </label>
          <div className="password-actions">
            <button className="primary" onClick={() => void savePassword(newPassword)} disabled={passwordBusy || !newPassword.trim()} type="button">
              <Save size={16} />
              {passwordBusy ? "保存中" : props.profile.hasPassword ? "保存新密码" : "创建密码"}
            </button>
            {props.profile.hasPassword ? (
              <button onClick={() => void savePassword("")} disabled={passwordBusy} type="button">
                清除密码
              </button>
            ) : null}
          </div>
          {passwordMessage ? <small>{passwordMessage}</small> : null}
          </div>
        </details>
        <div className="profile-meta-row"><span>默认时间</span><strong>{papoTimeZone}</strong></div>
        <button className="profile-logout" onClick={() => void props.onLogout()}>
          <RefreshCcw size={18} />
          退出登录
        </button>
      </section>
      </>}

    </section>
  );
}

function ProfileSectionHeading({ icon: Icon, title, meta }: { icon: typeof Check; title: string; meta?: string }) {
  return (
    <header className="profile-section-heading">
      <span><Icon size={18} /><strong>{title}</strong></span>
      {meta ? <small>{meta}</small> : null}
    </header>
  );
}

function ProfileEmptyState({ icon: Icon, text }: { icon: typeof Check; text: string }) {
  return <div className="profile-empty"><Icon size={22} /><span>{text}</span></div>;
}

function ActionCardCover({ card, profile }: { card: NonNullable<CreatureProfile["actionCards"]>[number]; profile: CreatureProfile }) {
  const coverUrl = card.cover
    ? resolveAssetUrl(card.cover.url)
    : profile.petProfile?.avatarImage
      ? resolveAssetUrl(profile.petProfile.avatarImage.url)
      : undefined;
  return (
    <MediaThumbnail item={actionCardMediaItem(card)} className="action-card-cover">
      {coverUrl ? (
        <img src={coverUrl} alt="" loading="lazy" />
      ) : (
        <AvatarPreview petKind={profile.petKind} petProfile={petProfileFor(profile)} state={profile.state} dogState={profile.dogState} />
      )}
      <span className="action-card-play"><Play size={18} fill="currentColor" /></span>
    </MediaThumbnail>
  );
}

function MemoryCover({ memory, onClick }: { memory: CreatureProfile["longTermMemories"][number]; onClick: () => void }) {
  const image = memory.visual ?? memory.attachments?.find((attachment) => attachment.kind === "image");
  const title = memory.shortTitle ?? memoryShortTitle(memory.narrative ?? memory.text);
  return (
    <button className={image ? "memory-cover has-image" : "memory-cover text-only"} type="button" onClick={onClick} aria-label={`查看记忆：${title}`}>
      <span className="memory-cover-art">
        {image ? <img src={resolveAssetUrl(image.url)} alt="" loading="lazy" /> : <strong>{title}</strong>}
      </span>
      <span className="memory-cover-details">
        <strong>{title}</strong>
        <small>{formatPapoDateTime(memory.createdAt)}</small>
      </span>
    </button>
  );
}

function AppUpdateSettings() {
  const [state, setState] = useState<AppUpdateState>();
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");

  const check = useCallback(async () => {
    setBusy(true);
    setMessage("");
    try {
      setState(await inspectAppUpdate());
    } catch (caught) {
      setMessage(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  async function download() {
    if (!state) return;
    setMessage("");
    try {
      await openAppUpdateDownload(state.release.downloadUrl);
    } catch (caught) {
      setMessage(errorMessage(caught));
    }
  }

  const status = !state
    ? busy ? "正在获取版本信息" : "暂时无法获取版本信息"
    : !state.native
      ? `Android 最新版 ${state.release.versionName}`
      : state.updateAvailable
        ? `${state.legacyNative ? "当前为早期版本" : `当前 ${state.currentVersionName}`}，可更新到 ${state.release.versionName}`
        : `当前 ${state.currentVersionName}，已是最新版`;

  return (
    <div className="app-update-settings">
      <div className="app-update-summary">
        <Smartphone size={18} />
        <div>
          <strong>应用更新</strong>
          <small>{status}</small>
        </div>
      </div>
      <div className="app-update-actions">
        <button onClick={() => void check()} disabled={busy} type="button" title="检查更新">
          <RefreshCcw className={busy ? "spin" : ""} size={16} />
          {busy ? "检查中" : "检查更新"}
        </button>
        {state && (!state.native || state.updateAvailable) ? (
          <button className="primary" onClick={() => void download()} type="button">
            <Download size={16} />
            下载 {state.release.versionName}
          </button>
        ) : null}
      </div>
      {state?.updateAvailable && state.release.notes.length ? (
        <small>{state.release.notes.join("；")}</small>
      ) : null}
      {message ? <small className="app-update-error">{message}</small> : null}
    </div>
  );
}

function PushNotificationSettings({ profile }: { profile: CreatureProfile }) {
  const [state, setState] = useState<PushNotificationState>("loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    void inspectPushNotifications()
      .then((next) => {
        if (active) setState(next);
      })
      .catch((error) => {
        if (active) {
          setState("disabled");
          setMessage(errorMessage(error));
        }
      });
    return () => {
      active = false;
    };
  }, [profile.userId]);

  async function toggle() {
    setBusy(true);
    setMessage("");
    try {
      const next = state === "enabled"
        ? await disablePushNotifications(profile.userId)
        : await enablePushNotifications(profile.userId);
      setState(next);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const canToggle = state !== "loading" && state !== "unsupported" && state !== "unconfigured" && state !== "denied";
  return (
    <div className="push-notification-settings">
      <div>
        {state === "enabled" ? <Bell size={18} /> : <BellOff size={18} />}
        <div>
          <strong>消息通知</strong>
          <small>{pushNotificationStateText(state)}</small>
        </div>
      </div>
      <button className={state === "enabled" ? "" : "primary"} onClick={() => void toggle()} disabled={busy || !canToggle} type="button">
        {busy ? "处理中" : state === "enabled" ? "关闭" : "开启"}
      </button>
      {message ? <small>{message}</small> : null}
    </div>
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
        <strong>{profile.creatureName} 想起一件事</strong>
        {emergence.cognitionTrace ? <DeveloperTrace trace={emergence.cognitionTrace} profile={profile} /> : null}
      </div>
      <p>{visibleCreatureText(emergence.text)}</p>
      {emergence.memoryId ? (
        <button className="emergence-memory-link" type="button" onClick={() => requestMemoryNavigation(emergence.memoryId!)}>
          <History size={15} />
          查看这段记忆
          <ChevronRight size={15} />
        </button>
      ) : null}
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
        {props.unreadCount ? <i className="unread-dot" aria-label={`${props.unreadCount} 条未读回复`}>{Math.min(9, props.unreadCount)}</i> : null}
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

function ConversationWorkIndicator({ profile, onDismissJob }: { profile: CreatureProfile; onDismissJob: (jobId: string) => Promise<void> }) {
  const conversationJobs = (profile.jobs ?? []).filter((job) => job.type !== "memory_enrichment" && job.type !== "candidate_visual");
  const active = conversationJobs.filter((job) => job.status === "queued" || job.status === "running");
  const failed = conversationJobs.filter((job) => job.status === "failed" && !job.dismissedAt).slice(0, 2);
  if (!active.length && !failed.length) return null;
  const byTurn = new Map<string, typeof active>();
  for (const job of active) byTurn.set(job.turnId, [...(byTurn.get(job.turnId) ?? []), job]);
  return (
    <div className="conversation-work-list" aria-live="polite">
      {[...byTurn.entries()].map(([turnId, jobs]) => {
        const slowAction = jobs.find((job) => job.stage === "action");
        const sensing = jobs.find((job) => job.stage === "sensing");
        const label = slowAction
          ? slowAction.type === "illustration" ? "正在画画" : slowAction.type === "action_card" ? "正在制作动作" : "正在处理外部任务"
          : sensing ? sensing.type === "audio_understanding" ? "正在听录音" : "正在看照片" : "正在理解和回复";
        return (
          <div className="conversation-work" key={turnId} data-stage={slowAction ? "action" : "cognition"}>
            <span className="working-pet" aria-hidden="true"><PawPrint size={18} /></span>
            <span>{profile.creatureName} {label}</span>
          </div>
        );
      })}
      {failed.map((job) => (
        <div className="conversation-work failed" key={job.id}>
          <span className="working-pet" aria-hidden="true"><X size={16} /></span>
          <span>{job.type === "illustration" ? "画画" : job.type === "action_card" ? "动作制作" : job.stage === "sensing" ? "媒体理解" : "回复"}失败：{job.error ?? "可以继续发送消息"}</span>
          <button type="button" aria-label="关闭失败提示" onClick={() => void onDismissJob(job.id)}><X size={15} /></button>
        </div>
      ))}
    </div>
  );
}

function ActionCardPendingNotice({ profile, count }: { profile: CreatureProfile; count: number }) {
  return (
    <div className="hermes-notice action-card-pending" aria-live="polite">
      <Sparkles size={16} />
      <span>正在让 {profile.creatureName} 动起来...</span>
      <small>{count > 1 ? `${count} 张动作卡在生成` : "动作卡生成好后会自动出现"}</small>
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

function countPendingActionCards(profile: CreatureProfile | undefined) {
  if (!profile) return 0;
  return Math.min((profile.jobs ?? []).filter((job) => job.type === "action_card" && (job.status === "queued" || job.status === "running")).length, 9);
}

function initialMotionActionCardCount(profile: CreatureProfile | undefined) {
  return (profile?.actionCards ?? []).filter((card) => !card.deleted && card.sourceIds.some((id) => id.startsWith("initial-motion:"))).length;
}

function readSavedUserId() {
  return safeLocalStorageGet(LOCAL_USER_ID_KEY)?.trim() || "";
}

function saveUserId(userId: string) {
  safeLocalStorageSet(LOCAL_USER_ID_KEY, userId);
}

function forgetSavedUserId() {
  safeLocalStorageRemove(LOCAL_USER_ID_KEY);
}

function randomRegistrationPetKind() {
  return PET_KINDS[Math.floor(Math.random() * PET_KINDS.length)]?.id ?? "shiba";
}

function readProfileSnapshot(): Partial<CreatureProfile> | undefined {
  try {
    const raw = safeLocalStorageGet(LOCAL_PROFILE_SNAPSHOT_KEY);
    if (!raw) return undefined;
    return JSON.parse(raw) as Partial<CreatureProfile>;
  } catch {
    return undefined;
  }
}

function saveProfileSnapshot(profile: CreatureProfile) {
  const snapshot: Partial<CreatureProfile> = {
    userId: profile.userId,
    creatureName: profile.creatureName,
    petKind: profile.petKind,
    state: profile.state,
    dogState: profile.dogState,
    petProfile: profile.petProfile
  };
  safeLocalStorageSet(LOCAL_PROFILE_SNAPSHOT_KEY, JSON.stringify(snapshot));
}

function saveProfilePassword(userId: string, password?: string) {
  const key = `${LOCAL_PASSWORD_PREFIX}${userId}`;
  if (password?.trim()) {
    safeLocalStorageSet(key, password);
    return;
  }
  safeLocalStorageRemove(key);
}

function forgetProfilePassword(userId: string) {
  safeLocalStorageRemove(`${LOCAL_PASSWORD_PREFIX}${userId}`);
}

function safeLocalStorageGet(key: string) {
  try {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function safeLocalStorageSet(key: string, value: string) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, value);
  } catch {
    // Storage may be blocked in embedded/private contexts. The app must still render.
  }
}

function safeLocalStorageRemove(key: string) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(key);
  } catch {
    // Storage may be blocked in embedded/private contexts. The app must still render.
  }
}

function messageTitle(message: CreatureProfile["conversation"][number], creatureName: string) {
  if (message.role === "papo") return creatureName;
  if (message.channel === "feedback") return "你的反馈";
  if (message.modality === "image_summary") return `你给 ${creatureName} 看了照片`;
  if (message.modality === "audio_observation") return "一段声音";
  return message.role === "world" ? "周围的一段" : "你";
}

function messageContextText(message: CreatureProfile["conversation"][number], creatureName: string) {
  if (message.role === "papo") return "";
  if (message.channel === "feedback") return "你在教我";
  if (message.channel === "curious") return "和这次陪伴放在一起";
  return `说给 ${creatureName}`;
}

function locationText(location: NonNullable<StreamSegment["location"]>) {
  const accuracy = typeof location.accuracy === "number" ? `，约 ${Math.round(location.accuracy)} 米` : "";
  return location.label ?? `位置 ${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}${accuracy}`;
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "发生未知错误";
  if (message === "Password required") return "这个账号需要密码。";
  if (message === "Password is incorrect") return "密码不对。";
  if (/Request failed: 50[234]|Bad Gateway|Gateway Timeout|Service Unavailable/i.test(message)) return "连接刚才等太久断开了。你可以继续使用，稍慢的生成任务会在后台完成。";
  return message;
}

function nativeListeningError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/Microphone permission/i.test(message)) return "需要允许麦克风权限才能开始陪伴。";
  if (/Camera permission/i.test(message)) return "“陪我+看我”需要允许摄像头权限。";
  if (/notification/i.test(message)) return "需要允许系统通知，才能显示后台陪伴状态。";
  if (/securely cache|Keystore/i.test(message)) return "这台设备暂时无法安全保存后台陪伴凭据。";
  if (/microphone-(start|restart)-failed/i.test(message)) return "后台麦克风没有成功启动，请停止后重试。";
  if (/camera-(start-failed|permission-missing)/i.test(message)) return "摄像头没有成功启动；声音陪伴仍可单独使用。";
  if (/batch-persist-failed/i.test(message)) return "这一段没有安全写入待上传队列，陪伴已暂停。";
  return message || "后台陪伴暂时没有启动。";
}

function stagedSegmentReady(segment: StagedChatSegment | StreamSegment) {
  return !("status" in segment) || !segment.status || segment.status === "ready";
}

function clientTurnId() {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, "") ?? `${Date.now()}${Math.random().toString(36).slice(2)}`;
  return `turn_${random}`;
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

function audioAuditSummary(status?: SensingTrace["status"]) {
  if (status === "unreadable") return "这 30 秒的声音没有整理出可用内容。";
  if (status === "empty") return "这 30 秒里没有听到需要继续处理的内容。";
  return "这 30 秒里没有形成需要继续处理的声音线索。";
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
