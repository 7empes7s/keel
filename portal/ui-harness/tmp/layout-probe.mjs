// TEMP diagnostic: prints element heights on the restore page so CI and a cloud session can be compared.
import { chromium } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
await page.goto(pathToFileURL(resolve("ui-harness/dist/index.html")).href + "#/restore");
await page.locator("main#main-content h1").waitFor();
await page.evaluate(() => document.fonts.ready);
const rows = await page.evaluate(() => {
  const out = [`scrollHeight ${document.documentElement.scrollHeight}`];
  const t = document.createElement("span"); t.textContent = "Restore → ✓"; t.style.fontFamily = "var(--font-sans)"; document.body.append(t);
  const tr = t.getBoundingClientRect(); out.push(`probe ${tr.width.toFixed(3)} ${tr.height.toFixed(3)}`);
  for (const el of document.querySelectorAll("main *")) {
    const r = el.getBoundingClientRect();
    if (!r.height) continue;
    out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join(".")} ${r.top.toFixed(2)} ${r.height.toFixed(2)} ${r.width.toFixed(2)}`);
  }
  return out;
});
console.log(rows.join("\n"));
await browser.close();
