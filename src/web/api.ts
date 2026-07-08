import type { CaptureResult, CreatureProfile, DreamRecord, FeedbackKind, FeedbackRecord, MediaAttachment, MessageCognitionTrace, SegmentKind, SensingTrace, StreamSegment, WakeEvent } from "../core/types";

const jsonHeaders = { "Content-Type": "application/json" };
const apiBase = import.meta.env.VITE_API_BASE as string | undefined;

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

export async function getProfile(userId: string): Promise<CreatureProfile> {
  const data = await request<{ profile: CreatureProfile }>(`/api/profiles/${userId}`);
  return data.profile;
}

export async function markPapoRead(userId: string, lastReadPapoMessageId?: string): Promise<CreatureProfile> {
  const data = await request<{ profile: CreatureProfile }>(`/api/profiles/${userId}/read-state`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ lastReadPapoMessageId })
  });
  return data.profile;
}

export async function wakeProfile(userId: string): Promise<{ profile: CreatureProfile; wake: WakeEvent }> {
  return request<{ profile: CreatureProfile; wake: WakeEvent }>(`/api/profiles/${userId}/wake`, { method: "POST" });
}

export async function summarizeImage(dataUrl: string, label: string): Promise<{ summary: string; asset?: MediaAttachment; provider: string; model?: string; route?: string; semanticSource: "llm"; sensingTrace?: SensingTrace }> {
  return request<{ summary: string; asset?: MediaAttachment; provider: string; model?: string; route?: string; semanticSource: "llm"; sensingTrace?: SensingTrace }>("/api/image-summary", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ dataUrl, label })
  });
}

export async function observeAudio(dataUrl: string, label: string): Promise<{ observation: string; provider: string; model?: string; route?: string; noSpeech?: boolean; unreadable?: boolean; semanticSource: "llm"; sensingTrace?: SensingTrace }> {
  return request<{ observation: string; provider: string; model?: string; route?: string; noSpeech?: boolean; unreadable?: boolean; semanticSource: "llm"; sensingTrace?: SensingTrace }>("/api/audio-observation", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ dataUrl, label })
  });
}

export async function buttonCapture(userId: string, text: string): Promise<CaptureResult> {
  return request(`/api/profiles/${userId}/button`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ text })
  });
}

export async function curiousCapture(userId: string, segments: StreamSegment[]): Promise<CaptureResult> {
  return request(`/api/profiles/${userId}/curious`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ segments })
  });
}

export async function sendFeedback(
  userId: string,
  kind: FeedbackKind,
  targetId?: string,
  input: { content?: string; modality?: "text" | "audio_observation" | "button" } = {}
): Promise<{ profile: CreatureProfile; feedback: FeedbackRecord }> {
  return request<{ profile: CreatureProfile; feedback: FeedbackRecord }>(`/api/profiles/${userId}/feedback`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ kind, targetId, ...input })
  });
}

export async function updateLongTermMemory(userId: string, memoryId: string, text: string): Promise<CreatureProfile> {
  const data = await request<{ profile: CreatureProfile }>(`/api/profiles/${userId}/memories/${memoryId}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ text })
  });
  return data.profile;
}

export async function dreamMemories(userId: string): Promise<{ profile: CreatureProfile; dream?: DreamRecord }> {
  return request<{ profile: CreatureProfile; dream?: DreamRecord }>(`/api/profiles/${userId}/dreaming`, { method: "POST" });
}

export async function activeEmergence(userId: string) {
  return request<{ profile: CreatureProfile; emergence: { text: string; memoryId?: string; cognitionTrace?: MessageCognitionTrace } }>(
    `/api/profiles/${userId}/emergence`,
    { method: "POST" }
  );
}

export function makeSegment(id: string, kind: SegmentKind, label: string, content: string, extra: Partial<StreamSegment> = {}): StreamSegment {
  return { id, kind, label, content, ...extra };
}

export function resolveAssetUrl(url: string) {
  if (/^https?:\/\//.test(url)) return url;
  return resolveApiPath(url);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(resolveApiPath(path), init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function resolveApiPath(path: string) {
  if (!apiBase) return path;
  return `${apiBase.replace(/\/$/, "")}${path.replace(/^\/api/, "")}`;
}
