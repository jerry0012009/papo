import { getPushConfig, registerPushSubscription, removePushSubscription } from "./api";
import { ensurePapoServiceWorker } from "./service-worker";

const publicBaseUrl = import.meta.env.BASE_URL ?? "/";

export type PushNotificationState =
  | "loading"
  | "unsupported"
  | "unconfigured"
  | "prompt"
  | "denied"
  | "enabled"
  | "disabled";

export async function inspectPushNotifications(): Promise<PushNotificationState> {
  if (!supportsPushNotifications()) return "unsupported";
  const config = await getPushConfig();
  if (!config.enabled || !config.publicKey) return "unconfigured";
  if (Notification.permission === "denied") return "denied";
  const registration = await ensurePapoServiceWorker();
  if (!registration) return "unsupported";
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) return "enabled";
  return Notification.permission === "default" ? "prompt" : "disabled";
}

export async function enablePushNotifications(userId: string): Promise<PushNotificationState> {
  if (!supportsPushNotifications()) return "unsupported";
  const config = await getPushConfig();
  if (!config.enabled || !config.publicKey) return "unconfigured";
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "prompt";

  const registration = await ensurePapoServiceWorker();
  if (!registration) return "unsupported";
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidKeyBytes(config.publicKey)
  });
  try {
    await registerPushSubscription(userId, subscription.toJSON(), appUrl());
  } catch (error) {
    if (!existing) await subscription.unsubscribe().catch(() => false);
    throw error;
  }
  return "enabled";
}

export async function disablePushNotifications(userId: string): Promise<PushNotificationState> {
  if (!supportsPushNotifications()) return "unsupported";
  const registration = await ensurePapoServiceWorker();
  if (!registration) return "unsupported";
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    let removeError: unknown;
    await removePushSubscription(userId, subscription.endpoint).catch((error) => {
      removeError = error;
    });
    await subscription.unsubscribe();
    if (removeError) throw removeError;
  }
  return Notification.permission === "denied" ? "denied" : "disabled";
}

export async function syncExistingPushSubscription(userId: string) {
  if (!supportsPushNotifications() || Notification.permission !== "granted") return;
  const config = await getPushConfig();
  if (!config.enabled) return;
  const registration = await ensurePapoServiceWorker();
  if (!registration) return;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) await registerPushSubscription(userId, subscription.toJSON(), appUrl());
}

export function pushNotificationStateText(state: PushNotificationState) {
  return {
    loading: "正在检查浏览器通知",
    unsupported: "当前浏览器不支持网页推送",
    unconfigured: "服务器还没有配置网页推送",
    prompt: "尚未开启",
    denied: "通知已被浏览器拦截，请在网站设置中允许",
    enabled: "新消息会发送到这台设备",
    disabled: "这台设备没有开启通知"
  }[state];
}

function supportsPushNotifications() {
  return typeof window !== "undefined"
    && window.isSecureContext
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

function appUrl() {
  return new URL(publicBaseUrl, window.location.origin).toString();
}

function vapidKeyBytes(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}
