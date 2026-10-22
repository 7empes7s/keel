import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HARNESS = pathToFileURL(join(__dirname, "dist/index.html")).href;

// A list that reports its order to its page must not re-render forever: once a page with
// a list (and its open details panel) has settled, the main thread is idle.
for (const hash of ["/drift", "/drift?open=dr5", "/benchmarks", "/benchmarks?open=e7a10000-0000-4000-8000-0000000000e1", "/compare"]) {
  test(`idle once settled · ${hash}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${HARNESS}#${hash}`);
    await page.locator("main#main-content h1").waitFor();
    await page.waitForTimeout(1500);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const script = async () => (await cdp.send("Performance.getMetrics")).metrics.find((metric) => metric.name === "ScriptDuration")?.value ?? 0;
    const before = await script();
    await page.waitForTimeout(1000);
    const busy = (await script()) - before;
    expect(busy, `seconds of script in one idle second`).toBeLessThan(0.15);
  });
}
