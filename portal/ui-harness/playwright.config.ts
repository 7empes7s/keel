import { defineConfig, devices } from "@playwright/test";

// UI checks run against the static harness build (no server, no database). Build it
// first with `npm run ui:build`; `npm run test:ui` does both.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "./test-results",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  fullyParallel: true,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]] : "list",
  expect: {
    // Text antialiasing differs slightly between Linux builds; layout changes do not
    // hide inside 1% of pixels.
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled", caret: "hide" },
  },
  use: {
    ...devices["Desktop Chrome"],
    deviceScaleFactor: 1,
    contextOptions: { reducedMotion: "reduce" },
  },
});
