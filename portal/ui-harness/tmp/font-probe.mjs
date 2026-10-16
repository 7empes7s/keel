import { chromium } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(pathToFileURL(resolve("ui-harness/dist/index.html")).href + "#/restore");
await page.locator("main#main-content h1").waitFor();
const c = await page.context().newCDPSession(page);
await c.send("DOM.enable"); await c.send("CSS.enable");
const doc = await c.send("DOM.getDocument", { depth: -1 });
for (const sel of ["a.activity-title", "p.activity-meta time", "span.job-status"]) {
  const { nodeId } = await c.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: sel });
  const f = await c.send("CSS.getPlatformFontsForNode", { nodeId });
  const s = await page.locator(sel).first().evaluate((e) => { const cs = getComputedStyle(e); return `${cs.fontFamily} | ${cs.fontWeight} ${cs.fontStyle} | ${e.textContent}`; });
  console.log(sel, JSON.stringify(f.fonts), s);
}
await browser.close();
