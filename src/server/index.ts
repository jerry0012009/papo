import { createApp } from "./app";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const app = createApp({
  proactive: {
    enabled: process.env.PAPO_PROACTIVE_ENABLED !== "0",
    intervalMs: Number(process.env.PAPO_PROACTIVE_INTERVAL_MS ?? 60_000)
  }
});

app.listen(port, host, () => {
  console.log(`Papo API listening on http://${host}:${port}`);
});
