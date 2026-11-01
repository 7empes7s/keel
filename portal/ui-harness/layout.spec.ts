import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HARNESS = pathToFileURL(join(__dirname, "dist/index.html")).href;

// Layout fits the screen (UI audit E4): on a phone (375 and 390 px) and on the 1278 px
// laptop the audit used, no page scrolls sideways, nothing is cut off by the edge of
// the window or of a card, and nothing pokes out of the box it sits in. A table may
// still scroll inside its own scroll box; that is the one allowed way to be wide.
//
// Every harness route is checked: the list is read from the harness's own router, so a
// new page is covered without editing this file. A few routes with a panel open are
// added, because panels are where long names and badges meet the narrowest boxes.
const WIDTHS = [375, 390, 1278];
const SOURCE = readFileSync(join(__dirname, "app.tsx"), "utf8");
const ROUTER = SOURCE.slice(SOURCE.indexOf("function Page("));
const ROUTES = [...new Set([...ROUTER.matchAll(/case "(\/[^"]*)"/g)].map((match) => match[1]))];
const OPENED = [
  "/sites/contoso.sharepoint.com%2C5e170000-0000-4000-8000-000000000001%2C5e170000-0000-4000-8000-000000000002",
  "/rules?new=1",
  "/alerts?open=a1e70000-0000-4000-8000-000000000002",
  "/approvals?open=a9e10000-0000-4000-8000-000000000101",
  "/compliance?open=e7a10000-0000-4000-8000-0000000000e1",
  "/protect?open=deviceConfiguration",
  "/changes?open=dr5",
  "/activity?open=job:a4",
];
const PAGES = [...ROUTES, ...OPENED];

test("the layout check finds the harness pages", () => {
  expect(ROUTES.length).toBeGreaterThan(50);
});

async function open(page: Page, hash: string) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${HARNESS}#${hash}`);
  await page.evaluate(() => { document.documentElement.dataset.harnessCi = ""; });
  await page.locator("main#main-content h1").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
    .map((animation) => animation.finished.catch(() => undefined))));
}

// Runs in the page. Returns one line per problem, so a failure names what broke.
function layoutProblems(): string[] {
  const viewport = document.documentElement.clientWidth;
  const problems: string[] = [];
  const name = (element: Element) => {
    const classes = typeof element.className === "string" ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${element.tagName.toLowerCase()}${classes.map((entry) => `.${entry}`).join("")}${text ? ` "${text}"` : ""}`;
  };
  if (document.documentElement.scrollWidth > viewport) problems.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px wide in a ${viewport} px window`);
  for (const element of document.body.querySelectorAll("*")) {
    if (element instanceof SVGElement && element.ownerSVGElement) continue;
    if (element.closest(".visually-hidden, .harness-controls, [hidden], details:not([open]) > :not(summary)")) continue;
    const style = getComputedStyle(element);
    if (style.display === "contents" || style.display === "none" || style.visibility === "hidden") continue;
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    // The nearest ancestor that clips or scrolls sideways.
    let clipper: Element | null = null;
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowX !== "visible") { clipper = parent; break; }
    }
    // A scroll box is a deliberate way to show something wide on a phone. On a laptop
    // it must not hide a column off to the side (the Sites table at 1278 px did).
    if (clipper && /auto|scroll/.test(getComputedStyle(clipper).overflowX)) {
      if (viewport >= 1200 && clipper.closest("main") && !clipper.matches("[data-scrolls]") && clipper.scrollWidth > clipper.clientWidth + 1) {
        problems.push(`${name(clipper)} hides ${clipper.scrollWidth - clipper.clientWidth} px off to the side`);
      }
      continue;
    }
    const edge = clipper ? clipper.getBoundingClientRect().right : viewport;
    if (box.right > edge + 1 && style.textOverflow !== "ellipsis") {
      problems.push(`${name(element)} is cut off by ${clipper ? name(clipper) : "the window"} (${Math.round(box.right - edge)} px)`);
      continue;
    }
    // Out of its own box: a badge or control wider than its card. Negative margins are a
    // deliberate bleed (hover backgrounds, full-width footers), so they are left alone.
    if (/absolute|fixed/.test(style.position) || style.display === "inline" || style.display.startsWith("table") || parseFloat(style.marginRight) < 0) continue;
    let parent = element.parentElement;
    while (parent && getComputedStyle(parent).display === "contents") parent = parent.parentElement;
    if (!parent || getComputedStyle(parent).overflowX !== "visible" || getComputedStyle(parent).display === "inline") continue;
    // Measured against the parent's content edge: a chip that runs over a card's
    // padding to its border already looks broken.
    const outer = parent.getBoundingClientRect();
    const parentStyle = getComputedStyle(parent);
    const inner = outer.right - parseFloat(parentStyle.paddingRight) - parseFloat(parentStyle.borderRightWidth);
    if (outer.width > 0 && box.right > inner + 4) problems.push(`${name(element)} pokes out of ${name(parent)} (${Math.round(box.right - inner)} px)`);
  }
  return [...new Set(problems)].slice(0, 10);
}

for (const hash of PAGES) {
  test(`layout fits · ${hash}`, async ({ page }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await open(page, hash);
      const problems = await page.evaluate(layoutProblems);
      expect(problems, `${hash} at ${width} px`).toEqual([]);
    }
  });
}

// The selection bar sticks to the bottom of the window. Picking a row near the bottom
// must leave that row in sight above the bar, not under it.
for (const width of [390, 1278]) {
  test(`selection bar leaves the picked row in sight · ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 640 });
    await open(page, "/changes");
    const boxes = page.locator(".sel-row .sel-check");
    // Scroll the list up to the top of the window, then pick the lowest row that is
    // still fully on screen: the bar arrives right over it.
    await boxes.first().evaluate((box) => window.scrollTo(0, box.closest(".sel-row")!.getBoundingClientRect().top + window.scrollY - 80));
    const index = await boxes.evaluateAll((all) => {
      let lowest = 0;
      all.forEach((box, at) => { const row = box.closest(".sel-row")!.getBoundingClientRect(); if (row.bottom <= window.innerHeight - 8) lowest = at; });
      return lowest;
    });
    expect(index, "several rows on screen").toBeGreaterThan(1);
    await boxes.nth(index).check();
    const bar = page.locator(".sel-bar");
    await expect(bar).toBeVisible();
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const row = await boxes.nth(index).evaluate((box) => box.closest(".sel-row")!.getBoundingClientRect().bottom);
    const barTop = await bar.evaluate((element) => element.getBoundingClientRect().top);
    expect(row, "the picked row ends above the bar").toBeLessThanOrEqual(barTop + 1);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollPaddingBottom)).not.toBe("0px");
  });
}
