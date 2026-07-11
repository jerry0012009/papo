import { Download, X } from "lucide-react";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useEffect, useMemo, useState, type ComponentProps, type CSSProperties, type ImgHTMLAttributes } from "react";
import { PhotoSlider } from "react-photo-view";
import "react-photo-view/dist/react-photo-view.css";
import { downloadImage } from "./image-download";

export interface ImageLightboxItem {
  id: string;
  src: string;
  title: string;
  mime: string;
}

interface ImageSize {
  width: number;
  height: number;
}

const imageSizeCache = new Map<string, ImageSize>();
type PhotoSliderImage = ComponentProps<typeof PhotoSlider>["images"][number];

export function ImageLightbox(props: { items: ImageLightboxItem[]; index?: number; onClose: () => void; onIndexChange?: (index: number) => void }) {
  const viewport = useViewportSize();
  const [imageSizes, setImageSizes] = useState<Record<string, ImageSize>>(() => Object.fromEntries(imageSizeCache));

  useEffect(() => {
    if (props.index === undefined || !Capacitor.isNativePlatform()) return;
    const listener = CapacitorApp.addListener("backButton", () => props.onClose());
    return () => {
      void listener.then((handle) => handle.remove()).catch(() => undefined);
    };
  }, [props.index, props.onClose]);

  useEffect(() => {
    let cancelled = false;
    const missingItems = props.items.filter((item) => !imageSizeCache.has(item.src));
    for (const item of missingItems) {
      const image = new Image();
      image.onload = () => {
        if (cancelled || !image.naturalWidth || !image.naturalHeight) return;
        const size = { width: image.naturalWidth, height: image.naturalHeight };
        imageSizeCache.set(item.src, size);
        setImageSizes((current) => ({ ...current, [item.src]: size }));
      };
      image.src = item.src;
    }
    return () => {
      cancelled = true;
    };
  }, [props.items]);

  const images = useMemo<PhotoSliderImage[]>(() => props.items.map((item) => {
    const naturalSize = imageSizes[item.src];
    if (!naturalSize) return { key: item.id, src: item.src };
    const fittedSize = fitInsideViewport(naturalSize, viewport, initialFillRatio(viewport));
    return {
      key: `${item.id}:${fittedSize.width}x${fittedSize.height}`,
      width: fittedSize.width,
      height: fittedSize.height,
      render: ({ attrs }) => (
        <img
          {...attrs as ImgHTMLAttributes<HTMLImageElement>}
          src={item.src}
          alt={item.title}
          draggable={false}
        />
      )
    };
  }), [imageSizes, props.items, viewport]);

  return (
    <PhotoSlider
      className="papo-photo-view"
      photoClassName="papo-photo-view-image"
      images={images}
      visible={props.index !== undefined}
      index={props.index ?? 0}
      onIndexChange={(index) => props.onIndexChange?.(index)}
      onClose={props.onClose}
      loop={false}
      maskClosable
      photoClosable={false}
      pullClosable
      maskOpacity={1}
      toolbarRender={({ index, onClose, scale }) => {
        const item = props.items[index];
        return (
          <div className="papo-photo-view-toolbar" style={{ "--papo-photo-view-scale": scale } as CSSProperties}>
            <button type="button" className="papo-photo-view-close" aria-label="关闭图片" onClick={onClose}>
              <X className="papo-photo-view-icon" />
            </button>
            <button
              type="button"
              className="papo-photo-view-download"
              aria-label="下载原图"
              onClick={() => item && void downloadImage(item.src, item.title, item.mime)}
            >
              <Download className="papo-photo-view-icon" />
            </button>
          </div>
        );
      }}
    />
  );
}

function useViewportSize() {
  const readViewport = () => ({ width: window.innerWidth, height: window.innerHeight });
  const [viewport, setViewport] = useState(readViewport);
  useEffect(() => {
    const update = () => setViewport(readViewport());
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return viewport;
}

function fitInsideViewport(image: ImageSize, viewport: ImageSize, fillRatio: number): ImageSize {
  const scale = Math.min((viewport.width * fillRatio) / image.width, (viewport.height * fillRatio) / image.height, 1);
  return {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale))
  };
}

function initialFillRatio(viewport: ImageSize) {
  return Math.min(viewport.width, viewport.height) >= 600 ? 0.8 : viewport.width > viewport.height ? 0.8 : 0.86;
}
