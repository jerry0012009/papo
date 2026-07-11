import { Download, X, ZoomIn, ZoomOut } from "lucide-react";
import { useState } from "react";
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
  return (
    <Lightbox
      className="papo-lightbox"
      open={props.index !== undefined}
      close={props.onClose}
      index={props.index ?? 0}
      slides={props.items.map((item) => ({ src: item.src, alt: item.title }))}
      plugins={[ZoomPlugin, DownloadPlugin]}
      toolbar={{ buttons: ["zoom", "download", "close"] }}
      carousel={{ finite: props.items.length <= 1, padding: "12px", imageFit: "contain" }}
      controller={{ closeOnBackdropClick: true, closeOnPullDown: true, closeOnPullUp: true }}
      zoom={{ maxZoomPixelRatio: 5, zoomInMultiplier: 2, doubleClickMaxStops: 3, pinchZoomV4: true, scrollToZoom: true }}
      download={{
        download: ({ slide }) => {
          const item = props.items.find((candidate) => candidate.src === slide.src);
          if (item) void downloadImage(slide.src, item.title, item.mime);
        }
      }}
      on={{ view: ({ index }) => props.onIndexChange?.(index), zoom: ({ zoom }) => setZoom(zoom) }}
      labels={{ Close: "关闭图片", Download: "下载图片", "Zoom in": "放大图片", "Zoom out": "缩小图片", Previous: "上一张", Next: "下一张" }}
      render={{
        iconClose: () => <X size={22} />,
        iconDownload: () => <Download size={21} />,
        iconZoomIn: () => <ZoomIn size={21} />,
        iconZoomOut: () => <ZoomOut size={21} />
      }}
      styles={{ root: { "--yarl__papo_zoom": zoom } }}
    />
  );
}
