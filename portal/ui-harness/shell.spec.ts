import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The page frame (menu, bell, phone tab bar) and the shared list and pickers, as the
// redesign rules ask: every link is real, view state lives in the URL, and the list
// selects with Shift+click, a whole service, Select all, and long-press and drag on a phone.
const HARNESS = pathToFileURL(join(__dirname, "dist/index.html")).href;

async function open(page: Page, hash: string, theme: "light" | "dark" = "dark") {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.goto(`${HARNESS}#${hash}`);
  await page.evaluate(() => { document.documentElement.dataset.harnessCi = ""; });
  await page.locator("main#main-content h1").waitFor();
  await page.locator('.shell[data-statuses="ready"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };

async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

test("every menu, bell and tab link is a real link to a page that opens", async ({ page }) => {
  await page.setViewportSize(desktop);
  await open(page, "/");
  await page.locator(".rail .bell").click();
  const hrefs = new Set<string>();
  for (const link of await page.locator("aside.rail a, .popover-panel a").all()) {
    const href = await link.getAttribute("href");
    // Sign out leaves for Cloudflare Access's own sign-out page.
    if (href === "/cdn-cgi/access/logout") continue;
    expect(href, await link.innerText()).toMatch(/^#\//);
    hrefs.add(href!.slice(1));
  }
  await page.keyboard.press("Escape");
  // Every section's sub-pages too: open each section and collect what it lists.
  for (const section of await page.locator('section[data-group="everything"] a.menu-link').all()) hrefs.add((await section.getAttribute("href"))!.slice(1));
  for (const first of [...hrefs]) {
    await open(page, first);
    for (const sub of await page.locator("aside.rail a.menu-sublink").all()) hrefs.add((await sub.getAttribute("href"))!.slice(1));
  }
  expect(hrefs.size).toBeGreaterThanOrEqual(23);
  for (const href of hrefs) {
    await open(page, href);
    await expect(page.locator("main h1")).not.toHaveText("Not included in this preview");
  }
});

test("each section shows its status, and a closed group keeps its count and status", async ({ page }) => {
  await page.setViewportSize(desktop);
  await open(page, "/");
  const baselines = page.locator('section[data-group="everything"] a.menu-link', { hasText: "Baselines" });
  await expect(baselines.locator(".menu-badge")).toHaveAttribute("data-tone", "urgent");
  // The number is the changes at the badge's own risk: the 2 that could lock out admins.
  await expect(baselines.locator(".menu-badge")).toContainText("2");
  const toggle = page.locator('section[data-group="everything"] .menu-group-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('section[data-group="everything"] a.menu-link')).toHaveCount(0);
  await expect(toggle.locator(".menu-badge")).toHaveAttribute("data-tone", "urgent");
  await expect(toggle).toHaveAccessibleName(/Everything \d+ Urgent: \d+ sections? needs? urgent attention/);
  await toggle.click();
  await expect(page.locator('section[data-group="everything"] a.menu-link')).toHaveCount(8);
});

test("pin, star and save a view: each lands at the top of the menu as a real link", async ({ page }) => {
  await page.setViewportSize(desktop);
  await open(page, "/schedules");
  // Pin a section from Everything.
  const row = page.locator('section[data-group="everything"] .menu-section', { hasText: "Restore" }).locator(".menu-row").first();
  await row.hover();
  await row.getByRole("button", { name: "Pin Restore to the top of the menu" }).click();
  const pinned = page.locator('section[data-group="pinned"] a.menu-link');
  await expect(pinned).toHaveText("Restore");
  await expect(pinned).toHaveAttribute("href", "#/restore");
  // Star this page.
  await page.getByRole("button", { name: "Add Schedules to Favourites" }).click();
  await expect(page.getByRole("button", { name: "Remove Schedules from Favourites" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('section[data-group="favourites"] a.menu-link')).toHaveAttribute("aria-current", "page");
  // Save the kit's grouped view as a filter; it lands under Favourites, next to the starred page.
  await open(page, "/kit?group=risk");
  await page.getByRole("button", { name: "Save filter" }).click();
  await page.getByLabel("Name for this filter").fill("Settings by risk");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".saved-filter a")).toHaveText("Settings by risk");
  const favourites = page.locator('section[data-group="favourites"] a.menu-link');
  await expect(favourites).toHaveCount(2);
  await expect(favourites.last()).toHaveText("Settings by risk");
  await expect(favourites.last()).toHaveAttribute("href", "#/kit?group=risk");
  await expect(page.locator('section[data-group="custom"]')).toHaveCount(0);
  // Reorder and remove pinned items in edit mode.
  await page.locator('section[data-group="pinned"]').getByRole("button", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Remove Restore from Pinned" }).click();
  await expect(page.locator('section[data-group="pinned"] .menu-empty')).toBeVisible();
});

test("the menu hides and comes back, keeping focus on the control", async ({ page }) => {
  await page.setViewportSize(desktop);
  await open(page, "/");
  await page.getByRole("button", { name: "Hide the menu" }).click();
  await expect(page.locator("aside.rail")).toBeHidden();
  const reveal = page.getByRole("button", { name: "Show the menu" });
  await expect(reveal).toBeFocused();
  const width = await page.locator("main").evaluate((element) => element.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(1300);
  await reveal.click();
  await expect(page.locator("aside.rail")).toBeVisible();
});

test("the bell opens approvals and alerts with their counts", async ({ page }) => {
  await page.setViewportSize(desktop);
  await open(page, "/");
  const bell = page.locator(".rail .bell");
  await expect(bell).toHaveAccessibleName("Notifications: 2 approvals waiting");
  await bell.click();
  const panel = page.locator(".popover-panel");
  await expect(panel.getByRole("link", { name: /Approvals/ })).toHaveAttribute("href", "#/approvals");
  await panel.getByRole("link", { name: /Alerts/ }).click();
  await expect(page.locator("main h1")).toHaveText("Alerts");
  // The inbox keeps its two pages as tabs, since the menu does not list them.
  await expect(page.locator(".section-tabs a[aria-current='page']")).toHaveText("Alerts");
});

test("phone: top bar, five tabs, and All opens the whole menu as a sheet", async ({ page }) => {
  await page.setViewportSize(phone);
  await open(page, "/schedules");
  await expect(page.locator("aside.rail")).toBeHidden();
  const tabs = page.locator(".tabbar .tab");
  // Each badge also says, for a screen reader, what it means.
  await expect(tabs).toHaveText([/^Dashboards/, /^Backup4Urgent: 4 kinds/, /^Restore$/, /^Baselines2Urgent: 2 changes could lock out admins/, /^All/]);
  await expect(page.locator(".tabbar a[aria-current]")).toContainText("Backup");
  // A section's pages are one scrolling row.
  const row = page.locator(".section-tabs");
  await expect(row).toBeVisible();
  expect(await row.evaluate((element) => getComputedStyle(element).flexWrap)).toBe("nowrap");
  await noSidewaysScroll(page);
  await page.locator(".tabbar button.tab").click();
  const sheet = page.locator('aside.rail[role="dialog"]');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('section[data-group="everything"] a.menu-link')).toHaveCount(8);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  // Focus goes back to the tab that opened the sheet.
  await expect(page.locator(".tabbar button.tab")).toBeFocused();
  await page.locator(".tabbar button.tab").click();
  await sheet.getByRole("link", { name: "Audit log" }).click();
  await expect(page.locator("main h1")).toHaveText("Activity");
  await expect(page.locator("aside.rail")).toBeHidden();
  await expect(page.locator(".tabbar button.tab")).toHaveAttribute("data-current", "true");
});

test("list · Shift+click selects a range, Ctrl+click toggles, Esc clears", async ({ page }) => {
  await page.setViewportSize(desktop);
  await open(page, "/kit");
  const rows = page.locator(".sel-row");
  await rows.nth(0).locator("input").click();
  await rows.nth(3).locator(".kit-row-name").click({ modifiers: ["Shift"] });
  await expect(page.locator(".sel-row[data-selected]")).toHaveCount(4);
  await expect(page.locator(".sel-bar")).toContainText("4 settings selected");
  await expect(page.getByRole("button", { name: "Restore 4 settings" })).toBeVisible();
  await rows.nth(1).locator(".kit-row-name").click({ modifiers: ["ControlOrMeta"] });
  await expect(page.locator(".sel-row[data-selected]")).toHaveCount(3);
  // Selection is never also a text selection.
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
  await page.keyboard.press("Escape");
  await expect(page.locator(".sel-row[data-selected]")).toHaveCount(0);
  await expect(page.locator(".sel-bar")).toHaveCount(0);
});

test("list · select all, a whole service, and Ctrl+A", async ({ page }) => {
  await page.setViewportSize(desktop);
  await open(page, "/kit");
  await page.getByRole("button", { name: "Select all 14 settings" }).click();
  await expect(page.locator(".sel-bar")).toContainText("14 settings selected");
  await page.getByRole("button", { name: "Clear selection" }).first().click();
  const exchange = page.getByRole("checkbox", { name: "Select all 3 settings in Exchange Online" });
  await exchange.check();
  await expect(page.locator(".sel-bar")).toContainText("3 settings selected");
  // One more row elsewhere makes the Entra ID header partly checked.
  await page.getByRole("checkbox", { name: "Select Block legacy sign-in, Sign-in rule" }).check();
  expect(await page.getByRole("checkbox", { name: /in Entra ID/ }).evaluate((box: HTMLInputElement) => box.indeterminate)).toBe(true);
  await page.keyboard.press("Escape");
  await page.getByRole("checkbox", { name: "Select Block legacy sign-in, Sign-in rule" }).focus();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(page.locator(".sel-row[data-selected]")).toHaveCount(14);
});

test("list · grouping, find and closed groups stay in the URL", async ({ page }) => {
  await page.setViewportSize(desktop);
  await open(page, "/kit");
  await page.getByRole("radio", { name: "Risk", exact: true }).click();
  await expect(page).toHaveURL(/group=risk/);
  await expect(page.locator(".sel-group-name b").first()).toHaveText("Urgent");
  await page.getByRole("button", { name: /^Urgent/ }).click();
  await expect(page).toHaveURL(/closed=urgent/);
  await page.getByPlaceholder("Find settings").fill("finance");
  await expect(page).toHaveURL(/q=finance/);
  // A fresh load of the same address brings the same view back.
  await page.reload();
  await page.locator("main h1").waitFor();
  await expect(page.getByRole("radio", { name: "Risk", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByPlaceholder("Find settings")).toHaveValue("finance");
  await expect(page.locator(".sel-row")).toHaveCount(2);
});

test("list · phone: hold a row, then drag over others to select them", async ({ page, browser }) => {
  const context = await browser.newContext({ viewport: phone, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const touchPage = await context.newPage();
  await touchPage.goto(`${HARNESS}#/kit`);
  await touchPage.locator('.shell[data-statuses="ready"]').waitFor();
  const rows = touchPage.locator(".sel-row");
  await rows.nth(2).scrollIntoViewIfNeeded();
  const box = async (index: number) => (await rows.nth(index).locator(".kit-row-name").boundingBox())!;
  const first = await box(0);
  const third = await box(2);
  const client = await context.newCDPSession(touchPage);
  const point = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y) }];
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(first.x + 20, first.y + 8) });
  await touchPage.waitForTimeout(650);
  await expect(touchPage.locator(".sel-row[data-selected]")).toHaveCount(1);
  for (let step = 1; step <= 6; step += 1) {
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(first.x + 20, first.y + 8 + ((third.y - first.y) * step) / 6) });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(touchPage.locator(".sel-row[data-selected]")).toHaveCount(3);
  await expect(touchPage.locator(".sel-bar")).toContainText("3 settings selected");
  // The bar sits above the tab bar.
  const bar = (await touchPage.locator(".sel-bar").boundingBox())!;
  const tabbar = (await touchPage.locator(".tabbar-slot").boundingBox())!;
  expect(bar.y + bar.height).toBeLessThanOrEqual(tabbar.y + 1);
  expect(await touchPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await context.close();
  void page;
});

test("pickers · dates from a preset or the keyboard, options by typing, kept in the URL", async ({ page }) => {
  await page.setViewportSize(desktop);
  await open(page, "/kit");
  const dates = page.getByRole("button", { name: /^Changed:/ });
  await expect(dates).toHaveAccessibleName("Changed: Any time");
  await dates.click();
  await page.getByRole("button", { name: "Last 7 days" }).click();
  await expect(page).toHaveURL(/when=2026-09-26\.\.2026-10-02/);
  await expect(dates).toContainText("Last 7 days · 26 Sep – 2 Oct");
  // Keyboard: open, move with arrows, Enter on the first day and on the last.
  await dates.click();
  await page.getByRole("button", { name: "Custom", exact: true }).click();
  await expect(page.getByRole("button", { name: /Friday 2 October 2026/ })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/when=2026-09-29\.\.2026-10-01/);
  // Backup days are marked and say so.
  await dates.click();
  await expect(page.getByRole("button", { name: "Tuesday 29 September 2026, has a backup" })).toHaveAttribute("data-marked", "true");
  await page.keyboard.press("Escape");
  await expect(dates).toBeFocused();
  // Options: type to narrow, Enter to choose.
  await page.getByRole("button", { name: /^Service:/ }).click();
  await page.keyboard.type("exch");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/service=Exchange/);
  await expect(page.getByRole("button", { name: /^Service:/ })).toContainText("Exchange Online");
  // Segments: arrow keys move the choice.
  await page.getByRole("radio", { name: "All", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Needs action" })).toHaveAttribute("aria-checked", "true");
  await expect(page).toHaveURL(/show=action/);
  // Pickers match buttons: same height and radius.
  const heights = await page.locator(".picker-button, .segmented, .sel-find-box").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(new Set(heights.map(Math.round)).size).toBe(1);
});

test("pickers · on a phone the date picker opens as a sheet and fits", async ({ page }) => {
  await page.setViewportSize(phone);
  await open(page, "/kit");
  await page.getByRole("button", { name: /^Changed:/ }).click();
  const panel = page.locator(".popover-panel");
  // The sheet slides up from below; measure where it settles, not where it starts.
  await panel.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const box = (await panel.boundingBox())!;
  expect(Math.round(box.x)).toBe(0);
  expect(Math.round(box.width)).toBe(phone.width);
  expect(Math.round(box.y + box.height)).toBe(phone.height);
  await noSidewaysScroll(page);
});

// Frame and kit, both themes, with the menu open on a phone and a popover open.
for (const theme of ["dark", "light"] as const) {
  for (const { name, viewport, hash, step } of [
    { name: "kit", viewport: desktop, hash: "/kit", step: async (page: Page) => { await page.locator(".sel-row input").first().check(); } },
    { name: "bell", viewport: desktop, hash: "/", step: async (page: Page) => { await page.locator(".rail .bell").click(); } },
    { name: "cloud", viewport: desktop, hash: "/", step: async (page: Page) => { await page.locator(".cloud-switcher").click(); } },
    { name: "date-picker", viewport: desktop, hash: "/kit", step: async (page: Page) => { await page.getByRole("button", { name: /^Changed:/ }).click(); } },
    { name: "menu-sheet", viewport: phone, hash: "/drift", step: async (page: Page) => { await page.locator(".tabbar button.tab").click(); } },
  ]) {
    test(`a11y · frame ${name} · ${theme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await open(page, hash, theme);
      await step(page);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const summary = results.violations.map((violation) => ({ rule: violation.id, targets: violation.nodes.slice(0, 5).map((node) => node.target.join(" ")) }));
      expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);
    });
  }
}

test("visual · menu sheet and kit · phone", async ({ page }) => {
  await page.setViewportSize(phone);
  await open(page, "/kit");
  await page.locator(".sel-row input").nth(1).check();
  await expect(page).toHaveScreenshot("kit-phone.png");
  await page.locator(".tabbar button.tab").click();
  await expect(page).toHaveScreenshot("menu-sheet-phone.png");
});

test("visual · kit · desktop", async ({ page }) => {
  await page.setViewportSize(desktop);
  await open(page, "/kit");
  await page.locator(".sel-row input").first().check();
  await expect(page).toHaveScreenshot("kit-dark.png");
  await page.getByRole("button", { name: /^Changed:/ }).click();
  await expect(page).toHaveScreenshot("date-picker-dark.png");
});

test("buttons are outlined, with amber for the main action and red only inside a confirm step", async ({ page }) => {
  await page.setViewportSize(desktop);
  for (const path of ["/principals", "/notifications", "/integrations", "/setup", "/kit"]) {
    await open(page, path);
    expect(await page.locator(".btn-danger").evaluateAll((buttons) => buttons.filter((button) => !button.closest("dialog")).length), path).toBe(0);
  }
  await expect(page.getByRole("button", { name: "Start setup" })).toHaveClass(/btn-primary/);
  await page.getByRole("button", { name: "Remove access" }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog.getByRole("button", { name: "Keep the role" })).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Remove the role" })).toHaveClass(/btn-danger/);
  await expect(dialog.locator(".severity-label")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator("dialog[open]").getByRole("button", { name: "Pause", exact: true })).toHaveClass(/btn-primary/);
  await page.keyboard.press("Escape");
});

test("could-not-read messages say what failed and offer Try again; messages use the portal's icons and Undo", async ({ page }) => {
  await page.setViewportSize(desktop);
  await open(page, "/kit");
  const service = page.locator('.data-error[data-cause="service"]');
  await expect(service).toContainText("Keel could not reach ServiceNow just now. Your other pages still work.");
  await expect(service.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(service.getByRole("link", { name: "Open the connection" })).toHaveAttribute("href", "/integrations");
  await expect(page.locator('.data-error[data-cause="database"]')).not.toContainText("portal service");
  await page.getByRole("button", { name: "Show a message with Undo" }).click();
  const toast = page.locator(".toast").first();
  await expect(toast.locator(".toast-icon svg")).toHaveCount(1);
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".toast", { hasText: "Rule turned back on" })).toBeVisible();
});

test("search finds pages by what they do, your saved views, actions and people", async ({ page }) => {
  await page.setViewportSize(desktop);
  await open(page, "/kit?group=risk");
  await page.getByRole("button", { name: "Save filter" }).click();
  await page.getByLabel("Name for this filter").fill("Settings by risk");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await open(page, "/");
  await page.keyboard.press("Control+k");
  const palette = page.locator("dialog.command-palette");
  await expect(palette.getByRole("group", { name: "Actions" })).toContainText("Back up the critical settings now");
  await page.keyboard.type("consent");
  await expect(palette.getByRole("option").first()).toContainText("Setup");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("amara");
  await expect(palette.getByRole("group", { name: "Items" }).getByRole("option")).toContainText("Amara Okafor");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("settings by");
  await expect(palette.getByRole("option").first()).toContainText("Favourite");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/kit\?group=risk$/);
});

test("the menu keeps the open page in view, flags Settings and names the person", async ({ page }) => {
  await page.setViewportSize(desktop);
  await open(page, "/setup");
  const current = page.locator('aside.rail a.menu-sublink[aria-current="page"]');
  await expect(current).toHaveText("Setup");
  const inView = await current.evaluate((link) => {
    const rail = link.closest(".rail")!.getBoundingClientRect();
    const box = link.getBoundingClientRect();
    return box.top >= rail.top && box.bottom <= rail.bottom;
  });
  expect(inView).toBe(true);
  const settings = page.locator('aside.rail .menu-section:has(.menu-label:text-is("Settings")) .menu-badge').first();
  await expect(settings).toHaveAttribute("data-tone", "soon");
  await expect(settings).toHaveAttribute("title", "1 alert channel is failing to send");
  const person = page.locator("aside.rail a.menu-person-link");
  await expect(person.locator(".menu-person-name")).toHaveText("Marouane Defili");
  await expect(person.locator(".avatar")).toHaveText("MD");
  await expect(person).toContainText("your access");
});
