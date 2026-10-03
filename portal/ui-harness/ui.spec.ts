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
  { name: "restore", hash: "/restore" },
  { name: "incidents", hash: "/incidents" },
  { name: "resilience", hash: "/resilience" },
  { name: "resilience-unmeasured", hash: "/resilience/unmeasured" },
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
  { name: "benchmarks", hash: "/benchmarks" },
  { name: "principals", hash: "/principals" },
  { name: "notifications", hash: "/notifications" },
  { name: "integrations", hash: "/integrations" },
  { name: "setup", hash: "/setup" },
  { name: "alerts", hash: "/alerts" },
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
  await page.getByLabel("Select Block legacy auth (Conditional Access policy)").click();
  await expect(page.locator('[data-layer="verdict"]')).toHaveText("Step 1 of 5: choose what to put back.");
  await page.getByRole("button", { name: "Next: start dry run" }).click();
  await expect(page.getByText("Ready to confirm")).toBeVisible({ timeout: 15_000 });
  // Task-131: the step title is the verdict, and the review speaks in words: no natural
  // key, verb, closure or artifact id outside the record, and no credential path input.
  await expect(page.locator('[data-layer="verdict"]')).toHaveText("Step 4 of 5: review what will change, then confirm.");
  expectPlainText(await textOutside(page, "main#main-content", '[data-layer="record"]'));
  await expect(page.locator("input[value*='/etc/keel']")).toHaveCount(0);
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
  await expect(page.locator(".edge-op.edge-add").first()).toContainText("amara.okafor@contoso.example (user)");
  await expect(page.locator(".edge-op.edge-remove").first()).toContainText("as member of");
  await page.getByPlaceholder("Why is this restore appropriate?").fill("Roll back INC-2291");
  await page.getByRole("button", { name: "Confirm restore" }).click();
  await expect(page.getByRole("heading", { name: "Sent to approvers" })).toBeVisible();
  await expect(page.locator('[data-layer="verdict"]')).toHaveText("Step 5 of 5: sent to approvers. Nothing changes until one of them approves.");
});

// Task-131: the roll-back preview says what KEEL would do in words, keeps verbs and
// waves in the record, and states a refusal as a sentence.
test("the roll-back preview speaks in words and states a refusal as a sentence", async ({ page }) => {
  await open(page, "/drift");
  await page.getByLabel("Select Finance (group)").check();
  await page.getByLabel("Select Block legacy auth (Conditional Access policy)").check();
  await page.getByRole("button", { name: "Preview roll back" }).click();
  const preview = page.locator(".remediation-preview");
  await expect(preview).toContainText("Put the baseline settings back");
  await expect(preview.locator('[role="alert"]')).toHaveText(/KEEL refused to change Finance \(group\) because it is synced from on-premises Active Directory, which owns it\./);
  await expect(preview.getByRole("button", { name: "Confirm and request approval" })).toBeDisabled();
  const record = preview.locator('[data-layer="record"]');
  await record.locator("summary").click();
  await expect(record).toContainText("Write wave 1");
  await expect(record).toContainText("onPremisesSyncEnabled=true");
  expectPlainText(await textOutside(page, "main#main-content", '[data-layer="record"]'));
});

// Task-91: who made a change, in words, with its evidence kept in the record; a missing
// audit log is said plainly, and a cross-entity roll back is handed to a central approver.
test("a change says who made it from the audit log and where a roll back goes", async ({ page }) => {
  await open(page, "/drift");
  await page.locator("tr.drift-row").filter({ has: page.locator(".resource-name", { hasText: /^Block legacy auth$/ }) }).getByRole("button", { name: "Show what changed" }).click();
  const panel = page.locator(".change-attribution");
  await expect(panel.locator(".change-attribution-headline")).toContainText("Confirmed by the Microsoft audit log. Amara Okafor made this change, according to the audit log.");
  await expect(panel.locator(".change-attribution-route")).toHaveText("A roll back goes to a central approver (2 people), because it touches more than one entity.");
  expectPlainText(await textOutside(page, "main#main-content", '[data-layer="record"]'));
  const record = panel.locator('[data-layer="record"]');
  await record.locator("summary").click();
  for (const kept of ["Directory_8f2c1d7a-4b3e-4f61-9a20-1c5d7e9b3a44", "a71ce000-0000-4000-8000-0000000000a7", "c0a10000-0000-4000-8000-0000000000ca", "exact · audit-record-names-resource", "central · cross-entity"]) {
    await expect(record).toContainText(kept);
  }
  await page.locator("tr.drift-row").filter({ has: page.locator(".resource-name", { hasText: /^Finance$/ }) }).getByRole("button", { name: "Show what changed" }).click();
  await expect(page.locator(".change-attribution-headline")).toContainText("Not known. The audit log for that time is no longer available");
  await expect(page.locator(".change-attribution-route")).toHaveText("A roll back goes to CREOS approvers (1 person).");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
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
  await page.getByLabel("Select Block legacy auth (Conditional Access policy)").click();
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
  approvals: ["a9e10000-0000-4000-8000-000000000100", "8c1e0000-0000-4000-8000-0000000000a1"],
  baselines: ["b1180000-0000-4000-8000-000000000118", "b1170000-0000-4000-8000-000000000117", "b1160000-0000-4000-8000-000000000116", "0b5e0000-0000-4000-8000-0000000000c8"],
  benchmarks: ["e7a10000-0000-4000-8000-0000000000e1", "e7c10000-0000-4000-8000-0000000000c1", "d7100000-0000-4000-8000-0000000000d1", "d7100000-0000-4000-8000-0000000000d2", "7f3c0000-0000-4000-8000-000000000011", "0b5e0000-0000-4000-8000-0000000000d6", "/opt/backups/keel-recovery-manifest.json"],
  notifications: ["c4e10000-0000-4000-8000-0000000000c1", "c4e10000-0000-4000-8000-0000000000c2", "c4e10000-0000-4000-8000-0000000000c3", "d0e10000-0000-4000-8000-0000000000d1", "d0e10000-0000-4000-8000-0000000000d3"],
  integrations: ["de570000-0000-4000-8000-0000000000e1"],
  protect: ["engine/restore/updatePath.test.mjs", "docs/release/qualification/ca-update.json", "0b5e0000-0000-4000-8000-0000000000d5", "authenticationMethodsPolicy", "Authorization_RequestDenied"],
  schedules: ["5c4e0000-0000-4000-8000-000000000001", "5c4e0000-0000-4000-8000-000000000005", "0 0 * * 1", "a11c0000-0000-4000-8000-0000000000a1", "throttle-heavy", "overlap (acknowledged)"],
  setup: ["5e7a" + "0b".repeat(30), "step-1a2b3c4d5e6f7a82", "plan-9f8e7d6c5b4a3921"],
  alerts: ["a1e70000-0000-4000-8000-000000000001", "conditionalAccessPolicy:Block legacy auth", "group:Finance"],
  "job-restore-completion": ["7f3c0000-0000-4000-8000-000000000011"],
  "job-restore-undo": ["7f3c0000-0000-4000-8000-000000000010"],
  resilience: ["18190", "18201", "type:group", "relationship:group/members", "b7c10000-0000-4000-8000-000000000074", "1c1d0000-0000-4000-8000-000000000071", "5a2be911-0000-4000-8000-000000000002", "5c4e0000-0000-4000-8000-000000000005", "/opt/backups/keel-recovery-manifest.json"],
  "resilience-unmeasured": ["type:conditionalAccessPolicy", "unmeasured"],
  readiness: ["b9000000-0000-4000-8000-000000000001", "b9000000-0000-4000-8000-000000000002", "a1e70000-0000-4000-8000-000000000094", "conditionalAccessPolicy:Block legacy auth", "si-7f21", "au-9c10"],
  "readiness-ready": ["b9000000-0000-4000-8000-000000000002", "activation-rules-not-collected"],
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

test("contract · shell: seven entries, plain words, the eyebrow is the section", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "/", "dark");
  const entries = page.locator("#primary-nav a.nav-link");
  await expect(entries).toHaveCount(7);
  expect(await Promise.all((await entries.all()).map((entry) => entry.locator("span").first().innerText())))
    .toEqual(["Overview", "Protect", "Changes", "Restore", "Approvals", "Activity", "Settings"]);
  expectPlainText(await textOutside(page, "aside.sidebar", ".nope"));
  // A page absorbed into a section is reached through that section's tabs.
  for (const { hash, section, tab } of [
    { hash: "/schedules", section: "Protect", tab: "Schedules" },
    { hash: "/incidents", section: "Restore", tab: "Incidents" },
    { hash: "/principals", section: "Settings", tab: "People" },
  ]) {
    await open(page, hash, "dark");
    await expect(page.locator(".eyebrow").first()).toHaveText(section);
    await expect(page.locator('#primary-nav a[aria-current]')).toContainText(section);
    await expect(page.locator(".section-tabs a[aria-current='page']")).toHaveText(tab);
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

// A record inside a stacked table cell stays in the value column on a phone, an empty
// cell is not shown, the active-row bar clears the text, and the disclosure triangle is
// text (iOS otherwise draws the default marker as an emoji).
test("stacked tables on a phone keep records beside their label and hide empty cells", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "/baselines", "light");
  const row = page.locator(".baselines-table tbody tr.active-row");
  const nameCell = row.locator("th[data-label='Name']");
  const name = await nameCell.locator(".baseline-table-label").boundingBox();
  const summary = await nameCell.locator(".technical-details > summary").boundingBox();
  expect(name && summary, "name and record are laid out").toBeTruthy();
  // Below 25rem the cell is one column, so the record sits under the name, aligned with it.
  expect(Math.abs(summary!.x - name!.x)).toBeLessThan(2);
  // Task-87: the active row offers "Capture new version"; a superseded version has no
  // actions, so its empty cell is the one that must not be shown.
  await expect(row.locator("td[data-label='Actions']")).toBeVisible();
  await expect(page.locator(".baselines-table tbody tr").last().locator("td[data-label='Actions']")).toBeHidden();
  expect(await nameCell.evaluate((cell) => getComputedStyle(cell).boxShadow)).toBe("none");
  expect(await nameCell.locator(".technical-details > summary").evaluate((element) => getComputedStyle(element).listStyleType)).toBe("none");

  // Between 25rem and 46rem the cell is two columns: the record joins the value column.
  // The first read after a resize can precede the relayout, so wait for it to settle.
  await page.setViewportSize({ width: 600, height: 900 });
  await expect.poll(async () => {
    const wideName = await nameCell.locator(".baseline-table-label").boundingBox();
    const wideSummary = await nameCell.locator(".technical-details > summary").boundingBox();
    return Math.abs(wideSummary!.x - wideName!.x);
  }).toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

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
