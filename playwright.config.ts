import { defineConfig, devices } from "@playwright/test";

const host = "127.0.0.1";
const port = 4321;
const defaultBasePath = "/online-tools-hub";

function normalizeBasePath(value: string): string {
  const normalized = `/${value}`.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return normalized === "/" ? "" : normalized;
}

const basePath = normalizeBasePath(
  process.env.PLAYWRIGHT_BASE_PATH ?? defaultBasePath,
);
const localBaseURL = `http://${host}:${port}${basePath}/`;
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? localBaseURL;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["line"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `npm run preview -- --host ${host} --port ${port}`,
        url: localBaseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
});
