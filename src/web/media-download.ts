import { Capacitor, registerPlugin } from "@capacitor/core";

interface PapoMediaPlugin {
  downloadMedia(options: { url: string; filename: string; mime: string }): Promise<{ uri: string }>;
  downloadImage(options: { url: string; filename: string; mime: string }): Promise<{ id?: number; uri?: string }>;
}

const PapoMedia = registerPlugin<PapoMediaPlugin>("PapoMedia");

export async function downloadMedia(url: string, title: string, mime: string) {
  const filename = mediaFilename(title, mime);
  const absoluteUrl = new URL(url, window.location.href).href;
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android" && absoluteUrl.startsWith("https://")) {
    try {
      return await PapoMedia.downloadMedia({ url: absoluteUrl, filename, mime });
    } catch (error) {
      if (mime.startsWith("image/") && isUnavailablePluginMethod(error)) {
        try {
          await PapoMedia.downloadImage({ url: absoluteUrl, filename, mime });
          return { uri: "downloads" };
        } catch (legacyError) {
          if (!isUnavailablePluginMethod(legacyError)) throw legacyError;
        }
      }
      throw error;
    }
  }

  const response = await fetch(absoluteUrl);
  if (!response.ok) throw new Error(`下载失败（${response.status}）`);
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  }
  return { uri: "browser-download" };
}

function isUnavailablePluginMethod(error: unknown) {
  return error instanceof Error && /not implemented|unavailable|does not have an implementation/i.test(error.message);
}

function mediaFilename(title: string, mime: string) {
  const extension = extensionForMime(mime);
  const clean = title.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").slice(0, 80) || "Papo 媒体";
  return `${clean}.${extension}`;
}

function extensionForMime(mime: string) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  if (mime === "video/webm") return "webm";
  if (mime === "video/quicktime") return "mov";
  if (mime.startsWith("video/")) return "mp4";
  return "jpg";
}
