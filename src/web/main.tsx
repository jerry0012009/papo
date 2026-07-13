import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { MediaViewerProvider } from "./MediaViewer";
import { ensurePapoServiceWorker } from "./service-worker";
import "./styles.css";

void ensurePapoServiceWorker().catch(() => undefined);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MediaViewerProvider><App /></MediaViewerProvider>
  </React.StrictMode>
);
