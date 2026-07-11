import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Download, Loader2, Play, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ImageLightbox } from "./ImageLightbox";
import { downloadMedia } from "./media-download";
import type { MediaViewerItem } from "./media-viewer-types";

interface MediaViewerContextValue {
  openMedia: (items: MediaViewerItem[], index?: number) => void;
}

const MediaViewerContext = createContext<MediaViewerContextValue | undefined>(undefined);

export function MediaViewerProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<{ items: MediaViewerItem[]; index: number }>();
  const [downloadState, setDownloadState] = useState<"idle" | "busy" | "saved" | "failed">("idle");
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    const handlePopState = () => {
      if (viewRef.current) setView(undefined);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!view || !Capacitor.isNativePlatform()) return;
    const listener = CapacitorApp.addListener("backButton", () => closeMedia());
    return () => {
      void listener.then((handle) => handle.remove()).catch(() => undefined);
    };
  }, [view]);

  useEffect(() => {
    if (downloadState !== "saved" && downloadState !== "failed") return;
    const timer = window.setTimeout(() => setDownloadState("idle"), 3_000);
    return () => window.clearTimeout(timer);
  }, [downloadState]);

  const openMedia = useCallback((items: MediaViewerItem[], index = 0) => {
    if (!items.length) return;
    window.history.pushState({ ...(window.history.state ?? {}), papoOverlay: "media-viewer" }, "");
    setDownloadState("idle");
    setView({ items, index: Math.max(0, Math.min(index, items.length - 1)) });
  }, []);

  const closeMedia = useCallback(() => {
    if (window.history.state?.papoOverlay === "media-viewer") window.history.back();
    else setView(undefined);
  }, []);

  const handleDownload = useCallback(async (item: MediaViewerItem) => {
    if (downloadState === "busy") return;
    setDownloadState("busy");
    try {
      await downloadMedia(item.src, item.title, item.mime);
      setDownloadState("saved");
    } catch {
      setDownloadState("failed");
    }
  }, [downloadState]);

  const current = view?.items[view.index];
  const context = useMemo(() => ({ openMedia }), [openMedia]);
  return (
    <MediaViewerContext.Provider value={context}>
      {children}
      {view && current?.kind === "image" ? (
        <ImageLightbox
          items={view.items.filter((item) => item.kind === "image")}
          index={Math.max(0, view.items.filter((item) => item.kind === "image").findIndex((item) => item.id === current.id))}
          onClose={closeMedia}
          onIndexChange={(imageIndex) => {
            const next = view.items.findIndex((item) => item.id === view.items.filter((candidate) => candidate.kind === "image")[imageIndex]?.id);
            if (next >= 0) setView({ ...view, index: next });
          }}
          onDownload={handleDownload}
        />
      ) : null}
      {view && current?.kind === "video" ? (
        <VideoViewer item={current} onClose={closeMedia} onDownload={() => void handleDownload(current)} downloadState={downloadState} />
      ) : null}
      {view && downloadState !== "idle" ? <DownloadStatus state={downloadState} /> : null}
    </MediaViewerContext.Provider>
  );
}

export function MediaThumbnail(props: { item: MediaViewerItem; items?: MediaViewerItem[]; index?: number; className?: string; children?: ReactNode }) {
  const { openMedia } = useMediaViewer();
  const items = props.items ?? [props.item];
  const index = props.index ?? Math.max(0, items.findIndex((item) => item.id === props.item.id));
  return (
    <button type="button" className={props.className} onClick={() => openMedia(items, index)} aria-label={`${props.item.kind === "video" ? "播放视频" : "查看图片"}：${props.item.title}`}>
      {props.children ?? (props.item.kind === "image" ? (
        <img src={props.item.src} alt={props.item.title} loading="lazy" />
      ) : (
        <>
          <video src={props.item.src} poster={props.item.poster} muted playsInline preload="metadata" />
          <span className="media-thumbnail-play"><Play size={18} fill="currentColor" /></span>
        </>
      ))}
    </button>
  );
}

function useMediaViewer() {
  const context = useContext(MediaViewerContext);
  if (!context) throw new Error("MediaThumbnail must be rendered inside MediaViewerProvider");
  return context;
}

function VideoViewer(props: { item: MediaViewerItem; onClose: () => void; onDownload: () => void; downloadState: string }) {
  return createPortal(
    <div className="papo-video-view" role="dialog" aria-label={`播放视频：${props.item.title}`}>
      <video src={props.item.src} poster={props.item.poster} controls autoPlay playsInline preload="auto" />
      <button type="button" className="papo-media-close" aria-label="关闭媒体" onClick={props.onClose}><X /></button>
      <button type="button" className="papo-media-download" aria-label="下载原文件" onClick={props.onDownload} disabled={props.downloadState === "busy"}>
        {props.downloadState === "busy" ? <Loader2 className="spin-icon" /> : <Download />}
      </button>
    </div>,
    document.body
  );
}

function DownloadStatus({ state }: { state: "busy" | "saved" | "failed" }) {
  const text = state === "busy" ? "正在保存原文件" : state === "saved" ? "已保存到系统下载/Papo" : "保存失败，请检查网络后重试";
  return <div className={`media-download-status ${state}`} role="status">{state === "busy" ? <Loader2 className="spin-icon" /> : null}{text}</div>;
}
