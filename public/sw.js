self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

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
