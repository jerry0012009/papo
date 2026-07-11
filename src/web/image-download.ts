import { Capacitor, registerPlugin } from "@capacitor/core";

interface PapoMediaPlugin {
  downloadImage(options: { url: string; filename: string; mime: string }): Promise<{ id: number }>;
}

const PapoMedia = registerPlugin<PapoMediaPlugin>("PapoMedia");

export async function downloadImage(url: string, title: string, mime: string) {
  const filename = imageFilename(title, mime);
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android" && /^https:\/\//i.test(url)) {
    try {
      await PapoMedia.downloadImage({ url, filename, mime });
      return;
    } catch {
      // Older APKs load the latest web UI but do not have the media plugin yet.
    }
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image download failed (${response.status})`);
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
}

function imageFilename(title: string, mime: string) {
  const extension = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const clean = title.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").slice(0, 80) || "Papo 图片";
  return `${clean}.${extension}`;
}
