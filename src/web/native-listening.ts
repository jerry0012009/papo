import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { createDeviceSession } from "./api";

export type ListeningMode = "listen" | "watch";
export type CameraFacing = "front" | "back";

export interface NativeListeningStatus {
  active: boolean;
  startedAt: number;
  endAt: number;
  mode: ListeningMode;
  cameraFacing: CameraFacing;
  pendingBatches?: number;
}

export interface NativeListeningEvent {
  event: "started" | "stopped" | "completed" | "error" | "batch-queued" | "batch-uploaded";
  batchId?: string;
  error?: string;
}

interface PapoListeningPlugin {
  start(options: {
    userId: string;
    deviceToken: string;
    apiBase: string;
    creatureName: string;
    durationMs: number;
    mode: ListeningMode;
    cameraFacing: CameraFacing;
  }): Promise<NativeListeningStatus>;
  stop(): Promise<NativeListeningStatus>;
  getStatus(): Promise<NativeListeningStatus>;
  clearCredentials(): Promise<void>;
  addListener(eventName: "listeningEvent", listener: (event: NativeListeningEvent) => void): Promise<PluginListenerHandle>;
}

const PapoListening = registerPlugin<PapoListeningPlugin>("PapoListening");
const apiBase = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "");

export function supportsNativeListening() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export async function startNativeListening(input: {
  userId: string;
  creatureName: string;
  durationMs: number;
  mode: ListeningMode;
  cameraFacing: CameraFacing;
}) {
  if (!supportsNativeListening()) throw new Error("Android background listening is unavailable");
  if (!apiBase || !/^https:\/\//.test(apiBase)) throw new Error("Android API address is not configured");
  const session = await createDeviceSession(input.userId);
  return PapoListening.start({
    ...input,
    apiBase,
    deviceToken: session.token
  });
}

export function stopNativeListening() {
  return PapoListening.stop();
}

export function getNativeListeningStatus() {
  return PapoListening.getStatus();
}

export function clearNativeListeningCredentials() {
  if (!supportsNativeListening()) return Promise.resolve();
  return PapoListening.clearCredentials();
}

export function onNativeListeningEvent(listener: (event: NativeListeningEvent) => void) {
  return PapoListening.addListener("listeningEvent", listener);
}
