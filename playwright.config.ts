import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/ui",
  timeout: 30_000,
  fullyParallel: true,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:5174",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "npm run dev:web -- --host 127.0.0.1 --port 5174 --strictPort",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  },
  projects: [
    {
      name: "mobile",
      use: { ...devices["Pixel 5"] }
    },
    {
      name: "desktop",
      use: { viewport: { width: 1280, height: 900 } }
    }
  ]
});
