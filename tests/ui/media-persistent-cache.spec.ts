import { expect, test } from "@playwright/test";

test("downloaded product images remain available from persistent cache while offline", async ({ page, context }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
  });

  const firstSize = await page.evaluate(async () => {
    const response = await fetch("/pets/register/shiba.jpg");
    return (await response.blob()).size;
  });
  expect(firstSize).toBeGreaterThan(10_000);
  await expect.poll(() => page.evaluate(async () => Boolean(await (await caches.open("papo-persistent-media-v1")).match("/pets/register/shiba.jpg")))).toBe(true);

  await context.setOffline(true);
  const offlineSize = await page.evaluate(async () => {
    const response = await fetch("/pets/register/shiba.jpg");
    return (await response.blob()).size;
  });
  expect(offlineSize).toBe(firstSize);
});
