import { defineConfig } from "@playwright/test";

// Runs against the browser build, which swaps the native side for a generated
// board (src/lib/mockBackend.ts). Set PW_CHROMIUM to use a preinstalled browser.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:1431",
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      executablePath: process.env.PW_CHROMIUM || undefined,
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
    }
  },
  webServer: {
    command: "npx vite --host 127.0.0.1 --port 1431 --strictPort",
    url: "http://127.0.0.1:1431",
    reuseExistingServer: true
  }
});
