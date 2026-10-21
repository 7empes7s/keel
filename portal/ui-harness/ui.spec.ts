import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HARNESS = pathToFileURL(join(__dirname, "dist/index.html")).href;

const PAGES = [
  { name: "dashboard", hash: "/" },
  { name: "protect", hash: "/protect" },
  { name: "schedules", hash: "/schedules" },
  { name: "drift", hash: "/drift" },
  { name: "drift-services", hash: "/drift/services" },
  { name: "restore", hash: "/restore" },
  { name: "incidents", hash: "/incidents" },
  { name: "resilience", hash: "/resilience" },
  { name: "resilience-unmeasured", hash: "/resilience/unmeasured" },
  { name: "reports", hash: "/reports" },
  { name: "reports-scoped", hash: "/reports/scoped" },
  { name: "readiness", hash: "/readiness" },
  { name: "readiness-ready", hash: "/readiness/ready" },
  { name: "activity", hash: "/activity" },
  { name: "job-failed", hash: "/jobs/a4" },
  { name: "job-restore-completion", hash: "/jobs/r9" },
  { name: "job-restore-undo", hash: "/jobs/r10" },
  { name: "policies", hash: "/policies" },
  { name: "policy", hash: "/policies/p1" },
  { name: "policy-activation", hash: "/policies/p2" },
  { name: "approvals", hash: "/approvals" },
  { name: "baselines", hash: "/baselines" },
  { name: "baselines-new", hash: "/baselines/new" },
  { name: "benchmarks", hash: "/benchmarks" },
  { name: "principals", hash: "/principals" },
  { name: "notifications", hash: "/notifications" },
  { name: "integrations", hash: "/integrations" },
  { name: "integrations-servicenow-off", hash: "/integrations/servicenow-off" },
  { name: "setup", hash: "/setup" },
  { name: "setup-checked", hash: "/setup/checked" },
  { name: "alerts", hash: "/alerts" },
  { name: "ask", hash: "/ask" },
  { name: "ask-unknown", hash: "/ask/unknown" },
  { name: "emergency-changes", hash: "/emergency-changes" },
  { name: "compare", hash: "/compare" },
  { name: "compare-tenants", hash: "/compare/tenants" },
  { name: "sites", hash: "/sites" },
  { name: "site", hash: "/sites/contoso.sharepoint.com%2C5e170000-0000-4000-8000-000000000001%2C5e170000-0000-4000-8000-000000000002" },
];

async function open(page: Page, hash: string, theme: "light" | "dark" = "dark") {
  // Emulating the OS scheme exercises the default "System" theme path, which is
  // what most operators run.
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.goto(`${HARNESS}#${hash}`);
  await page.evaluate(() => { document.documentElement.dataset.harnessCi = ""; });
  await page.locator("main#main-content h1").waitFor();
  // The menu's section statuses arrive from a stubbed read; wait so every check and
  // screenshot sees them.
  await page.locator('.shell[data-statuses="ready"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  // Let entrance animations and transitions settle: axe measures contrast against
  // the current opacity, and screenshots must not catch a frame mid-fade.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
    .map((animation) => animation.finished.catch(() => undefined))));
}

// Every page, both themes: no WCAG 2.1 A/AA violations that axe can detect.
for (const theme of ["dark", "light"] as const) {
  for (const { name, hash } of PAGES) {
    test(`a11y · ${name} · ${theme}`, async ({ page }) => {
      await open(page, hash, theme);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const summary = results.violations.map((violation) => ({
        rule: violation.id,
        impact: violation.impact,
        targets: violation.nodes.slice(0, 5).map((node) => node.target.join(" ")),
      }));
      expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);
    });
  }
}

// Visual baselines for the pages most likely to regress, both themes, plus phone width.
const VISUAL = ["dashboard", "drift", "restore", "approvals", "protect", "job-failed"];
for (const theme of ["dark", "light"] as const) {
  for (const name of VISUAL) {
    test(`visual · ${name} · ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await open(page, PAGES.find((entry) => entry.name === name)!.hash, theme);
      await expect(page).toHaveScreenshot(`${name}-${theme}.png`, { fullPage: true });
    });
  }
}

test("visual · dashboard · phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "/", "dark");
  await expect(page).toHaveScreenshot("dashboard-phone.png", { fullPage: true });
});

// Interactions that the design relies on.
test("switch account ends the Access session, then signs out of Microsoft", async ({ page }) => {
  await page.route("https://login.microsoftonline.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Signed out</title>" }));
  await open(page, "/");
  await expect(page.getByRole("link", { name: "Sign out" })).toHaveAttribute("href", "/cdn-cgi/access/logout");
  // Record the Access sign-out request; it must happen before the browser leaves.
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      sessionStorage.setItem("keel-fetched", String(input));
      return original(input, init);
    };
  });
  await page.getByRole("button", { name: "Switch account" }).click();
  await page.waitForURL("https://login.microsoftonline.com/common/oauth2/v2.0/logout");
  await page.goBack();
  expect(await page.evaluate(() => sessionStorage.getItem("keel-fetched"))).toBe("/cdn-cgi/access/logout");
});

test("command palette opens with the keyboard and navigates", async ({ page }) => {
  await open(page, "/");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("evid");
  await page.keyboard.press("Enter");
  // Task-130: the audit record is part of Activity.
  await expect(page.locator("main h1")).toHaveText("Activity");
});

test("reject shows the spinner on Reject only", async ({ page }) => {
  await open(page, "/approvals?open=a9e10000-0000-4000-8000-000000000103");
  const card = page.locator(".ap-card").first();
  await card.getByRole("button", { name: "Reject…" }).click();
  // Without a reason the rejection is blocked, with the message next to the field.
  await card.getByRole("button", { name: "Reject the request" }).click();
  await expect(card.locator(".ap-field-error")).toHaveText("Write a reason to reject.");
  await card.locator("textarea").fill("outside the change window");
  await card.getByRole("button", { name: "Reject the request" }).click();
  await expect(card.getByRole("button", { name: "Reject the request" })).toHaveAttribute("aria-busy", "true");
  await expect(card.getByRole("button", { name: "Approve" })).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".toast").first()).toContainText("Request rejected");
});

// The page's done-test (portal audit, Approvals, pick B): tiles filter in the address,
// a request opens in place and Back closes it, the decision is made from what will
// change, a two-person request says how far along it is, and one amber action at most.
test("Approvals · tiles filter, a request opens in place, Back closes it, two-person progress", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, "/approvals");
  await expect(page.locator('[data-layer="verdict"] .verdict-sentence')).toHaveText("4 requests are waiting for you. One expires in 3 hours.");
  await expect(page.locator("main .btn-primary")).toHaveCount(1);
  const tiles = page.locator(".ap-tile");
  await expect(tiles).toHaveCount(4);
  const heights = await tiles.evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height)));
  expect(new Set(heights).size).toBe(1);
  await tiles.filter({ hasText: "Expiring within 4 hours" }).click();
  await expect(page).toHaveURL(/soon=1/);
  await expect(page.locator(".sel-row")).toHaveCount(1);
  await expect(page.locator(".ap-filter-note")).toContainText("Showing requests expiring within 4 hours only: 1 of 4.");
  await page.getByRole("link", { name: "Show every request" }).click();
  await expect(page.locator(".sel-row")).toHaveCount(4);
  // Soonest to expire first, grouped by kind; every title opens its card.
  await expect(page.locator(".sel-group .sel-group-name b").first()).toHaveText("Restores");
  for (const link of await page.locator(".ap-row-link").all()) expect(await link.getAttribute("href")).toMatch(/open=/);
  await page.locator(".ap-row-link", { hasText: "Restore 12 settings" }).first().click();
  await expect(page).toHaveURL(/open=a9e10000-0000-4000-8000-000000000101/);
  const card = page.locator(".ap-card");
  await expect(card).toHaveCount(1);
  // The verdict's action gives way to the card's one amber Approve.
  await expect(page.locator("main .btn-primary")).toHaveCount(1);
  await expect(card.locator(".ap-what h4")).toContainText("What will change · 12 settings (Entra ID 9, Exchange Online 3)");
  await expect(card.locator(".ap-changes > li").first()).toContainText("Block old sign-in methods");
  await expect(card.locator(".ap-changes > li").first().locator(".ap-after")).toHaveText("on");
  await expect(card.locator(".ap-progress")).toContainText("Needs 2 approvals");
  await expect(card.locator(".ap-progress")).toContainText("1 of 2");
  await expect(card.locator(".ap-progress")).toContainText("Lee Chen");
  await expect(card.getByRole("link", { name: "Open the full preview" })).toHaveAttribute("href", /^#?\/jobs\/a3$/);
  expectPlainText(await textOutside(page, "main#main-content", '[data-layer="record"]'));
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".toast").first()).toContainText("1 of 2 approvals recorded");
  await page.goBack();
  await expect(page.locator(".ap-card")).toHaveCount(0);
  await expect(page).not.toHaveURL(/open=/);
  // Several requests can be rejected with one reason; Approve stays one at a time.
  await page.getByRole("checkbox", { name: "Select all 1 request in Undo changes" }).check();
  await page.getByRole("checkbox", { name: "Select all 1 request in Approved-setup switches" }).check();
  await expect(page.locator(".sel-bar")).toContainText("2 requests selected");
  await expect(page.locator(".sel-bar")).toContainText("Approve stays one request at a time.");
  await page.locator(".sel-bar").getByRole("button", { name: "Reject 2 requests…" }).click();
  await expect(page.locator(".ap-reject")).toContainText("Why reject these 2 requests?");
  await page.locator(".ap-reject textarea").fill("Not this week");
  await page.locator(".ap-reject").getByRole("button", { name: "Reject 2 requests" }).click();
  await expect(page.locator(".toast", { hasText: "2 requests rejected" })).toHaveCount(1);
  // History: filter by outcome, open a decision in place.
  await page.getByRole("radio", { name: "Decided · 4" }).click();
  await page.getByRole("button", { name: "Rejected" }).click();
  await expect(page.locator(".ap-history-row")).toHaveCount(1);
  await page.locator(".ap-history-row .row-name a").click();
  await expect(page.locator(".ap-history-detail")).toContainText("Outside the change window; ask again on Monday.");
  await expect(page.locator(".ap-history-detail").getByRole("link", { name: "Open the restore run" })).toHaveAttribute("href", /^#?\/jobs\/a3$/);
});

for (const theme of ["dark", "light"] as const) {
  for (const width of [390, 1440]) {
    test(`Approvals · ${width} · ${theme}: no sideways scroll or clipped text, open card included`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await open(page, "/approvals?open=a9e10000-0000-4000-8000-000000000101", theme);
      await expect(page.locator(".ap-card")).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      const clipped = await page.locator("main#main-content").evaluate((main) => [...main.querySelectorAll<HTMLElement>(".ap-page *, .page-header *")]
        .filter((element) => element.children.length === 0 && element.clientWidth > 1 && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflow !== "visible" && getComputedStyle(element).textOverflow !== "ellipsis")
        .map((element) => element.textContent));
      expect(clipped).toEqual([]);
      const tiles = await page.locator(".ap-tile").evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height)));
      expect(new Set(tiles).size).toBe(1);
      if (width === 390) {
        // The decision stays reachable on a phone: the card's footer is in view once scrolled to.
        await page.locator(".ap-card-foot").scrollIntoViewIfNeeded();
        await expect(page.locator(".ap-card-foot .btn-primary")).toBeInViewport();
      }
    });
  }
}

test("destructive writes ask for confirmation with Cancel focused", async ({ page }) => {
  await open(page, "/notifications?tab=rules");
  await page.getByRole("button", { name: "Delete", exact: true }).first().click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

// The page's done-test (portal audit, Notifications, pick A: three tabs): the failing
// channel comes first, tiles set the tab and the status filter in the address, a test
// send posts to the channel's test route and appears under Sent, a channel can be turned
// back on, the rule form offers only real alerts and saves them, a sent row links to its
// alert, an escalation rule can be added and turned off, and the first screen holds one
// amber action.
test("Notifications · tiles, tabs, send test, turn back on, real-event rules, escalation, one amber action", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, "/notifications");
  await expect(page.locator(".status-pill")).toHaveText("Slack is failing");
  await expect(page.locator('[data-layer="verdict"] .verdict-sentence')).toHaveText("Slack has been failing for 27 minutes; the other 3 channels work.");
  const amber = page.locator("main .btn-primary:visible");
  await expect(amber).toHaveCount(1);
  await expect(amber).toHaveText("Send test to Slack");
  const tiles = page.locator(".nf-tile");
  await expect(tiles).toHaveCount(4);
  const heights = await tiles.evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height)));
  expect(new Set(heights).size).toBe(1);
  for (const tile of await tiles.all()) expect(await tile.getAttribute("href")).toMatch(/\/notifications/);
  // Failing first; every channel name opens its panel.
  await expect(page.locator(".sel-group .sel-group-name b").first()).toHaveText("Failing");
  await expect(page.locator(".nf-row-link").first()).toHaveText("Slack");
  for (const link of await page.locator(".nf-row-link").all()) expect(await link.getAttribute("href")).toMatch(/open=/);
  expectPlainText(await textOutside(page, "main#main-content", '[data-layer="record"]'));

  // The channel panel: what to do, the rules that use it, its recent sends, one amber action.
  await page.locator(".nf-row-link", { hasText: "Slack" }).first().click();
  await expect(page).toHaveURL(/open=c4e10000-0000-4000-8000-0000000000c4/);
  const panel = page.getByRole("dialog", { name: "Slack" });
  await expect(panel).toBeVisible();
  await expect(panel.locator(".nf-note")).toContainText("Make a new address in Slack");
  await expect(panel.getByRole("link", { name: "An alert came back · warning or above" })).toHaveCount(1);
  await expect(panel.locator(".nf-mini > li")).toHaveCount(3);
  await expect(panel.locator(".btn-primary:visible")).toHaveText("Send test");
  await expect(page.locator("main .btn-primary:visible")).toHaveCount(0);
  await page.goBack();
  await expect(panel).toBeHidden();

  // (1) Send test posts to the channel's test route; the Sent tab shows the new row.
  type Call = { url: string; method: string; body: string | null };
  const calls = () => page.evaluate(() => (window as unknown as { __harnessCalls: Call[] }).__harnessCalls);
  const posts = async () => (await calls()).filter((call) => call.method === "POST").map((call) => call.url);
  await amber.click();
  const toast = page.locator(".toast").first();
  await expect(toast).toContainText("Test alert queued for Slack");
  expect(await posts()).toContain("/api/channels/c4e10000-0000-4000-8000-0000000000c4/test");
  await toast.getByRole("link", { name: "Show under Sent" }).click();
  await expect(page).toHaveURL(/tab=sent/);
  await expect(page).toHaveURL(/channel=c4e10000-0000-4000-8000-0000000000c4/);
  await expect(page.locator(".nf-filter-note")).toContainText("Showing to Slack only");
  await expect(page.locator(".nf-sent").first()).toContainText("Test alert");
  await expect(page.locator(".nf-sent").first().locator(".badge")).toHaveText("Waiting to send");
  // (4) A sent row about an alert links to it.
  await expect(page.locator(".nf-sent .nf-row-link", { hasText: "Alert came back: Corporate laptops" }).first()).toHaveAttribute("href", /^#?\/alerts\?open=a1e70000-0000-4000-8000-000000000002$/);
  await page.getByRole("link", { name: "Show every send" }).click();
  await expect(page.locator(".sel-row")).toHaveCount(10);

  // (3) The Failed tile sets status=failed and Sent shows failures only.
  await tiles.filter({ hasText: "Failed" }).click();
  await expect(page).toHaveURL(/status=failed/);
  await expect(page.locator(".sel-row")).toHaveCount(2);
  for (const badge of await page.locator(".sel-row .badge").all()) await expect(badge).toHaveText("Failed");
  await expect(page.locator(".nf-filter-note")).toContainText("Showing failed only: 2 of 10.");

  // (5) Turn back on: the off channel's row offers it, and it posts to the enable route.
  await tiles.filter({ hasText: "Channels on" }).click();
  await expect(page).not.toHaveURL(/tab=/);
  const teams = page.locator(".sel-row", { hasText: "Microsoft Teams" });
  await expect(teams.locator(".badge")).toHaveText("Turned off");
  await teams.getByRole("button", { name: "Turn back on" }).click();
  await expect(page.locator(".toast", { hasText: "Microsoft Teams turned back on" })).toHaveCount(1);
  expect(await posts()).toContain("/api/channels/c4e10000-0000-4000-8000-0000000000c5/enable");

  // (2) The rule form offers only real alerts and saves alert.opened.
  await page.getByRole("radio", { name: /Who gets which alerts/ }).click();
  await expect(page).toHaveURL(/tab=rules/);
  await expect(page.locator(".nf-row-link", { hasText: "All alerts" })).toHaveCount(1);
  await expect(page.locator(".nf-escalation")).toContainText("A critical alert not acknowledged in 30 minutes");
  await expect(page.locator(".nf-escalation")).toContainText("Owner Sam Ortiz");
  await page.getByRole("link", { name: "Add rule" }).click();
  const form = page.getByRole("dialog", { name: "Add a rule" });
  await expect(form).toBeVisible();
  await form.getByRole("button", { name: /Which alerts/ }).click();
  const choices = page.locator(".option-panel [role='option']");
  await expect(choices).toHaveCount(3);
  for (const [index, label] of ["All alerts", "An alert opened", "An alert came back"].entries()) await expect(choices.nth(index)).toContainText(label);
  await choices.filter({ hasText: "An alert opened" }).click();
  await form.getByRole("button", { name: "Add rule" }).click();
  await expect(page.locator(".toast", { hasText: "Rule added" })).toHaveCount(1);
  const bodies = (await calls()).filter((call) => call.method === "POST" && call.url === "/api/subscriptions").map((call) => call.body ?? "");
  expect(bodies.length).toBe(1);
  expect(JSON.parse(bodies[0])).toMatchObject({ eventGlob: "alert.opened", minSeverity: "warning" });
  await expect(form).toBeHidden();

  // (6) An escalation rule can be added and turned off.
  await page.getByRole("link", { name: "Add escalation" }).click();
  const escalation = page.getByRole("dialog", { name: "Add an escalation rule" });
  await expect(escalation).toBeVisible();
  await escalation.getByRole("radio", { name: "4 h" }).click();
  await expect(escalation.locator(".bl-help")).toContainText("If a critical alert is not acknowledged in 4 hours, Keel also sends it to Web address hooks.contoso.com.");
  await escalation.getByRole("button", { name: "Add escalation" }).click();
  await expect(page.locator(".toast", { hasText: "Escalation rule added" })).toHaveCount(1);
  expect(await posts()).toContain("/api/escalation-rules");
  await page.locator(".nf-escalation").getByRole("button", { name: "Turn off" }).click();
  await expect(page.locator(".toast", { hasText: "Escalation rule turned off" })).toHaveCount(1);
  expect(await posts()).toContain("/api/escalation-rules/e5c10000-0000-4000-8000-0000000000e1/disable");
  // (7) Still one amber action at most on the page itself.
  expect(await page.locator("main .btn-primary:visible").count()).toBeLessThanOrEqual(1);
});

// The page's done-test (portal audit, Activity, pick A: a timeline by day): the status
// pill and verdict name what failed, the tiles are links that set a filter, the newest
// day comes first, a row opens its panel (Back closes it), "Run again" on a failed
// backup posts the same request the Backup page makes, the Who picker narrows to one
// person, and the first screen holds one amber action.
test("Activity · tiles, day groups, panel, run again, who filter, one amber action", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, "/activity");
  await expect(page.locator(".status-pill")).toHaveText("2 failed today");
  await expect(page.locator('[data-layer="verdict"] .verdict-sentence')).toHaveText("Keel ran 6 jobs in the last day; the backup of Tier 1 failed, and 1 more.");
  await expect(page.locator('[data-layer="verdict"] .verdict-detail')).toHaveText("Graph 429: throttled after 5 retries on /deviceManagement/deviceConfigurations");
  const amber = page.locator("main .btn-primary:visible");
  await expect(amber).toHaveCount(1);
  await expect(amber).toHaveText("Run the Tier 1 backup again");
  const tiles = page.locator(".ac-tile");
  await expect(tiles).toHaveCount(4);
  const heights = await tiles.evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height)));
  expect(new Set(heights).size).toBe(1);
  for (const tile of await tiles.all()) expect(await tile.getAttribute("href")).toMatch(/\/activity/);
  await expect(tiles.filter({ hasText: "Audit record" })).toContainText("Intact");
  // Newest day first, and every row title is a link that opens its panel.
  const groups = page.locator(".sel-group .sel-group-name b");
  await expect(groups.nth(0)).toHaveText("Today");
  await expect(groups.nth(1)).toHaveText("Yesterday");
  await expect(groups.nth(2)).toHaveText("Wednesday 30 September");
  await expect(page.locator(".sel-group").first()).toContainText("1 failed, 1 refused");
  for (const link of await page.locator(".ac-row-link").all()) expect(await link.getAttribute("href")).toMatch(/open=/);
  await expect(page.locator(".ac-row-link").first()).toHaveText("Amara Okafor approved a restore");
  expectPlainText(await textOutside(page, "main#main-content", '[data-layer="record"]'));

  // The panel of a failed backup: what went wrong, one amber "Run again", the job page link.
  await page.locator(".ac-row-link", { hasText: "Backup of Tier 1" }).first().click();
  await expect(page).toHaveURL(/open=job%3Aa4|open=job:a4/);
  const panel = page.getByRole("dialog", { name: "Backup of Tier 1" });
  await expect(panel).toBeVisible();
  await expect(panel.locator(".ac-note")).toContainText("Graph 429: throttled after 5 retries");
  await expect(panel.getByRole("link", { name: "Open the job page" })).toHaveAttribute("href", /\/jobs\/a4$/);
  await expect(panel.locator(".btn-primary:visible")).toHaveText("Run the Tier 1 backup again");
  await expect(page.locator("main .btn-primary:visible")).toHaveCount(0);
  await page.goBack();
  await expect(panel).toBeHidden();

  // "Run again" posts to the backup action with the failed job's tier.
  type Call = { url: string; method: string; body: string | null };
  const calls = () => page.evaluate(() => (window as unknown as { __harnessCalls: Call[] }).__harnessCalls);
  await amber.click();
  await expect(page.locator(".toast").first()).toContainText("Tier 1 backup queued");
  const backups = (await calls()).filter((call) => call.method === "POST" && call.url === "/api/actions/backup");
  expect(backups.length).toBe(1);
  expect(JSON.parse(backups[0].body ?? "{}")).toEqual({ tier: "tier1" });

  // The Failed tile sets the filter in the address; the list shows failures only.
  await tiles.filter({ hasText: "failed in the last 7 days" }).click();
  await expect(page).toHaveURL(/outcome=failed/);
  await expect(page.locator(".sel-row")).toHaveCount(2);
  for (const badge of await page.locator(".sel-row .badge").all()) await expect(badge).toHaveText("Failed");
  await expect(page.locator(".ac-filter-note")).toContainText("Showing failed jobs only: 2 of 18 loaded.");
  await page.getByRole("link", { name: "Show everything" }).click();
  await expect(page).not.toHaveURL(/outcome=/);
  await expect(page.locator(".sel-row")).toHaveCount(18);

  // Who: one person's jobs and audit entries, no one else's.
  await page.getByRole("button", { name: /^Who:/ }).click();
  await page.locator(".option-panel [role='option']", { hasText: "Amara Okafor" }).click();
  await expect(page).toHaveURL(/who=8c1e0000-0000-4000-8000-0000000000a2/);
  await expect(page.locator(".sel-row")).toHaveCount(2);
  await expect(page.locator(".ac-filter-note")).toContainText("Showing entries by Amara Okafor only");
  // Group by outcome: failed first.
  await page.getByRole("radio", { name: "Outcome" }).click();
  await expect(page.locator(".sel-group .sel-group-name b").first()).toHaveText("Failed");
  expect(await page.locator("main .btn-primary:visible").count()).toBeLessThanOrEqual(1);
});

// A row's panel says what it changed: each object, each setting, its value before and
// after, ids read as names, and nested values one line per setting.
for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
  test(`Activity · a backup's panel shows each changed setting before and after at ${viewport.width} px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await open(page, "/activity?open=job:y2", "dark");
    const panel = page.getByRole("dialog");
    const changes = panel.locator(".ac-changes");
    await expect(changes.locator("h3")).toHaveText("What changed (3)");
    const policy = changes.locator(".cv-object", { hasText: "Block legacy auth" });
    await expect(policy.locator(".cv-chip")).toHaveText("Changed");
    const state = policy.locator(".cv-row", { hasText: "State" });
    await expect(state.locator('[data-side="before"]')).toContainText("Previous backup");
    await expect(state.locator('[data-side="before"]')).toContainText("enabled");
    await expect(state.locator('[data-side="after"]')).toContainText("enabled for reporting but not enforced");
    await expect(policy.locator(".cv-row", { hasText: "Exclude groups" }).locator('[data-side="after"]')).toContainText("Break-glass admins, an object Keel has no name for");
    const removed = changes.locator(".cv-object", { hasText: "Old project team" });
    await expect(removed.locator(".cv-chip")).toHaveText("Removed");
    await expect(removed.locator(".cv-row", { hasText: "Description" }).locator('[data-side="before"]')).toContainText("Project Atlas, closed in September");
    await expect(removed.locator(".cv-row", { hasText: "Description" }).locator('[data-side="after"]')).toContainText("Not there");
    await expect(changes.locator(".cv-object", { hasText: "Windows compliance" })).toContainText("#1 › grace period hours: 24");
    await expect(changes.getByRole("link", { name: "See every difference in Compare" })).toHaveAttribute("href", /\/compare\?from=0b5e0000-0000-4000-8000-0000000000c8&to=0b5e0000-0000-4000-8000-0000000000d5/);
    expect(await panel.evaluate((element) => element.textContent ?? "")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

    // A restore says what it put back, and a row that changed no settings has no section.
    await open(page, "/activity?open=job:y1", "light");
    const restore = page.getByRole("dialog").locator(".ac-changes");
    await expect(restore.locator(".cv-row", { hasText: "Security enabled" }).locator('[data-side="before"]')).toContainText("no");
    await expect(restore.locator(".cv-row", { hasText: "Security enabled" }).locator('[data-side="after"]')).toContainText("yes");
    await open(page, "/activity?open=record:18204", "light");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").locator(".ac-changes")).toHaveCount(0);
  });
}

test("Activity · a viewer sees the timeline and no way to run anything", async ({ page }) => {
  await open(page, "/activity/viewer");
  await expect(page.locator(".ac-tile")).toHaveCount(4);
  await expect(page.locator("main .btn-primary:visible")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run again" })).toHaveCount(0);
  await expect(page.locator(".sel-row").first()).toBeVisible();
});

for (const theme of ["dark", "light"] as const) {
  for (const width of [390, 1440]) {
    for (const search of ["", "show=records", "group=who"]) {
      test(`Activity · ${width} · ${theme} · ${search || "everything"}: no sideways scroll or clipped text, equal tiles`, async ({ page }) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        await open(page, `/activity${search ? `?${search}` : ""}`, theme);
        await expect(page.locator(".sel-row").first()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
        const clipped = await page.locator("main#main-content").evaluate((main) => [...main.querySelectorAll<HTMLElement>(".ac-page *, .page-header *")]
          .filter((element) => element.children.length === 0 && element.clientWidth > 1 && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflow !== "visible" && getComputedStyle(element).textOverflow !== "ellipsis")
          .map((element) => element.textContent));
        expect(clipped).toEqual([]);
        const tiles = await page.locator(".ac-tile").evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height)));
        expect(new Set(tiles).size).toBe(1);
        // Rule 12: everything styled as clickable is a link with a target or a button.
        const dead = await page.locator("main#main-content").evaluate((main) => [...main.querySelectorAll<HTMLElement>("a, .btn, .ac-tile, .ac-row-link")]
          .filter((element) => (element.tagName === "A" && !(element as HTMLAnchorElement).getAttribute("href")) || (element.tagName !== "A" && element.tagName !== "BUTTON" && !element.closest("a, button")))
          .map((element) => element.outerHTML.slice(0, 80)));
        expect(dead).toEqual([]);
        if (width === 390 && !search) {
          // The panel is a full sheet with its actions in view; Shift+click still selects a range.
          await page.locator(".ac-row-link", { hasText: "Backup of Tier 1" }).first().click();
          const sheet = page.getByRole("dialog", { name: "Backup of Tier 1" });
          await expect(sheet).toBeVisible();
          await expect(sheet.locator(".btn-primary:visible")).toBeInViewport();
          await page.keyboard.press("Escape");
          await expect(sheet).toBeHidden();
        }
        if (width === 1440 && !search) {
          const rows = page.locator(".sel-row");
          await rows.nth(0).locator(".sel-check").click();
          await rows.nth(3).click({ modifiers: ["Shift"] });
          await expect(page.locator(".sel-bar-count")).toContainText("4 entries");
          await expect(page.locator(".sel-bar .btn-primary")).toHaveText("Export 4 entries");
          await page.getByRole("button", { name: /Select all 18 entries/ }).click();
          await expect(page.locator(".sel-bar-count")).toContainText("18 entries");
        }
      });
    }
  }
}

test("Notifications · a viewer sees what was sent and no controls", async ({ page }) => {
  await open(page, "/notifications/viewer");
  await expect(page.locator('[data-layer="verdict"] .verdict-sentence')).toHaveText("9 alerts were sent recently; 2 failed.");
  await expect(page.locator(".nf-tile")).toHaveCount(2);
  await expect(page.locator(".nf-tabs")).toHaveCount(0);
  await expect(page.locator(".nf-sent")).toHaveCount(9);
  await expect(page.getByRole("button", { name: "Send test" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Add channel" })).toHaveCount(0);
});

for (const theme of ["dark", "light"] as const) {
  for (const width of [390, 1440]) {
    for (const tab of ["", "tab=rules", "tab=sent"]) {
      test(`Notifications · ${width} · ${theme} · ${tab || "channels"}: no sideways scroll or clipped text, equal tiles`, async ({ page }) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        await open(page, `/notifications${tab ? `?${tab}` : ""}`, theme);
        await expect(page.locator(".sel-row").first()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
        const clipped = await page.locator("main#main-content").evaluate((main) => [...main.querySelectorAll<HTMLElement>(".nf-page *, .page-header *")]
          .filter((element) => element.children.length === 0 && element.clientWidth > 1 && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflow !== "visible" && getComputedStyle(element).textOverflow !== "ellipsis")
          .map((element) => element.textContent));
        expect(clipped).toEqual([]);
        const tiles = await page.locator(".nf-tile").evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height)));
        expect(new Set(tiles).size).toBe(1);
        // Rule 12: everything styled as clickable is a link with a target or a button.
        const dead = await page.locator("main#main-content").evaluate((main) => [...main.querySelectorAll<HTMLElement>("a, .btn, .nf-tile, .nf-row-link, .nf-chip")]
          .filter((element) => (element.tagName === "A" && !(element as HTMLAnchorElement).getAttribute("href")) || (element.tagName !== "A" && element.tagName !== "BUTTON" && !element.closest("a, button")))
          .map((element) => element.outerHTML.slice(0, 80)));
        expect(dead).toEqual([]);
        if (width === 390) {
          // The phone tabs are short words; the panel is a full sheet with its actions in view.
          await expect(page.getByRole("radio", { name: "Channels", exact: true })).toBeVisible();
          if (!tab) {
            await page.locator(".nf-row-link").first().click();
            const sheet = page.getByRole("dialog", { name: "Slack" });
            await expect(sheet).toBeVisible();
            await expect(sheet.locator(".btn-primary:visible")).toBeInViewport();
          }
        }
      });
    }
  }
}

test("a queued backup confirms with a toast linking to the job", async ({ page }) => {
  await open(page, "/protect");
  await page.getByRole("button", { name: "Back up Tier 1", exact: true }).click();
  const toast = page.locator(".toast").first();
  await expect(toast).toContainText("Tier 1 backup queued");
  await expect(toast.getByRole("link", { name: /View job/ })).toBeVisible();
});

test("the restore wizard walks select → dry run → review → confirm → track", async ({ page }) => {
  await open(page, "/restore");
  await expect(page.locator('[data-layer="verdict"]')).toHaveText("5 settings changed since the backup of Wed, 30 Sept 2026. Undo the ones nobody expected.");
  await page.getByRole("button", { name: "Show all 11 settings" }).click();
  await page.getByLabel("Select Require MFA for admins (sign-in rule)").click();
  await page.getByRole("button", { name: "Put back 1 setting" }).click();
  await expect(page.getByText("Ready to send for approval")).toBeVisible({ timeout: 15_000 });
  // Task-131: the step title is the verdict, and the review speaks in words: no natural
  // key, verb, closure or artifact id outside the record, and no credential path input.
  await expect(page.locator('[data-layer="verdict"]')).toHaveText("Step 3 of 4: review what will change, then send it for approval.");
  // What it depends on is added, with the reason.
  await expect(page.locator(".wizard-closure")).toContainText("Break-glass admins (group), because Require MFA for admins (sign-in rule) depends on it");
  expectPlainText(await textOutside(page, "main#main-content", '[data-layer="record"]'));
  await expect(page.locator("input[value*='/etc/keel']")).toHaveCount(0);
  // Task-61: a restored group's membership changes are listed apart from object changes.
  // Task-64: each resource names its recovery mechanism and what happens to its id.
  await expect(page.getByText("How each setting is put back")).toBeVisible();
  await expect(page.locator(".mechanism-row.mechanism-update-existing").first()).toContainText("Same ID kept");
  // Task-66: a content effect states that content is not backed up and needs its own approval.
  const effects = page.locator(".content-effects");
  await expect(effects).toContainText("Widens sharing");
  await expect(effects).toContainText("is not recoverable by KEEL");
  await expect(effects).toContainText("Not yet approved");
  await effects.getByPlaceholder("Why are these content effects acceptable?").fill("Visibility was public before INC-2291");
  await effects.getByRole("button", { name: "Approve this content change" }).click();
  await expect(effects).toContainText("Approved for exactly these effects");
  await expect(page.getByText("MEMBERSHIP CHANGES")).toBeVisible();
  await expect(page.locator(".edge-op.edge-add").first()).toContainText("amara.okafor@contoso.example (user)");
  await expect(page.locator(".edge-op.edge-remove").first()).toContainText("as member of");
  await page.getByPlaceholder("Why is this restore appropriate?").fill("Roll back INC-2291");
  await page.getByRole("button", { name: "Send for approval" }).click();
  await expect(page.getByRole("heading", { name: "Sent to approvers" })).toBeVisible();
  await expect(page.locator('[data-layer="verdict"]')).toHaveText("Step 4 of 4: sent to approvers. Nothing changes until one of them approves.");
});

// Restore redesign: grouped by service with "Changed recently" on top, an undo per
// change and per group, a calendar that marks backup days, and the chosen point always
// visible with its age.
test("restore leads with what changed, by service, and undoes a change or a group", async ({ page }) => {
  await open(page, "/restore");
  const groups = page.locator(".sel-group");
  await expect(groups.nth(0).locator(".sel-group-name b")).toHaveText("Changed recently");
  await expect(groups.nth(1).locator(".sel-group-name b")).toHaveText("Entra ID");
  // Deleted first, then changes newest first, each with who and when.
  const changed = groups.nth(0).locator(".sel-row");
  await expect(changed).toHaveCount(5);
  await expect(changed.nth(0)).toContainText("Branch offices");
  await expect(changed.nth(0)).toContainText("Deleted after this backup");
  await expect(changed.nth(1)).toContainText("State: on → report only, and 1 more");
  await expect(changed.nth(1)).toContainText("By Amara Okafor · between 1 Oct, 06:09 and 2 Oct, 09:12");
  await expect(changed.nth(2)).toContainText("Probably Lee Chen");
  // The point in time and its age, and the four tiles explain their numbers.
  await expect(page.locator(".restore-point-when")).toHaveText("Wed, 30 Sept 2026, 06:08 UTC");
  await expect(page.locator(".restore-point-age")).toHaveText("2 days old · 19 settings saved · 3 backups taken after it");
  await expect(page.locator(".restore-tile").nth(0)).toContainText("Changed since4");
  await expect(page.locator(".restore-tile").nth(3).getByRole("link")).toHaveAttribute("href", "#/jobs/a3");
  // Long groups show their first rows and say how many more.
  await expect(groups.nth(1).locator(".sel-row")).toHaveCount(8);
  await groups.nth(1).getByRole("button", { name: "Show all 11 settings" }).click();
  await expect(groups.nth(1).locator(".sel-row")).toHaveCount(11);
  // Undo the whole group: every change goes to the check at once, with before and after.
  await groups.nth(0).getByRole("button", { name: "Undo all 5: Changed recently" }).click();
  await expect(page.getByText("Ready to send for approval")).toBeVisible({ timeout: 15_000 });
  const beforeAfter = page.locator(".restore-before-after");
  await expect(beforeAfter).toContainText("Branch offices (trusted location)Now: gone");
  await expect(beforeAfter.locator("tr", { hasText: "Visibility" })).toContainText("PublicPrivate");
  await expect(page.locator(".restore-point-hint")).toHaveText("To pick another backup, change your selection first.");
  await page.getByRole("button", { name: "Change selection" }).click();
  await expect(groups.nth(0).locator(".sel-group-name b")).toHaveText("Changed recently");
});

test("restore lists the backups of other services, and only those", async ({ page }) => {
  await open(page, "/restore");
  const section = page.locator(".restore-services");
  await expect(section.locator("h2")).toHaveText("Other services");
  // Only services with a backup or a failed backup run; Power Platform (not switched on)
  // and Purview (no backup) are left out.
  await expect(section.locator(".restore-service h3")).toHaveText(["Exchange Online", "SharePoint and OneDrive", "Teams"]);
  await expect(section.locator(".restore-workload", { hasText: "Purview sensitivity labels" })).toHaveCount(0);
  await expect(section.locator(".restore-workload", { hasText: "Power Platform and Power BI" })).toHaveCount(0);
  const flow = section.locator(".restore-workload", { hasText: "Exchange mail flow and protection" });
  await expect(flow.locator(".restore-workload-backup")).toHaveText("Backed up 3 hours ago · 7 items.");
  await expect(section.locator(".restore-workload", { hasText: "Teams organization policies" })).toContainText("The newest backup failed");
  // No capability lists or how-to copy: that lives in the docs.
  await expect(section).not.toContainText("What you do by hand");
  await expect(section).not.toContainText("What the backup holds");
  await expect(section).not.toContainText("More services");
  // No stored code on the screen outside Technical details.
  await expect(section.locator(".restore-workload-head")).not.toContainText(["power-platform-settings", "exchange-mail-flow"]);
});

// Exchange, Teams and Purview: the same four steps from a service card, then Approvals.
for (const theme of ["dark", "light"] as const) {
  test(`restore puts back another service through the same steps and Approvals · ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open(page, "/restore", theme);
    // Only kinds KEEL can put back from the page get the button.
    await expect(page.locator(".restore-workload", { hasText: "OneDrive settings" }).getByRole("button", { name: "Choose what to put back" })).toHaveCount(0);
    await expect(page.locator(".restore-workload", { hasText: "SharePoint settings" }).getByRole("button", { name: "Choose what to put back" })).toHaveCount(0);
    await page.locator(".restore-workload", { hasText: "Exchange mail flow and protection" }).getByRole("button", { name: "Choose what to put back" }).click();
    const panel = page.locator(".workload-restore");
    await expect(panel.locator("h3")).toHaveText("Step 1 of 4: choose what to put back.");
    await expect(panel).toContainText("From the backup of 2 Oct, 06:12.");
    // An earlier backup: what changed since is chosen for you; a deleted rule cannot be.
    await panel.getByRole("button", { name: /^Backup day:/ }).click();
    await page.getByRole("button", { name: /^Tuesday 29 September 2026/ }).click();
    await expect(panel).toContainText("From the backup of 29 Sept, 06:10.");
    await expect(panel.getByRole("checkbox", { name: /KEEL-RT Block external auto-forward/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /KEEL-RT Quarantine executables/ })).not.toBeChecked();
    await expect(panel.getByRole("checkbox", { name: "KEEL-RT Route partner mail, cannot be put back" })).toBeDisabled();
    await expect(panel.locator(".workload-choice-group", { hasText: "Accepted domains" })).toContainText("By hand only");
    const results = await new AxeBuilder({ page }).include(".workload-restore").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
    await expect(panel).toContainText("2 settings chosen.");
    await panel.getByRole("button", { name: "Check what would change" }).click();
    await expect(panel.locator("h3")).toHaveText("Step 3 of 4: review what will change, then send it for approval.", { timeout: 20_000 });
    await expect(panel).toContainText("KEEL will put back 2 objects, 3 settings in all.");
    const table = panel.locator(".restore-ba-table").first();
    await expect(table).toContainText("Test only");
    await expect(table).toContainText("Reject message reason text");
    await expect(panel.locator(".workload-manual")).toContainText("Turning it on or off is a separate step an admin takes");
    expectPlainText(await textOutside(page, ".workload-restore", '[data-layer="record"]'));
    await panel.getByPlaceholder("Why is this restore appropriate?").fill("Undo INC-2301");
    await panel.getByRole("button", { name: "Send for approval" }).click();
    await expect(panel.locator("h3")).toHaveText("Step 4 of 4: sent to approvers. Nothing changes until one of them approves.");
    await expect(panel.getByRole("link", { name: "Open in Approvals" })).toHaveAttribute("href", /\/approvals$/);
  });
}

test("restore puts back several mailboxes at once, each as its own request", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, "/restore");
  await page.locator(".restore-workload", { hasText: "Exchange mailbox settings" }).getByRole("button", { name: "Choose what to put back" }).click();
  const panel = page.locator(".workload-restore");
  await expect(panel.locator("h3")).toHaveText("Step 1 of 4: choose what to put back.");
  // The organization-wide settings are never ticked for you, and need a mailbox.
  await expect(panel.getByRole("checkbox", { name: /Organization-wide Exchange settings/ })).not.toBeChecked();
  await panel.getByRole("checkbox", { name: /Organization-wide Exchange settings/ }).check();
  await expect(panel).toContainText("The organization-wide settings go with a mailbox: choose one too.");
  await expect(panel.getByRole("button", { name: "Check what would change" })).toBeDisabled();
  await panel.getByRole("checkbox", { name: /Organization-wide Exchange settings/ }).uncheck();
  await panel.getByRole("checkbox", { name: /KEEL-RT-Shared@contoso.example/ }).check();
  await panel.getByRole("checkbox", { name: /KEEL-RT-User1@contoso.example/ }).check();
  await expect(panel).toContainText("2 mailboxes chosen.");
  await panel.getByRole("button", { name: "Check 2 mailboxes" }).click();
  await expect(panel.locator("h3")).toHaveText("Step 3 of 4: review what will change, then send it for approval.", { timeout: 20_000 });
  await expect(panel).toContainText("KEEL will put back 2 objects, 3 settings in all, as 2 requests.");
  await expect(panel.locator(".workload-run h4")).toHaveText(["KEEL-RT-Shared@contoso.example", "KEEL-RT-User1@contoso.example"]);
  const results = await new AxeBuilder({ page }).include(".workload-restore").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
  expectPlainText(await textOutside(page, ".workload-restore", '[data-layer="record"]'));
  await panel.getByRole("button", { name: "Send 2 for approval" }).click();
  await expect(panel.locator("h3")).toHaveText("Step 4 of 4: sent to approvers. Nothing changes until one of them approves.");
});

test("restore of another service fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "/restore");
  await page.locator(".restore-workload", { hasText: "Exchange mail flow and protection" }).getByRole("button", { name: "Choose what to put back" }).click();
  await expect(page.locator(".workload-restore h3")).toHaveText("Step 1 of 4: choose what to put back.");
  await expect(page.locator(".workload-choice").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  const button = page.getByRole("button", { name: "Check what would change" });
  const box = await button.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});

test("restore picks its backup on a calendar that marks backup days", async ({ page }) => {
  await open(page, "/restore");
  await page.getByRole("button", { name: /^Backup day:/ }).click();
  await expect(page.locator(".date-day[data-marked]")).toHaveCount(4);
  // A day without a backup takes the one before it, and says so.
  await page.getByRole("button", { name: /^Tuesday 29 September 2026/ }).click();
  await expect(page.locator(".restore-point-when")).toHaveText("Sat, 26 Sept 2026, 06:08 UTC");
  await expect(page.locator(".restore-point-notice")).toHaveText("No backup on Tue, 29 Sept 2026, so this is the one before it.");
  // The newest backup already has the latest changes: the page offers the one before.
  await page.getByRole("button", { name: "Use the newest backup" }).click();
  await expect(page.locator('[data-layer="verdict"]')).toHaveText("2 settings changed just before your newest backup. Pick an earlier day to undo them.");
  await expect(page.locator(".restore-earlier").getByRole("link")).toHaveAttribute("href", "#/restore?snapshot=snap-3");
  await expect(page.locator(".sel-group-name b").first()).toHaveText("Entra ID");
});

test("restore refuses a synced group with the reason, before any check runs", async ({ page }) => {
  await open(page, "/restore");
  await page.getByLabel("Select Finance (group)").click();
  await page.getByRole("button", { name: "Put back 1 setting" }).click();
  await expect(page.getByRole("heading", { name: "KEEL cannot put this back" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("KEEL refused to change Finance (group) because it is synced from on-premises Active Directory, which owns it.");
  expectPlainText(await textOutside(page, "main#main-content", '[data-layer="record"]'));
});

// The Changes page: a change opens in a details panel from its name; accept, ignore and
// undo act on the chosen rows of the shared list.
async function openChange(page: Page, name: string) {
  await page.locator(".bl-row-link", { hasText: new RegExp(`^${name}$`) }).click();
  const sheet = page.getByRole("dialog", { name });
  await expect(sheet).toBeVisible();
  return sheet;
}

// Task-131: the undo preview says what Keel would do in words, keeps verbs and waves in
// the record, and states a refusal as a sentence.
test("the undo preview speaks in words and states a refusal as a sentence", async ({ page }) => {
  await open(page, "/drift");
  await page.getByLabel("Select Finance (group)").check();
  await page.getByLabel("Select Block legacy auth (sign-in rule)").check();
  await expect(page.locator(".sel-bar")).toContainText("2 changes selected");
  await page.locator(".sel-bar").getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Undo these changes…" }).click();
  const sheet = page.getByRole("dialog", { name: "Undo 2 changes" });
  await expect(sheet).toContainText("Applies only to: Block legacy auth (sign-in rule), Finance (group).");
  await sheet.getByRole("button", { name: "Check what undoing would do" }).click();
  const preview = sheet.locator(".remediation-preview");
  await expect(preview).toContainText("Put the approved settings back");
  await expect(preview.locator('[role="alert"]')).toHaveText(/KEEL refused to change Finance \(group\) because it is synced from on-premises Active Directory, which owns it\./);
  await expect(sheet.getByRole("button", { name: "Send for approval" })).toBeDisabled();
  const record = preview.locator('[data-layer="record"]');
  await record.locator("summary").click();
  await expect(record).toContainText("Write wave 1");
  await expect(record).toContainText("onPremisesSyncEnabled=true");
  expectPlainText(await textOutside(page, ".bl-sheet", '[data-layer="record"]'));
});

// Accepting chosen changes says what it does first, asks why, then takes them off the list.
test("accepting chosen changes says what it does, asks why, and clears them from the list", async ({ page }) => {
  await open(page, "/drift");
  await page.getByLabel("Select Old project team (group)").check();
  await page.getByRole("checkbox", { name: /^Select Windows baseline/ }).check();
  await page.locator(".sel-bar").getByRole("button", { name: "Accept 2 changes" }).click();
  const sheet = page.getByRole("dialog", { name: "Accept 2 changes into the approved setup" });
  await expect(sheet).toContainText("Nothing in Microsoft 365 changes.");
  await sheet.getByRole("button", { name: "Accept 2 changes" }).click();
  await expect(sheet.getByRole("alert")).toContainText("Say why");
  await sheet.getByPlaceholder("Why is this decision right?").fill("Planned clean-up");
  await sheet.getByRole("button", { name: "Accept 2 changes" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.locator(".bl-row-link", { hasText: /^Old project team$/ })).toHaveCount(0);
  await expect(page.locator(".bl-tile", { hasText: "All open changes" }).locator(".bl-tile-count")).toHaveText("5");
});

// Task-91: who made a change, in words, with its evidence kept in the record; a missing
// audit log is said plainly, and a cross-entity undo is handed to a central approver.
test("a change says who made it from the audit log and where an undo goes", async ({ page }) => {
  await open(page, "/drift");
  let sheet = await openChange(page, "Block legacy auth");
  const panel = sheet.locator(".change-attribution");
  await expect(panel.locator(".change-attribution-headline")).toContainText("Confirmed by the Microsoft audit log. Amara Okafor made this change, according to the audit log.");
  await expect(panel.locator(".change-attribution-route")).toHaveText("A roll back goes to a central approver (2 people), because it touches more than one entity.");
  expectPlainText(await textOutside(page, ".bl-sheet", '[data-layer="record"]'));
  const record = panel.locator('[data-layer="record"]');
  await record.locator("summary").click();
  for (const kept of ["Directory_8f2c1d7a-4b3e-4f61-9a20-1c5d7e9b3a44", "a71ce000-0000-4000-8000-0000000000a7", "c0a10000-0000-4000-8000-0000000000ca", "exact · audit-record-names-resource", "central · cross-entity"]) {
    await expect(record).toContainText(kept);
  }
  // The record opens as its own panel on top of the sheet; the first Esc closes only it.
  await expect(record.locator(".technical-body")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(record.locator(".technical-body")).toBeHidden();
  await expect(sheet).toBeVisible();
  // The sheet is in the address, closes with Esc and gives focus back to the row.
  await expect(page).toHaveURL(/open=dr1/);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(page.locator(".bl-row-link", { hasText: /^Block legacy auth$/ })).toBeFocused();
  sheet = await openChange(page, "Finance");
  await expect(sheet.locator(".change-attribution-headline")).toContainText("Not known. The audit log for that time is no longer available");
  await expect(sheet.locator(".change-attribution-route")).toHaveText("A roll back goes to CREOS approvers (1 person).");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});

// Task-98: a change lists only the settings that change behaviour, grouped by what an
// undo can do, links the records a decision rests on and says which ones do not match.
// An unknown earlier value is never a removal.
test("a change shows its behavioural settings and linked records, and flags mismatches", async ({ page }) => {
  await open(page, "/drift");
  const all = page.locator(".bl-tile", { hasText: "All open changes" });
  await expect(all.locator(".bl-tile-count")).toHaveText("7");
  await expect(all).toContainText("Everything that differs from the approved setup");
  await expect(page.locator(".bl-context")).toContainText("1 change rests on records that do not match each other.");

  // The name opens the panel from the keyboard.
  await page.locator(".bl-row-link", { hasText: /^Finance$/ }).focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: "Finance" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".bl-why")).toContainText("Why it matters");
  const diff = sheet.locator(".semantic-diff");
  await expect(diff.locator(".semantic-summary")).toHaveText("2 settings differ from the approved setup in a way that changes behaviour.");
  await expect(diff.getByRole("heading", { name: "Cannot be changed back in place (1)" })).toBeVisible();
  await expect(diff.getByRole("heading", { name: "Changes behaviour (1)" })).toBeVisible();
  const evidence = sheet.locator(".decision-evidence");
  await expect(evidence.locator(".decision-mismatch-note")).toHaveText("2 records do not match the others. Check before you decide.");
  await expect(evidence.locator(".decision-row-mismatch dt")).toHaveText(["Baseline copy · does not match", "Roll-back plan and result · does not match"]);
  await expect(evidence).toContainText("Owned by CREOS.");
  await expect(evidence).toContainText("A roll-back request is approved. Its job is finished.");
  await expect(evidence).toContainText("It restores from a different backup than the baseline's, so it is not linked to this change. Result: KEEL wrote it back and checked the result.");
  expectPlainText(await textOutside(page, ".bl-sheet", '[data-layer="record"]'));
  const record = evidence.locator('[data-layer="record"]');
  await record.locator("summary").click();
  for (const kept of ["7f3c0000-0000-4000-8000-000000000011", "a9e10000-0000-4000-8000-000000000100", "0b5e0000-0000-4000-8000-0000000000c8", "mismatch"]) {
    await expect(record).toContainText(kept);
  }
  await sheet.getByRole("button", { name: "Close technical details" }).click();
  await expect(record.locator(".technical-body")).toBeHidden();
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(".semantic-diff")).toHaveCount(0);

  const unknownSheet = await openChange(page, "HQ egress");
  const unknown = unknownSheet.locator(".semantic-diff");
  await expect(unknown.locator(".semantic-summary")).toHaveText("KEEL did not keep the baseline's copy of this, so the earlier values are not known. Nothing is shown as removed.");
  await expect(unknown.locator("td[data-label='Approved']")).toHaveText(["Not known", "Not known"]);
  await expect(unknown.locator(".diff-kind")).toHaveText(["Now set", "Now set"]);
  await expect(unknownSheet.locator(".decision-evidence")).toContainText("The baseline holds no copy of this, so KEEL cannot check what it compared against.");
  await expect(unknownSheet.locator(".decision-evidence")).toContainText("The backup that found this change is stored, but the change did not record what it saw, so KEEL cannot check it.");
  expectPlainText(await textOutside(page, ".bl-sheet", '[data-layer="record"]'));
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});

test("an opened change and the counts fit a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "/drift", "light");
  const sheet = await openChange(page, "Block legacy auth");
  await expect(sheet.locator(".decision-evidence")).toContainText("Shared by CREOS and ENOVOS.");
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  // On a phone the panel fills the screen, and each linked record stacks its label above its sentence.
  const panel = (await page.locator(".bl-sheet").boundingBox())!;
  expect(panel.width).toBeGreaterThanOrEqual(389);
  const row = sheet.locator(".decision-row").first();
  const [label, value] = await Promise.all([row.locator("dt").boundingBox(), row.locator("dd").boundingBox()]);
  expect(value!.y).toBeGreaterThan(label!.y);
  // The footer's decisions stay on screen while the panel scrolls.
  const footer = (await sheet.locator(".bl-sheet-foot").boundingBox())!;
  expect(footer.y + footer.height).toBeLessThanOrEqual(845);
  await page.keyboard.press("Escape");
  // The risk tiles are two by two, of equal height.
  const tiles = await page.locator(".bl-tile").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect()).map((rect) => ({ x: Math.round(rect.x), h: Math.round(rect.height) })));
  expect(new Set(tiles.map((tile) => tile.x)).size).toBe(2);
  expect(await overflow()).toBeLessThanOrEqual(0);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});

// The shared list on the Changes page: Shift+click picks a range, a service header picks
// its service, select all picks every change, and a tile filters by risk in the address.
test("changes · Shift+click range, select a service, select all, filter by risk", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/drift");
  const rows = page.locator(".sel-row");
  await rows.nth(0).locator("input").click();
  await rows.nth(2).locator(".bl-row-who").click({ modifiers: ["Shift"] });
  await expect(page.locator(".sel-row[data-selected]")).toHaveCount(3);
  await expect(page.locator(".sel-bar")).toContainText("3 changes selected");
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
  await page.keyboard.press("Escape");
  await page.getByRole("checkbox", { name: "Select all 1 change in Intune" }).check();
  await expect(page.locator(".sel-bar")).toContainText("1 change selected");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Select all 7 changes" }).click();
  await expect(page.locator(".sel-row[data-selected]")).toHaveCount(7);
  await page.keyboard.press("Escape");
  await page.locator(".bl-tile", { hasText: "Could lock out admins" }).click();
  await expect(page).toHaveURL(/risk=tenant-lockout/);
  await expect(page.locator(".sel-row")).toHaveCount(2);
  await expect(page.locator(".bl-filter-note")).toContainText("Showing could lock out admins only: 2 of 7.");
  await page.getByRole("link", { name: "Show every change" }).click();
  await expect(page.locator(".sel-row")).toHaveCount(7);
});

test("changes · phone: hold a change, then drag over others to select them", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const touchPage = await context.newPage();
  await touchPage.goto(`${HARNESS}#/drift`);
  await touchPage.locator('.shell[data-statuses="ready"]').waitFor();
  const rows = touchPage.locator(".sel-row");
  await rows.nth(2).scrollIntoViewIfNeeded();
  const box = async (index: number) => (await rows.nth(index).locator(".bl-row-name small").boundingBox())!;
  const first = await box(0);
  const third = await box(2);
  const client = await context.newCDPSession(touchPage);
  const point = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y) }];
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(first.x + 20, first.y + 6) });
  await touchPage.waitForTimeout(650);
  await expect(touchPage.locator(".sel-row[data-selected]")).toHaveCount(1);
  for (let step = 1; step <= 6; step += 1) {
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(first.x + 20, first.y + 6 + ((third.y - first.y) * step) / 6) });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(touchPage.locator(".sel-row[data-selected]")).toHaveCount(3);
  await expect(touchPage.locator(".sel-bar")).toContainText("3 changes selected");
  expect(await touchPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await context.close();
});

// Q45: a restore planned with the command line carries a content effect. The inbox
// says so and links to its review; the review approves it. Both fit a phone.
test("a CLI-planned restore's content effects are linked from the inbox and approvable on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const axe = async () => (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations.map((violation) => violation.id);

  await open(page, "/approvals/cli-restore?open=a9e10000-0000-4000-8000-000000000145", "light");
  const note = page.locator(".approval-content-effects");
  await expect(note).toContainText("1 change in this restore affects kept or shared content. It needs its own approval by someone other than the person who asked");
  await expect(note.getByRole("link", { name: "Review the content changes" })).toHaveAttribute("href", /^#?\/approvals\/content-effects\/7f3c0000-0000-4000-8000-000000000045$/);
  expectPlainText(await textOutside(page, "main#main-content", '[data-layer="record"]'));
  expect(await overflow()).toBeLessThanOrEqual(0);
  expect(await axe()).toEqual([]);

  for (const theme of ["light", "dark"] as const) {
    await open(page, "/approvals/content-effects", theme);
    await expect(page.locator(".content-effects")).toContainText("Shortens retention");
    await expect(page.locator(".content-effects")).toContainText("Not yet approved");
    expect(await overflow()).toBeLessThanOrEqual(0);
    expect(await axe()).toEqual([]);
  }
  const effects = page.locator(".content-effects");
  await effects.getByPlaceholder("Why are these content effects acceptable?").fill("Policy review agreed 365 days");
  await effects.getByRole("button", { name: "Approve this content change" }).click();
  await expect(effects).toContainText("Approved for exactly these effects by Marouane Defili");
  expect(await overflow()).toBeLessThanOrEqual(0);
});

// Task-131 (was task-54/63's coverage matrix), rebuilt as What's protected: a kind's
// details panel answers in one sentence and keeps the recovery decision, remapping proof
// and proof reference in its record. The panel is in the address and Back closes it.
test("a kind's details panel states its standing and keeps the recovery decision and proof in its record", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/protect");
  await page.locator(".pt-row-link", { hasText: /^Sign-in rule$/ }).click();
  await expect(page).toHaveURL(/open=conditionalAccessPolicy/);
  const sheet = page.locator(".bl-sheet");
  await expect(sheet.locator(".pt-details-standing")).toHaveText("Protected: restore proven on this tenant on 20 Sept 2026.");
  await expect(sheet.locator(".decision-automated")).toContainText("Keel restores this type on its own.");
  await expect(sheet.getByRole("link", { name: "Restore this kind" })).toHaveAttribute("href", /^#?\/restore\?q=Sign-in%20rule$/);
  expectPlainText(await textOutside(page, ".bl-sheet", '[data-layer="record"]'));
  const record = sheet.locator('[data-layer="record"]');
  await record.locator("summary").click();
  await expect(record.locator(".technical-field").filter({ hasText: "Recovery decision" })).toContainText("automated");
  await expect(record.locator(".technical-field").filter({ hasText: "Remapping · create" })).toContainText("proven");
  await expect(record.locator(".technical-field").filter({ hasText: "Proof reference · update" })).toContainText("docs/release/qualification/ca-update.json");
  await page.goBack();
  await expect(sheet).toBeHidden();
  await expect(page).not.toHaveURL(/open=/);
});

test("What's protected sorts failed and out-of-date kinds first, each with a run of its tier", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/protect");
  await expect(page.locator('[data-layer="verdict"] .verdict-sentence')).toHaveText("2 types failed their last backup.");
  const entra = page.locator(".sel-group", { hasText: "Entra ID" }).first();
  await expect(entra.locator(".pt-row-link").first()).toHaveText("Authentication methods policy");
  const failed = entra.locator(".sel-row").first();
  await expect(failed.locator(".badge")).toHaveText("Failed");
  await failed.getByRole("button", { name: "Back up Tier 1 again" }).click();
  await expect(page.locator(".toast").first()).toContainText("Tier 1 backup queued");
});

// The page's done-test (portal audit, What's protected): tiles filter the list in the
// address, the view survives a reload, selection names the tiers it runs, every job
// title is a link, and the first screen holds exactly one amber action.
test("What's protected · tiles filter in the address, selection names its tiers, one amber action", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, "/protect");
  const amber = page.locator("main .btn-primary:not(.pt-split-more)");
  await expect(amber).toHaveCount(1);
  await expect(amber).toHaveText("Back up now");
  // On a desktop the list is grouped by service; the service cards are the phone's.
  await expect(page.locator(".pt-by-service")).toBeHidden();
  const tiles = page.locator(".pt-tile");
  await expect(tiles).toHaveCount(4);
  const heights = await tiles.evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height)));
  expect(new Set(heights).size).toBe(1);
  for (const tile of await tiles.all()) expect(await tile.getAttribute("href")).toMatch(/health=/);
  await tiles.filter({ hasText: "Failed" }).click();
  await expect(page).toHaveURL(/health=failed/);
  await expect(page.locator(".sel-row")).toHaveCount(2);
  await expect(page.locator(".pt-filter-note")).toContainText("Showing failed only: 2 of 15.");
  await page.goto(`${HARNESS}#/protect?health=failed&group=service`);
  await page.locator("main#main-content h1").waitFor();
  await expect(page.locator(".sel-row")).toHaveCount(2);
  await page.getByRole("link", { name: "Show every kind" }).click();
  await expect(page.locator(".sel-row")).toHaveCount(15);
  // Shift+click picks a range; the bar says which tiers run before anything runs.
  const rows = page.locator(".sel-row");
  await rows.nth(0).locator("input").click();
  await rows.nth(2).locator(".pt-row-name small").click({ modifiers: ["Shift"] });
  await expect(page.locator(".sel-row[data-selected]")).toHaveCount(3);
  await expect(page.locator(".sel-bar")).toContainText("3 kinds selected");
  await expect(page.locator(".sel-bar")).toContainText("Runs Tier 1 in full. It only reads your tenant.");
  await page.locator(".sel-bar").getByRole("button", { name: "Back up 3 kinds" }).click();
  await expect(page.locator(".toast").first()).toContainText("Tier 1 backup queued");
  await page.keyboard.press("Escape");
  await page.getByRole("checkbox", { name: "Select all 2 kinds in Intune" }).check();
  await expect(page.locator(".sel-bar")).toContainText("Runs Tier 2 and Tier 3 in full.");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Select all 15 kinds" }).click();
  await expect(page.locator(".sel-row[data-selected]")).toHaveCount(15);
  await page.keyboard.press("Escape");
  // Every kind name opens its panel; every job title is a link to its job.
  for (const link of await page.locator(".pt-row-link").all()) expect(await link.getAttribute("href")).toMatch(/open=/);
  for (const title of await page.locator(".job-list .row-name a").all()) expect(await title.getAttribute("href")).toMatch(/^#?\/jobs\//);
});

for (const theme of ["dark", "light"] as const) {
  for (const width of [390, 1440]) {
    test(`What's protected · ${width} · ${theme}: no sideways scroll or clipped text`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await open(page, "/protect", theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      // No text runs out of its box in the page body (a deliberate ellipsis aside).
      const clipped = await page.locator("main#main-content").evaluate((main) => [...main.querySelectorAll<HTMLElement>(".pt-page *, .page-header *")]
        .filter((element) => element.children.length === 0 && element.clientWidth > 1 && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflow !== "visible" && getComputedStyle(element).textOverflow !== "ellipsis")
        .map((element) => element.textContent));
      expect(clipped).toEqual([]);
      const tiles = await page.locator(".pt-tile").evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height)));
      expect(new Set(tiles).size).toBe(1);
      if (width === 390) {
        // Phone: pick B, the service cards come first and open their kinds below.
        await expect(page.locator(".pt-by-service")).toBeVisible();
        await page.locator(".pt-service", { hasText: "Intune" }).getByRole("link", { name: "Open 2 kinds" }).click();
        await expect(page).toHaveURL(/service=Intune/);
        await expect(page.locator(".sel-row")).toHaveCount(2);
        await page.locator(".pt-service", { hasText: "Intune" }).getByRole("checkbox").check();
        await expect(page.locator(".pt-selbar")).toContainText("Runs Tier 2 and Tier 3 in full.");
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      }
    });
  }
}

test("What's protected · phone: hold a kind, then drag over others to select them", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const touchPage = await context.newPage();
  await touchPage.goto(`${HARNESS}#/protect`);
  await touchPage.locator('.shell[data-statuses="ready"]').waitFor();
  const rows = touchPage.locator(".sel-row");
  await rows.nth(2).scrollIntoViewIfNeeded();
  const box = async (index: number) => (await rows.nth(index).locator(".pt-row-name small").boundingBox())!;
  const first = await box(0);
  const third = await box(2);
  const client = await context.newCDPSession(touchPage);
  const point = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y) }];
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(first.x + 20, first.y + 6) });
  await touchPage.waitForTimeout(650);
  await expect(touchPage.locator(".sel-row[data-selected]")).toHaveCount(1);
  for (let step = 1; step <= 6; step += 1) {
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(first.x + 20, first.y + 6 + ((third.y - first.y) * step) / 6) });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(touchPage.locator(".sel-row[data-selected]")).toHaveCount(3);
  await expect(touchPage.locator(".sel-bar")).toContainText("3 kinds selected");
  expect(await touchPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await context.close();
});

test("restore completion closes an item with a reference and refuses a pasted secret", async ({ page }) => {
  await open(page, "/jobs/r9");
  const app = page.locator(".completion-resource").filter({ hasText: "application:Payroll connector" });
  await expect(app.locator(".completion-badge-configuration-restored")).toHaveText("Configuration restored");
  const credential = app.locator(".completion-item").filter({ hasText: "client secrets" });
  await credential.getByLabel("Evidence reference").fill("-----BEGIN PRIVATE KEY----- secret");
  await credential.getByRole("button", { name: "Mark verified" }).click();
  await expect(page.getByText("never the credential")).toBeVisible();
  await credential.getByLabel("Evidence reference").fill("CHG-5120");
  await credential.getByRole("button", { name: "Mark verified" }).click();
  await expect(credential.getByRole("button", { name: "Reopen" })).toBeVisible();
  const integration = app.locator(".completion-item").filter({ hasText: "new object id" });
  await integration.getByLabel("Evidence reference").fill("CHG-5121");
  await integration.getByRole("button", { name: "Mark verified" }).click();
  await expect(app.locator(".completion-badge-service-validation-pending")).toHaveText("Service validation pending");
});

// Task-73: the recovery point comes from the last complete off-site copy, a newer copy
// that lacks a good backup is named and does not count, a failed restore is listed
// apart from recovery time, and a tenant with nothing measured says so in every card.
test("resilience shows measured values, names what does not count, and keeps unmeasured visible", async ({ page }) => {
  await open(page, "/resilience");
  await expect(page.locator('[data-layer="verdict"] .verdict-sentence')).toHaveText("If this server were lost, KEEL could recover settings as of 29 hours ago. The last proven recovery took 20 minutes.");
  const point = page.locator(".resilience-point");
  await expect(point).toContainText("does not count: it holds no good backup of Group and Members of each group.");
  const time = page.locator(".resilience-time");
  await expect(time).toContainText("The last checked recovery took 20 minutes; the slowest of 2 checked recoveries took 20 minutes.");
  await expect(time).toContainText("does not count: it failed.");
  await expect(time.getByRole("link", { name: "View the restore" })).toHaveAttribute("href", /b7c10000-0000-4000-8000-000000000074/);
  const freshness = page.locator(".resilience-freshness");
  await expect(freshness).toContainText("The oldest good backup KEEL relies on is 3 hours 40 minutes old: Conditional Access policy.");
  await expect(freshness).toContainText("This is the plan, not a result.");
  await expect(page.locator(".resilience-incidents").getByRole("link", { name: "Admin consent phishing" })).toBeVisible();

  await open(page, "/resilience/unmeasured");
  await expect(page.locator('[data-layer="verdict"] .verdict-sentence')).toHaveText("Recovery is not measured yet: no checked off-site copy holds every backed-up type, and no recovery has been timed.");
  for (const card of ["freshness", "point", "time", "drills"]) {
    await expect(page.locator(`.resilience-${card} .pill`)).toHaveText("Not measured");
    await expect(page.locator(`.resilience-${card} .resilience-sentence`)).toContainText("Not measured");
  }
  await expect(page.locator(".resilience-freshness")).toContainText("Group has never been backed up successfully.");
});

// Task-100: the value report counts each request once, keeps hours next to their
// assumptions, shows no hours without an estimate, and fits a phone.
test("the value report adds up, shows hours only with an estimate, and withholds tenant-wide sections from a scoped reader", async ({ page }) => {
  await open(page, "/reports");
  await expect(page.locator('[data-layer="verdict"] .verdict-sentence')).toHaveText("1 of 5 put back and checked; 2 failed or changed again.");
  const summary = page.locator("table.value-summary");
  let total = 0;
  for (const row of await summary.locator("tbody tr").all()) {
    const cells = (await row.locator("td").allInnerTexts()).map(Number);
    expect(cells[0] + cells[1]).toBe(cells[2]);
    total += cells[2];
  }
  await expect(summary.locator(".value-total")).toHaveText(String(total));
  await expect(page.locator(".value-outcomes tr[data-state='reopened']")).toContainText("Changed again: a later backup shows it changed again");
  await expect(page.locator(".value-hours-list")).toContainText("1 checked restore × 90 minutes = 1.5 hours");
  await expect(page.locator(".value-assumptions")).toContainText("A manual restore of one group and its members takes about 90 minutes.");
  await expect(page.locator(".value-card-method")).toContainText("It is not a statement of compliance with any regulation or framework.");
  await expect(page.getByRole("link", { name: "Download spreadsheet (CSV)" })).toHaveAttribute("href", /format=csv/);

  await open(page, "/reports/scoped");
  await expect(page.locator(".value-scope")).toContainText("Showing only what FIN owns.");
  await expect(page.locator(".value-hours-list")).toHaveCount(0);
  await expect(page.locator(".value-card-hours")).toContainText("No time-saving estimate is set, so this report shows no hours saved.");
  expect(await textOutside(page, "main#main-content", '[data-layer="record"]')).not.toMatch(/\d+(\.\d+)?\s*hours/i);
  await expect(page.locator(".value-card-findings .value-sentence")).toContainText("shown only to people who can read all of it");

  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "/reports");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

// Task-94: each emergency account shows its five checks separately; "Not known" is its
// own state, checks KEEL cannot make stay listed, and a use leads the verdict.
test("emergency access shows each check, keeps unknown and unchecked visible, and leads with a use", async ({ page }) => {
  await open(page, "/readiness");
  await expect(page.locator(".verdict-headline")).toHaveText("An emergency account was used");
  await expect(page.locator(".readiness-account-0 .readiness-check")).toHaveCount(5);
  const second = page.locator(".readiness-account-1");
  await expect(second.locator(".item-card-head .pill")).toHaveText("Not ready");
  await expect(second.locator(".readiness-check-unknown")).toContainText("Not known");
  await expect(second.locator(".readiness-check-fail")).toContainText("Block legacy auth");
  await expect(second.locator(".readiness-check-due")).toContainText("a new test has been due since");
  await expect(page.locator(".readiness-alerts")).toContainText("was used 1 hour ago, and made 2 changes after it.");
  await expect(page.locator(".readiness-surface-unsupported")).toHaveCount(4);
  await expect(page.locator(".readiness-surface-unsupported").first()).toContainText("KEEL cannot check this");

  await open(page, "/readiness/ready");
  await expect(page.locator(".verdict-headline")).toHaveText("Ready");
  await expect(page.locator(".verdict-sentence")).toContainText("4 areas need a manual check");
  await expect(page.locator(".readiness-surface-unsupported")).toHaveCount(4);
});

// Polish pass 1: the recovery surfaces added by tasks 63–66 get their own
// baselines and a phone-width check that nothing scrolls sideways.
for (const theme of ["dark", "light"] as const) {
  test(`visual · job-restore-completion · ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open(page, "/jobs/r9", theme);
    await page.locator(".completion-resource").first().waitFor();
    await expect(page).toHaveScreenshot(`job-restore-completion-${theme}.png`, { fullPage: true });
  });
}

test("recovery surfaces fit a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "/jobs/r9", "light");
  await page.locator(".completion-resource").first().waitFor();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);

  await open(page, "/restore", "dark");
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "Undo change: Block legacy auth" }).click();
  await expect(page.getByText("Ready to send for approval")).toBeVisible({ timeout: 15_000 });
  expect(await overflow()).toBeLessThanOrEqual(0);
  // Stacked mechanism rows keep their column labels, and pills keep their own width.
  const cell = page.locator(".recovery-table td[data-label='How']").first();
  await expect(cell).toBeVisible();
  const pill = cell.locator(".pill");
  const [pillWidth, cellWidth] = await Promise.all([
    pill.evaluate((element) => element.getBoundingClientRect().width),
    cell.evaluate((element) => element.getBoundingClientRect().width),
  ]);
  expect(pillWidth).toBeLessThan(cellWidth * 0.9);
});

// Site permissions audit, gap 2: the site list and a site's page fit a phone, long
// names wrap, and a site's name opens its own page.
test("site permissions fit a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await open(page, "/sites", "dark");
  await expect(page.locator(".site-list .site-card")).toHaveCount(3);
  await expect(page.locator(".site-list")).toContainText("App access unknown · groups and roles not read yet");
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.getByRole("link", { name: "Finance" }).click();
  await expect(page.locator("main#main-content h1")).toHaveText("Finance");
  await expect(page.locator('[data-layer="verdict"]')).toContainText("2 apps have access to this site; 1 has full control.");
  await expect(page.getByText("Payroll connector")).toBeVisible();
  await expect(page.getByText("KEEL does not read this site's SharePoint groups or the roles given to people yet.", { exact: false })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
});

// Service setting changes sit in the Changes list beside the approved-setup changes, so
// grouping and filtering by service cover every service, not only Entra ID and Intune.
// They fit a phone, and their details point to the Alerts page instead of accept or undo.
test("the Changes list groups and filters every service, and service changes point to Alerts", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, "/drift/services", "dark");
  await expect(page.locator('[data-layer="verdict"]')).toContainText("5 service setting changes wait for review");
  const groups = page.locator(".sel-group-name");
  for (const service of ["Entra ID", "Exchange Online", "SharePoint and OneDrive", "Teams", "Purview", "Power Platform"]) {
    await expect(page.locator(".sel-group-head", { hasText: service }).first()).toBeVisible();
  }
  expect(await groups.count()).toBeGreaterThanOrEqual(6);
  await expect(page.getByText("have no approved setup yet, so Keel compares each read with the one before it")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

  await page.getByRole("link", { name: "Forward finance mail" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("Exchange mail flow or protection rule · changed");
  await expect(sheet).toContainText("Previous read → newest read");
  await expect(sheet).toContainText("1 setting changed since the previous read.");
  await expect(sheet.getByRole("link", { name: "Review on the Alerts page" })).toHaveAttribute("href", /alerts/);
  await expect(sheet.getByRole("button", { name: "Accept this change" })).toHaveCount(0);
});

// Portal experience contract, mechanical checks (roadmap task-129). They run on every
// harness route. A route not yet rebuilt to the contract may fail them only through
// this allowlist, which task-130 and task-131 empty; its size is asserted, so it can
// only shrink. Check 5 (display map) and the eyebrow check live in
// portal/test/experience-contract.test.ts; check 8 is the axe, screenshot and
// interaction suites in this file.
const BANNED_TERMS = [
  "natural key", "disposition", "fidelity", "qualification", "qualified", "live-qualified", "fixture-tested",
  "capability", "capabilities", "closure", "dependency-closed", "projection", "field class", "blast radius",
  "guard refusal", "wave", "verb", "artifact", "promotion", "enforce", "compensation", "observation", "descriptor",
  "adapter", "catalog type", "evidence chain", "anchor", "checkpoint", "kill switch", "tenant_ref", "CIR", "symbol",
  "lineage", "Postgres", "worker", "heartbeat", "fingerprint",
];
// Task-131 emptied it: every harness route now passes checks 1 to 7.
const CONTRACT_PENDING = new Set<string>([]);
const CONTRACT_PENDING_MAX = 0;

test("contract allowlist only shrinks and names real routes", () => {
  expect(CONTRACT_PENDING.size).toBeLessThanOrEqual(CONTRACT_PENDING_MAX);
  for (const name of CONTRACT_PENDING) expect(PAGES.some((entry) => entry.name === name), name).toBe(true);
});

// The ids each route's fixtures carry, which its records must keep (roadmap task-130).
const RECORD_IDS: Record<string, string[]> = {
  policy: ["7a1d0f3e-0000-4000-8000-000000000001", "3f9c2b1e-0000-4000-8000-000000000002"],
  policies: ["7a1d0f3e-0000-4000-8000-000000000001", "7a1d0f3e-0000-4000-8000-000000000003"],
  "policy-activation": ["9a0c0000-0000-4000-8000-000000000092", "7a1d0f3e-0000-4000-8000-000000000004", "d9200000-0000-4000-8000-000000000001", "d9200000-0000-4000-8000-000000000002", "group:Privileged approvers tenant-lockout over-ceiling", "6a000000-0000-4000-8000-000000000092", "0e900000-0000-4000-8000-000000000092", "e7a10000-0000-4000-8000-0000000000e1", "2e".repeat(32)],
  restore: ["a3"],
  drift: ["conditionalAccessPolicy:Block legacy auth", "group:Old project team", "dr6", "b1180000-0000-4000-8000-000000000118"],
  "drift-services": ["conditionalAccessPolicy:Block legacy auth", "d1a00000-0000-4000-8000-0000000000d1", "exchange-mail-flow:transport-rule:Forward finance mail"],
  approvals: ["a9e10000-0000-4000-8000-000000000100", "8c1e0000-0000-4000-8000-0000000000a1"],
  "baselines-new": ["0b5e0000-0000-4000-8000-0000000000d6"],
  baselines: ["b1180000-0000-4000-8000-000000000118", "b1170000-0000-4000-8000-000000000117", "b1160000-0000-4000-8000-000000000116", "0b5e0000-0000-4000-8000-0000000000c8"],
  benchmarks: ["e7a10000-0000-4000-8000-0000000000e1", "e7c10000-0000-4000-8000-0000000000c1", "d7100000-0000-4000-8000-0000000000d1", "d7100000-0000-4000-8000-0000000000d2", "7f3c0000-0000-4000-8000-000000000011", "0b5e0000-0000-4000-8000-0000000000d6", "/opt/backups/keel-recovery-manifest.json"],
  notifications: ["c4e10000-0000-4000-8000-0000000000c1", "c4e10000-0000-4000-8000-0000000000c2", "c4e10000-0000-4000-8000-0000000000c3", "d0e10000-0000-4000-8000-0000000000d1", "d0e10000-0000-4000-8000-0000000000d3"],
  integrations: ["de570000-0000-4000-8000-0000000000e1", "keel:decision:5e9c0000-0000-4000-8000-000000000097", "9d3f0000000040008000000000000097", "u_keel_gated_change", "u_gate_owner.email", "env:KEEL_SERVICENOW_TOKEN", "gate_passed", "gate_withdrawn", "HTTP 403"],
  "integrations-servicenow-off": ["states-rejected", "field-approver", "u_keel_gated_change"],
  protect: ["engine/restore/updatePath.test.mjs", "docs/release/qualification/ca-update.json", "0b5e0000-0000-4000-8000-0000000000d5", "authenticationMethodsPolicy", "Authorization_RequestDenied"],
  schedules: ["5c4e0000-0000-4000-8000-000000000001", "5c4e0000-0000-4000-8000-000000000005", "0 0 * * 1", "a11c0000-0000-4000-8000-0000000000a1", "throttle-heavy", "overlap (acknowledged)"],
  setup: ["5e7a" + "0b".repeat(30), "step-1a2b3c4d5e6f7a82", "plan-9f8e7d6c5b4a3921"],
  "setup-checked": ["5e7a" + "0c".repeat(30), "step-4a2b3c4d5e6f7a81", "plan-8e7d6c5b4a392110"],
  "emergency-changes": ["c1a70000-0000-4000-8000-000000000093", "c1a70000-0000-4000-8000-000000000094", "c1a70000-0000-4000-8000-000000000095", "9d".repeat(32), "conditionalAccessPolicy:Block legacy auth", "8c1e0000-0000-4000-8000-0000000000a2", "d9300000-0000-4000-8000-000000000001", "d9300000-0000-4000-8000-000000000002", "CHG0031337", "state: \"enabled\" -> \"enabledForReportingButNotEnforced\""],
  alerts: ["a1e70000-0000-4000-8000-000000000001", "conditionalAccessPolicy:Block legacy auth", "group:Finance"],
  activity: ["a4", "y1", "18205", "18200", "marouanedefili@gmail.com", "sam.ortiz@contoso.example", "Graph 429: throttled after 5 retries", "GET /api/evidence/verify"],
  "job-restore-completion": ["7f3c0000-0000-4000-8000-000000000011"],
  "job-restore-undo": ["7f3c0000-0000-4000-8000-000000000010"],
  resilience: ["18190", "18201", "type:group", "relationship:group/members", "b7c10000-0000-4000-8000-000000000074", "1c1d0000-0000-4000-8000-000000000071", "5a2be911-0000-4000-8000-000000000002", "5c4e0000-0000-4000-8000-000000000005", "/opt/backups/keel-recovery-manifest.json"],
  "resilience-unmeasured": ["type:conditionalAccessPolicy", "unmeasured"],
  reports: ["restore-plan:7f3c0000-0000-4000-8000-000000000100", "job:a1000000-0000-4000-8000-000000000002", "change:d1f70000-0000-4000-8000-000000000101", "keel.mfa.admins", "e7a10000-0000-4000-8000-000000000203", "4c".repeat(32), "9b".repeat(32), "/etc/keel/value-estimate.json"],
  "reports-scoped": ["restore-plan:7f3c0000-0000-4000-8000-000000000100", "EntityFIN", "not-configured"],
  ask: ["a5c00000-0000-4000-8000-000000000991", "c0110000-0000-4000-8000-000000000992", "group:Sales Admins", "conditionalAccessPolicy:Sales VPN", "not-compared-yet"],
  "ask-unknown": ["no-history", "2020-01-01T00:00:00.000Z"],
  compare: ["c0a10000-0000-4000-8000-000000000001", "c0a10000-0000-4000-8000-000000000002", "conditionalAccessPolicy:Block legacy auth", "mailbox:finance@contoso.com", "drive:b!Xc9", "3e".repeat(32)],
  "compare-tenants": ["sha256:5a1e00000000c0b2", "conditionalAccessPolicy:Require MFA for admins"],
  readiness: ["b9000000-0000-4000-8000-000000000001", "b9000000-0000-4000-8000-000000000002", "a1e70000-0000-4000-8000-000000000094", "conditionalAccessPolicy:Block legacy auth", "si-7f21", "au-9c10"],
  "readiness-ready": ["b9000000-0000-4000-8000-000000000002", "activation-rules-not-collected"],
  sites: ["c0110000-0000-4000-8000-0000000000c5"],
  site: ["contoso.sharepoint.com,5e170000-0000-4000-8000-000000000001,5e170000-0000-4000-8000-000000000002", "a9900000-0000-4000-8000-0000000000a1", "a9900000-0000-4000-8000-0000000000a2", "aTowaS50fG1zLnNwLmV4dGVybmFsfGFwcDE"],
};

async function textOutside(page: Page, root: string, excluded: string): Promise<string> {
  // Each text node on its own line, so adjacent blocks never run together.
  return page.locator(root).evaluate((element, skip) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement?.closest(skip)) parts.push(node.textContent ?? "");
    }
    return parts.join("\n");
  }, excluded);
}

function expectPlainText(visible: string) {
  // Each failure names the text that matched, so a leak is found without a debugger.
  const absent = (pattern: RegExp, label: string) => {
    const found = visible.match(pattern);
    expect(found?.[0] ?? null, `${label}: ${found ? JSON.stringify(visible.slice(Math.max(0, (found.index ?? 0) - 40), (found.index ?? 0) + 60)) : ""}`).toBeNull();
  };
  absent(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "identifier test: UUID");
  absent(/\b[0-9a-f]{32,}\b/i, "identifier test: hex");
  absent(/\b[a-z][A-Za-z]+:[A-Za-z0-9]/, "identifier test: resource key");
  // Enum codes (auto_remediate, require_approval, run_as_principal_id) are display-mapped.
  absent(/\b[a-z]+(?:_[a-z0-9]+)+\b/, "enum test: snake_case code");
  for (const term of BANNED_TERMS) {
    absent(new RegExp(`\\b${term.replace("-", "\\-")}s?\\b`, "i"), `vocabulary test: "${term}"`);
  }
}

for (const { name, hash } of PAGES) {
  test(`contract · ${name}`, async ({ page }) => {
    test.skip(CONTRACT_PENDING.has(name), "allowlisted until task-130/131 rebuilds this page");
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, hash, "dark");
    // 1. Glance test.
    await expect(page.locator("main#main-content h1")).toHaveCount(1);
    const verdict = page.locator('[data-layer="verdict"]');
    await expect(verdict).toHaveCount(1);
    await expect(verdict).toBeInViewport();
    const sentence = (await verdict.locator(".verdict-sentence").innerText()).trim();
    expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(25);
    expect(sentence).not.toMatch(/\d{7,}|[{}[\]"]/);
    // 6. Single primary action.
    expect(await verdict.locator("button.primary, a.primary").count()).toBeLessThanOrEqual(1);
    // 2 and 3. Identifiers and vocabulary stay in the record layer.
    expectPlainText(await textOutside(page, "main#main-content", '[data-layer="record"]'));
    // 4. Reference test: a rendered reference is a name, never an id.
    for (const text of await page.locator("main#main-content a[data-ref]").allTextContents()) {
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    }
    // 7. Record completeness: honesty is moved, not lost; every record field is labelled,
    // and the ids of the objects the page shows are all in the record layer.
    const records = page.locator('[data-layer="record"]');
    expect(await records.count()).toBeGreaterThan(0);
    const recordText = (await records.allTextContents()).join("\n");
    for (const id of RECORD_IDS[name] ?? []) expect(recordText, `record keeps ${id}`).toContain(id);
    for (const field of await records.locator(".technical-field").all()) {
      expect((await field.locator("dt").textContent())?.trim().length ?? 0).toBeGreaterThan(0);
      expect((await field.locator("dd").textContent())?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });
}

test("contract · shell: eight sections, plain words, the page's sub-pages under its section", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/", "dark");
  const entries = page.locator('aside.rail section[data-group="everything"] a.menu-link');
  await expect(entries).toHaveCount(8);
  expect(await Promise.all((await entries.all()).map((entry) => entry.locator(".menu-label").innerText())))
    .toEqual(["Dashboards", "Backup", "Restore", "Baselines", "Reports", "Automation center", "Audit log", "Settings"]);
  expectPlainText(await textOutside(page, "aside.rail", ".nope"));
  // A page a section absorbs is listed under that section in the menu, which is open
  // while you are in it; on a desktop the page carries no second row of tabs.
  for (const { hash, section, sub } of [
    { hash: "/schedules", section: "Backup", sub: "Schedules" },
    { hash: "/incidents", section: "Restore", sub: "Incidents" },
    { hash: "/principals", section: "Settings", sub: "People" },
    { hash: "/compare", section: "Baselines", sub: "Compare" },
  ]) {
    await open(page, hash, "dark");
    await expect(page.locator('aside.rail .menu-link[aria-current]')).toContainText(section);
    await expect(page.locator("aside.rail .menu-sublink[aria-current='page']")).toHaveText(sub);
    await expect(page.locator(".section-tabs")).toBeHidden();
    await expect(page.locator(".page-header .eyebrow")).toHaveCount(0);
  }
});

// Task-71: the incident view recommends the newest cleared snapshot, keeps the check
// form honest, keeps ids in Technical details, and fits a phone.
test("the incident view recommends the cleared snapshot, not the newest, and refuses exclusions on an unsafe result", async ({ page }) => {
  await open(page, "/incidents", "dark");
  await expect(page.locator('[data-layer="verdict"]')).toContainText("Restore from the snapshot of 30 Sept 2026, 06:00 UTC");
  const rows = page.locator("tr.incident-point");
  await expect(rows.nth(0)).toContainText("Unsafe");
  await expect(rows.nth(0)).not.toContainText("Recommended");
  await expect(rows.nth(1)).toContainText("Recommended");
  await expect(rows.nth(1)).toContainText("Being kept does not mean it is clean");
  await expect(rows.nth(1)).toContainText("Mail Sync Helper (enterprise app)");

  // The id is one click away, labelled, with a copy control.
  await rows.nth(1).locator("summary", { hasText: "Technical details" }).click();
  await expect(rows.nth(1).locator('[data-layer="record"]')).toContainText("Snapshot ID");
  await expect(rows.nth(1).locator('[data-layer="record"]')).toContainText("5a2be911-0000-4000-8000-000000000002");
  await expect(rows.nth(1).getByRole("button", { name: "Copy Snapshot ID" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(rows.nth(1).locator(".technical-body")).toBeHidden();

  await rows.nth(2).getByRole("button", { name: "Record a check" }).click();
  await page.getByLabel("Result").selectOption("compromised");
  await page.getByLabel("Why").fill("captured the backdoor");
  await page.getByLabel(/Malicious items to leave out/).fill("group:backdoor | attacker group");
  await page.getByRole("button", { name: "Save check" }).click();
  await expect(page.getByRole("alert")).toContainText("Leaving items out applies only to a clean one");

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator('[data-layer="verdict"]')).toBeInViewport();
});

// Task-70: undo of a failed restore — planned against the live tenant, reviewed,
// then sent for the normal approval. Never written from this page.
async function planUndo(page: Page) {
  await page.getByRole("button", { name: "Plan undo" }).click();
  await expect(page.getByText("Ready for approval")).toBeVisible({ timeout: 15_000 });
}

test("a failed restore's undo lists what will be undone, kept, and lost, then asks for approval", async ({ page }) => {
  await open(page, "/jobs/r10");
  await expect(page.getByRole("heading", { name: "Undo what this failed restore changed" })).toBeVisible();
  await planUndo(page);
  const undone = page.locator(".compensation-section").filter({ hasText: "WILL BE UNDONE" });
  await expect(undone.getByText("Revert description, visibility")).toBeVisible();
  await expect(undone.getByText("Delete the object this restore created")).toBeVisible();
  await expect(page.locator(".compensation-section").filter({ hasText: "NOT OVERWRITTEN" }).getByText("Require MFA for admins (Conditional Access policy)", { exact: true })).toBeVisible();
  await expect(page.locator(".compensation-section").filter({ hasText: "NOT OVERWRITTEN" })).toContainText("session controls changed after this restore, so KEEL will not overwrite the later change.");
  await expect(page.locator(".compensation-section").filter({ hasText: "CANNOT BE UNDONE" }).getByText("Contractors (group)", { exact: true })).toBeVisible();
  await expect(page.locator(".compensation-section").filter({ hasText: "NEEDS MANUAL REVIEW" })).toContainText("amara.okafor@contoso.example (user) as member of Finance (group)");
  await expect(page.locator(".compensation-statement")).toContainText("not atomic");
  // The planned undo speaks in words too; keys, raw reasons and ids stay in its record.
  expectPlainText(await textOutside(page, "main#main-content", '[data-layer="record"]'));
  const records = (await page.locator('.compensation-panel [data-layer="record"]').allTextContents()).join("\n");
  for (const kept of ["c0de0000-0000-4000-8000-000000000010", "7f3c0000-0000-4000-8000-000000000010", "group:Contractors",
    "concurrent-change: sessionControls changed after this restore wrote it", "group:Finance|member|user:amara.okafor@contoso.example"]) {
    expect(records, `record keeps ${kept}`).toContain(kept);
  }

  const request = page.getByRole("button", { name: "Request approval to undo" });
  await expect(request).toBeDisabled();
  await page.getByLabel("Why undo this restore?").fill("Wrong snapshot restored over Finance");
  await request.click();
  await expect(page.locator(".compensation-requested")).toHaveText("Sent to approvers. Nothing changes until one of them approves.");
});

for (const theme of ["dark", "light"] as const) {
  test(`a11y · job-restore-undo planned · ${theme}`, async ({ page }) => {
    await open(page, "/jobs/r10", theme);
    await planUndo(page);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const summary = results.violations.map((violation) => ({ rule: violation.id, targets: violation.nodes.slice(0, 5).map((node) => node.target.join(" ")) }));
    expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);
  });
}

test("the undo plan fits a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "/jobs/r10", "light");
  await planUndo(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

// Task-76: a setup step is done only when KEEL has seen it in the tenant, so the page
// offers no way to tick one off; continuing re-checks the tenant through the route.
test("setup shows the step waiting on the operator and continues through the guarded route", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/setup", "dark");
  const read = page.locator("section", { has: page.getByRole("heading", { name: "Read access for backups" }) });
  await expect(read.locator(".setup-step-waiting-for-you h3")).toHaveText('Give keel-collector the Intune role "Read Only Operator"');
  await expect(read.locator(".setup-step-waiting-for-you .pill")).toHaveText("Waiting for you");
  await expect(page.getByRole("button", { name: /mark|done|complete/i })).toHaveCount(0);
  await expect(page.getByText("KEEL cannot look at your tenant from this server yet")).toBeVisible();
  // The harness answers fetch in-page, so record the call where the page's reload keeps it.
  await page.evaluate(() => {
    const stub = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).endsWith("/api/actions/setup")) sessionStorage.setItem("setup-call", String(init?.body));
      return stub(input, init);
    };
  });
  await read.getByRole("button", { name: "Continue setup" }).click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("setup-call"))).not.toBeNull();
  expect(JSON.parse((await page.evaluate(() => sessionStorage.getItem("setup-call")))!)).toEqual({ resume: "5e7a" + "0b".repeat(30) });
});

// Task-76 production host: a grant broader than setup asks for is reported as found in
// the tenant, never as something KEEL fixed or will remove.
test("setup reports the restorer's extra grant as observed", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/setup/checked", "light");
  const restore = page.locator("section", { has: page.getByRole("heading", { name: "Write access for restores" }) });
  const consent = restore.locator(".setup-step", { has: page.getByRole("heading", { name: "Grant admin consent for keel-restorer" }) });
  await expect(consent.locator(".pill")).toHaveText("Done");
  await expect(consent).toContainText("The app also holds a permission this setup does not ask for: MailboxSettings.ReadWrite. KEEL reports it and does not remove it");
  await expect(page.getByText("KEEL cannot look at your tenant from this server yet")).toHaveCount(0);
  await expect(restore.locator(".setup-step-waiting-for-you h3")).toHaveText('Activate your "Privileged Role Administrator" role');
});

// The approved setup page: one card for the setup in use, a card per service with what
// is in line, changed or not covered, and the earlier setups. Fits a phone and a desktop.
for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`the approved setup sums up each service and fits ${viewport.width} px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await open(page, "/baselines", viewport.width < 600 ? "light" : "dark");
    await expect(page.locator(".status-pill")).toContainText("7 changes to review");
    const current = page.locator(".bl-current");
    await expect(current).toContainText("Post-migration golden state");
    await expect(current).toContainText("4,812 settings in 6 kinds");
    await expect(current.getByRole("link", { name: "Compare with the latest backup" })).toHaveAttribute("href", /compare\?from=0b5e0000-0000-4000-8000-0000000000c8&to=0b5e0000-0000-4000-8000-0000000000d6/);
    const entra = page.locator(".bl-service", { hasText: "Entra ID" });
    await expect(entra).toContainText(/Changed\s*3\s*kinds/);
    // A service with changes links to them, filtered to that service.
    await expect(entra).toHaveAttribute("href", /drift\?service=/);
    await entra.click();
    await expect(page).toHaveURL(/drift\?service=/);
    await expect(page.locator(".sel-row")).toHaveCount(6);
    await page.goBack();
    await page.locator(".bl-current").waitFor();
    // Service cards in one row are the same height; nothing scrolls sideways.
    const heights = await page.locator(".bl-service").evaluateAll((cards) => cards.map((card) => { const rect = card.getBoundingClientRect(); return { y: Math.round(rect.y), h: Math.round(rect.height) }; }));
    for (const card of heights) for (const other of heights) if (card.y === other.y) expect(card.h).toBe(other.h);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    // A replaced setup offers no actions.
    await expect(page.locator(".bl-version", { hasText: "Replaced by a newer version" }).getByRole("button")).toHaveCount(0);
    await expect(page.locator(".bl-version", { hasText: "Before migration (v2)" }).getByRole("button", { name: "Use this one" })).toBeVisible();
  });
}

// The guided create: start from a backup, name it, check what happens, then create.
test("a new approved setup is made in three steps that say what will happen", async ({ page }) => {
  await open(page, "/baselines/new");
  const wizard = page.locator(".bl-wizard");
  await expect(wizard.locator(".bl-steps li[aria-current='step']")).toContainText("Start from");
  await wizard.getByRole("radio", { name: /An earlier backup/ }).click();
  await wizard.getByRole("button", { name: "Next" }).click();
  await expect(wizard.getByRole("alert")).toHaveText("Choose the backup to start from.");
  await wizard.getByRole("button", { name: /^Backup/ }).click();
  await page.getByRole("option", { name: /1 Oct 2026/ }).click();
  await wizard.getByRole("button", { name: "Next" }).click();
  await expect(wizard.locator(".bl-steps li[aria-current='step']")).toContainText("Name it");
  await wizard.getByRole("button", { name: "Next" }).click();
  await expect(wizard.getByRole("alert")).toContainText("Give it a name");
  await wizard.getByPlaceholder("e.g. After the October audit").fill("After the October audit");
  await wizard.getByRole("button", { name: "Next" }).click();
  const review = wizard.locator(".bl-review");
  await expect(review).toContainText("4,838 settings from the backup of 1 Oct 2026, 09:11 UTC");
  await expect(review).toContainText("Nothing changes. Keel only reads its own backup.");
  await wizard.getByRole("button", { name: "Create approved setup" }).click();
  await expect(page.locator(".bl-wizard-done")).toContainText("“After the October audit” is being created");
  expectPlainText(await textOutside(page, "main#main-content", '[data-layer="record"]'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

// Rule 12, "everything clicks": on every Baselines page, whatever looks clickable is a
// link or a button, and each one shows a focus ring from the keyboard.
for (const hash of ["/baselines", "/drift", "/baselines/new", "/compare"]) {
  test(`everything that looks clickable on ${hash} is a link or a button`, async ({ page }) => {
    await open(page, hash);
    const fakes = await page.locator("main#main-content").evaluate((main) => [...main.querySelectorAll<HTMLElement>("*")]
      .filter((element) => getComputedStyle(element).cursor === "pointer")
      .filter((element) => !element.closest("a[href], button, label, summary, input, select, [role='button'], [role='radio'], [role='checkbox'], [role='option']"))
      .map((element) => element.className || element.tagName));
    expect(fakes).toEqual([]);
    const controls = page.locator("main#main-content .bl-card :is(a[href], button:not([disabled])):visible");
    const count = await controls.count();
    for (let index = 0; index < Math.min(count, 6); index += 1) {
      await controls.nth(index).focus();
      const ring = await controls.nth(index).evaluate((element) => { const style = getComputedStyle(element); return style.boxShadow !== "none" || style.outlineStyle !== "none"; });
      expect(ring, `focus ring on control ${index}`).toBe(true);
    }
  });
}

// Task-92: an automatic policy that is off shows what turning it on would do, names the
// dependency above its limit, and a refused turn-on says what changed since the preview.
test("policy activation preview names dependencies above the limit and refuses a stale preview", async ({ page }) => {
  await open(page, "/policies/p2");
  const preview = page.locator("section.policy-preview");
  await expect(preview.locator(".policy-preview-sentence")).toHaveText("Ready to turn on. It would undo 2 changes now; Keel will refuse 1 that depends on something above its limit.");
  await expect(preview.locator(".policy-dependencies li")).toHaveText("Privileged approvers (group), needed by Finance (group). Impact: could lock out admins. Above its limit, so Keel will refuse these undos.");
  await expect(preview).toContainText("1 waiting to run, not yet undone");
  await expect(preview).not.toContainText("1 undone");
  // With a preview ready, "Turn on" is the one amber action; a plain Turn on never shows for an undo rule.
  await expect(page.locator("main .btn-primary:visible")).toHaveText("Turn on");
  await page.getByRole("button", { name: "Turn on" }).click();
  const toast = page.locator(".toast").first();
  await expect(toast).toContainText("Not turned on");
  await expect(toast).toContainText("The account's access changed since the preview. Preview again.");
  await expect(preview).toHaveCount(0);
  // Without a preview, "Preview turning on" is the one amber action.
  await expect(page.locator("main .btn-primary:visible")).toHaveText("Preview turning on");
  await expect(page.getByRole("button", { name: "Turn on" })).toHaveCount(0);
  await page.getByRole("button", { name: "Preview turning on" }).click();
  await expect(page.locator("section.policy-preview .policy-preview-sentence")).toBeVisible();
  expectPlainText(await textOutside(page, "main#main-content", '[data-layer="record"]'));
});

// The page's done-test (portal audit, Policies, one design): the status pill and verdict
// name the paused rule, Resume is the one amber action, the tiles are links that set a
// filter, the rules are grouped by what they do, names link to the rule's page, a
// selection turns rules off through the guarded route after a confirm, and New rule
// creates an undo rule switched off and lands on its page.
test("Policies · tiles, groups, Resume, bulk turn off, New rule", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, "/policies");
  await expect(page.locator("main#main-content h1")).toHaveText("Automatic rules");
  await expect(page.locator(".status-pill")).toHaveText("1 stopped");
  await expect(page.locator('[data-layer="verdict"] .verdict-sentence')).toHaveText("Undo mail flow changes is stopped: the account it acts as needs repair.");
  const tiles = page.locator(".po-tile");
  await expect(tiles).toHaveCount(4);
  await expect(tiles.filter({ hasText: "Running" })).toContainText("2");
  await expect(tiles.filter({ hasText: "Paused or stopped" })).toContainText("1 hit its limit, 1 needs repair");
  await expect(tiles.filter({ hasText: "Actions this week" })).toContainText("24");
  for (const tile of await tiles.all()) expect(await tile.getAttribute("href")).toMatch(/\/policies/);
  // Grouped by what the rule does, undo first; every name links to the rule's page.
  const groups = page.locator(".sel-group .sel-group-name b");
  await expect(groups).toHaveText(["Undo automatically", "Ask for approval", "Alert only"]);
  await expect(page.locator(".sel-group").first()).toContainText("3 rules");
  for (const link of await page.locator(".po-row-link").all()) expect(await link.getAttribute("href")).toMatch(/#\/policies\/[^/]+$/);
  const rows = page.locator(".sel-row");
  await expect(rows).toHaveCount(5);
  await expect(rows.filter({ hasText: "Undo low-risk changes" })).toContainText("Last undid Branch offices 2 hours ago");
  await expect(rows.filter({ hasText: "Undo low-risk changes" })).toContainText("Policy service account");
  await expect(rows.filter({ hasText: "Undo mail flow changes" }).locator(".badge")).toHaveText("Stopped: account needs repair");
  await expect(rows.filter({ hasText: "Undo changes to admin groups" }).getByRole("link", { name: "Preview turning on" })).toBeVisible();
  await expect(rows.filter({ hasText: "Undo changes to admin groups" }).getByRole("button", { name: "Turn on" })).toHaveCount(0);
  await expect(rows.filter({ hasText: "Alert on changes" }).getByRole("link", { name: "Open alerts" })).toHaveAttribute("href", /alerts/);
  // One amber action at most on the page: here none, since the stopped rule needs People, not Resume.
  expect(await page.locator("main .btn-primary:visible").count()).toBeLessThanOrEqual(1);
  expectPlainText(await textOutside(page, "main#main-content", '[data-layer="record"]'));

  // The Paused or stopped tile sets the filter in the address; Resume is amber there.
  await tiles.filter({ hasText: "Paused or stopped" }).click();
  await expect(page).toHaveURL(/state=paused/);
  await expect(page.locator(".sel-row")).toHaveCount(2);
  await expect(page.locator(".po-filter-note")).toContainText("Showing paused or stopped rules only: 2 of 5.");
  await page.getByRole("link", { name: "Show everything" }).click();
  await expect(page).not.toHaveURL(/state=/);
  await expect(page.locator(".sel-row")).toHaveCount(5);

  // Shift+click selects a range; "Turn off 2 rules" says what happens, confirms, then posts once per rule.
  type Call = { url: string; method: string; body: string | null };
  const calls = () => page.evaluate(() => (window as unknown as { __harnessCalls: Call[] }).__harnessCalls);
  await rows.nth(0).locator(".sel-check").click();
  await rows.nth(1).click({ modifiers: ["Shift"] });
  await expect(page.locator(".sel-bar-count")).toContainText("2 rules");
  await expect(page.locator(".sel-bar")).toContainText("They stop acting on new changes. 2 undo rules need a preview to turn back on.");
  await page.locator(".sel-bar .btn-primary", { hasText: "Turn off 2 rules" }).click();
  await expect(page.locator(".toast").first()).toContainText("2 rules turned off");
  const posts = (await calls()).filter((call) => call.method === "POST" && call.url.endsWith("/enabled"));
  expect(posts.map((call) => call.url)).toEqual(["/api/policies/7a1d0f3e-0000-4000-8000-000000000001/enabled", "/api/policies/7a1d0f3e-0000-4000-8000-000000000006/enabled"]);
  for (const call of posts) expect(JSON.parse(call.body ?? "{}")).toEqual({ enabled: false });

  // New rule: an undo rule is created off and lands on its page with "Preview turning on".
  await page.getByRole("link", { name: "New rule" }).click();
  const sheet = page.getByRole("dialog", { name: "New rule" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("radio", { name: "Undo automatically" }).click();
  await expect(sheet).toContainText("Created off. Keel shows what it would undo before you turn it on.");
  await sheet.getByRole("button", { name: /^Account/ }).click();
  await page.locator(".option-panel [role='option']", { hasText: "Marouane Defili" }).click();
  await sheet.getByLabel("Name", { exact: true }).fill("Undo changes to admin groups");
  await expect(sheet.locator(".po-check")).toContainText("Undoes changes to anything.");
  await sheet.getByRole("button", { name: "Create rule" }).click();
  const created = (await calls()).filter((call) => call.method === "POST" && call.url === "/api/policies");
  expect(created.length).toBe(1);
  expect(JSON.parse(created[0].body ?? "{}")).toMatchObject({ name: "Undo changes to admin groups", action: "auto_remediate", maxBlastRadius: "cosmetic", runAsPrincipalId: "8c1e0000-0000-4000-8000-0000000000a1" });
  await expect(page).toHaveURL(/#\/policies\/p2$/);
  await expect(page.locator("main#main-content h1")).toHaveText("Undo changes to admin groups");
  // Its page opens on the preview step (the harness shows p2 with a preview already made).
  await expect(page.locator(".po-activation h2")).toHaveText("Before it turns on");
  await expect(page.locator("main .btn-primary:visible")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Preview turning on|Preview again/ })).toBeVisible();
});

test("Policies · a rule's page: the sentence once, actions open their jobs, Resume or Turn off as the controls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, "/policies/p1");
  await expect(page.locator(".status-pill")).toHaveText("Running");
  await expect(page.locator('[data-layer="verdict"] .verdict-sentence')).toHaveText("Undoes low-risk changes to anything, up to 50 an hour.");
  await expect(page.locator(".po-chip")).toHaveText(["Anything", "Changed", "Low risk"]);
  await expect(page.locator(".po-person-link")).toContainText("Policy service account");
  expect(await page.locator(".po-person-link").getAttribute("href")).toMatch(/principals/);
  const actions = page.locator(".po-action");
  await expect(actions).toHaveCount(3);
  await expect(actions.nth(0).locator(".badge")).toHaveText("Waiting");
  await expect(actions.nth(1)).toContainText("Branch offices");
  await expect(actions.nth(1).locator(".badge")).toHaveText("Undone");
  await expect(actions.nth(2).locator(".badge")).toHaveText("Failed");
  for (const link of await actions.locator(".po-row-link").all()) expect(await link.getAttribute("href")).toMatch(/#\/jobs\/[^/]+$/);
  await expect(page.locator("main .btn-primary:visible")).toHaveCount(0);
  await page.getByRole("button", { name: "Turn off" }).click();
  await expect(page.locator("dialog[open]")).toContainText("Undo low-risk changes stops acting on new changes. It needs a preview to turn back on.");
  await page.locator("dialog[open]").getByRole("button", { name: "Cancel" }).click();
  expectPlainText(await textOutside(page, "main#main-content", '[data-layer="record"]'));
  // A paused rule: Resume is the one amber action, and it posts to clear-pause.
  await open(page, "/policies/p3");
  await expect(page.locator(".status-pill")).toHaveText("Paused");
  const amber = page.locator("main .btn-primary:visible");
  await expect(amber).toHaveText("Resume");
  await amber.click();
  await expect(page.locator(".toast").first()).toContainText("Ask before changing sign-in rules resumed");
  type Call = { url: string; method: string };
  const posts = await page.evaluate(() => (window as unknown as { __harnessCalls: Call[] }).__harnessCalls.filter((call) => call.method === "POST").map((call) => call.url));
  expect(posts).toContain("/api/policies/7a1d0f3e-0000-4000-8000-000000000005/clear-pause");
});

test("Policies · a viewer sees the rules and no controls", async ({ page }) => {
  await open(page, "/policies/viewer");
  await expect(page.locator(".po-tile")).toHaveCount(4);
  await expect(page.locator("main .btn-primary:visible")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Turn off|Resume|Turn on/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "New rule" })).toHaveCount(0);
  await expect(page.locator(".sel-row")).toHaveCount(5);
});

for (const theme of ["dark", "light"] as const) {
  for (const width of [390, 1440]) {
    for (const hash of ["/policies", "/policies?group=state", "/policies/p1", "/policies/p2"]) {
      test(`Policies · ${width} · ${theme} · ${hash}: no sideways scroll or clipped text, equal tiles`, async ({ page }) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        await open(page, hash, theme);
        await expect(page.locator('[data-layer="verdict"]')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
        const clipped = await page.locator("main#main-content").evaluate((main) => [...main.querySelectorAll<HTMLElement>(".po-page *, .page-header *")]
          .filter((element) => element.children.length === 0 && element.clientWidth > 1 && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflow !== "visible" && getComputedStyle(element).textOverflow !== "ellipsis")
          .map((element) => element.textContent));
        expect(clipped).toEqual([]);
        if (hash.startsWith("/policies?") || hash === "/policies") {
          const tiles = await page.locator(".po-tile").evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height)));
          expect(tiles.length).toBe(4);
          expect(new Set(tiles).size).toBe(1);
        }
        // Rule 12: everything styled as clickable is a link with a target or a button.
        const dead = await page.locator("main#main-content").evaluate((main) => [...main.querySelectorAll<HTMLElement>("a, .btn, .po-tile, .po-row-link")]
          .filter((element) => (element.tagName === "A" && !(element as HTMLAnchorElement).getAttribute("href")) || (element.tagName !== "A" && element.tagName !== "BUTTON" && !element.closest("a, button")))
          .map((element) => element.outerHTML.slice(0, 80)));
        expect(dead).toEqual([]);
        expect(await page.locator("main .btn-primary:visible").count()).toBeLessThanOrEqual(1);
        if (width === 390 && hash === "/policies") {
          // The New rule sheet fits a phone with its action in view.
          await page.getByRole("link", { name: "New rule" }).click();
          const sheet = page.getByRole("dialog", { name: "New rule" });
          await expect(sheet).toBeVisible();
          await expect(sheet.getByRole("button", { name: "Create rule" })).toBeInViewport();
          expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
          await page.keyboard.press("Escape");
          await expect(sheet).toBeHidden();
        }
        if (width === 1440 && hash === "/policies") {
          await page.getByRole("button", { name: /Select all 5 rules/ }).click();
          await expect(page.locator(".sel-bar-count")).toContainText("5 rules");
          await expect(page.locator(".sel-bar .btn-primary")).toHaveText("Turn off 5 rules");
          await expect(page.locator(".sel-bar")).toContainText("1 is already off and stays as it is.");
        }
      });
    }
  }
}

test("People · tiles, groups, Add person, Add Viewer to several, the last admin, Keel's accounts", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, "/principals");
  await expect(page.locator("main#main-content h1")).toHaveText("People");
  await expect(page.locator(".status-pill")).toHaveText("Only 1 admin");
  await expect(page.locator('[data-layer="verdict"] .verdict-sentence')).toHaveText("4 people can use Keel; 2 can approve.");
  const tiles = page.locator(".pe-tile");
  await expect(tiles).toHaveCount(4);
  for (const tile of await tiles.all()) expect(await tile.getAttribute("href")).toMatch(/\/principals/);
  await expect(page.locator(".sel-group .sel-group-name b")).toHaveText(["Admins", "Approvers", "Operators", "Starting later", "Disabled"]);
  const rows = page.locator(".sel-row");
  await expect(rows).toHaveCount(6);
  for (const link of await page.locator(".pe-row-link").all()) expect(await link.getAttribute("href")).toMatch(/open=/);
  // A sentence about someone else never says "You".
  for (const line of await page.locator(".pe-row-can").allTextContents()) expect(line).not.toMatch(/^You\b/);
  await expect(rows.filter({ hasText: "Lee Chen" })).toContainText("Operator, only for Contoso FR");
  await expect(rows.filter({ hasText: "Former Contractor" }).locator(".badge")).toHaveText("Disabled");
  expect(await page.locator("main .btn-primary:visible").count()).toBeLessThanOrEqual(1);
  expectPlainText(await textOutside(page, "main#main-content", '[data-layer="record"]'));

  // Keel's own accounts: listed apart, with no controls.
  const keel = page.locator(".pe-keel-row");
  await expect(keel).toHaveText(/Keel's scheduler/);
  await expect(keel.locator("a, button, input")).toHaveCount(0);

  // The Can approve tile sets ?role=approver and shows only approvers.
  await tiles.filter({ hasText: "Can approve" }).click();
  await expect(page).toHaveURL(/role=approver/);
  await expect(page.locator(".sel-row")).toHaveCount(2);
  await expect(page.locator(".pe-filter-note")).toContainText("Showing approvers only: 2 of 6.");
  await page.getByRole("link", { name: "Show everyone" }).click();
  await expect(page.locator(".sel-row")).toHaveCount(6);

  // Shift+click a range of 3, then "Add Viewer to 3 people" posts a grant per person who lacks it.
  type Call = { url: string; method: string; body: string | null };
  const calls = () => page.evaluate(() => (window as unknown as { __harnessCalls: Call[] }).__harnessCalls);
  await rows.nth(0).locator(".sel-check").click();
  await rows.nth(2).click({ modifiers: ["Shift"] });
  await expect(page.locator(".sel-bar-count")).toContainText("3 people");
  await expect(page.locator(".sel-bar .btn-primary")).toHaveText("Add Viewer to 3 people");
  await expect(page.locator(".sel-bar")).toContainText("From now on they can see backups, changes and reports.");
  await page.locator(".sel-bar .btn-primary").click();
  await expect(page.locator(".toast").first()).toContainText("Viewer added: 3 people");
  const grants = (await calls()).filter((call) => call.method === "POST" && call.url.endsWith("/grant"));
  expect(grants.length).toBe(3);
  for (const call of grants) expect(JSON.parse(call.body ?? "{}")).toEqual({ role: "viewer" });
  await page.keyboard.press("Escape");

  // The last admin: Disable and the admin role's Remove are off, with the reason shown before any click.
  await page.locator(".pe-row-link", { hasText: "Marouane Defili" }).click();
  const panel = page.getByRole("dialog", { name: "Marouane Defili" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Disable" })).toBeDisabled();
  await expect(panel.locator(".pe-grant", { hasText: "Admin" }).getByRole("button", { name: "Remove" })).toBeDisabled();
  await expect(panel.locator(".pe-grant", { hasText: "Admin" })).toContainText("Keel keeps at least one admin. Make someone else an admin first.");
  await expect(panel.locator(".pe-grant", { hasText: "Approver" }).getByRole("button", { name: "Remove" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  // Someone else: a role starting later can be cancelled; Disable confirms first.
  await page.locator(".pe-row-link", { hasText: "Sam Ortiz" }).click();
  const sam = page.getByRole("dialog", { name: "Sam Ortiz" });
  await expect(sam.locator(".pe-grant", { hasText: "Restorer" })).toContainText("From 6 Oct 2026 until 20 Oct 2026 · granted by Marouane Defili");
  await expect(sam.locator(".pe-grant", { hasText: "Restorer" }).getByRole("button", { name: "Cancel" })).toBeVisible();
  await sam.getByRole("button", { name: "Disable" }).click();
  await expect(page.locator("dialog[open]")).toContainText("Sam Ortiz can no longer sign in to Keel.");
  await page.locator("dialog[open]").getByRole("button", { name: "Keep access" }).click();
  await page.keyboard.press("Escape");

  // A disabled person: Enable again is the one amber action in their panel, and posts to enable.
  await page.locator(".pe-row-link", { hasText: "Former Contractor" }).click();
  const former = page.getByRole("dialog", { name: "Former Contractor" });
  await former.getByRole("button", { name: "Enable again" }).click();
  await expect(page.locator(".toast", { hasText: "Former Contractor can use Keel again" })).toBeVisible();
  expect((await calls()).some((call) => call.method === "POST" && call.url === "/api/principals/8c1e0000-0000-4000-8000-0000000000c3/enable")).toBe(true);
  await page.keyboard.press("Escape");

  // Add person posts {email, displayName, role} and the new row appears.
  await page.getByRole("link", { name: "Add person" }).click();
  const sheet = page.getByRole("dialog", { name: "Add person" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("They can sign in once your sign-in gate lets their email through.");
  await sheet.getByLabel("Email").fill("jo.martin@contoso.example");
  await sheet.getByLabel("Name (optional)").fill("Jo Martin");
  await sheet.getByRole("button", { name: /^Role/ }).click();
  await page.locator(".option-panel [role='option']", { hasText: "Approver" }).click();
  await sheet.getByRole("button", { name: "Add person" }).click();
  const created = (await calls()).filter((call) => call.method === "POST" && call.url === "/api/principals");
  expect(created.length).toBe(1);
  expect(JSON.parse(created[0].body ?? "{}")).toMatchObject({ email: "jo.martin@contoso.example", displayName: "Jo Martin", role: "approver" });
  await expect(sheet).toBeHidden();
  await expect(page.locator(".sel-row", { hasText: "Jo Martin" })).toBeVisible();
});

test("People · someone who may disable but not grant sees no role controls", async ({ page }) => {
  await open(page, "/principals/viewer");
  await expect(page.getByRole("link", { name: "Add person" })).toHaveCount(0);
  await page.locator(".pe-row-link", { hasText: "Amara Okafor" }).click();
  const panel = page.getByRole("dialog", { name: "Amara Okafor" });
  await expect(panel.getByRole("button", { name: "Disable" })).toBeVisible();
  await expect(panel.getByRole("button", { name: /Remove|Add role/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Without the roles permission the bulk action is Disable, never a grant.
  await page.locator(".sel-row").nth(1).locator(".sel-check").click();
  await expect(page.locator(".sel-bar .btn-primary")).toHaveText("Disable 1 person");
});

for (const theme of ["dark", "light"] as const) {
  for (const width of [390, 1440]) {
    for (const hash of ["/principals", "/principals?group=state", "/principals?open=8c1e0000-0000-4000-8000-0000000000b3", "/principals?new=1"]) {
      test(`People · ${width} · ${theme} · ${hash}: no sideways scroll or clipped text, equal tiles`, async ({ page }) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        await open(page, hash, theme);
        await expect(page.locator('[data-layer="verdict"]')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
        const clipped = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".pe-page *, .page-header *, .bl-sheet *")]
          .filter((element) => element.children.length === 0 && element.clientWidth > 1 && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflow !== "visible" && getComputedStyle(element).textOverflow !== "ellipsis")
          .map((element) => element.textContent));
        expect(clipped).toEqual([]);
        const tiles = await page.locator(".pe-tile").evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height)));
        expect(tiles.length).toBe(4);
        expect(new Set(tiles).size).toBe(1);
        // Rule 12: everything styled as clickable is a link with a target or a button.
        const dead = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main a, main .btn, .pe-tile, .pe-row-link, .bl-sheet a, .bl-sheet .btn")]
          .filter((element) => (element.tagName === "A" && !(element as HTMLAnchorElement).getAttribute("href")) || (element.tagName !== "A" && element.tagName !== "BUTTON" && !element.closest("a, button")))
          .map((element) => element.outerHTML.slice(0, 80)));
        expect(dead).toEqual([]);
        expect(await page.locator("main .btn-primary:visible").count()).toBeLessThanOrEqual(1);
        if (hash.includes("open=") || hash.includes("new=")) {
          const sheet = page.getByRole("dialog");
          await expect(sheet).toBeVisible();
          await expect(sheet.locator(".bl-sheet-foot .btn-primary")).toBeInViewport();
          await expect(sheet.locator(".bl-sheet-foot .btn-primary")).toHaveCount(1);
        }
      });
    }
  }
}

test("Compliance · tiles filter, a control opens its panel, renew an exception, export evidence", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, "/benchmarks");
  await expect(page.locator("main#main-content h1")).toHaveText("Compliance");
  await expect(page.locator(".status-pill")).toHaveText("1 failing");
  await expect(page.locator('[data-layer="verdict"] .verdict-sentence')).toHaveText("1 control fails, and its exception ended 2 days ago.");
  await expect(page.locator(".cp-context")).toContainText("Measured against Post-migration golden state");
  const tiles = page.locator(".cp-tile");
  await expect(tiles).toHaveCount(4);
  await expect(page.locator(".sel-group .sel-group-name b")).toHaveText(["Entra ID"]);
  const rows = page.locator(".sel-row");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("No more than 5 people hold the top admin role");
  await expect(rows.nth(0)).toContainText("Exception ended 2 days ago");
  await expect(rows.filter({ hasText: "No trusted location" })).toContainText("Owner Amara Okafor");
  await expect(rows.filter({ hasText: "Groups that grant admin roles" })).toContainText("The newest group backup is too old for this check");
  // The phone scorecard is hidden at desktop width.
  await expect(page.locator(".cp-by-service")).toBeHidden();
  expect(await page.locator("main .btn-primary:visible").count()).toBe(1);
  const visible = await textOutside(page, "main#main-content", '[data-layer="record"]');
  expectPlainText(visible);
  for (const word of ["secops@", "@contoso", "westeurope", "KEEL", "Baseline", "Conditional Access", "Named location"]) expect(visible).not.toContain(word);

  // (1) The Failing tile sets result=failing and shows only the failing control.
  await tiles.filter({ hasText: "Failing" }).click();
  await expect(page).toHaveURL(/result=failing/);
  await expect(page.locator(".sel-row")).toHaveCount(1);
  await expect(page.locator(".cp-filter-note")).toContainText("Showing failing only: 1 of 4.");
  await page.getByRole("link", { name: "Show every control" }).click();
  await expect(page.locator(".sel-row")).toHaveCount(4);

  // (2) A control's name opens its panel with open=<evaluationId>; Esc closes it and focus returns.
  const name = page.locator(".cp-row-link", { hasText: "No more than 5 people hold the top admin role" });
  await name.click();
  await expect(page).toHaveURL(/open=e7a10000-0000-4000-8000-0000000000e1/);
  const panel = page.getByRole("dialog", { name: "No more than 5 people hold the top admin role" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Every extra top admin is one more account");
  await expect(panel.locator(".cp-block", { hasText: "Exception" })).toContainText("Two break-glass accounts during the migration");
  await expect(panel.locator(".cp-block", { hasText: "Exception" })).toContainText("granted by Marouane Defili");
  // (4) A linked change links to the Changes page, opened on that change.
  expect(await panel.getByRole("link", { name: /Global Administrator · Adele added/ }).getAttribute("href")).toMatch(/\/drift\?open=d7100000-0000-4000-8000-0000000000d1/);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(name).toBeFocused();

  // (3) Renew: the sheet asks for an owner, a reason and a future date, posts, and toasts.
  type Call = { url: string; method: string; body: string | null };
  const calls = () => page.evaluate(() => (window as unknown as { __harnessCalls: Call[] }).__harnessCalls);
  await page.locator('[data-layer="verdict"]').getByRole("link", { name: "Renew the exception" }).click();
  const sheet = page.getByRole("dialog", { name: "Renew the exception" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("The control still fails; it stops counting as failing until the date you pick.");
  await expect(sheet.getByLabel("Or pick a date")).toHaveAttribute("min", "2026-10-03");
  await sheet.getByLabel(/Reason/).fill("");
  await sheet.getByRole("button", { name: /^Renew until/ }).click();
  await expect(sheet.locator(".cp-error")).toHaveText("Say why the control may fail for now.");
  await sheet.getByRole("button", { name: /^Owner/ }).click();
  await page.locator(".option-panel [role='option']", { hasText: "Amara Okafor" }).click();
  await sheet.getByLabel(/Reason/).fill("Emergency accounts stay until the November cut-over.");
  await sheet.getByRole("button", { name: /^30 days/ }).click();
  await sheet.getByRole("button", { name: "Renew until 1 Nov 2026" }).click();
  await expect(page.locator(".toast").first()).toContainText("Exception saved until 1 Nov 2026");
  const posts = (await calls()).filter((call) => call.method === "POST" && call.url === "/api/actions/compliance/exception");
  expect(posts.length).toBe(1);
  expect(JSON.parse(posts[0].body ?? "{}")).toEqual({ evaluationId: "e7a10000-0000-4000-8000-0000000000e1", owner: "amara.okafor@contoso.example", reason: "Emergency accounts stay until the November cut-over.", expiresAt: "2026-11-01T23:59:59.000Z" });
  await expect(sheet).toBeHidden();
  // Back on the control's panel, which now shows the exception in force.
  await expect(panel.locator(".cp-block", { hasText: "Exception" })).toContainText("Until 1 Nov 2026");
  await page.keyboard.press("Escape");
  await expect(page.locator(".sel-row", { hasText: "No more than 5 people" })).toContainText("Accepted until 1 Nov 2026");
  await expect(page.locator(".sel-row", { hasText: "No more than 5 people" })).toContainText("Owner Amara Okafor");

  // (6) Export evidence reads both kinds and downloads JSON.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export evidence" }).click();
  expect((await download).suggestedFilename()).toMatch(/^keel-compliance-evidence-.*\.json$/);
  expect((await calls()).some((call) => call.url.startsWith("/api/evidence?kind=benchmark-evaluation,benchmark-exception"))).toBe(true);
});

test("Compliance · a reader sees results and no exception controls", async ({ page }) => {
  await open(page, "/benchmarks/viewer");
  await expect(page.locator(".sel-row")).toHaveCount(4);
  await expect(page.getByRole("link", { name: /^(Grant|Renew|Extend)/ })).toHaveCount(0);
  await expect(page.locator("main .btn-primary")).toHaveCount(0);
  await page.locator(".sel-row").nth(0).locator(".sel-check").click();
  await expect(page.locator(".sel-bar .btn-primary")).toHaveText("Export 1 control");
});

test("Compliance · phone: pass and fail tiles per service open the same panel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "/benchmarks");
  const card = page.locator(".cp-by-service .cp-service");
  await expect(card).toHaveCount(1);
  await expect(card.locator(".cp-service-head")).toContainText("Entra ID");
  await expect(card.locator(".cp-ctile")).toHaveCount(4);
  await card.locator(".cp-ctile", { hasText: "At most 5 top admins" }).click();
  await expect(page.getByRole("dialog", { name: "No more than 5 people hold the top admin role" })).toBeVisible();
});

for (const theme of ["dark", "light"] as const) {
  for (const width of [390, 1440]) {
    for (const hash of ["/benchmarks", "/benchmarks?group=result", "/benchmarks?open=e7a10000-0000-4000-8000-0000000000e1", "/benchmarks?open=e7a10000-0000-4000-8000-0000000000e1&grant=e7a10000-0000-4000-8000-0000000000e1"]) {
      test(`Compliance · ${width} · ${theme} · ${hash}: no sideways scroll or clipped text, equal tiles`, async ({ page }) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        await open(page, hash, theme);
        await expect(page.locator('[data-layer="verdict"]')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
        const clipped = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".cp-page *, .page-header *, .bl-sheet *")]
          .filter((element) => element.children.length === 0 && element.clientWidth > 1 && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflow !== "visible" && getComputedStyle(element).textOverflow !== "ellipsis")
          .map((element) => element.textContent));
        expect(clipped).toEqual([]);
        const tiles = await page.locator(".cp-tile").evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height)));
        expect(tiles.length).toBe(4);
        expect(new Set(tiles).size).toBe(1);
        if (width === 390) {
          const scorecard = await page.locator(".cp-ctile").evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height)));
          expect(new Set(scorecard).size).toBe(1);
        }
        // Rule 12: everything styled as clickable is a link with a target or a button.
        const dead = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main a, main .btn, .cp-tile, .cp-ctile, .cp-row-link, .bl-sheet a, .bl-sheet .btn")]
          .filter((element) => (element.tagName === "A" && !(element as HTMLAnchorElement).getAttribute("href")) || (element.tagName !== "A" && element.tagName !== "BUTTON" && !element.closest("a, button")))
          .map((element) => element.outerHTML.slice(0, 80)));
        expect(dead).toEqual([]);
        expect(await page.locator("main .btn-primary:visible").count()).toBeLessThanOrEqual(1);
        if (hash.includes("open=")) {
          const sheet = page.getByRole("dialog");
          await expect(sheet).toBeVisible();
          await expect(sheet.locator(".bl-sheet-foot .btn-primary")).toBeInViewport();
          await expect(sheet.locator(".bl-sheet-foot .btn-primary")).toHaveCount(1);
        }
      });
    }
  }
}

// Task-99: a grounded answer cites each record and its window, says which part of the
// period is not known, never reads missing history as "nothing changed", and fits a phone.
test("ask cites its records, states unknown periods, and fits a phone", async ({ page }) => {
  await open(page, "/ask", "dark");
  const answer = page.locator(".ask-answer");
  await expect(answer).toContainText("Understood as: Changes owned by SALES");
  await expect(answer).toContainText("Only resources owned by SALES are included");
  await expect(answer.locator(".ask-gap")).toContainText("KEEL has not compared a backup since then");
  const records = answer.locator(".ask-record");
  await expect(records).toHaveCount(2);
  await expect(records.nth(0)).toContainText("Sales Admins (group)");
  await expect(records.nth(0)).toContainText("Happened between");
  await expect(records.nth(0).getByRole("link", { name: "Open the Changes page" })).toHaveAttribute("href", /drift/);
  await expect(records.nth(1)).toContainText("the earlier backup is not known");
  await expect(page.locator("form[method='get']")).toHaveCount(2);
  await expect(page.locator("form[method='post']")).toHaveCount(0);
  await answer.locator("summary", { hasText: "Technical details" }).click();
  await expect(answer.locator('[data-layer="record"]')).toContainText("a5c00000-0000-4000-8000-000000000991");

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

  await open(page, "/ask/unknown", "light");
  await expect(page.locator('[data-layer="verdict"]')).toContainText("Not known");
  await expect(page.locator(".ask-answer")).toContainText("This is not the same as nothing happening");
  await expect(page.locator(".ask-answer")).not.toContainText("Nothing matched");
});

// Wave 2 CMP: compare groups differences by service and kind with plain names, reads
// references by name across tenants, and fits a phone and a desktop.
for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`compare groups differences by service and kind and fits ${viewport.width} px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await open(page, "/compare", "dark");
    await expect(page.locator('[data-layer="verdict"]')).toContainText("8 differences between the two backups");
    await expect(page.locator("form[method='get']")).toHaveCount(1);
    await expect(page.locator("form[method='post']")).toHaveCount(0);
    const settings = page.locator("section", { has: page.locator("#compare-settings-heading") });
    await expect(settings.locator("h3").first()).toHaveText("Entra ID");
    const policies = settings.locator("details.compare-group", { hasText: "Sign-in rule" });
    await policies.locator("summary").click();
    await expect(policies).toContainText("Block legacy auth");
    await expect(policies).toContainText("enabled for reporting but not enforced");
    await expect(policies.locator(".cv-row", { hasText: "Exclude groups" }).locator('[data-side="before"]')).toContainText("Break-glass admins");
    await expect(policies.locator(".cv-row", { hasText: "Exclude groups" }).locator('[data-side="after"]')).toContainText("Break-glass admins, an object Keel has no name for");
    // Added and removed objects list the settings they hold, each with its value.
    const groups = settings.locator("details.compare-group").filter({ has: page.locator(".compare-group-name", { hasText: /^Group$/ }) });
    await groups.locator("summary").click();
    await expect(groups.locator(".compare-item", { hasText: "Old project team" }).locator(".cv-row", { hasText: "Description" })).toContainText("Project Atlas, closed in September");
    const contractors = groups.locator(".compare-item", { hasText: "KEEL-RT-Contractors" });
    await expect(contractors.locator(".cv-row", { hasText: "Membership rule" }).locator('[data-side="after"]')).toContainText("Processing state: On");
    await expect(contractors.locator(".cv-row", { hasText: "Membership rule" }).locator('[data-side="before"]')).toContainText("Not there");
    await expect(settings).toContainText("Device configuration (Intune): First side read in full, second side failed to read.");
    const content = page.locator("section", { has: page.locator("#compare-content-heading") });
    await content.locator("details.compare-group", { hasText: "Drive" }).locator("summary").click();
    await expect(content).toContainText("Budget 2027 v2.xlsx");
    await content.locator("details.compare-group", { hasText: "Inbox (mailbox)" }).locator("summary").click();
    await expect(content).toContainText("An item (message)");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

    await open(page, "/compare/tenants", "light");
    await expect(page.locator('[data-layer="verdict"]')).toContainText("between the two tenants");
    const across = page.locator("section", { has: page.locator("#compare-settings-heading") });
    await across.locator("details.compare-group").first().locator("summary").click();
    await expect(across).toContainText("Break-glass admins (group)");
    await expect(across).toContainText("an object Keel could not name");
    await expect(across).toContainText("Device category (Intune): 3 in the first, 2 in the second.");
    await expect(page.locator("section", { has: page.locator("#compare-content-heading") })).toContainText("812 items in both");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
}

// Task-93: an approved emergency change says what KEEL will hold back and until when,
// keeps every other change on the resource in play, says what happened when one ended,
// and refuses an approval by the person who made the change.
test("emergency changes say what is held back, how each ended, and refuse self-approval", async ({ page }) => {
  await open(page, "/emergency-changes");
  await expect(page.locator('[data-layer="verdict"] .verdict-sentence')).toHaveText("One emergency change is approved right now; KEEL will not roll it back. The next approval ends in 3 hours.");
  const active = page.locator("li.change-intent.is-active");
  await expect(active.locator(".change-intent-sentence")).toHaveText(/^KEEL will not roll back the state change until .+ \(in 3 hours\)\.$/);
  await expect(active).toContainText("Any other change to Block legacy auth (Conditional Access policy) is still rolled back as its policies say.");
  await expect(active).toContainText("Change ticket CHG0031337.");
  await expect(page.locator("li.change-intent.is-ended .change-intent-settled")).toHaveText("When it ended, KEEL checked again: it was still changed, so its policies acted on it as usual.");
  await expect(page.locator("li.change-intent.is-revoked .change-intent-sentence")).toHaveText("Revoked 47 hours ago by Amara Okafor: migration finished early.");

  const form = page.locator("form.change-intent-form");
  const submit = form.getByRole("button", { name: "Approve emergency change" });
  await expect(submit).toBeDisabled();
  await form.getByLabel("Visibility").check();
  await form.getByLabel("Who made or owns the change").selectOption({ label: "Amara Okafor" });
  await form.getByLabel("Reason").fill("Responders need the group open");
  await submit.click();
  const toast = page.locator(".toast").first();
  await expect(toast).toContainText("Not approved");
  await expect(toast).toContainText("The person who made the change cannot approve it.");

  await active.getByLabel(/Why revoke the approval/).fill("Partner app fixed");
  await active.getByRole("button", { name: "Revoke" }).click();
  await expect(page.locator("dialog[open]").getByRole("button", { name: "Cancel" })).toBeFocused();
  expectPlainText(await textOutside(page, "main#main-content", '[data-layer="record"]'));
});

// Restore, rule 12: no sideways scroll, sibling tiles share a height, and everything
// styled as clickable is a link or a button, at phone and desktop width in both themes.
for (const theme of ["dark", "light"] as const) {
  for (const width of [390, 1440]) {
    test(`restore clicks · ${width} · ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, "/restore", theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      const heights = await page.locator(".restore-tile").evaluateAll((tiles) => tiles.map((tile) => Math.round(tile.getBoundingClientRect().height)));
      const rows = width < 1200 ? [heights.slice(0, 2), heights.slice(2)] : [heights];
      for (const row of rows) expect(new Set(row).size, JSON.stringify(heights)).toBe(1);
      for (const element of await page.locator(".restore-page .btn, .restore-page .restore-tile-link, .restore-page .sel-group-toggle").all()) {
        expect(await element.evaluate((node) => node.tagName)).toMatch(/^(A|BUTTON)$/);
      }
    });
  }
}
