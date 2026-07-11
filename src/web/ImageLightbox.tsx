import { Download, X } from "lucide-react";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useEffect, useState } from "react";
import Lightbox from "yet-another-react-lightbox";
import DownloadPlugin from "yet-another-react-lightbox/plugins/download";
import ZoomPlugin from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";
import { downloadImage } from "./image-download";

export interface ImageLightboxItem {
  id: string;
  src: string;
  title: string;
  mime: string;
}

export function ImageLightbox(props: { items: ImageLightboxItem[]; index?: number; onClose: () => void; onIndexChange?: (index: number) => void }) {
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (props.index === undefined || !Capacitor.isNativePlatform()) return;
    const listener = CapacitorApp.addListener("backButton", () => props.onClose());
    return () => {
      void listener.then((handle) => handle.remove()).catch(() => undefined);
    };
  }, [props.index, props.onClose]);

  return (
    <Lightbox
      className="papo-lightbox"
      open={props.index !== undefined}
      close={props.onClose}
      index={props.index ?? 0}
      slides={props.items.map((item) => ({ src: item.src, alt: item.title }))}
      plugins={[ZoomPlugin, DownloadPlugin]}
      toolbar={{ buttons: ["close", "download"] }}
      carousel={{ finite: props.items.length <= 1, padding: 0, imageFit: "contain" }}
      controller={{ closeOnBackdropClick: true, closeOnPullDown: true, closeOnPullUp: true }}
      zoom={{ minZoom: 1, maxZoomPixelRatio: 3, zoomInMultiplier: 2, doubleClickMaxStops: 2, pinchZoomV4: true, scrollToZoom: true }}
      download={{
        download: ({ slide }) => {
          const item = props.items.find((candidate) => candidate.src === slide.src);
          if (item) void downloadImage(slide.src, item.title, item.mime);
        }
      }}
      on={{ view: ({ index }) => props.onIndexChange?.(index), zoom: ({ zoom }) => setZoom(zoom) }}
      labels={{ Close: "关闭图片", Download: "下载原图", "Zoom in": "放大图片", "Zoom out": "缩小图片", Previous: "上一张", Next: "下一张" }}
      render={{
        buttonZoom: () => null,
        iconClose: () => <X size={22} />,
        iconDownload: () => <Download size={21} />
      }}
      styles={{ root: { "--yarl__papo_zoom": zoom } }}
    />
  );
}
