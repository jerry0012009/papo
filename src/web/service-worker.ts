import type { CreatureProfile } from "../core/types";
import { resolveAssetUrl } from "./api";
import { profileImageUrls } from "./media-cache-sources";

const publicBaseUrl = import.meta.env.BASE_URL ?? "/";
let registrationPromise: Promise<ServiceWorkerRegistration | undefined> | undefined;

export function ensurePapoServiceWorker() {
  if (registrationPromise) return registrationPromise;
  registrationPromise = register();
  return registrationPromise;
}

export async function persistProfileImages(profile: CreatureProfile) {
  const urls = profileImageUrls(profile).map(resolveAssetUrl);
  if (!urls.length) return;
  const registration = await ensurePapoServiceWorker();
  registration?.active?.postMessage({ type: "PAPO_CACHE_MEDIA", urls });
}

async function register() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return undefined;
  const registration = await navigator.serviceWorker.register(`${publicBaseUrl}sw.js`, { scope: publicBaseUrl, updateViaCache: "none" });
  await navigator.serviceWorker.ready;
  if (navigator.storage?.persist) await navigator.storage.persist().catch(() => false);
  return registration;
}
