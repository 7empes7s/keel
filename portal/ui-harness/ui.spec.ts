import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HARNESS = pathToFileURL(join(__dirname, "dist/index.html")).href;

const PAGES = [
  { name: "dashboard", hash: "/" },
  { name: "coverage", hash: "/coverage" },
  { name: "drift", hash: "/drift" },
  { name: "backups", hash: "/backups" },
  { name: "restore", hash: "/restore" },
  { name: "jobs", hash: "/jobs" },
  { name: "job-failed", hash: "/jobs/a4" },
  { name: "job-restore-completion", hash: "/jobs/r9" },
  { name: "job-restore-undo", hash: "/jobs/r10" },
  { name: "policies", hash: "/policies" },
  { name: "policy", hash: "/policies/p1" },
  { name: "approvals", hash: "/approvals" },
  { name: "evidence", hash: "/evidence" },
  { name: "principals", hash: "/principals" },
  { name: "notifications", hash: "/notifications" },
  { name: "integrations", hash: "/integrations" },
];

async function open(page: Page, hash: string, theme: "light" | "dark" = "dark") {
  // Emulating the OS scheme exercises the default "System" theme path, which is
  // what most operators run.
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.goto(`${HARNESS}#${hash}`);
  await page.evaluate(() => { document.documentElement.dataset.harnessCi = ""; });
  await page.locator("main#main-content h1").waitFor();
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
const VISUAL = ["dashboard", "drift", "restore", "approvals", "coverage", "job-failed"];
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
test("command palette opens with the keyboard and navigates", async ({ page }) => {
  await open(page, "/");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("evid");
  await page.keyboard.press("Enter");
  await expect(page.locator("main h1")).toHaveText("Evidence");
});

test("reject shows the spinner on Reject only", async ({ page }) => {
  await open(page, "/approvals");
  const row = page.locator("tbody tr").first();
  await row.locator("input").fill("outside the change window");
  await row.getByRole("button", { name: "Reject" }).click();
  await expect(row.getByRole("button", { name: "Reject" })).toHaveAttribute("aria-busy", "true");
  await expect(row.getByRole("button", { name: "Approve" })).not.toHaveAttribute("aria-busy", "true");
});

test("destructive writes ask for confirmation with Cancel focused", async ({ page }) => {
  await open(page, "/notifications");
  await page.getByRole("button", { name: "Delete subscription" }).first().click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("a queued backup confirms with a toast linking to the job", async ({ page }) => {
  await open(page, "/backups");
  await page.getByRole("button", { name: "Back up Tier 1" }).click();
  const toast = page.locator(".toast").first();
  await expect(toast).toContainText("Tier 1 backup queued");
  await expect(toast.getByRole("link", { name: /View job/ })).toBeVisible();
});

test("the restore wizard walks select → dry run → review → confirm → track", async ({ page }) => {
  await open(page, "/restore");
  await page.getByLabel("Select conditionalAccessPolicy:Block legacy auth").click();
  await page.getByRole("button", { name: "Next: start dry run" }).click();
  await expect(page.getByText("Ready to confirm")).toBeVisible({ timeout: 15_000 });
  // Task-61: a restored group's membership changes are listed apart from object changes.
  // Task-64: each resource names its recovery mechanism and what happens to its id.
  await expect(page.getByText("RECOVERY MECHANISM")).toBeVisible();
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
  await expect(page.locator(".edge-op.edge-add").first()).toContainText("user:amara.okafor@contoso.example");
  await expect(page.locator(".edge-op.edge-remove").first()).toContainText("as member of");
  await page.getByPlaceholder("Why is this restore appropriate?").fill("Roll back INC-2291");
  await page.getByRole("button", { name: "Confirm restore" }).click();
  await expect(page.getByRole("heading", { name: "Restore requested, pending approval" })).toBeVisible();
});

test("coverage details show the explicit recovery decision and remapping proof", async ({ page }) => {
  await open(page, "/coverage");
  const details = page.locator(".capability-matrix").filter({ has: page.locator(".decision-automated") }).first();
  await details.locator("summary").click();
  await expect(details.getByText("Recovery decision")).toBeVisible();
  await expect(details.locator(".decision-automated")).toHaveText("Automated");
  await expect(details.getByText("Create remapping: proven")).toBeVisible();
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
  await page.getByLabel("Select conditionalAccessPolicy:Block legacy auth").click();
  await page.getByRole("button", { name: "Next: start dry run" }).click();
  await expect(page.getByText("Ready to confirm")).toBeVisible({ timeout: 15_000 });
  expect(await overflow()).toBeLessThanOrEqual(0);
  // Stacked mechanism rows keep their column labels, and pills keep their own width.
  const cell = page.locator(".recovery-table td[data-label='Mechanism']").first();
  await expect(cell).toBeVisible();
  const pill = cell.locator(".pill");
  const [pillWidth, cellWidth] = await Promise.all([
    pill.evaluate((element) => element.getBoundingClientRect().width),
    cell.evaluate((element) => element.getBoundingClientRect().width),
  ]);
  expect(pillWidth).toBeLessThan(cellWidth * 0.9);
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
  await expect(page.locator(".compensation-section").filter({ hasText: "NOT OVERWRITTEN" }).getByText("conditionalAccessPolicy:Require MFA for admins", { exact: true })).toBeVisible();
  await expect(page.locator(".compensation-section").filter({ hasText: "CANNOT BE UNDONE" }).getByText("group:Contractors", { exact: true })).toBeVisible();
  await expect(page.getByText("not atomic")).toBeVisible();

  const request = page.getByRole("button", { name: "Request approval to undo" });
  await expect(request).toBeDisabled();
  await page.getByLabel("Why undo this restore?").fill("Wrong snapshot restored over Finance");
  await request.click();
  await expect(page.locator(".compensation-requested")).toHaveText(/Sent for approval/);
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
