self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (!isPersistentMediaRequest(event.request)) return;
  event.respondWith(cacheFirstMedia(event.request));
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "PAPO_CACHE_MEDIA" || !Array.isArray(event.data.urls)) return;
  event.waitUntil(cacheMediaUrls(event.data.urls));
});

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

const MEDIA_CACHE = "papo-persistent-media-v1";

function isPersistentMediaRequest(request) {
  if (request.method !== "GET" || request.headers.has("range")) return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  return /^\/(?:papo-api|api)\/assets\/(?:img|vid|aud)_[a-f0-9]{24}\.(?:png|jpg|webp|mp4|webm|wav|mp3|m4a|ogg|aac)$/.test(url.pathname)
    || /^\/papo\/pets\//.test(url.pathname)
    || /^\/pets\//.test(url.pathname);
}

async function cacheFirstMedia(request) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(request, { ignoreVary: false });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.status === 200 && !request.headers.has("range")) {
    await cache.put(request, response.clone());
  }
  return response;
}

async function cacheMediaUrls(urls) {
  const cache = await caches.open(MEDIA_CACHE);
  const unique = [...new Set(urls)].slice(0, 240);
  for (let index = 0; index < unique.length; index += 4) {
    await Promise.all(unique.slice(index, index + 4).map(async (rawUrl) => {
      try {
        const request = new Request(new URL(rawUrl, self.location.origin), { credentials: "same-origin" });
        if (!isPersistentMediaRequest(request) || await cache.match(request)) return;
        const response = await fetch(request);
        if (response.ok && response.status === 200) await cache.put(request, response);
      } catch {
        // A failed prefetch must never affect the page or discard older cached media.
      }
    }));
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openPapo(event.notification.data?.url));
});

async function handlePush(event) {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { body: event.data?.text() ?? "Papo 有一条新消息" };
  }

  const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windowClients) {
    client.postMessage({
      type: "PAPO_PUSH_MESSAGE",
      userId: payload.userId,
      messageId: payload.messageId
    });
  }
  if (windowClients.some((client) => client.visibilityState === "visible")) return;

  await self.registration.showNotification(payload.title || "Papo", {
    body: payload.body || "有一条新消息",
    tag: payload.messageId ? `papo-${payload.messageId}` : "papo-new-message",
    data: { url: payload.url },
    renotify: false
  });
}

async function openPapo(targetUrl) {
  const fallbackUrl = new URL("./?open=chat", self.registration.scope).toString();
  const url = targetUrl || fallbackUrl;
  const target = new URL(url);
  const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windowClients) {
    const current = new URL(client.url);
    if (current.origin !== target.origin || current.pathname !== target.pathname) continue;
    client.postMessage({ type: "PAPO_OPEN_CHAT" });
    return client.focus();
  }
  return self.clients.openWindow(url);
}
