import type { CaptureResult, ConversationJobRecord, ConversationTurnRecord, CreatureProfile, DreamRecord, FeedbackKind, FeedbackRecord, MediaAttachment, MessageCognitionTrace, SegmentKind, SensingTrace, StreamSegment, WakeEvent } from "../core/types";

const jsonHeaders = { "Content-Type": "application/json" };
const apiBase = import.meta.env.VITE_API_BASE as string | undefined;
const LOCAL_PASSWORD_PREFIX = "papo:password:";

export interface ProviderInfo {
  kind: string;
  name: string;
  available: boolean;
  usesRealModel: boolean;
  diagnostics?: {
    textProvider?: string;
    visionProvider?: string;
    audioProvider?: string;
    textModel?: string;
    visionModel?: string;
    audioModel?: string;
    audioRoute?: string;
  };
}

export interface ProfileSummary {
  userId: string;
  creatureName: string;
  createdAt: string;
}

export interface PushConfig {
  enabled: boolean;
  publicKey?: string;
}

export async function getPushConfig(): Promise<PushConfig> {
  return request("/api/push/config");
}

export async function registerPushSubscription(userId: string, subscription: PushSubscriptionJSON, appUrl: string) {
  return request<{ ok: true }>(`/api/profiles/${userId}/push-subscriptions`, {
    method: "POST",
    headers: profileJsonHeaders(userId),
    body: JSON.stringify({ ...subscription, appUrl })
  });
}

export async function removePushSubscription(userId: string, endpoint: string) {
  return request<{ ok: true }>(`/api/profiles/${userId}/push-subscriptions`, {
    method: "DELETE",
    headers: profileJsonHeaders(userId),
    body: JSON.stringify({ endpoint })
  });
}

export async function createDeviceSession(userId: string) {
  return request<{ token: string; expiresAt: string }>(`/api/profiles/${userId}/device-sessions`, {
    method: "POST",
    headers: authHeaders(userId)
  });
}

export async function revokeDeviceSessions(userId: string) {
  return request<{ ok: true }>(`/api/profiles/${userId}/device-sessions`, {
    method: "DELETE",
    headers: authHeaders(userId)
  });
}

export async function getProvider(): Promise<ProviderInfo> {
  return request("/api/provider");
}

export async function listProfiles(): Promise<ProfileSummary[]> {
  const data = await request<{ profiles: ProfileSummary[] }>("/api/profiles");
  return data.profiles;
}

export async function createProfile(input: { userId?: string; creatureName?: string; petKind?: string } | string = {}): Promise<CreatureProfile> {
  const body = typeof input === "string" ? { creatureName: input } : input;
  const data = await request<{ profile: CreatureProfile }>("/api/profiles", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body)
  });
  return data.profile;
}

export async function loginProfile(userId: string, password?: string): Promise<CreatureProfile> {
  const data = await request<{ profile: CreatureProfile }>(`/api/profiles/${userId}/login`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ password })
  });
  return data.profile;
}

export async function getProfile(userId: string): Promise<CreatureProfile> {
  const data = await request<{ profile: CreatureProfile }>(`/api/profiles/${userId}`, {
    headers: authHeaders(userId)
  });
  return data.profile;
}

export async function markPapoRead(userId: string, lastReadPapoMessageId?: string): Promise<CreatureProfile> {
  const data = await request<{ profile: CreatureProfile }>(`/api/profiles/${userId}/read-state`, {
    method: "PATCH",
    headers: profileJsonHeaders(userId),
    body: JSON.stringify({ lastReadPapoMessageId })
  });
  return data.profile;
}

export async function wakeProfile(userId: string): Promise<{ profile: CreatureProfile; wake: WakeEvent }> {
  return request<{ profile: CreatureProfile; wake: WakeEvent }>(`/api/profiles/${userId}/wake`, {
    method: "POST",
    headers: authHeaders(userId)
  });
}

export async function touchPet(userId: string, action: "idle" | "poke-wave" | "play-ball" | "nap"): Promise<{ profile: CreatureProfile; applied: boolean }> {
  return request<{ profile: CreatureProfile; applied: boolean }>(`/api/profiles/${userId}/pet-touch`, {
    method: "POST",
    headers: profileJsonHeaders(userId),
    body: JSON.stringify({ action })
  });
}

export async function summarizeImage(dataUrl: string, label: string): Promise<{ summary: string; asset?: MediaAttachment; provider: string; model?: string; route?: string; semanticSource: "llm"; sensingTrace?: SensingTrace }> {
  return request<{ summary: string; asset?: MediaAttachment; provider: string; model?: string; route?: string; semanticSource: "llm"; sensingTrace?: SensingTrace }>("/api/image-summary", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ dataUrl, label })
  });
}

export async function observeCameraFrame(dataUrl: string, label: string): Promise<{ summary: string; provider: string; model?: string; route?: string; semanticSource: "llm"; sensingTrace?: SensingTrace }> {
  return request<{ summary: string; provider: string; model?: string; route?: string; semanticSource: "llm"; sensingTrace?: SensingTrace }>("/api/camera-observation", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ dataUrl, label })
  }, { retries: 2, retryDelayMs: 1200 });
}

export async function observeAudio(dataUrl: string, label: string): Promise<{ observation: string; provider: string; model?: string; route?: string; noSpeech?: boolean; unreadable?: boolean; semanticSource: "llm"; sensingTrace?: SensingTrace }> {
  return request<{ observation: string; provider: string; model?: string; route?: string; noSpeech?: boolean; unreadable?: boolean; semanticSource: "llm"; sensingTrace?: SensingTrace }>("/api/audio-observation", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ dataUrl, label })
  }, { retries: 2, retryDelayMs: 1200 });
}

export async function buttonCapture(userId: string, text: string): Promise<CaptureResult> {
  return request(`/api/profiles/${userId}/button`, {
    method: "POST",
    headers: profileJsonHeaders(userId),
    body: JSON.stringify({ text })
  });
}

export async function curiousCapture(userId: string, segments: StreamSegment[]): Promise<CaptureResult> {
  return request(`/api/profiles/${userId}/curious`, {
    method: "POST",
    headers: profileJsonHeaders(userId),
    body: JSON.stringify({ segments })
  });
}

export interface AsyncTurnSegment {
  id: string;
  kind: SegmentKind;
  label: string;
  content?: string;
  dataUrl?: string;
  observedAt?: string;
  batchId?: string;
  location?: StreamSegment["location"];
  auditOnly?: boolean;
  sensingTrace?: SensingTrace;
}

export async function acceptConversationTurn(userId: string, input: {
  turnId: string;
  requestId: string;
  channel: "button" | "curious";
  segments: AsyncTurnSegment[];
}) {
  return request<{ profile: CreatureProfile; turn: ConversationTurnRecord; jobs: ConversationJobRecord[]; duplicate?: boolean }>(`/api/profiles/${userId}/turns`, {
    method: "POST",
    headers: profileJsonHeaders(userId),
    body: JSON.stringify(input)
  }, { retries: 2, retryDelayMs: 500 });
}

export async function sendFeedback(
  userId: string,
  kind: FeedbackKind,
  targetId?: string,
  input: { content?: string; modality?: "text" | "audio_observation" | "button" } = {}
): Promise<{ profile: CreatureProfile; feedback: FeedbackRecord }> {
  return request<{ profile: CreatureProfile; feedback: FeedbackRecord }>(`/api/profiles/${userId}/feedback`, {
    method: "POST",
    headers: profileJsonHeaders(userId),
    body: JSON.stringify({ kind, targetId, ...input })
  });
}

export async function updateLongTermMemory(userId: string, memoryId: string, text: string): Promise<CreatureProfile> {
  const data = await request<{ profile: CreatureProfile }>(`/api/profiles/${userId}/memories/${memoryId}`, {
    method: "PATCH",
    headers: profileJsonHeaders(userId),
    body: JSON.stringify({ text })
  });
  return data.profile;
}

export async function dreamMemories(userId: string): Promise<{ profile: CreatureProfile; dream?: DreamRecord }> {
  return request<{ profile: CreatureProfile; dream?: DreamRecord }>(`/api/profiles/${userId}/dreaming`, {
    method: "POST",
    headers: authHeaders(userId)
  });
}

export async function activeEmergence(userId: string) {
  return request<{ profile: CreatureProfile; emergence: { text: string; memoryId?: string; cognitionTrace?: MessageCognitionTrace } }>(
    `/api/profiles/${userId}/emergence`,
    { method: "POST", headers: authHeaders(userId) }
  );
}

export async function updateProfilePassword(userId: string, input: { currentPassword?: string; newPassword?: string }): Promise<CreatureProfile> {
  const data = await request<{ profile: CreatureProfile }>(`/api/profiles/${userId}/password`, {
    method: "PATCH",
    headers: profileJsonHeaders(userId),
    body: JSON.stringify(input)
  });
  return data.profile;
}

export async function updateProfileName(userId: string, creatureName: string): Promise<CreatureProfile> {
  const data = await request<{ profile: CreatureProfile }>(`/api/profiles/${userId}`, {
    method: "PATCH",
    headers: profileJsonHeaders(userId),
    body: JSON.stringify({ creatureName })
  });
  return data.profile;
}

export async function updatePetProfile(userId: string, input: { guidance?: string; referenceSummary?: string; referenceAttachment?: MediaAttachment }): Promise<CreatureProfile> {
  const data = await request<{ profile: CreatureProfile }>(`/api/profiles/${userId}/pet-profile`, {
    method: "POST",
    headers: profileJsonHeaders(userId),
    body: JSON.stringify(input)
  });
  return data.profile;
}

export async function generateInitialActionCards(userId: string, guidance?: string): Promise<CreatureProfile> {
  const data = await request<{ profile: CreatureProfile }>(`/api/profiles/${userId}/pet-profile/initial-action-cards`, {
    method: "POST",
    headers: profileJsonHeaders(userId),
    body: JSON.stringify({ guidance: guidance?.trim() || undefined })
  });
  return data.profile;
}

export async function updateActionCard(userId: string, cardId: string, input: { disabled?: boolean; deleted?: boolean }): Promise<CreatureProfile> {
  const data = await request<{ profile: CreatureProfile }>(`/api/profiles/${userId}/action-cards/${cardId}`, {
    method: "PATCH",
    headers: profileJsonHeaders(userId),
    body: JSON.stringify(input)
  });
  return data.profile;
}

export function makeSegment(id: string, kind: SegmentKind, label: string, content: string, extra: Partial<StreamSegment> = {}): StreamSegment {
  return { id, kind, label, content, ...extra };
}

export function resolveAssetUrl(url: string) {
  if (/^(https?:|blob:|data:)/.test(url)) return url;
  if (/^https?:\/\//.test(url)) return url;
  return resolveApiPath(url);
}

async function request<T>(path: string, init?: RequestInit, options: { retries?: number; retryDelayMs?: number } = {}): Promise<T> {
  const retries = options.retries ?? 0;
  const retryDelayMs = options.retryDelayMs ?? 800;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(resolveApiPath(path), init);
      if (isRetryableStatus(response.status) && attempt < retries) {
        await wait(retryDelayMs * (attempt + 1));
        continue;
      }
      return await parseResponse<T>(response);
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await wait(retryDelayMs * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Request failed");
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function isRetryableStatus(status: number) {
  return status === 502 || status === 503 || status === 504;
}

function wait(ms: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function resolveApiPath(path: string) {
  if (!apiBase) return path;
  return `${apiBase.replace(/\/$/, "")}${path.replace(/^\/api/, "")}`;
}

function profileJsonHeaders(userId: string): Record<string, string> {
  return { ...jsonHeaders, ...authHeaders(userId) };
}

function authHeaders(userId: string): Record<string, string> {
  const password = storedProfilePassword(userId);
  return password ? { "x-papo-password": password } : {};
}

function storedProfilePassword(userId: string) {
  try {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(`${LOCAL_PASSWORD_PREFIX}${userId}`) ?? "";
  } catch {
    return "";
  }
}
