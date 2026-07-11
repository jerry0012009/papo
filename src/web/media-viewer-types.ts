export interface MediaViewerItem {
  id: string;
  kind: "image" | "video";
  src: string;
  title: string;
  mime: string;
  poster?: string;
}
