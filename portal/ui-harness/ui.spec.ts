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
  { name: "drift-sites", hash: "/drift/sites" },
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
  await open(page, "/approvals");
  const row = page.locator("li.approval-card").first();
  await row.locator("input").fill("outside the change window");
  await row.getByRole("button", { name: "Reject" }).click();
  await expect(row.getByRole("button", { name: "Reject" })).toHaveAttribute("aria-busy", "true");
  await expect(row.getByRole("button", { name: "Approve" })).not.toHaveAttribute("aria-busy", "true");
});

test("destructive writes ask for confirmation with Cancel focused", async ({ page }) => {
  await open(page, "/notifications");
  await page.getByRole("button", { name: "Delete rule" }).first().click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("a queued backup confirms with a toast linking to the job", async ({ page }) => {
  await open(page, "/protect");
  await page.getByRole("button", { name: "Back up Tier 1" }).click();
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
  await effects.getByRole("button", { name: "Approve content effects" }).click();
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

test("restore lists every other Microsoft 365 service it backs up, and says what can be put back", async ({ page }) => {
  await open(page, "/restore");
  const services = page.locator(".restore-service h3");
  await expect(services).toHaveText(["Exchange Online", "SharePoint and OneDrive", "Teams", "Power Platform", "Purview"]);
  const flow = page.locator(".restore-workload", { hasText: "Exchange mail flow and protection" });
  await expect(flow.locator(".restore-chip")).toHaveText("KEEL can put back");
  await expect(flow.locator(".restore-workload-backup")).toHaveText("Backed up 3 hours ago · 7 items.");
  const onedrive = page.locator(".restore-workload", { hasText: "OneDrive settings" });
  await expect(onedrive.locator(".restore-chip")).toHaveText("By hand only");
  await onedrive.getByText("What you do by hand").click();
  await expect(onedrive).toContainText("Change them by hand in the SharePoint admin center");
  await expect(page.locator(".restore-workload", { hasText: "Teams organization policies" })).toContainText("The newest backup failed");
  const power = page.locator(".restore-workload", { hasText: "Power Platform and Power BI" });
  await expect(power).toContainText("Not switched on for this tenant yet");
  await expect(power.locator(".restore-chip")).toHaveText("No backup yet");
  // No stored code on the screen outside Technical details.
  await expect(page.locator(".restore-services .restore-workload-head")).not.toContainText(["power-platform-settings"]);
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
  // The panel is in the address, closes with Esc and gives focus back to the row.
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
  await sheet.getByRole("button", { name: "Close" }).click();
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

  await open(page, "/approvals/cli-restore", "light");
  const note = page.locator(".approval-content-effects");
  await expect(note).toContainText("1 change in this restore affects content. It needs its own approval by someone other than the requester");
  await expect(note.getByRole("link", { name: "Review content effects" })).toHaveAttribute("href", "/approvals/content-effects/7f3c0000-0000-4000-8000-000000000045");
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
  await effects.getByRole("button", { name: "Approve content effects" }).click();
  await expect(effects).toContainText("Approved for exactly these effects by Marouane Defili");
  expect(await overflow()).toBeLessThanOrEqual(0);
});

// Task-131 (was task-54/63's coverage matrix): a type's drawer answers in one sentence
// and keeps the recovery decision, remapping proof and proof reference in its record.
test("a type drawer states its standing and keeps the recovery decision and proof in its record", async ({ page }) => {
  await open(page, "/protect");
  const drawer = page.locator("details.type-drawer").filter({ hasText: "Conditional Access policy" }).first();
  await drawer.locator("summary").first().click();
  await expect(drawer.locator(".type-drawer-standing")).toHaveText("Protected: restore proven on this tenant on 20 Sept 2026.");
  await expect(drawer.locator(".decision-automated")).toContainText("KEEL restores this type on its own.");
  const record = drawer.locator('[data-layer="record"]');
  await record.locator("summary").click();
  await expect(record.locator(".technical-field").filter({ hasText: "Recovery decision" })).toContainText("automated");
  await expect(record.locator(".technical-field").filter({ hasText: "Remapping · create" })).toContainText("proven");
  await expect(record.locator(".technical-field").filter({ hasText: "Proof reference · update" })).toContainText("docs/release/qualification/ca-update.json");
});

test("Protect lists failed and out-of-date types by name with a retry", async ({ page }) => {
  await open(page, "/protect");
  await expect(page.locator('[data-layer="verdict"]')).toHaveText("2 types failed their last backup.");
  const problems = page.locator(".protect-problem");
  await expect(problems).toHaveText([/Authentication methods policy/, /Retention label/, /Device configuration/, /Cross-tenant access partner/]);
  await problems.first().getByRole("button", { name: "Retry the backup of Authentication methods policy (Tier 1)" }).click();
  await expect(page.locator(".toast").first()).toContainText("Tier 1 backup queued");
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

// Site permissions audit: site setting changes are listed on the Changes page, fit a
// phone, and each site's name opens its own page.
test("site permission changes show on the Changes page and fit a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, "/drift/sites", "dark");
  const list = page.locator(".site-change-list .site-change");
  await expect(list).toHaveCount(2);
  await expect(list.nth(0)).toContainText("App access changed.");
  await expect(list.nth(0)).toContainText("Alert: open");
  await expect(list.nth(1)).toContainText("Name and web address changed.");
  await expect(page.getByRole("link", { name: "Review the open alert on the Alerts page" })).toHaveAttribute("href", /alerts/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await list.nth(0).getByRole("link", { name: "Finance" }).click();
  await expect(page.locator("main#main-content h1")).toHaveText("Finance");
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
  "drift-sites": ["conditionalAccessPolicy:Block legacy auth", "d1a00000-0000-4000-8000-0000000000d1", "a1e70000-0000-4000-8000-0000000000a5", "site:contoso.sharepoint.com,5e170000-0000-4000-8000-000000000001,5e170000-0000-4000-8000-000000000002"],
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
  "job-restore-completion": ["7f3c0000-0000-4000-8000-000000000011"],
  "job-restore-undo": ["7f3c0000-0000-4000-8000-000000000010"],
  resilience: ["18190", "18201", "type:group", "relationship:group/members", "b7c10000-0000-4000-8000-000000000074", "1c1d0000-0000-4000-8000-000000000071", "5a2be911-0000-4000-8000-000000000002", "5c4e0000-0000-4000-8000-000000000005", "/opt/backups/keel-recovery-manifest.json"],
  "resilience-unmeasured": ["type:conditionalAccessPolicy", "unmeasured"],
  reports: ["restore-plan:7f3c0000-0000-4000-8000-000000000100", "job:a1000000-0000-4000-8000-000000000002", "change:d1f70000-0000-4000-8000-000000000101", "keel.mfa.admins", "e7a10000-0000-4000-8000-000000000203", "4c".repeat(32), "9b".repeat(32), "/etc/keel/value-estimate.json"],
  "reports-scoped": ["restore-plan:7f3c0000-0000-4000-8000-000000000100", "entities FIN", "not-configured"],
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
  await expect(preview.locator(".policy-preview-sentence")).toHaveText("Ready to turn on. It would roll back 2 changes now; KEEL will refuse 1 that depends on something above its limit.");
  await expect(preview.locator(".policy-dependencies li")).toHaveText("Privileged approvers (group), needed by Finance (group). Impact: could lock out admins. Above its limit, so KEEL will refuse these roll backs.");
  await expect(preview).toContainText("1 waiting to run, not yet rolled back");
  await expect(preview).not.toContainText("1 rolled back");
  await page.getByRole("button", { name: "Turn on" }).click();
  const toast = page.locator(".toast").first();
  await expect(toast).toContainText("Not turned on");
  await expect(toast).toContainText("The account's access changed since the preview. Preview again.");
  await expect(preview).toHaveCount(0);
  await page.getByRole("button", { name: "Preview turning on" }).click();
  await expect(page.locator("section.policy-preview .policy-preview-sentence")).toBeVisible();
  expectPlainText(await textOutside(page, "main#main-content", '[data-layer="record"]'));
});

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
    await expect(policies).toContainText("an id, an id");
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
    await expect(across).toContainText("an object KEEL could not name");
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
