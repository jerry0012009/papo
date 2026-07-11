import { Capacitor, registerPlugin } from "@capacitor/core";

const DEFAULT_MANIFEST_URL = "https://eu.jerrypsy.top/papo/android/latest.json";
const manifestUrl = (import.meta.env.VITE_ANDROID_UPDATE_URL as string | undefined)?.trim() || DEFAULT_MANIFEST_URL;

interface PapoUpdaterPlugin {
  getVersion(): Promise<{ versionName: string; versionCode: number }>;
  openDownload(options: { url: string }): Promise<void>;
}

export interface AndroidRelease {
  versionName: string;
  versionCode: number;
  downloadUrl: string;
  publishedAt: string;
  notes: string[];
  sha256?: string;
  size?: number;
}

export interface AppUpdateState {
  release: AndroidRelease;
  native: boolean;
  legacyNative: boolean;
  currentVersionName?: string;
  currentVersionCode?: number;
  updateAvailable: boolean;
}

const PapoUpdater = registerPlugin<PapoUpdaterPlugin>("PapoUpdater");

export async function inspectAppUpdate(): Promise<AppUpdateState> {
  const native = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
  let currentVersion: { versionName: string; versionCode: number } | undefined;
  let legacyNative = false;
  if (native) {
    try {
      currentVersion = await PapoUpdater.getVersion();
    } catch {
      legacyNative = true;
    }
  }

  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`检查更新失败 (${response.status})`);
  const release = parseAndroidRelease(await response.json());
  return {
    release,
    native,
    legacyNative,
    currentVersionName: currentVersion?.versionName,
    currentVersionCode: currentVersion?.versionCode,
    updateAvailable: native && (legacyNative || (currentVersion?.versionCode ?? 0) < release.versionCode)
  };
}

export async function openAppUpdateDownload(url: string) {
  if (!isHttpsUrl(url)) throw new Error("下载地址无效");
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
    try {
      await PapoUpdater.openDownload({ url });
      return;
    } catch {
      window.location.assign(url);
      return;
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function parseAndroidRelease(value: unknown): AndroidRelease {
  if (!value || typeof value !== "object") throw new Error("更新信息格式无效");
  const candidate = value as Record<string, unknown>;
  const versionName = typeof candidate.versionName === "string" ? candidate.versionName.trim() : "";
  const versionCode = typeof candidate.versionCode === "number" ? candidate.versionCode : Number.NaN;
  const downloadUrl = typeof candidate.downloadUrl === "string" ? candidate.downloadUrl.trim() : "";
  if (!versionName || !Number.isSafeInteger(versionCode) || versionCode < 1 || !isHttpsUrl(downloadUrl)) {
    throw new Error("更新信息格式无效");
  }
  return {
    versionName,
    versionCode,
    downloadUrl,
    publishedAt: typeof candidate.publishedAt === "string" ? candidate.publishedAt : "",
    notes: Array.isArray(candidate.notes) ? candidate.notes.filter((note): note is string => typeof note === "string") : [],
    sha256: typeof candidate.sha256 === "string" ? candidate.sha256 : undefined,
    size: typeof candidate.size === "number" ? candidate.size : undefined
  };
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
